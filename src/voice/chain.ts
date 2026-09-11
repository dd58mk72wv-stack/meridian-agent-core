/**
 * The voice chain.
 *
 * Built ONCE and shared by every agent that speaks, rather than rebuilt per
 * agent. Twenty-one agents each owning their own copy of "how a phone call
 * works" is twenty-one places to fix a dropped call.
 *
 *   Twilio  — carries the call and the number
 *   Vapi    — runs the live call: speech to text, turn-taking, barge-in, and
 *             text to speech. It calls US with the conversation so far.
 *   Claude  — the reasoning. Which is to say: this system, via the CMO.
 *   Twilio  — delivers the audio back
 *
 * From this codebase's side the chain is one HTTP handler: Vapi posts the
 * conversation, we dispatch it through the hierarchy, we return what to say.
 * Everything between the microphone and that POST is Vapi's problem, which is
 * the entire reason for using it.
 *
 * ---------------------------------------------------------------------------
 * A correction to the build prompts, carried here so it is not repeated.
 *
 * The three vertical prompts describe ElevenLabs as 'the "Fable 5.1"
 * voice/personality layer'. That conflates two unrelated things. ElevenLabs is
 * text-to-speech — it decides how the words sound. Claude Fable 5.1 is a
 * language model — it decides what the words are. The personality lives in the
 * agent's prompt, not in the voice.
 *
 * It matters practically: ElevenLabs is configured inside Vapi's dashboard and
 * has no key in this system at all, so anyone looking for one here will not
 * find it and should not go hunting.
 * ---------------------------------------------------------------------------
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { Context, type Trigger } from '../core/context.js';
import type { CMO } from '../core/cmo.js';
import { log } from '../core/logger.js';

/** One turn of the conversation, as Vapi reports it. */
export interface Turn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface VoiceRequest {
  callId: string;
  /** The caller's number, when it is not withheld. */
  from?: string;
  /** The number they rang — which client this is, when one client has several. */
  to?: string;
  turns: Turn[];
  /** Vapi's own event type: a new call, a turn, or the call ending. */
  event: 'call.started' | 'turn' | 'call.ended';
}

export interface VoiceResponse {
  /** What to say back. Empty means say nothing and keep listening. */
  say: string;
  /** End the call after saying it. */
  hangUp?: boolean;
  /** Put the caller through to a human. */
  transferTo?: string;
}

/**
 * Verify the request really came from Vapi.
 *
 * The server URL is public and the payload contains a caller's number and the
 * transcript of what they said. An unverified endpoint is an open microphone
 * into a veterinary practice's phone line.
 *
 * Constant-time comparison, because a fast reject leaks the prefix of the
 * signature to anyone patient enough to measure.
 */
export function verifySignature(
  rawBody: string,
  provided: string | undefined,
  secret: string,
): boolean {
  if (!secret || !provided) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);

  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal. Check the length first and return the same way either way.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * What the caller last said.
 *
 * The whole transcript goes into the context; this is only what the dispatcher
 * needs to work out what is being asked right now.
 */
export function lastUtterance(turns: Turn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn?.role === 'user') return turn.content;
  }
  return '';
}

export interface VoiceChainOptions {
  cmo: CMO;
  clientId: string;
  /** Said once when the call connects. Per client, from their config. */
  greeting: string;
  /** Where a caller goes when the system cannot help. */
  humanNumber?: string;
  /** What to say when escalating to a human is not possible. */
  fallback?: string;
}

const DEFAULT_FALLBACK =
  "I'm not going to be able to help with that one properly. "
  + "Let me take a note and someone will call you straight back.";

/**
 * Handle one turn of a call.
 *
 * The whole transcript is put into the context, every time — not just the last
 * utterance. A caller who gave their registration in turn two and asks "so how
 * much is that then?" in turn nine is relying on it still being there.
 */
export async function handleVoiceTurn(
  request: VoiceRequest,
  options: VoiceChainOptions,
): Promise<VoiceResponse> {
  if (request.event === 'call.started') {
    return { say: options.greeting };
  }

  if (request.event === 'call.ended') {
    return { say: '' };
  }

  const trigger: Trigger = {
    kind: 'call',
    externalId: request.callId,
    ...(request.from ? { from: request.from } : {}),
    payload: {
      // The full transcript. Never the last line alone.
      turns: request.turns,
      said: lastUtterance(request.turns),
      ...(request.to ? { calledNumber: request.to } : {}),
    },
    receivedAt: new Date(),
  };

  const ctx = new Context({
    trigger,
    clientId: options.clientId,
    correlationId: request.callId,
  });

  // A throw anywhere below the CMO must not become dead air. The caller is on
  // the phone: an exception that propagates out of this handler gives Vapi a
  // 500, and the caller hears silence and hangs up.
  let outcome: Awaited<ReturnType<typeof options.cmo.dispatch>>;
  try {
    outcome = await options.cmo.dispatch(ctx);
  } catch (err) {
    log.error({ err, callId: request.callId }, 'dispatch threw during a live call');
    return options.humanNumber
      ? { say: 'Let me put you through to someone.', transferTo: options.humanNumber }
      : { say: options.fallback ?? DEFAULT_FALLBACK };
  }

  // Anything the CMO could not route confidently goes to a person. On a live
  // call a guess is worse than a transfer, because the caller acts on it.
  if (outcome.needsHuman) {
    log.warn(
      { callId: request.callId, reason: outcome.needsHuman },
      'voice turn could not be routed',
    );
    return options.humanNumber
      ? { say: 'Let me put you through to someone.', transferTo: options.humanNumber }
      : { say: options.fallback ?? DEFAULT_FALLBACK };
  }

  const escalated = outcome.results.filter((r) => r.status === 'escalate');
  if (escalated.length > 0 && escalated.length === outcome.results.length) {
    return options.humanNumber
      ? { say: 'Let me put you through to someone who can sort that.', transferTo: options.humanNumber }
      : { say: options.fallback ?? DEFAULT_FALLBACK };
  }

  // Agents that speak return `say`. Several may have run — a cross-department
  // turn produces two — and both halves are said, in the order they ran, so the
  // caller hears an answer to the whole of what they asked.
  const spoken = outcome.results
    .map((r) => r.say)
    .filter((s): s is string => Boolean(s && s.trim()));

  if (spoken.length === 0) {
    // Every agent acted rather than spoke. Saying nothing on a phone call is
    // dead air, which a caller reads as the line having dropped.
    return { say: 'One moment.' };
  }

  return { say: spoken.join(' ') };
}

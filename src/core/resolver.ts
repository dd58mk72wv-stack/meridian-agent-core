/**
 * Turning a sentence into a department.
 *
 * `IntentResolver` has been an interface with no implementation since the CMO
 * was written. This is the implementation, and it is the only place in Meridian
 * where a model decides where something goes.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MODEL IS GIVEN A CLOSED LIST
 *
 * The obvious design asks "what does this person want?" and lets the model
 * answer freely. That produces intents nobody registered, which route nowhere,
 * and the failure is silent: the caller is told something is being handled and
 * no department ever hears it.
 *
 * So the prompt carries the EXACT intents the registry currently knows, and an
 * answer outside that list is discarded rather than interpreted. The list is
 * built from the managers at construction time, which means a newly registered
 * agent becomes routable without anyone editing a prompt — and a deleted one
 * stops being offered in the same deploy.
 * ---------------------------------------------------------------------------
 *
 * CONFIDENCE IS THE MODEL'S, AND IT IS NOT TRUSTED BLINDLY. The CMO applies
 * CONFIDENCE_FLOOR itself; this resolver's job is to report honestly rather
 * than to round up. The system prompt says plainly that saying "I am not sure"
 * is a correct and common answer, because a resolver that never hedges makes
 * the floor meaningless.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod/v4';

import type { Context } from './context.js';
import type { Intent, IntentResolver } from './cmo.js';
import type { Manager } from './manager.js';
import { log } from './logger.js';

const MODEL = 'claude-opus-5';

/**
 * Deliberately small. Routing is a short answer to a short question, and a
 * generous cap here mostly buys reasoning that never reaches the caller.
 */
const MAX_TOKENS = 1024;

const IntentSchema = z.object({
  intents: z.array(z.object({
    name: z.string().describe(
      'EXACTLY one of the intent names listed in the prompt. Never invent one, '
      + 'never reword one, never return a department name instead.'),
    confidence: z.number().min(0).max(1).describe(
      'How sure you are. Below 0.6 nothing is dispatched and a human is asked, '
      + 'which is the correct outcome for anything genuinely ambiguous. Do not '
      + 'inflate this to seem useful.'),
    because: z.string().describe(
      'The words in the trigger that led here. Quote them. If you cannot quote '
      + 'anything, the confidence is too high.'),
  })).describe(
    'One entry per SEPARATE thing being asked. Usually one. Two when someone '
    + 'genuinely raises two different departments\' business in one message — '
    + 'that case is the reason the CMO exists. Empty when nothing matches.'),
});

function systemPrompt(catalogue: string): string {
  return [
    'You route an incoming trigger to the intents a business already handles.',
    '',
    'You are not answering the person. You are not solving anything. You decide',
    'which registered intent or intents this is, and how sure you are.',
    '',
    'THE ONLY INTENTS THAT EXIST:',
    catalogue,
    '',
    'RULES',
    '',
    '1. Return names from that list, character for character. An intent that is',
    '   not on the list routes nowhere and the person is never helped, so',
    '   inventing one is worse than returning nothing.',
    '',
    '2. Return NOTHING rather than a weak guess. An empty list sends this to a',
    '   human, which is a good outcome. A wrong route gives someone a confident',
    '   answer to a question they did not ask, and the department that should',
    '   have heard them never does.',
    '',
    '3. Two intents ONLY when two separate things are genuinely being raised —',
    '   "book it in for a service, and I have been thinking about trading it in"',
    '   is two. One request described at length is one.',
    '',
    '4. Confidence is what you actually believe. Under 0.6 means a human decides.',
    '   Saying you are unsure is a correct and common answer, not a failure.',
    '',
    '5. Judge only what is in front of you. Do not assume what someone probably',
    '   meant, what customers usually want, or what would be commercially',
    '   convenient.',
  ].join('\n');
}

/** What the model is allowed to choose from, built from the live registry. */
export function catalogueOf(managers: Manager[]): string {
  const lines: string[] = [];
  for (const m of managers) {
    lines.push(`\n${m.name} — ${m.owns}`);
    for (const agent of m.agents) {
      for (const intent of agent.handles) {
        lines.push(`  ${intent}  (handled by ${agent.name})`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * What the model is shown of the trigger.
 *
 * Only the trigger, never the notes. Notes accumulate what earlier layers have
 * already decided, and feeding those back in makes the resolver agree with
 * whatever happened last time rather than read what was actually said.
 */
export function triggerText(ctx: Context): string {
  const t = ctx.trigger;
  const payload = typeof t.payload['text'] === 'string' ? t.payload['text']
    : typeof t.payload['transcript'] === 'string' ? t.payload['transcript']
    : JSON.stringify(t.payload);

  return [
    `Channel: ${t.kind}`,
    t.from ? `From: ${t.from}` : null,
    '',
    payload,
  ].filter((l) => l !== null).join('\n');
}

export interface ResolverOptions {
  managers: Manager[];
  apiKey?: string;
  /** Returned intents whose name is not registered. Exposed for monitoring. */
  onUnknownIntent?: (name: string) => void;
}

/**
 * The resolver the CMO has been waiting for.
 *
 * Fails to an EMPTY intent list, never to a guess. Every failure path here —
 * no key, a refusal, a network fault, a malformed answer — ends with the
 * trigger going to a human, because the alternative is routing on the strength
 * of something that did not work.
 */
export function llmResolver(opts: ResolverOptions): IntentResolver {
  const catalogue = catalogueOf(opts.managers);

  // Every registered intent, for checking answers against.
  const known = new Set<string>();
  for (const m of opts.managers) {
    for (const a of m.agents) for (const i of a.handles) known.add(i);
  }

  const client = new Anthropic({
    apiKey: opts.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '',
  });

  return {
    async resolve(ctx: Context): Promise<Intent[]> {
      if (!(opts.apiKey ?? process.env['ANTHROPIC_API_KEY'])) {
        log.warn({ correlationId: ctx.correlationId },
          'no ANTHROPIC_API_KEY — every trigger will go to a human');
        return [];
      }

      try {
        const response = await client.messages.parse({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: [{
            type: 'text',
            text: systemPrompt(catalogue),
            // The catalogue is identical for every trigger in a deploy, so it
            // is worth caching: routing is the highest-frequency model call in
            // the system and this prefix is the bulk of every one of them.
            cache_control: { type: 'ephemeral' },
          }],
          messages: [{ role: 'user', content: triggerText(ctx) }],
          output_config: { format: zodOutputFormat(IntentSchema) },
        });

        // A refusal comes back as HTTP 200. Reading content without checking
        // this is how a refusal becomes an empty object and then a bad route.
        if (response.stop_reason === 'refusal') {
          log.warn({ correlationId: ctx.correlationId },
            'the model refused to route this trigger — sending it to a human');
          return [];
        }

        const parsed = response.parsed_output;
        if (!parsed) return [];

        const out: Intent[] = [];
        for (const i of parsed.intents) {
          if (!known.has(i.name)) {
            // Recorded rather than silently dropped: an intent the model keeps
            // reaching for is usually a department the business actually needs.
            log.warn({ correlationId: ctx.correlationId, intent: i.name },
              'model returned an intent that is not registered');
            opts.onUnknownIntent?.(i.name);
            continue;
          }
          ctx.add('cmo', `routed to "${i.name}" (${i.confidence.toFixed(2)})`, {
            because: i.because,
          });
          out.push({ name: i.name, confidence: i.confidence });
        }
        return out;
      } catch (err) {
        // Including a network fault. The CMO's own needsHuman path is a better
        // outcome than a route chosen on the strength of a failed call.
        log.error({ err, correlationId: ctx.correlationId },
          'intent resolution failed — sending this trigger to a human');
        return [];
      }
    },
  };
}

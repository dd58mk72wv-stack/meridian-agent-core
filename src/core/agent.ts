/**
 * An agent: one job, and only one.
 *
 * "No agent should be given more than one job" is the rule the whole
 * organisational structure rests on, and it is the one that decays first —
 * because the second job is always easier to bolt onto an existing agent than
 * to give a new one. A Service Booking Agent that also sends the confirmation
 * is two agents, and the second one is invisible.
 *
 * So `handles` is declared, `run` is the only entry point, and the registry
 * refuses two agents claiming the same intent.
 */

import type { Context } from './context.js';

/** What an agent produces. Never a bare value — the trail matters as much. */
export interface AgentResult {
  /** Did this agent complete its one job? */
  status: 'done' | 'deferred' | 'escalate' | 'failed';
  /** A sentence a human could read in a log without further explanation. */
  summary: string;
  /**
   * Words to say, when this agent is answering a live caller. Absent for
   * agents that act rather than speak.
   */
  say?: string;
  /** Why it escalated or failed. Required for those, meaningless otherwise. */
  reason?: string;
}

export interface AgentDefinition {
  /** Stable identifier. Appears in logs, the registry and the client config. */
  name: string;
  /** The one department this agent reports to. */
  department: string;
  /** One sentence. If it needs "and", it is two agents. */
  does: string;
  /**
   * The intents this agent claims. The registry enforces that no two agents
   * claim the same one — an ambiguous route is a silent coin toss.
   */
  handles: string[];
  /**
   * Whether this agent needs a language model at all.
   *
   * Most do not. "Treat the org chart as a naming and ownership scheme, not as
   * a mandate for N language models" — an agent that reads a row and writes a
   * field does not need to reason its way there, and making it agentic adds
   * cost and latency for nothing.
   */
  reasons: boolean;
  run: (ctx: Context) => Promise<AgentResult>;
}

/**
 * Define an agent, with the one-job rule checked at definition time.
 *
 * Cheap checks, deliberately. They catch the thing that actually happens —
 * someone writing "handles bookings and sends confirmations" in the
 * description and meaning it.
 */
export function defineAgent(def: AgentDefinition): AgentDefinition {
  if (def.handles.length === 0) {
    throw new Error(`agent "${def.name}" handles nothing — it would never be routed to`);
  }

  // " and " in a one-sentence job description is the tell. It is not a
  // guarantee, but it catches the common case at the moment it is introduced
  // rather than a year later.
  if (/\band\b/i.test(def.does) && !/\band then\b/i.test(def.does)) {
    throw new Error(
      `agent "${def.name}" describes its job with "and": "${def.does}". `
      + 'That is usually two agents. If it genuinely is one job, rephrase it '
      + 'without the conjunction.',
    );
  }

  return def;
}

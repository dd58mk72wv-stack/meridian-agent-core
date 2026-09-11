/**
 * A department manager.
 *
 * "Managers do not execute the automations themselves." A manager receives a
 * delegated task, picks the agent that owns it, passes the WHOLE context down,
 * and reports what happened back up.
 *
 * That is the entire job, and the temptation to widen it is constant: a manager
 * that handles "just the simple case" itself has become an agent with no name,
 * no declared intent and no place in the registry — invisible to everything
 * that reasons about the org chart.
 */

import type { Context } from './context.js';
import type { AgentDefinition, AgentResult } from './agent.js';
import { log } from './logger.js';

export interface ManagerDefinition {
  name: string;
  /** One sentence about what this department is responsible for. */
  owns: string;
  agents: AgentDefinition[];
}

export interface ManagerResult extends AgentResult {
  /** Which agent actually did the work. Null when nothing claimed it. */
  agent: string | null;
}

export class Manager {
  readonly name: string;
  readonly owns: string;
  readonly agents: AgentDefinition[];

  readonly #byIntent = new Map<string, AgentDefinition>();

  constructor(def: ManagerDefinition) {
    this.name = def.name;
    this.owns = def.owns;
    this.agents = def.agents;

    for (const agent of def.agents) {
      if (agent.department !== def.name) {
        throw new Error(
          `agent "${agent.name}" says it reports to "${agent.department}" `
          + `but was registered under "${def.name}"`,
        );
      }
      for (const intent of agent.handles) {
        const existing = this.#byIntent.get(intent);
        if (existing) {
          // Two agents claiming one intent is a silent coin toss at runtime,
          // and the loser simply never runs.
          throw new Error(
            `intent "${intent}" is claimed by both "${existing.name}" and "${agent.name}" `
            + `in department "${def.name}"`,
          );
        }
        this.#byIntent.set(intent, agent);
      }
    }
  }

  handles(intent: string): boolean {
    return this.#byIntent.has(intent);
  }

  intents(): string[] {
    return [...this.#byIntent.keys()].sort();
  }

  /**
   * Delegate. The whole context goes down, unmodified.
   */
  async delegate(intent: string, ctx: Context): Promise<ManagerResult> {
    const agent = this.#byIntent.get(intent);

    if (!agent) {
      ctx.add(`manager:${this.name}`, `no agent in this department handles "${intent}"`);
      return {
        agent: null,
        status: 'escalate',
        summary: `${this.name} has no agent for "${intent}"`,
        reason: 'unrouted intent',
      };
    }

    ctx.add(`manager:${this.name}`, `delegating "${intent}" to ${agent.name}`);

    try {
      const result = await agent.run(ctx);

      // Report back up, in full. The manager records what the agent said
      // rather than its own reading of it.
      ctx.add(`agent:${agent.name}`, result.summary, {
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
      });

      return { agent: agent.name, ...result };
    } catch (err) {
      const reason = (err as Error).message;
      ctx.add(`agent:${agent.name}`, `threw: ${reason}`);
      log.error({ err, agent: agent.name, intent }, 'agent threw');

      // A thrown agent escalates rather than failing silently. Somebody is
      // usually on the phone.
      return {
        agent: agent.name,
        status: 'escalate',
        summary: `${agent.name} could not complete: ${reason}`,
        reason,
      };
    }
  }
}

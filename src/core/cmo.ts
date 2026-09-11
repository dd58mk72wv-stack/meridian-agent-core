/**
 * The CMO.
 *
 * Single entry point for every trigger — a call, a text, a scheduled event, a
 * system event. It reads the trigger, works out what is being asked, and
 * dispatches to the right department.
 *
 * **It never touches the underlying work.** The moment the CMO answers
 * something itself "because it was simple", it has become an agent with no
 * name, no department and no place in the registry.
 *
 * What it genuinely owns, and nothing else does:
 *
 *   CROSS-DEPARTMENT ESCALATION. One caller can raise two departments' business
 *   in one sentence — "I want to book the car in for a service, and actually
 *   I've been thinking about trading it in." Each department handles its half
 *   perfectly well and neither knows about the other. The CMO is the only place
 *   both signals are visible at once, so it is the only place that can notice.
 */

import type { Context } from './context.js';
import type { Manager, ManagerResult } from './manager.js';
import { log } from './logger.js';

export interface Intent {
  name: string;
  /** How sure the resolver is. Below the floor, a human decides. */
  confidence: number;
}

/**
 * Turns a trigger into intents.
 *
 * Deliberately an interface. A scheduled job carries its intent in its payload
 * and needs no model at all; a live call needs one. Making this pluggable is
 * what stops every trigger paying for reasoning it does not need.
 */
export interface IntentResolver {
  resolve: (ctx: Context) => Promise<Intent[]>;
}

/**
 * Below this, nothing is dispatched automatically.
 *
 * A wrong route is worse than no route: the caller gets a confident answer to a
 * question they did not ask, and the department that should have heard it never
 * does.
 */
export const CONFIDENCE_FLOOR = 0.6;

export interface DispatchOutcome {
  results: ManagerResult[];
  /** Set when more than one department was involved. */
  crossDepartment: string[] | null;
  /** Set when nothing could be routed with enough confidence. */
  needsHuman: string | null;
}

export class CMO {
  readonly #managers: Manager[];
  readonly #resolver: IntentResolver;

  constructor(input: { managers: Manager[]; resolver: IntentResolver }) {
    this.#managers = input.managers;
    this.#resolver = input.resolver;

    // Two departments claiming one intent is the same silent coin toss the
    // Manager guards against one level down, and it is worth catching at
    // construction rather than on a live call.
    const seen = new Map<string, string>();
    for (const manager of input.managers) {
      for (const intent of manager.intents()) {
        const other = seen.get(intent);
        if (other) {
          throw new Error(
            `intent "${intent}" is claimed by both the ${other} and ${manager.name} departments`,
          );
        }
        seen.set(intent, manager.name);
      }
    }
  }

  /** Every intent the whole organisation can handle. For the registry view. */
  intents(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const manager of this.#managers) {
      for (const intent of manager.intents()) map[intent] = manager.name;
    }
    return map;
  }

  #managerFor(intent: string): Manager | undefined {
    return this.#managers.find((m) => m.handles(intent));
  }

  async dispatch(ctx: Context): Promise<DispatchOutcome> {
    ctx.add('cmo', `received a ${ctx.trigger.kind} trigger`);

    const intents = await this.#resolver.resolve(ctx);

    if (intents.length === 0) {
      ctx.add('cmo', 'nothing recognisable in this trigger');
      return { results: [], crossDepartment: null, needsHuman: 'no intent could be resolved' };
    }

    const confident = intents.filter((i) => i.confidence >= CONFIDENCE_FLOOR);
    const unsure = intents.filter((i) => i.confidence < CONFIDENCE_FLOOR);

    for (const i of unsure) {
      ctx.add('cmo', `not confident enough to route "${i.name}"`, { confidence: i.confidence });
    }

    if (confident.length === 0) {
      return {
        results: [],
        crossDepartment: null,
        needsHuman: `nothing above the confidence floor (best was ${
          Math.max(...intents.map((i) => i.confidence)).toFixed(2)})`,
      };
    }

    // Which departments are involved? Worked out BEFORE dispatching, so that
    // each department knows it is not the whole conversation.
    const departments = [...new Set(
      confident.map((i) => this.#managerFor(i.name)?.name).filter((n): n is string => Boolean(n)),
    )];

    const crossDepartment = departments.length > 1 ? departments : null;

    if (crossDepartment) {
      // The thing only the CMO can see. Recorded in the context so every
      // department that runs below can see it too.
      ctx.add('cmo', `this touches ${departments.join(' and ')} — neither sees the whole of it`, {
        departments,
        intents: confident.map((i) => i.name),
      });
      ctx.learn('cmo', 'cross_department', departments);
    }

    const results: ManagerResult[] = [];

    for (const intent of confident) {
      const manager = this.#managerFor(intent.name);
      if (!manager) {
        ctx.add('cmo', `no department handles "${intent.name}"`);
        results.push({
          agent: null,
          status: 'escalate',
          summary: `no department handles "${intent.name}"`,
          reason: 'unrouted intent',
        });
        continue;
      }

      // The whole context goes down. Every department sees what the previous
      // one did, which is how the second half of a two-part request lands with
      // the first half already known.
      results.push(await manager.delegate(intent.name, ctx));
    }

    const escalations = results.filter((r) => r.status === 'escalate');
    if (escalations.length > 0) {
      log.warn(
        { correlationId: ctx.correlationId, count: escalations.length },
        'dispatch produced escalations',
      );
    }

    return {
      results,
      crossDepartment,
      needsHuman: unsure.length > 0 && confident.length === 0
        ? 'some intents were below the confidence floor'
        : null,
    };
  }
}

/**
 * The resolver for triggers that already know what they are.
 *
 * A scheduled reminder, a webhook, an internal event — the intent is in the
 * payload. Running a model over it would be paying for a decision that has
 * already been made.
 */
export const declaredIntentResolver: IntentResolver = {
  resolve: async (ctx) => {
    const declared = ctx.trigger.payload.intent;
    if (typeof declared === 'string' && declared.length > 0) {
      return [{ name: declared, confidence: 1 }];
    }
    return [];
  },
};

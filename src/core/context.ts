/**
 * The context that travels through the hierarchy.
 *
 * There is one architectural rule in this system that is easy to state and easy
 * to erode: **workers pass full context up, managers pass full context down,
 * and no layer summarises away detail a later step needs.**
 *
 * Documenting that rule is not enough. The erosion never looks like a decision
 * — it looks like a reasonable tidy-up. Someone writes a manager that passes
 * `{ caller, intent }` to its agent instead of the whole thing, because that is
 * all that agent appears to need, and six months later the escalation path has
 * no idea the caller already said they were in a hurry.
 *
 * So context here is APPEND-ONLY. There is no setter, no way to replace the
 * record, and no method that returns a reduced copy. Every layer may add; none
 * may take away. That makes the rule a property of the type rather than a note
 * in a README.
 */

export type TriggerKind = 'call' | 'sms' | 'email' | 'scheduled' | 'system' | 'manual';

export interface Trigger {
  kind: TriggerKind;
  /** The provider's own id, so an event can be traced back out of the system. */
  externalId?: string;
  /** Who it came from, in whatever form the channel gives. */
  from?: string;
  /** What arrived: transcript so far, message body, scheduled job payload. */
  payload: Record<string, unknown>;
  receivedAt: Date;
}

/** One thing that happened, recorded by whichever layer it happened at. */
export interface Note {
  at: Date;
  /** 'cmo' | 'manager:sales' | 'agent:test_drive_booking' */
  by: string;
  note: string;
  data?: Record<string, unknown>;
}

export class Context {
  readonly trigger: Trigger;
  readonly clientId: string;
  readonly correlationId: string;

  /**
   * Everything every layer has learned, in order.
   *
   * Readonly to callers. The only way in is `add`, and there is deliberately no
   * way to remove, replace or truncate — a layer that wants to "clean up" the
   * trail has to change this file to do it, which is the point.
   */
  readonly #notes: Note[] = [];
  readonly #facts = new Map<string, unknown>();

  constructor(input: { trigger: Trigger; clientId: string; correlationId?: string }) {
    this.trigger = input.trigger;
    this.clientId = input.clientId;
    this.correlationId = input.correlationId
      ?? `${input.clientId}-${input.trigger.receivedAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Record what this layer did or learned. */
  add(by: string, note: string, data?: Record<string, unknown>): this {
    this.#notes.push({
      at: new Date(),
      by,
      note,
      ...(data ? { data } : {}),
    });
    return this;
  }

  /**
   * Record a fact for later layers.
   *
   * Facts accumulate. Writing a key that already exists keeps BOTH — the second
   * write lands under a suffixed key and the original stands. A later layer
   * quietly overwriting what an earlier one established is the same information
   * loss the context rule exists to prevent, just spelled differently.
   */
  learn(by: string, key: string, value: unknown): this {
    if (this.#facts.has(key) && this.#facts.get(key) !== value) {
      let n = 2;
      while (this.#facts.has(`${key}#${n}`)) n++;
      this.#facts.set(`${key}#${n}`, value);
      this.add(by, `revised ${key}`, { previous: this.#facts.get(key), now: value });
    } else {
      this.#facts.set(key, value);
    }
    return this;
  }

  fact<T = unknown>(key: string): T | undefined {
    return this.#facts.get(key) as T | undefined;
  }

  /** Every fact, including superseded ones. */
  facts(): Record<string, unknown> {
    return Object.fromEntries(this.#facts);
  }

  /** Every note, oldest first. A copy, so a caller cannot splice the original. */
  notes(): Note[] {
    return [...this.#notes];
  }

  /**
   * The whole record as text, for a model that needs it.
   *
   * This is the one place a "summary" could creep in, so it does not summarise.
   * It renders everything, in order. If a prompt is too long the answer is a
   * cheaper model or a narrower trigger, never a lossy context.
   */
  render(): string {
    const lines = [
      `Trigger: ${this.trigger.kind} at ${this.trigger.receivedAt.toISOString()}`,
      this.trigger.from ? `From: ${this.trigger.from}` : null,
      '',
      'Known:',
      ...Object.entries(this.facts()).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
      '',
      'What has happened so far:',
      ...this.#notes.map((n) => `  [${n.by}] ${n.note}`
        + (n.data ? ` ${JSON.stringify(n.data)}` : '')),
    ];
    return lines.filter((l) => l !== null).join('\n');
  }

  /** For logging and persistence. Lossless. */
  toJSON(): Record<string, unknown> {
    return {
      correlationId: this.correlationId,
      clientId: this.clientId,
      trigger: this.trigger,
      facts: this.facts(),
      notes: this.#notes,
    };
  }
}

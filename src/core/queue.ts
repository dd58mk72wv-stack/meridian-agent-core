/**
 * The job queue.
 *
 * Postgres-backed, claimed with `for update skip locked`. No Redis, no broker:
 * the work here is measured in hundreds of jobs a day, and a second piece of
 * infrastructure to keep alive would cost more than it saves.
 *
 * Two properties matter more than throughput:
 *
 *   `dedupe_key` — a scheduler tick that fires twice must not enqueue the same
 *   work twice. Every spend in this system is real money and every send reaches
 *   a real person.
 *
 *   `skip locked` — two workers must never claim one job. This needs a genuine
 *   session, which is why DATABASE_URL has to be Supabase's session pooler on
 *   port 5432 rather than the transaction pooler.
 */

import { query, transaction } from './db.js';
import { log } from './logger.js';

/**
 * Where a job failure goes.
 *
 * The core has no events table of its own — each consumer has a different one.
 * A consumer that registers nothing still gets the log line, but a job that
 * exhausts its retries with nobody listening is exactly the silent failure this
 * whole system is built to avoid, so `index.ts` warns when it is left unset.
 */
export type FailureReporter = (failure: {
  jobId: string; kind: string; attempts: number; error: string;
}) => Promise<void>;

let reportFailure: FailureReporter | null = null;

export function onJobFailure(reporter: FailureReporter): void {
  reportFailure = reporter;
}

export function hasFailureReporter(): boolean {
  return reportFailure !== null;
}

export interface Job {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export type JobHandler = (job: Job) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerHandler(kind: string, handler: JobHandler): void {
  if (handlers.has(kind)) {
    // Two handlers for one kind means one of them silently never runs. Louder
    // to fail at startup than to debug it later.
    throw new Error(`a handler for "${kind}" is already registered`);
  }
  handlers.set(kind, handler);
}

export function registeredKinds(): string[] {
  return [...handlers.keys()].sort();
}

/** How many times a job is retried before it is left alone for a human. */
const MAX_ATTEMPTS = 4;

/** Exponential, with a ceiling — 1m, 5m, 25m, then capped. */
function backoffSeconds(attempts: number): number {
  return Math.min(60 * 5 ** (attempts - 1), 60 * 60);
}

export interface EnqueueOptions {
  /**
   * Makes the insert idempotent. A repeated enqueue with the same key is a
   * no-op rather than a second job.
   */
  dedupeKey?: string;
  runAt?: Date;
}

export async function enqueue(
  kind: string,
  payload: Record<string, unknown> = {},
  options: EnqueueOptions = {},
): Promise<string | null> {
  const rows = await query<{ id: string }>(
    `insert into jobs (kind, payload, dedupe_key, run_at)
     values ($1, $2::jsonb, $3, coalesce($4, now()))
     on conflict (dedupe_key) do nothing
     returning id`,
    [kind, JSON.stringify(payload), options.dedupeKey ?? null, options.runAt ?? null],
  );
  // null means the dedupe key already existed. That is a success, not a failure
  // — the desired state is "this work is queued", and it is.
  return rows[0]?.id ?? null;
}

/**
 * Claim and run one job. Returns false when there was nothing to do, so the
 * caller can back off rather than spin.
 *
 * The claim happens in its own transaction and commits before the handler runs.
 * Holding the row lock for the duration of a handler that makes several HTTP
 * calls would block the queue behind whichever job is slowest.
 */
export async function runOne(): Promise<boolean> {
  const job = await transaction(async (client) => {
    const { rows } = await client.query<Job & { attempts: number }>(
      `select id, kind, payload, attempts from jobs
        where status = 'pending' and run_at <= now()
        order by run_at
        limit 1
        for update skip locked`,
    );
    const found = rows[0];
    if (!found) return null;

    await client.query(
      `update jobs set status = 'running', started_at = now(), attempts = attempts + 1
        where id = $1`,
      [found.id],
    );
    return { ...found, attempts: found.attempts + 1 };
  });

  if (!job) return false;

  const handler = handlers.get(job.kind);
  if (!handler) {
    // An unregistered kind is a deploy problem, not a transient one. Retrying
    // it four times just delays finding out.
    await query(
      `update jobs set status = 'failed', last_error = $2, finished_at = now() where id = $1`,
      [job.id, `no handler registered for "${job.kind}"`],
    );
    await reportFailure?.({
      jobId: job.id, kind: job.kind, attempts: job.attempts,
      error: `no handler registered for "${job.kind}" (registered: ${registeredKinds().join(', ')})`,
    });
    return true;
  }

  try {
    await handler(job);
    await query(
      `update jobs set status = 'done', finished_at = now() where id = $1`,
      [job.id],
    );
  } catch (err) {
    const message = (err as Error).message ?? String(err);

    if (job.attempts >= MAX_ATTEMPTS) {
      await query(
        `update jobs set status = 'failed', last_error = $2, finished_at = now() where id = $1`,
        [job.id, message],
      );
      await reportFailure?.({
        jobId: job.id, kind: job.kind, attempts: job.attempts, error: message,
      });
    } else {
      const retryIn = backoffSeconds(job.attempts);
      await query(
        `update jobs
            set status = 'pending',
                last_error = $2,
                run_at = now() + make_interval(secs => $3),
                started_at = null
          where id = $1`,
        [job.id, message, retryIn],
      );
      log.warn(
        { jobId: job.id, kind: job.kind, attempt: job.attempts, retryIn },
        'job failed, retrying',
      );
    }
  }

  return true;
}

/**
 * Drain the queue, then return. Called on a tick rather than run as a loop, so
 * that a wedged handler cannot take the process with it.
 */
export async function drain(maxJobs = 50): Promise<number> {
  let done = 0;
  while (done < maxJobs) {
    const ran = await runOne();
    if (!ran) break;
    done += 1;
  }
  return done;
}

export interface QueueDepth {
  pending: number;
  running: number;
  failed: number;
  overdue: number;
}

/** For the health view. `overdue` is the one that means something is wrong. */
export async function depth(): Promise<QueueDepth> {
  const rows = await query<{
    pending: number; running: number; failed: number; overdue: number;
  }>(
    `select
       count(*) filter (where status = 'pending')::int as pending,
       count(*) filter (where status = 'running')::int as running,
       count(*) filter (where status = 'failed')::int  as failed,
       count(*) filter (where status = 'pending'
                          and run_at < now() - interval '15 minutes')::int as overdue
     from jobs`,
  );
  return rows[0] ?? { pending: 0, running: 0, failed: 0, overdue: 0 };
}

/**
 * Postgres access.
 *
 * One pool for the process. The connection string must be Supabase's *session*
 * pooler (port 5432), not the transaction pooler — the job queue relies on
 * `select ... for update skip locked` inside a transaction, and the transaction
 * pooler does not hold a session long enough for that to mean anything.
 */

import pg from 'pg';
import { log } from './logger.js';

const { Pool } = pg;

// Postgres returns numeric/bigint as strings to avoid precision loss. Counts in
// this system are small and are read as numbers everywhere, so parse int8 once
// here rather than remembering to Number() at forty call sites.
pg.types.setTypeParser(20, (v) => Number(v));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — nothing can read or write until it is');
  }

  pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (err) => {
    // An idle client erroring is not fatal — the pool replaces it — but it is
    // worth seeing, because a burst of these means the database is unhappy.
    log.error({ err }, 'idle postgres client errored');
  });

  return pool;
}

export async function query<T = unknown>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}

export async function queryOne<T = unknown>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Run a function inside a transaction, rolling back on any throw. */
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Read a runtime switch. These live in the database rather than the environment
 * so that stopping outbound is one UPDATE and takes effect within a job cycle,
 * without a redeploy.
 */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await queryOne<{ value: T }>(
    'select value from settings where key = $1',
    [key],
  );
  return row?.value ?? fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await query(
    `insert into settings (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Espelho de server/src/Core/Db.php: pool pg + helpers de query/transação.
// A transação é reentrante (como Db::txn no PHP): chamadas aninhadas
// participam da transação exterior em vez de abrir uma nova.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient } from 'pg';
import { config } from '../config/env.js';

function useSsl(): boolean {
  if (config.pgSslMode === 'disable') {
    return false;
  }
  if (config.pgSslMode === 'require' || config.pgSslMode === 'prefer') {
    return true;
  }
  if (config.databaseUrl.includes('sslmode=require') || config.databaseUrl.includes('sslmode=verify')) {
    return true;
  }
  // Bancos gerenciados (Render etc.) exigem SSL; localhost/Docker não têm.
  const host = config.databaseUrl
    ? (() => {
        try {
          return new URL(config.databaseUrl).hostname;
        } catch {
          return '';
        }
      })()
    : config.pgHost;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'postgres' || host === 'db' || host === 'host.docker.internal';
  return !!config.databaseUrl && !local;
}

const poolConfig = config.databaseUrl
  ? {
      connectionString: config.databaseUrl,
      ssl: useSsl() ? { rejectUnauthorized: false } : undefined,
      max: 10,
    }
  : {
      host: config.pgHost,
      port: config.pgPort,
      database: config.pgDatabase,
      user: config.pgUser,
      password: config.pgPassword,
      ssl: useSsl() ? { rejectUnauthorized: false } : undefined,
      max: 10,
    };

export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('[NaMosca db]', err.message);
});

const txStore = new AsyncLocalStorage<{ client: PoolClient }>();

export function currentTxClient(): PoolClient | undefined {
  return txStore.getStore()?.client;
}

/** Executa dentro de uma transação; aninhadas reaproveitam a exterior. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const existing = txStore.getStore();
  if (existing) {
    return fn(existing.client);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await txStore.run({ client }, () => fn(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    client.release();
  }
}

/** Roda fn com um cliente já adquirido (ex.: advisory lock de matchmaking). */
export async function withClientTransaction<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  const existing = txStore.getStore();
  if (existing) {
    return fn();
  }
  await client.query('BEGIN');
  try {
    const result = await txStore.run({ client }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/** Query parametriza — usa o cliente da transação ativa, se houver. */
export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const store = txStore.getStore();
  const executor = store?.client ?? pool;
  const res = await executor.query(text, params as never[] | undefined);
  return res.rows as T[];
}

export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

export function toNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

// Espelho de server/src/Support/RateLimiter.php (janela fixa no banco).
import { query, queryOne } from '../db/pool.js';

/** Janela fixa simples. Devolve true se a chamada é permitida. */
export async function check(bucketRaw: string, max: number, windowSec: number): Promise<boolean> {
  const bucket = [...bucketRaw].slice(0, 140).join('');

  interface Row { hits: number; expired: boolean }
  const row = await queryOne<Row>(
    `SELECT hits, (window_start < NOW() - make_interval(secs => $1)) AS expired
       FROM rate_limits WHERE bucket = $2`,
    [windowSec, bucket],
  );

  if (!row) {
    try {
      await query('INSERT INTO rate_limits (bucket, hits, window_start) VALUES ($1, 1, NOW())', [bucket]);
      return true;
    } catch (err: unknown) {
      // Concorrência: já existe, incrementa e confere.
      if (isUniqueViolation(err)) {
        await query('UPDATE rate_limits SET hits = hits + 1 WHERE bucket = $1', [bucket]);
        const count = await queryOne<{ hits: number }>('SELECT hits FROM rate_limits WHERE bucket = $1', [bucket]);
        return (count?.hits ?? 0) <= max;
      }
      throw err;
    }
  }

  if (row.expired) {
    await query('UPDATE rate_limits SET hits = 1, window_start = NOW() WHERE bucket = $1', [bucket]);
    return true;
  }

  if (row.hits >= max) {
    return false;
  }

  await query('UPDATE rate_limits SET hits = hits + 1 WHERE bucket = $1', [bucket]);
  return true;
}

/** Segundos restantes até a janela atual reabrir. */
export async function waitSecondsLeft(bucket: string, windowSec: number): Promise<number> {
  const row = await queryOne<{ seconds: string | number | null }>(
    `SELECT GREATEST(0, $1 - EXTRACT(EPOCH FROM (NOW() - window_start))) AS seconds
       FROM rate_limits WHERE bucket = $2`,
    [windowSec, bucket],
  );
  return row?.seconds != null ? Math.max(0, Math.floor(Number(row.seconds))) : 0;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

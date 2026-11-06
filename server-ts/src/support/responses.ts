// Espelho de server/src/Core/Response.php: { error } + status amigável.
import type { Context } from 'hono';
import { config } from '../config/env.js';

export function errorJson(c: Context, message: string, status: number, extra: Record<string, unknown> = {}) {
  return c.json({ error: message, ...extra }, status as never);
}

export function unexpected(c: Context, err: unknown) {
  if (config.appDebug) {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Erro inesperado: ${msg}` }, 500);
  }
  console.error('[NaMosca]', err instanceof Error ? err.message : err);
  return c.json({ error: 'Erro inesperado' }, 500);
}

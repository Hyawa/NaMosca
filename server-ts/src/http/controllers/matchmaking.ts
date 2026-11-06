// Espelho de server/src/Http/Controllers/MatchmakingController.php
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { GameException } from '../../domain/game-engine.js';
import { MatchmakingService } from '../../domain/matchmaking.js';
import * as RateLimiter from '../../support/rate-limiter.js';
import { errorJson, unexpected } from '../../support/responses.js';
import { parseBody } from './rooms.js';

function bearerToken(c: Context): string | null {
  const header = c.req.header('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  try {
    const addr = getConnInfo(c).remote?.address;
    return addr && addr !== '' ? addr : '0.0.0.0';
  } catch {
    return '0.0.0.0';
  }
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

// POST /matchmaking/queue — entra na fila
export async function enter(c: Context): Promise<Response> {
  const body = await parseBody(c);
  const bucket = `mm:${clientIp(c)}`;
  try {
    if (!(await RateLimiter.check(bucket, 30, 600))) {
      const wait = await RateLimiter.waitSecondsLeft(bucket, 600);
      return errorJson(c, `Muitas entradas na fila. Tente de novo em ${wait}s.`, 429);
    }
    const service = new MatchmakingService();
    const reply = await service.enqueue(
      asString(body['mode'], 'duel'),
      asString(body['nickname'], ''),
    );
    return c.json(reply);
  } catch (err) {
    if (err instanceof GameException) {
      return errorJson(c, err.message, err.status);
    }
    return unexpected(c, err);
  }
}

// GET /matchmaking/status — polling da fila
export async function status(c: Context): Promise<Response> {
  const token = bearerToken(c);
  if (token === null) {
    return errorJson(c, 'Fila ausente', 401);
  }
  try {
    const service = new MatchmakingService();
    return c.json(await service.status(token));
  } catch (err) {
    if (err instanceof GameException) {
      return errorJson(c, err.message, err.status);
    }
    return unexpected(c, err);
  }
}

// POST /matchmaking/cancel — sai da fila
export async function cancel(c: Context): Promise<Response> {
  const token = bearerToken(c);
  if (token === null) {
    return errorJson(c, 'Fila ausente', 401);
  }
  try {
    const service = new MatchmakingService();
    return c.json(await service.cancel(token));
  } catch (err) {
    if (err instanceof GameException) {
      return errorJson(c, err.message, err.status);
    }
    return unexpected(c, err);
  }
}

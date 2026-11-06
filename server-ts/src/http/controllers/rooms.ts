// Espelho de server/src/Http/Controllers/RoomController.php
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { toNumber, withTransaction } from '../../db/pool.js';
import { GameException, GameEngine } from '../../domain/game-engine.js';
import { AnswerRepository } from '../../repos/answers.js';
import { CardRepository } from '../../repos/cards.js';
import { PlayerRepository } from '../../repos/players.js';
import { RoomRepository } from '../../repos/rooms.js';
import * as RateLimiter from '../../support/rate-limiter.js';
import { errorJson, unexpected } from '../../support/responses.js';

const rooms = new RoomRepository();
const players = new PlayerRepository();
const engine = new GameEngine(rooms, players, new CardRepository(), new AnswerRepository());

function bearerToken(c: Context): string | null {
  const header = c.req.header('Authorization') ?? c.req.header('authorization') ?? '';
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

export async function parseBody(c: Context): Promise<Record<string, unknown>> {
  const method = c.req.method;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return {};
  }
  const raw = await c.req.text();
  if (raw.trim() === '') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sendSession(c: Context, room: { code: string; mode: string }, player: { id: string }, token: string) {
  return c.json({
    code: room.code,
    mode: room.mode,
    playerId: toNumber(player.id),
    token,
  });
}

async function actionsSession(
  c: Context,
  fn: (token: string) => Promise<Record<string, unknown>>,
): Promise<Response> {
  const token = bearerToken(c);
  if (token === null) {
    return errorJson(c, 'Sessão ausente', 401);
  }
  try {
    const result = await fn(token);
    return c.json(result);
  } catch (err) {
    if (err instanceof GameException) {
      return errorJson(c, err.message, err.status);
    }
    return unexpected(c, err);
  }
}

// ------------------------------------------------------------------
// POST /rooms — criar sala
// ------------------------------------------------------------------
export async function create(c: Context): Promise<Response> {
  const body = await parseBody(c);
  const mode = asString(body['mode'], 'duel');
  const name = asString(body['nickname'], '');
  const settings = asObject(body['settings']);

  try {
    const ip = clientIp(c);
    if (!(await RateLimiter.check(`create:${ip}`, 8, 600))) {
      const wait = await RateLimiter.waitSecondsLeft(`create:${ip}`, 600);
      return errorJson(c, `Muitas salas criadas. Tente de novo em ${wait}s.`, 429);
    }
    const result = await engine.createRoom(mode, name, settings);
    return sendSession(c, result.room, result.player, result.token);
  } catch (err) {
    if (err instanceof GameException) {
      return errorJson(c, err.message, err.status);
    }
    return unexpected(c, err);
  }
}

// ------------------------------------------------------------------
// POST /rooms/{code}/join — entrar em sala
// ------------------------------------------------------------------
export async function join(c: Context): Promise<Response> {
  const body = await parseBody(c);
  const name = asString(body['nickname'], '');
  const code = c.req.param('code') ?? '';

  try {
    const ip = clientIp(c);
    if (!(await RateLimiter.check(`join:${ip}`, 30, 600))) {
      return errorJson(c, 'Muitas tentativas de entrada. Aguarde um instante.', 429);
    }
    const result = await engine.joinRoom(code, name);
    return sendSession(c, result.room, result.player, result.token);
  } catch (err) {
    if (err instanceof GameException) {
      return errorJson(c, err.message, err.status);
    }
    return unexpected(c, err);
  }
}

// ------------------------------------------------------------------
// GET /rooms/{code} — estado (polling + ETag)
// ------------------------------------------------------------------
export async function state(c: Context): Promise<Response> {
  const code = c.req.param('code') ?? '';
  try {
    const room = await rooms.findByCode(code);
    if (!room) {
      return errorJson(c, 'Sala não encontrada', 404);
    }
    const roomId = toNumber(room.id);
    const token = bearerToken(c);
    let me = null as Awaited<ReturnType<PlayerRepository['findByToken']>> | null;
    let reconnected = false;
    if (token !== null) {
      const candidate = await players.findByToken(token);
      if (candidate && toNumber(candidate.room_id) === roomId) {
        me = candidate;
        reconnected = !candidate.connected;
        await players.touch(toNumber(candidate.id));
      } else {
        me = null;
      }
    }

    const projected = await withTransaction(async () => {
      const locked = await rooms.lockById(roomId);
      await engine.tick(locked);
      const swept = await players.sweepDisconnected(roomId, 12);
      if (swept > 0 || reconnected) {
        // connected é visível no estado; sem bump o ETag esconderia a mudança.
        await rooms.bumpVersion(roomId);
      }
      const fresh = (await rooms.getById(roomId)) ?? locked;
      const meFresh = me ? (await players.getById(toNumber(me.id))) ?? me : null;
      return engine.projectState(fresh, meFresh);
    });

    const etag = `W/"v${projected['version']}"`;
    const ifNoneMatch = (c.req.header('If-None-Match') ?? '').trim();
    if (ifNoneMatch !== '' && ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return c.json(projected, 200, { ETag: etag });
  } catch (err) {
    if (err instanceof GameException) {
      return errorJson(c, err.message, err.status);
    }
    return unexpected(c, err);
  }
}

// ------------------------------------------------------------------
// Ações
// ------------------------------------------------------------------
export async function ready(c: Context): Promise<Response> {
  return actionsSession(c, async (token) => {
    await engine.ready(token);
    return { ok: true };
  });
}

export async function start(c: Context): Promise<Response> {
  return actionsSession(c, async (token) => {
    await engine.start(token);
    return { ok: true };
  });
}

export async function answer(c: Context): Promise<Response> {
  return actionsSession(c, async (token) => {
    const body = await parseBody(c);
    const guess = asString(body['guess'], '');
    if (guess.trim() === '') {
      throw new GameException(400, 'Resposta vazia');
    }
    return engine.answer(token, guess) as Promise<Record<string, unknown>>; // { correct, points }
  });
}

export async function skipCard(c: Context): Promise<Response> {
  return actionsSession(c, async (token) => {
    await engine.skipCard(token);
    return { ok: true };
  });
}

export async function rematch(c: Context): Promise<Response> {
  return actionsSession(c, async (token) => {
    await engine.rematch(token);
    return { ok: true };
  });
}

export async function leave(c: Context): Promise<Response> {
  return actionsSession(c, async (token) => {
    await engine.leave(token);
    return { ok: true };
  });
}

export async function report(c: Context): Promise<Response> {
  const body = await parseBody(c);
  const reason = asString(body['reason'], 'outro');
  const code = c.req.param('code') ?? '';
  return actionsSession(c, async (token) => {
    void token;
    const room = await rooms.findByCode(code);
    if (!room) {
      throw new GameException(404, 'Sala não encontrada');
    }
    // reportar a carta atual da rodada
    const locked = await withTransaction(async () => {
      const lockedRoom = await rooms.lockById(toNumber(room.id));
      await engine.tick(lockedRoom);
      return lockedRoom;
    });
    const card =
      locked && Number(locked.round_number) >= 1
        ? await engine.roundCard(toNumber(locked.id), Number(locked.round_number))
        : undefined;
    if (card) {
      const reasonTruncated = [...reason].slice(0, 255).join('');
      await new CardRepository().report(toNumber(card.id), toNumber(locked.id), reasonTruncated);
    }
    return { ok: true };
  });
}

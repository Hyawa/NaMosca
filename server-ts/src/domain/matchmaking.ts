// Espelho de server/src/Domain/MatchmakingService.php
// Fila FIFO por modo (sem MMR/ranque): duel 2, teams 4 (2v2),
// royale alvo 8, abre com 3+ após 15s de paciência.
import { pool, query, queryOne, toNumber, withClientTransaction, withTransaction } from '../db/pool.js';
import { AnswerRepository } from '../repos/answers.js';
import { CardRepository } from '../repos/cards.js';
import { PlayerRepository } from '../repos/players.js';
import { RoomRepository } from '../repos/rooms.js';
import type { QueueRow } from '../repos/types.js';
import { normalizeName, shortName } from '../support/str.js';
import { generateToken, hashToken } from '../support/token.js';
import { GameException, GameEngine } from './game-engine.js';

const MODES = ['duel', 'teams', 'royale'];
const TARGET_PLAYERS: Record<string, number> = { duel: 2, teams: 4, royale: 8 };
const MIN_ROYALE = 3;
const ROYALE_PATIENCE_SECONDS = 15;
/** Só entra no pareamento quem deu heartbeat recente. */
const ACTIVE_SECONDS = 20;
/** Vaga sem heartbeat por este tempo é aposentada de vez. */
const STALE_SECONDS = 60;
const ROUNDS: Record<string, number> = { duel: 7, teams: 7, royale: 7 };
const CLUE_SECONDS = 25;

export class MatchmakingService {
  private readonly rooms = new RoomRepository();
  private readonly players = new PlayerRepository();
  private readonly engine: GameEngine;

  constructor(
    private readonly cardsRepo?: CardRepository,
    private readonly answersRepo?: AnswerRepository,
  ) {
    this.engine = new GameEngine(this.rooms, this.players, cardsRepo ?? new CardRepository(), answersRepo ?? new AnswerRepository());
  }

  /** Entra na fila e devolve o token da vaga + estado atual. */
  async enqueue(modeRaw: string, rawName: string): Promise<Record<string, unknown>> {
    const mode = MODES.includes(modeRaw) ? modeRaw : (() => { throw new GameException(400, 'Modo inválido'); })();

    const name = shortName(rawName);
    const nameNorm = normalizeName(name);
    if (nameNorm === '' || [...name].length < 2) {
      throw new GameException(400, 'Apelido muito curto (mínimo 2 caracteres)');
    }

    const token = generateToken();
    await withTransaction(async () => {
      const dup = await queryOne<{ id: string }>(
        `SELECT 1 AS id FROM matchmaking_queue
          WHERE mode = $1 AND name_norm = $2 AND status = 'queued' LIMIT 1`,
        [mode, nameNorm],
      );
      if (dup) {
        throw new GameException(409, 'Esse apelido já está na fila deste modo');
      }

      await query(
        `INSERT INTO matchmaking_queue (mode, name, name_norm, token_hash)
         VALUES ($1, $2, $3, $4)`,
        [mode, name, nameNorm, hashToken(token)],
      );
    });

    await this.pruneStale();
    await this.safeTryMatch(mode);

    return { queueToken: token, ...(await this.status(token)) };
  }

  /** Estado da vaga; também é o "heartbeat" de quem está esperando. */
  async status(token: string): Promise<Record<string, unknown>> {
    let row = await this.findByToken(token);
    if (!row) {
      throw new GameException(404, 'Fila não encontrada');
    }

    if (row.status === 'queued') {
      await this.touch(toNumber(row.id));
      await this.pruneStale();
      await this.safeTryMatch(row.mode);
      row = (await this.findById(toNumber(row.id))) ?? row;
    }

    return this.present(row);
  }

  /** Sai da fila. Se já foi pareada, não faz nada (a partida já existe). */
  async cancel(token: string): Promise<Record<string, unknown>> {
    let row = await this.findByToken(token);
    if (!row) {
      throw new GameException(404, 'Fila não encontrada');
    }

    if (row.status === 'queued') {
      await query(`UPDATE matchmaking_queue SET status = 'cancelled' WHERE id = $1 AND status = 'queued'`, [row.id]);
      row = (await this.findById(toNumber(row.id))) ?? row;
    }

    return { status: row.status, mode: row.mode };
  }

  // ------------------------------------------------------------------
  // Internos
  // ------------------------------------------------------------------

  private async safeTryMatch(mode: string): Promise<void> {
    try {
      await this.tryMatch(mode);
    } catch (err) {
      // Falha ao montar a sala não pode derrubar o polling de quem espera.
      console.error('[NaMosca matchmaking]', err instanceof Error ? err.message : err);
    }
  }

  private async tryMatch(mode: string): Promise<void> {
    const lockName = `namosca:mm:${mode}`;
    // Advisory lock por modo (equivalente ao GET_LOCK do MySQL).
    const client = await pool.connect();
    try {
      const locked = await queryOne<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [
        lockName,
      ]);
      if (!locked?.locked) {
        return;
      }
      try {
        await withClientTransaction(client, async () => {
          await this.pruneStale();
          const rows = await this.queuedRows(mode);
          const startCount = this.startCount(mode, rows);
          if (startCount === 0) {
            return;
          }
          await this.createMatch(mode, rows.slice(0, startCount), startCount);
        });
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
      }
    } finally {
      client.release();
    }
  }

  private async queuedRows(mode: string): Promise<QueueRow[]> {
    const limit = TARGET_PLAYERS[mode] ?? 8;
    return query<QueueRow>(
      `SELECT *, EXTRACT(EPOCH FROM (NOW() - created_at))::int AS waited_seconds
         FROM matchmaking_queue
        WHERE mode = $1 AND status = 'queued'
          AND last_seen_at >= NOW() - make_interval(secs => $2)
        ORDER BY created_at, id
        LIMIT $3`,
      [mode, ACTIVE_SECONDS, limit],
    );
  }

  /** Quantos jogadores da frente da fila entram agora (0 = espera mais). */
  private startCount(mode: string, rows: Array<QueueRow & { waited_seconds?: number | string }>): number {
    const count = rows.length;

    if (mode === 'duel') {
      return count >= 2 ? 2 : 0;
    }
    if (mode === 'teams') {
      return count >= 4 ? 4 : 0;
    }

    // royale
    const target = TARGET_PLAYERS['royale']!;
    if (count >= target) {
      return target;
    }
    if (count >= MIN_ROYALE) {
      const waited = toNumber(rows[0]?.['waited_seconds'] ?? 0);
      if (waited >= ROYALE_PATIENCE_SECONDS) {
        return count;
      }
    }
    return 0;
  }

  /**
   * Cria a sala, insere os jogadores, marca todos como prontos e inicia.
   * Roda dentro de uma única transação: ou a partida nasce inteira, ou
   * ninguém sai da fila.
   */
  private async createMatch(mode: string, rows: QueueRow[], needed: number): Promise<void> {
    await withTransaction(async () => {
      const ids = rows.map((r) => r.id);
      const locked = await query<QueueRow>(
        `SELECT * FROM matchmaking_queue
          WHERE id = ANY($1) AND status = 'queued'
          ORDER BY created_at, id FOR UPDATE`,
        [ids],
      );
      if (locked.length < needed) {
        return; // alguém cancelou entre a seleção e o lock
      }

      const first = locked[0]!;
      const created = await this.engine.createRoom(mode, first.name, {
        rounds: ROUNDS[mode] ?? 7,
        clueSeconds: CLUE_SECONDS,
      });
      const room = created.room;
      const hostToken = created.token;

      const seats: Array<{ queueId: number; playerId: number; token: string }> = [
        { queueId: toNumber(first.id), playerId: toNumber(created.player.id), token: hostToken },
      ];

      for (const row of locked.slice(1)) {
        const joined = await this.engine.joinRoom(room.code, row.name);
        seats.push({
          queueId: toNumber(row.id),
          playerId: toNumber(joined.player.id),
          token: joined.token,
        });
      }

      for (const seat of seats) {
        await this.players.setReady(seat.playerId, true);
      }

      await this.engine.start(hostToken);

      for (const seat of seats) {
        await query(
          `UPDATE matchmaking_queue
             SET status = 'matched', room_id = $1, player_id = $2, player_token = $3
           WHERE id = $4 AND status = 'queued'`,
          [room.id, seat.playerId, seat.token, seat.queueId],
        );
      }
    });
  }

  private async pruneStale(): Promise<void> {
    await query(
      `UPDATE matchmaking_queue
         SET status = 'expired'
       WHERE status = 'queued' AND last_seen_at < NOW() - make_interval(secs => $1)`,
      [STALE_SECONDS],
    );
  }

  private async touch(id: number): Promise<void> {
    await query('UPDATE matchmaking_queue SET last_seen_at = NOW() WHERE id = $1', [id]);
  }

  private async findByToken(token: string): Promise<QueueRow | undefined> {
    return queryOne<QueueRow>('SELECT * FROM matchmaking_queue WHERE token_hash = $1', [hashToken(token)]);
  }

  private async findById(id: number): Promise<QueueRow | undefined> {
    return queryOne<QueueRow>('SELECT * FROM matchmaking_queue WHERE id = $1', [id]);
  }

  private async present(row: QueueRow): Promise<Record<string, unknown>> {
    const created = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
    const state: Record<string, unknown> = {
      status: row.status,
      mode: row.mode,
      name: row.name,
      queuedMs: Math.max(0, Date.now() - created.getTime()),
    };

    if (row.status === 'queued') {
      const position = await queryOne<{ n: string | number }>(
        `SELECT COUNT(*) AS n FROM matchmaking_queue
          WHERE mode = $1 AND status = 'queued' AND id <= $2
            AND last_seen_at >= NOW() - make_interval(secs => $3)`,
        [row.mode, row.id, ACTIVE_SECONDS],
      );
      state['position'] = Math.max(1, toNumber(position?.n ?? 1));

      const queued = await queryOne<{ n: string | number }>(
        `SELECT COUNT(*) AS n FROM matchmaking_queue
          WHERE mode = $1 AND status = 'queued'
            AND last_seen_at >= NOW() - make_interval(secs => $2)`,
        [row.mode, ACTIVE_SECONDS],
      );
      state['queued'] = toNumber(queued?.n ?? 0);
    }

    if (row.status === 'matched') {
      const room = row.room_id !== null ? await this.rooms.getById(toNumber(row.room_id)) : undefined;
      state['code'] = room ? room.code : null;
      state['playerId'] = row.player_id !== null ? toNumber(row.player_id) : null;
      state['token'] = row.player_token !== null ? row.player_token : null;
    }

    return state;
  }
}

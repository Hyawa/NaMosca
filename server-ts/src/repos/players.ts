// Espelho de server/src/Repositories/PlayerRepository.php
import { query, queryOne, toNumber } from '../db/pool.js';
import { hashToken } from '../support/token.js';
import type { PlayerRow } from './types.js';

export class PlayerRepository {
  async findByToken(token: string): Promise<PlayerRow | undefined> {
    const hash = hashToken(token);
    if (hash === '') {
      return undefined;
    }
    return queryOne<PlayerRow>('SELECT * FROM players WHERE token_hash = $1', [hash]);
  }

  async lockByToken(token: string): Promise<PlayerRow | undefined> {
    return queryOne<PlayerRow>('SELECT * FROM players WHERE token_hash = $1 FOR UPDATE', [hashToken(token)]);
  }

  async getById(playerId: number): Promise<PlayerRow | undefined> {
    return queryOne<PlayerRow>('SELECT * FROM players WHERE id = $1', [playerId]);
  }

  async listByRoom(roomId: number, forUpdate = false): Promise<PlayerRow[]> {
    const sql = `SELECT * FROM players WHERE room_id = $1 ORDER BY seat${forUpdate ? ' FOR UPDATE' : ''}`;
    return query<PlayerRow>(sql, [roomId]);
  }

  async teamsById(roomId: number): Promise<Record<string, number>> {
    const rows = await this.listByRoom(roomId);
    const teams: Record<string, number> = {};
    for (const row of rows) {
      if (row.team !== null && row.team !== undefined) {
        const team = Number(row.team);
        teams[String(team)] = (teams[String(team)] ?? 0) + Number(row.score);
      }
    }
    return teams;
  }

  async nextSeat(roomId: number): Promise<number> {
    const row = await queryOne<{ next: string | number }>(
      'SELECT COALESCE(MAX(seat), -1) + 1 AS next FROM players WHERE room_id = $1',
      [roomId],
    );
    return toNumber(row?.next ?? 0);
  }

  async create(data: {
    room_id: number;
    name: string;
    name_norm: string;
    team: number | null;
    seat: number;
    is_host: boolean;
    token_hash: string;
  }): Promise<PlayerRow> {
    const row = await queryOne<PlayerRow>(
      `INSERT INTO players (room_id, name, name_norm, team, seat, is_host, token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [data.room_id, data.name, data.name_norm, data.team, data.seat, data.is_host, data.token_hash],
    );
    if (!row) {
      throw new Error('Falha ao criar jogador');
    }
    return row;
  }

  async touch(playerId: number): Promise<void> {
    await query('UPDATE players SET last_seen_at = NOW(), connected = TRUE WHERE id = $1', [playerId]);
  }

  async setReady(playerId: number, ready: boolean): Promise<void> {
    await query('UPDATE players SET is_ready = $1 WHERE id = $2', [ready, playerId]);
  }

  async count(roomId: number): Promise<number> {
    const row = await queryOne<{ n: string | number }>('SELECT COUNT(*) AS n FROM players WHERE room_id = $1', [roomId]);
    return toNumber(row?.n ?? 0);
  }

  async countInTeam(roomId: number, team: number): Promise<number> {
    const row = await queryOne<{ n: string | number }>(
      'SELECT COUNT(*) AS n FROM players WHERE room_id = $1 AND team = $2',
      [roomId, team],
    );
    return toNumber(row?.n ?? 0);
  }

  async leaderboard(roomId: number, byTeam = false): Promise<Array<Record<string, unknown>>> {
    if (byTeam) {
      return query(
        `SELECT team, SUM(score) AS total
           FROM players WHERE room_id = $1 AND team IS NOT NULL
           GROUP BY team ORDER BY total DESC`,
        [roomId],
      );
    }
    return query(
      'SELECT id, name, seat, team, score, is_host FROM players WHERE room_id = $1 ORDER BY score DESC, seat ASC',
      [roomId],
    );
  }

  async addPointsToTeam(roomId: number, team: number, points: number): Promise<void> {
    await query('UPDATE players SET score = score + $1 WHERE room_id = $2 AND team = $3', [points, roomId, team]);
  }

  async addPointsToPlayer(playerId: number, points: number): Promise<void> {
    await query('UPDATE players SET score = score + $1 WHERE id = $2', [points, playerId]);
  }

  async lockAllByRoom(roomId: number): Promise<PlayerRow[]> {
    return query<PlayerRow>('SELECT * FROM players WHERE room_id = $1 ORDER BY seat FOR UPDATE', [roomId]);
  }

  async setLastAnswerAt(playerId: number, value: Date | null): Promise<void> {
    await query('UPDATE players SET last_answer_at = $1 WHERE id = $2', [value, playerId]);
  }

  async findByName(roomId: number, nameNorm: string): Promise<PlayerRow | undefined> {
    return queryOne<PlayerRow>('SELECT * FROM players WHERE room_id = $1 AND name_norm = $2', [roomId, nameNorm]);
  }

  async delete(playerId: number): Promise<void> {
    await query('DELETE FROM players WHERE id = $1', [playerId]);
  }

  async transferHost(roomId: number): Promise<void> {
    // Remove o host atual e passa para o de menor assento restante.
    const next = await queryOne<{ id: string }>(
      'SELECT id FROM players WHERE room_id = $1 AND is_host = FALSE ORDER BY seat LIMIT 1',
      [roomId],
    );
    if (next) {
      await query('UPDATE players SET is_host = TRUE WHERE id = $1', [next.id]);
    }
  }

  async dropHostFlag(roomId: number): Promise<void> {
    await query('UPDATE players SET is_host = FALSE WHERE room_id = $1 AND is_host = TRUE', [roomId]);
  }

  async sweepDisconnected(roomId: number, seconds: number): Promise<number> {
    const res = await query<{ id: string }>(
      `UPDATE players SET connected = FALSE
        WHERE room_id = $1 AND connected = TRUE
          AND last_seen_at < NOW() - make_interval(secs => $2)
        RETURNING id`,
      [roomId, seconds],
    );
    return res.length;
  }
}

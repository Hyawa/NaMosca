// Espelho de server/src/Repositories/AnswerRepository.php
import { query, queryOne, toNumber } from '../db/pool.js';

export interface ScorerRow {
  id: string;
  name: string;
  seat: number | null;
  team: number | null;
  points: number;
  clue: number;
  created_at: Date | string;
}

export class AnswerRepository {
  async countAtClue(roomId: number, round: number, clue: number, playerId: number): Promise<number> {
    const row = await queryOne<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM answers
        WHERE room_id = $1 AND round_number = $2 AND clue_index = $3 AND player_id = $4`,
      [roomId, round, clue, playerId],
    );
    return toNumber(row?.n ?? 0);
  }

  async scorersOfRound(roomId: number, round: number): Promise<ScorerRow[]> {
    return query<ScorerRow>(
      `SELECT p.id, p.name, p.seat, p.team, a.points AS points, a.clue_index AS clue, a.created_at
         FROM answers a JOIN players p ON p.id = a.player_id
        WHERE a.room_id = $1 AND a.round_number = $2 AND a.is_correct = TRUE
        ORDER BY a.created_at ASC`,
      [roomId, round],
    );
  }

  async lastAnswerAtMs(playerId: number): Promise<number | null> {
    const row = await queryOne<{ ms: string | number | null }>(
      'SELECT CASE WHEN last_answer_at IS NULL THEN NULL ELSE EXTRACT(EPOCH FROM (NOW() - last_answer_at)) * 1000 END AS ms FROM players WHERE id = $1',
      [playerId],
    );
    return row?.ms == null ? null : Math.floor(toNumber(row.ms));
  }

  async record(data: {
    room_id: number;
    round_number: number;
    clue_index: number;
    player_id: number;
    raw_answer: string;
    normalized: string;
    is_correct: boolean;
    points: number;
    latency_ms: number;
  }): Promise<void> {
    await query(
      `INSERT INTO answers (room_id, round_number, clue_index, player_id, raw_answer, normalized, is_correct, points, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        data.room_id,
        data.round_number,
        data.clue_index,
        data.player_id,
        data.raw_answer,
        data.normalized,
        data.is_correct,
        data.points,
        data.latency_ms,
      ],
    );
  }

  async stats(roomId: number): Promise<Record<number, { tries: number; hits: number; points: number }>> {
    const rows = await query<{ player_id: string; tries: string | number | null; hits: string | number | null; points: string | number | null }>(
      `SELECT player_id, COUNT(*) AS tries, SUM(CASE WHEN is_correct THEN 1 ELSE 0 END) AS hits,
              SUM(points) AS points
         FROM answers WHERE room_id = $1
         GROUP BY player_id`,
      [roomId],
    );
    const stats: Record<number, { tries: number; hits: number; points: number }> = {};
    for (const row of rows) {
      stats[toNumber(row.player_id)] = {
        tries: toNumber(row.tries ?? 0),
        hits: toNumber(row.hits ?? 0),
        points: toNumber(row.points ?? 0),
      };
    }
    return stats;
  }
}

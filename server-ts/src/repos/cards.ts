// Espelho de server/src/Repositories/CardRepository.php
import { query, queryOne, toNumber } from '../db/pool.js';
import type { CardRow } from './types.js';

export class CardRepository {
  /**
   * Sorteia cartas priorizando as menos usadas.
   */
  async pick(count: number): Promise<CardRow[]> {
    return query<CardRow>(
      `SELECT id, answer, answer_norm, aliases, clues, category, difficulty
         FROM cards
        WHERE active = TRUE
        ORDER BY (last_used_at IS NULL) DESC, last_used_at ASC, times_used ASC, RANDOM()
        LIMIT $1`,
      [count],
    );
  }

  async get(cardId: number): Promise<CardRow | undefined> {
    return queryOne<CardRow>('SELECT * FROM cards WHERE id = $1', [cardId]);
  }

  async markUsed(cardId: number): Promise<void> {
    await query('UPDATE cards SET times_used = times_used + 1, last_used_at = NOW() WHERE id = $1', [cardId]);
  }

  async markSkippedUnuse(cardId: number): Promise<void> {
    await query('UPDATE cards SET times_used = GREATEST(0, times_used - 1) WHERE id = $1', [cardId]);
  }

  async count(): Promise<number> {
    const row = await queryOne<{ n: string | number }>('SELECT COUNT(*) AS n FROM cards WHERE active = TRUE');
    return toNumber(row?.n ?? 0);
  }

  async report(cardId: number, roomId: number | null, reason: string): Promise<void> {
    await query('INSERT INTO card_reports (card_id, room_id, reason) VALUES ($1, $2, $3)', [cardId, roomId, reason]);
  }
}

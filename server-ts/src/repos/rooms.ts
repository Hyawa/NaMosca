// Espelho de server/src/Repositories/RoomRepository.php
import { randomInt } from 'node:crypto';
import { query, queryOne, toNumber } from '../db/pool.js';
import type { RoomRow } from './types.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem I, O, 1, 0

export class RoomRepository {
  async findByCode(code: string): Promise<RoomRow | undefined> {
    return queryOne<RoomRow>('SELECT * FROM rooms WHERE code = $1', [code.trim().toUpperCase()]);
  }

  /** SELECT ... FOR UPDATE — precisa estar dentro de uma transação. */
  async lockById(roomId: number): Promise<RoomRow> {
    const row = await queryOne<RoomRow>('SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
    if (!row) {
      throw new Error('Sala não encontrada');
    }
    return row;
  }

  async getById(roomId: number): Promise<RoomRow | undefined> {
    return queryOne<RoomRow>('SELECT * FROM rooms WHERE id = $1', [roomId]);
  }

  async generateCode(): Promise<string> {
    const len = 4;
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = '';
      for (let i = 0; i < len; i++) {
        code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
      }
      const existing = await queryOne<{ id: string }>('SELECT id FROM rooms WHERE code = $1', [code]);
      if (!existing) {
        return code;
      }
    }
    throw new Error('Não foi possível gerar código de sala.');
  }

  async create(data: {
    code: string;
    mode: string;
    total_rounds: number;
    settings: Record<string, unknown>;
  }): Promise<RoomRow> {
    const row = await queryOne<RoomRow>(
      `INSERT INTO rooms (code, mode, total_rounds, seed, settings)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [data.code, data.mode, data.total_rounds, randomInt(1, 2147483647), JSON.stringify(data.settings)],
    );
    if (!row) {
      throw new Error('Falha ao criar sala');
    }
    return row;
  }

  /** Atualiza campos e incrementa a versão da sala. */
  async updateFields(roomId: number, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) {
      return;
    }
    for (const key of keys) {
      if (!/^[a-z][a-z0-9_]*$/i.test(key)) {
        throw new Error(`Campo inválido: ${key}`);
      }
    }
    const sets = keys.map((key, i) => `"${key}" = $${i + 1}`);
    sets.push('"version" = "version" + 1');
    const params = keys.map((key) => fields[key]);
    params.push(roomId);
    await query(`UPDATE rooms SET ${sets.join(', ')} WHERE id = $${keys.length + 1}`, params);
  }

  /** Invalida o ETag do polling sem alterar nenhum outro campo. */
  async bumpVersion(roomId: number): Promise<void> {
    await query('UPDATE rooms SET version = version + 1 WHERE id = $1', [roomId]);
  }

  async isPhaseExpired(roomId: number): Promise<boolean> {
    const row = await queryOne<{ expired: boolean | null }>(
      'SELECT phase_ends_at < NOW() AS expired FROM rooms WHERE id = $1',
      [roomId],
    );
    return row?.expired === true;
  }

  /** Milissegundos restantes do timer atual (0 se expirado, null sem timer). */
  async phaseEndsInMs(roomId: number): Promise<number | null> {
    const row = await queryOne<{ ms: string | number | null }>(
      `SELECT CASE
         WHEN phase_ends_at IS NULL THEN NULL
         ELSE GREATEST(0, EXTRACT(EPOCH FROM (phase_ends_at - NOW())) * 1000)
       END AS ms
       FROM rooms WHERE id = $1`,
      [roomId],
    );
    return row?.ms == null ? null : Math.floor(toNumber(row.ms));
  }

  async resetForRematch(roomId: number): Promise<void> {
    // Devolve a contagem de uso das cartas antes de remover o histórico
    // (conta quantas rodadas usaram cada carta, como o JOIN do PHP).
    await query(
      `UPDATE cards
         SET times_used = GREATEST(0, times_used - sub.cnt)
       FROM (SELECT card_id, COUNT(*)::int AS cnt
               FROM room_rounds WHERE room_id = $1 GROUP BY card_id) sub
       WHERE cards.id = sub.card_id`,
      [roomId],
    );

    await query('DELETE FROM answers WHERE room_id = $1', [roomId]);
    await query('DELETE FROM room_rounds WHERE room_id = $1', [roomId]);

    await query(
      `UPDATE rooms
         SET status = 'lobby', round_number = 0, clue_index = 0, phase = 'idle',
             phase_ends_at = NULL, sudden_death = FALSE, card_skips = 0,
             version = version + 1
       WHERE id = $1`,
      [roomId],
    );
  }
}

// Linhas do banco (espelho das tabelas de server/database/migrations/*.sql).
// BIGINT vem de `pg` como string; o código converte com toNumber() ao expor.

export interface RoomRow {
  id: string;
  code: string;
  mode: string;
  status: string;
  round_number: number;
  total_rounds: number;
  clue_index: number;
  phase: string;
  phase_ends_at: Date | string | null;
  version: number;
  card_skips: number;
  sudden_death: boolean;
  seed: number;
  settings: string | Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface PlayerRow {
  id: string;
  room_id: string;
  name: string;
  name_norm: string;
  team: number | null;
  seat: number;
  score: number;
  is_host: boolean;
  is_ready: boolean;
  connected: boolean;
  token_hash: string;
  last_answer_at: Date | string | null;
  last_seen_at: Date | string;
  joined_at: Date | string;
}

export interface CardRow {
  id: string;
  answer: string;
  answer_norm: string;
  aliases: string | string[];
  clues: string | string[];
  category: string;
  difficulty: string;
  source: string;
  model: string | null;
  prompt_version: string | null;
  times_used: number;
  last_used_at: Date | string | null;
  active: boolean;
  created_at: Date | string;
}

export interface RoundRow {
  id: string;
  room_id: string;
  round_number: number;
  card_id: string;
  resolved_at: Date | string | null;
  skipped: boolean;
  created_at: Date | string;
}

export interface QueueRow {
  id: string;
  mode: string;
  name: string;
  name_norm: string;
  token_hash: string;
  status: string;
  room_id: string | null;
  player_id: string | null;
  player_token: string | null;
  created_at: Date | string;
  last_seen_at: Date | string;
}

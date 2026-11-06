-- ============================================================
-- Na Mosca! — fila de matchmaking (normal game, sem ranque)
-- Port de server/database/migrations/002_matchmaking.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS matchmaking_queue (
  id           BIGSERIAL PRIMARY KEY,
  mode         TEXT         NOT NULL
               CHECK (mode IN ('duel', 'teams', 'royale')),
  name         VARCHAR(24)  NOT NULL,
  name_norm    VARCHAR(24)  NOT NULL,
  token_hash   CHAR(64)     NOT NULL,
  status       TEXT         NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'matched', 'cancelled', 'expired')),
  room_id      BIGINT       NULL REFERENCES rooms (id) ON DELETE SET NULL,
  player_id    BIGINT       NULL,
  -- Token do jogador na sala, entregue uma única vez ao cliente dono da vaga.
  -- Fica aqui só até a fila expirar; players guarda apenas o hash.
  player_token VARCHAR(64)  NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mm_token ON matchmaking_queue (token_hash);
CREATE INDEX IF NOT EXISTS idx_mm_pick
  ON matchmaking_queue (mode, status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_mm_seen ON matchmaking_queue (status, last_seen_at);

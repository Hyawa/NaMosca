-- ============================================================
-- Na Mosca! — schema inicial (PostgreSQL 14+)
-- Port do MySQL em server/database/migrations/001_init.sql:
--   ENUM -> TEXT + CHECK, DATETIME -> TIMESTAMPTZ, JSON -> JSONB,
--   BIGINT UNSIGNED AUTO_INCREMENT -> BIGSERIAL,
--   ON UPDATE CURRENT_TIMESTAMP -> trigger set_updated_at().
-- Os nomes de tabelas e colunas são os mesmos do backend PHP.
-- ============================================================

-- ------------------------------------------------------------
-- Registro de migrações
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (version)
);

-- ------------------------------------------------------------
-- updated_at automático (equivalente ao ON UPDATE CURRENT_TIMESTAMP)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- Cartas (resposta + 3 pistas). Fonte: seed curado ou IA.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cards (
  id             BIGSERIAL PRIMARY KEY,
  answer         VARCHAR(120) NOT NULL,
  answer_norm    VARCHAR(120) NOT NULL,
  aliases        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  clues          JSONB        NOT NULL DEFAULT '[]'::jsonb,
  category       VARCHAR(40)  NOT NULL,
  difficulty     TEXT         NOT NULL DEFAULT 'media'
                 CHECK (difficulty IN ('facil', 'media', 'dificil')),
  source         TEXT         NOT NULL DEFAULT 'seed'
                 CHECK (source IN ('seed', 'ai')),
  model          VARCHAR(120) NULL,
  prompt_version VARCHAR(20)  NULL,
  times_used     INTEGER      NOT NULL DEFAULT 0,
  last_used_at   TIMESTAMPTZ  NULL,
  active         BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cards_answer ON cards (answer_norm);
CREATE INDEX IF NOT EXISTS idx_cards_pick
  ON cards (active, difficulty, times_used, last_used_at);

-- ------------------------------------------------------------
-- Salas. O servidor é a autoridade: fase + timer norm aqui.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rooms (
  id            BIGSERIAL PRIMARY KEY,
  code          VARCHAR(6)   NOT NULL,
  mode          TEXT         NOT NULL
                CHECK (mode IN ('duel', 'teams', 'royale')),
  status        TEXT         NOT NULL DEFAULT 'lobby'
                CHECK (status IN ('lobby', 'playing', 'finished', 'closed')),
  round_number  INTEGER      NOT NULL DEFAULT 0,
  total_rounds  INTEGER      NOT NULL DEFAULT 7,
  clue_index    INTEGER      NOT NULL DEFAULT 0,
  phase         TEXT         NOT NULL DEFAULT 'idle'
                CHECK (phase IN ('idle', 'clue', 'reveal', 'result')),
  phase_ends_at TIMESTAMPTZ  NULL,
  version       INTEGER      NOT NULL DEFAULT 1,
  card_skips    INTEGER      NOT NULL DEFAULT 0,
  sudden_death  BOOLEAN      NOT NULL DEFAULT FALSE,
  seed          INTEGER      NOT NULL,
  settings      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rooms_code ON rooms (code);
CREATE INDEX IF NOT EXISTS idx_rooms_updated ON rooms (status, updated_at);

DROP TRIGGER IF EXISTS trg_rooms_updated_at ON rooms;
CREATE TRIGGER trg_rooms_updated_at
  BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- Jogadores da sala. Token hasheado vira credencial única.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS players (
  id           BIGSERIAL PRIMARY KEY,
  room_id      BIGINT      NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  name         VARCHAR(24) NOT NULL,
  name_norm    VARCHAR(24) NOT NULL,
  team         SMALLINT    NULL,
  seat         INTEGER     NOT NULL,
  score        INTEGER     NOT NULL DEFAULT 0,
  is_host      BOOLEAN     NOT NULL DEFAULT FALSE,
  is_ready     BOOLEAN     NOT NULL DEFAULT FALSE,
  connected    BOOLEAN     NOT NULL DEFAULT TRUE,
  token_hash   CHAR(64)    NOT NULL,
  last_answer_at TIMESTAMPTZ NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_players_token ON players (token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_players_seat ON players (room_id, seat);
CREATE UNIQUE INDEX IF NOT EXISTS uq_players_name ON players (room_id, name_norm);
CREATE INDEX IF NOT EXISTS idx_players_room ON players (room_id, seat);

-- ------------------------------------------------------------
-- Uma linha por rodada: qual carta jogou e quando resolveu.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_rounds (
  id           BIGSERIAL PRIMARY KEY,
  room_id      BIGINT      NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  round_number INTEGER     NOT NULL,
  card_id      BIGINT      NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  resolved_at  TIMESTAMPTZ NULL,
  skipped      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_room_round ON room_rounds (room_id, round_number);
CREATE INDEX IF NOT EXISTS idx_rounds_card ON room_rounds (card_id);

-- ------------------------------------------------------------
-- Tentativas de resposta (histórico completo da partida).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS answers (
  id           BIGSERIAL PRIMARY KEY,
  room_id      BIGINT      NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  round_number INTEGER     NOT NULL,
  clue_index   INTEGER     NOT NULL,
  player_id    BIGINT      NOT NULL,
  raw_answer   VARCHAR(120) NOT NULL,
  normalized   VARCHAR(120) NOT NULL,
  is_correct   BOOLEAN     NOT NULL,
  points       INTEGER     NOT NULL DEFAULT 0,
  latency_ms   INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_answers_room ON answers (room_id, round_number);
CREATE INDEX IF NOT EXISTS idx_answers_player ON answers (player_id);

-- ------------------------------------------------------------
-- Rate limit simples por janela.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       VARCHAR(140) PRIMARY KEY,
  hits         INTEGER     NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL
);

-- ------------------------------------------------------------
-- Cartas reportadas (para o painel de moderação futura).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_reports (
  id         BIGSERIAL PRIMARY KEY,
  card_id    BIGINT      NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  room_id    BIGINT      NULL,
  reason     VARCHAR(255) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reports_card ON card_reports (card_id);

-- ------------------------------------------------------------
-- Saúde de cada modelo (benchmark/fallback — fase de IA).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_model_health (
  model_key       VARCHAR(160) PRIMARY KEY,
  provider        VARCHAR(20)  NOT NULL,
  successes       INTEGER      NOT NULL DEFAULT 0,
  failures        INTEGER      NOT NULL DEFAULT 0,
  last_latency_ms INTEGER      NULL,
  cooldown_until  TIMESTAMPTZ  NULL,
  last_error      VARCHAR(255) NULL,
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_ai_model_health_updated_at ON ai_model_health;
CREATE TRIGGER trg_ai_model_health_updated_at
  BEFORE UPDATE ON ai_model_health
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS ai_usage (
  id                BIGSERIAL PRIMARY KEY,
  model_key         VARCHAR(160) NOT NULL,
  purpose           VARCHAR(40)  NOT NULL,
  latency_ms        INTEGER      NOT NULL DEFAULT 0,
  ok                BOOLEAN      NOT NULL DEFAULT FALSE,
  error             VARCHAR(255) NULL,
  prompt_tokens     INTEGER      NULL,
  completion_tokens INTEGER      NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON ai_usage (created_at);

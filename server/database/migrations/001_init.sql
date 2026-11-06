-- ============================================================
-- Na Mosca! — schema inicial (MySQL 8.0)
-- Charset: utf8mb4 / utf8mb4_0900_ai_ci
-- ============================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------
-- Registro de migrações
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(64) NOT NULL,
  applied_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- Cartas (resposta + 3 pistas). Fonte: seed curado ou IA.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cards (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  answer         VARCHAR(120)    NOT NULL,
  answer_norm    VARCHAR(120)    NOT NULL,
  aliases        JSON            NOT NULL,
  clues          JSON            NOT NULL,
  category       VARCHAR(40)     NOT NULL,
  difficulty     ENUM('facil','media','dificil') NOT NULL DEFAULT 'media',
  source         ENUM('seed','ai') NOT NULL DEFAULT 'seed',
  model          VARCHAR(120)    NULL,
  prompt_version VARCHAR(20)     NULL,
  times_used     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_used_at   DATETIME        NULL,
  active         TINYINT(1)      NOT NULL DEFAULT 1,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cards_answer (answer_norm),
  KEY idx_cards_pick (active, difficulty, times_used, last_used_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- Salas. O servidor é a autoridade: fase + timer norm aqui.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rooms (
  id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  code          CHAR(6)          NOT NULL,
  mode          ENUM('duel','teams','royale') NOT NULL,
  status        ENUM('lobby','playing','finished','closed') NOT NULL DEFAULT 'lobby',
  round_number  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  total_rounds  TINYINT UNSIGNED NOT NULL DEFAULT 7,
  clue_index    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  phase         ENUM('idle','clue','reveal','result') NOT NULL DEFAULT 'idle',
  phase_ends_at DATETIME(3)      NULL,
  version       INT UNSIGNED     NOT NULL DEFAULT 1,
  card_skips    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  sudden_death  TINYINT(1)       NOT NULL DEFAULT 0,
  seed          INT UNSIGNED     NOT NULL,
  settings      JSON             NOT NULL,
  created_at    DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rooms_code (code),
  KEY idx_rooms_updated (status, updated_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- Jogadores da sala. Token hasheado vira credencial única.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS players (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  room_id      BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(24)     NOT NULL,
  name_norm    VARCHAR(24)     NOT NULL,
  team         TINYINT UNSIGNED NULL,
  seat         TINYINT UNSIGNED NOT NULL,
  score        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  is_host      TINYINT(1)      NOT NULL DEFAULT 0,
  is_ready     TINYINT(1)      NOT NULL DEFAULT 0,
  connected    TINYINT(1)      NOT NULL DEFAULT 1,
  token_hash   CHAR(64)        NOT NULL,
  last_answer_at DATETIME(3)   NULL,
  last_seen_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  joined_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_players_token (token_hash),
  UNIQUE KEY uq_players_seat (room_id, seat),
  UNIQUE KEY uq_players_name (room_id, name_norm),
  KEY idx_players_room (room_id, seat),
  CONSTRAINT fk_players_room FOREIGN KEY (room_id)
    REFERENCES rooms (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- Uma linha por rodada: qual carta jogou e quando resolveu.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_rounds (
  id          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  room_id     BIGINT UNSIGNED  NOT NULL,
  round_number TINYINT UNSIGNED NOT NULL,
  card_id     BIGINT UNSIGNED  NOT NULL,
  resolved_at DATETIME         NULL,
  skipped     TINYINT(1)       NOT NULL DEFAULT 0,
  created_at  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_room_round (room_id, round_number),
  KEY idx_rounds_card (card_id),
  CONSTRAINT fk_rounds_room FOREIGN KEY (room_id)
    REFERENCES rooms (id) ON DELETE CASCADE,
  CONSTRAINT fk_rounds_card FOREIGN KEY (card_id)
    REFERENCES cards (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- Tentativas de resposta (histórico completo da partida).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS answers (
  id          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  room_id     BIGINT UNSIGNED  NOT NULL,
  round_number TINYINT UNSIGNED NOT NULL,
  clue_index  TINYINT UNSIGNED NOT NULL,
  player_id   BIGINT UNSIGNED  NOT NULL,
  raw_answer  VARCHAR(120)     NOT NULL,
  normalized  VARCHAR(120)     NOT NULL,
  is_correct  TINYINT(1)       NOT NULL,
  points      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  latency_ms  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at  DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_answers_room (room_id, round_number),
  KEY idx_answers_player (player_id),
  CONSTRAINT fk_answers_room FOREIGN KEY (room_id)
    REFERENCES rooms (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- Rate limit simples por janela.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       VARCHAR(140)      NOT NULL,
  hits         INT UNSIGNED      NOT NULL DEFAULT 0,
  window_start DATETIME          NOT NULL,
  PRIMARY KEY (bucket)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- Cartas reportadas (para o painel de moderação futura).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_reports (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  card_id    BIGINT UNSIGNED NOT NULL,
  room_id    BIGINT UNSIGNED NULL,
  reason     VARCHAR(255)    NOT NULL DEFAULT '',
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_reports_card (card_id),
  CONSTRAINT fk_reports_card FOREIGN KEY (card_id)
    REFERENCES cards (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- ------------------------------------------------------------
-- Saúde de cada modelo (benchmark/fallback — fase de IA).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_model_health (
  model_key       VARCHAR(160) NOT NULL,
  provider        VARCHAR(20)  NOT NULL,
  successes       INT UNSIGNED NOT NULL DEFAULT 0,
  failures        INT UNSIGNED NOT NULL DEFAULT 0,
  last_latency_ms INT UNSIGNED NULL,
  cooldown_until  DATETIME     NULL,
  last_error      VARCHAR(255) NULL,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                               ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (model_key)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS ai_usage (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  model_key         VARCHAR(160) NOT NULL,
  purpose           VARCHAR(40)  NOT NULL,
  latency_ms        INT UNSIGNED NOT NULL DEFAULT 0,
  ok                TINYINT(1)   NOT NULL DEFAULT 0,
  error             VARCHAR(255) NULL,
  prompt_tokens     INT UNSIGNED NULL,
  completion_tokens INT UNSIGNED NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_usage_created (created_at)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

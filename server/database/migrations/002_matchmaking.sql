-- ============================================================
-- Na Mosca! — fila de matchmaking (normal game, sem ranque)
-- ============================================================

CREATE TABLE IF NOT EXISTS matchmaking_queue (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mode          ENUM('duel','teams','royale') NOT NULL,
  name          VARCHAR(24)     NOT NULL,
  name_norm     VARCHAR(24)     NOT NULL,
  token_hash    CHAR(64)        NOT NULL,
  status        ENUM('queued','matched','cancelled','expired') NOT NULL DEFAULT 'queued',
  room_id       BIGINT UNSIGNED NULL,
  player_id     BIGINT UNSIGNED NULL,
  -- Token do jogador na sala, entregue uma única vez ao cliente dono da vaga.
  -- Fica aqui só até a fila expirar; players guarda apenas o hash.
  player_token  VARCHAR(64)     NULL,
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_mm_token (token_hash),
  KEY idx_mm_pick (mode, status, created_at, id),
  KEY idx_mm_seen (status, last_seen_at),
  CONSTRAINT fk_mm_room FOREIGN KEY (room_id)
    REFERENCES rooms (id) ON DELETE SET NULL
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

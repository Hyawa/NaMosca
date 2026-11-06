<?php

declare(strict_types=1);

namespace NaMosca\Domain;

use NaMosca\Core\Db;
use NaMosca\Repositories\AnswerRepository;
use NaMosca\Repositories\CardRepository;
use NaMosca\Repositories\PlayerRepository;
use NaMosca\Repositories\RoomRepository;
use NaMosca\Support\Str;
use NaMosca\Support\Token;

/**
 * Matchmaking normal (sem MMR/ranque): fila FIFO por modo.
 *
 * - duel: 2 jogadores
 * - teams: 4 jogadores (2v2)
 * - royale: alvo de 8; para não morrer esperando, abre com 3+ depois de
 *   ROYALE_PATIENCE_SECONDS segundos.
 *
 * Quando a fila fecha, a sala é criada, todos entram já prontos e a partida
 * começa sozinha. O lobby/ready/start continua sendo o caminho da sala privada.
 */
final class MatchmakingService
{
    private const MODES = ['duel', 'teams', 'royale'];
    private const TARGET_PLAYERS = ['duel' => 2, 'teams' => 4, 'royale' => 8];
    private const MIN_ROYALE = 3;
    private const ROYALE_PATIENCE_SECONDS = 15;
    /** Só entra no pareamento quem deu heartbeat recente. */
    private const ACTIVE_SECONDS = 20;
    /** Vaga sem heartbeat por este tempo é aposentada de vez. */
    private const STALE_SECONDS = 60;
    private const ROUNDS = ['duel' => 7, 'teams' => 7, 'royale' => 7];
    private const CLUE_SECONDS = 25;

    private RoomRepository $rooms;
    private PlayerRepository $players;
    private GameEngine $engine;

    public function __construct()
    {
        $this->rooms = new RoomRepository();
        $this->players = new PlayerRepository();
        $this->engine = new GameEngine(
            $this->rooms,
            $this->players,
            new CardRepository(),
            new AnswerRepository(),
        );
    }

    /** Entra na fila e devolve o token da vaga + estado atual. */
    public function enqueue(string $mode, string $rawName): array
    {
        $mode = in_array($mode, self::MODES, true)
            ? $mode
            : throw new GameException(400, 'Modo inválido');

        $name = Str::shortName($rawName);
        $nameNorm = Str::normalizeName($name);
        if ($nameNorm === '' || mb_strlen($name) < 2) {
            throw new GameException(400, 'Apelido muito curto (mínimo 2 caracteres)');
        }

        $token = Token::generate();
        Db::txn(function () use ($mode, $name, $nameNorm, $token): void {
            $stmt = Db::pdo()->prepare(
                "SELECT 1 FROM matchmaking_queue
                 WHERE mode = ? AND name_norm = ? AND status = 'queued' LIMIT 1"
            );
            $stmt->execute([$mode, $nameNorm]);
            if ($stmt->fetchColumn() !== false) {
                throw new GameException(409, 'Esse apelido já está na fila deste modo');
            }

            Db::pdo()->prepare(
                'INSERT INTO matchmaking_queue (mode, name, name_norm, token_hash)
                 VALUES (?, ?, ?, ?)'
            )->execute([$mode, $name, $nameNorm, Token::hash($token)]);
        });

        $this->pruneStale();
        $this->safeTryMatch($mode);

        return ['queueToken' => $token] + $this->status($token);
    }

    /** Estado da vaga; também é o "heartbeat" de quem está esperando. */
    public function status(string $token): array
    {
        $row = $this->findByToken($token);
        if ($row === null) {
            throw new GameException(404, 'Fila não encontrada');
        }

        if ((string) $row['status'] === 'queued') {
            $this->touch((int) $row['id']);
            $this->pruneStale();
            $this->safeTryMatch((string) $row['mode']);
            $row = $this->findById((int) $row['id']) ?? $row;
        }

        return $this->present($row);
    }

    /** Sai da fila. Se já foi pareada, não faz nada (a partida já existe). */
    public function cancel(string $token): array
    {
        $row = $this->findByToken($token);
        if ($row === null) {
            throw new GameException(404, 'Fila não encontrada');
        }

        if ((string) $row['status'] === 'queued') {
            Db::pdo()->prepare(
                "UPDATE matchmaking_queue SET status = 'cancelled' WHERE id = ? AND status = 'queued'"
            )->execute([(int) $row['id']]);
            $row = $this->findById((int) $row['id']) ?? $row;
        }

        return ['status' => (string) $row['status'], 'mode' => (string) $row['mode']];
    }

    // ------------------------------------------------------------------
    // Internos
    // ------------------------------------------------------------------

    private function safeTryMatch(string $mode): void
    {
        try {
            $this->tryMatch($mode);
        } catch (\Throwable $e) {
            // Falha ao montar a sala não pode derrubar o polling de quem espera.
            error_log('[NaMosca matchmaking] ' . $e->getMessage());
        }
    }

    private function tryMatch(string $mode): void
    {
        $pdo = Db::pdo();
        $lockName = 'namosca:mm:' . $mode;
        $lock = $pdo->prepare('SELECT GET_LOCK(?, 3)');
        $lock->execute([$lockName]);
        if ((int) $lock->fetchColumn() !== 1) {
            return;
        }

        try {
            $this->pruneStale();
            $rows = $this->queuedRows($mode);
            $startCount = $this->startCount($mode, $rows);
            if ($startCount === 0) {
                return;
            }
            $this->createMatch($mode, array_slice($rows, 0, $startCount), $startCount);
        } finally {
            $pdo->prepare('SELECT RELEASE_LOCK(?)')->execute([$lockName]);
        }
    }

    /** @return array<int,array<string,mixed>> */
    private function queuedRows(string $mode): array
    {
        $limit = self::TARGET_PLAYERS[$mode];
        $stmt = Db::pdo()->prepare(
            "SELECT *, TIMESTAMPDIFF(SECOND, created_at, NOW(3)) AS waited_seconds
             FROM matchmaking_queue
             WHERE mode = ? AND status = 'queued'
               AND last_seen_at >= DATE_SUB(NOW(3), INTERVAL ? SECOND)
             ORDER BY created_at, id
             LIMIT {$limit}"
        );
        $stmt->execute([$mode, self::ACTIVE_SECONDS]);
        return $stmt->fetchAll();
    }

    /** Quantos jogadores da frente da fila entram agora (0 = espera mais). */
    private function startCount(string $mode, array $rows): int
    {
        $count = count($rows);

        if ($mode === 'duel') {
            return $count >= 2 ? 2 : 0;
        }
        if ($mode === 'teams') {
            return $count >= 4 ? 4 : 0;
        }

        // royale
        $target = self::TARGET_PLAYERS['royale'];
        if ($count >= $target) {
            return $target;
        }
        if ($count >= self::MIN_ROYALE) {
            $waited = (int) ($rows[0]['waited_seconds'] ?? 0);
            if ($waited >= self::ROYALE_PATIENCE_SECONDS) {
                return $count;
            }
        }
        return 0;
    }

    /**
     * Cria a sala, insere os jogadores, marca todos como prontos e inicia.
     * Roda dentro de uma única transação: ou a partida nasce inteira, ou
     * ninguém sai da fila.
     *
     * @param array<int,array<string,mixed>> $rows
     */
    private function createMatch(string $mode, array $rows, int $needed): void
    {
        Db::txn(function () use ($mode, $rows, $needed): void {
            $ids = array_map(static fn (array $r): int => (int) $r['id'], $rows);
            $in = implode(',', array_fill(0, count($ids), '?'));
            $stmt = Db::pdo()->prepare(
                "SELECT * FROM matchmaking_queue
                 WHERE id IN ({$in}) AND status = 'queued'
                 ORDER BY created_at, id FOR UPDATE"
            );
            $stmt->execute($ids);
            $locked = $stmt->fetchAll();
            if (count($locked) < $needed) {
                return; // alguém cancelou entre a seleção e o lock
            }

            $first = array_shift($locked);
            $created = $this->engine->createRoom($mode, (string) $first['name'], [
                'rounds' => self::ROUNDS[$mode] ?? 7,
                'clueSeconds' => self::CLUE_SECONDS,
            ]);
            $room = $created['room'];
            $hostToken = (string) $created['token'];

            /** @var array<int,array{queueId:int,player:array,token:string}> $seats */
            $seats = [[
                'queueId' => (int) $first['id'],
                'player' => $created['player'],
                'token' => (string) $created['token'],
            ]];

            foreach ($locked as $row) {
                $joined = $this->engine->joinRoom((string) $room['code'], (string) $row['name']);
                $seats[] = [
                    'queueId' => (int) $row['id'],
                    'player' => $joined['player'],
                    'token' => (string) $joined['token'],
                ];
            }

            foreach ($seats as $seat) {
                $this->players->setReady((int) $seat['player']['id'], true);
            }

            $this->engine->start($hostToken);

            $update = Db::pdo()->prepare(
                "UPDATE matchmaking_queue
                 SET status = 'matched', room_id = ?, player_id = ?, player_token = ?
                 WHERE id = ? AND status = 'queued'"
            );
            foreach ($seats as $seat) {
                $update->execute([
                    (int) $room['id'],
                    (int) $seat['player']['id'],
                    $seat['token'],
                    $seat['queueId'],
                ]);
            }
        });
    }

    private function pruneStale(): void
    {
        Db::pdo()->prepare(
            "UPDATE matchmaking_queue
             SET status = 'expired'
             WHERE status = 'queued' AND last_seen_at < DATE_SUB(NOW(3), INTERVAL ? SECOND)"
        )->execute([self::STALE_SECONDS]);
    }

    private function touch(int $id): void
    {
        Db::pdo()->prepare('UPDATE matchmaking_queue SET last_seen_at = NOW(3) WHERE id = ?')
            ->execute([$id]);
    }

    private function findByToken(string $token): ?array
    {
        $stmt = Db::pdo()->prepare('SELECT * FROM matchmaking_queue WHERE token_hash = ?');
        $stmt->execute([Token::hash($token)]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    private function findById(int $id): ?array
    {
        $stmt = Db::pdo()->prepare('SELECT * FROM matchmaking_queue WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    private function present(array $row): array
    {
        $created = new \DateTimeImmutable(
            (string) $row['created_at'],
            new \DateTimeZone('UTC')
        );
        $state = [
            'status' => (string) $row['status'],
            'mode' => (string) $row['mode'],
            'name' => (string) $row['name'],
            'queuedMs' => max(
                0,
                (int) round((microtime(true) - (float) $created->format('U.u')) * 1000)
            ),
        ];

        if ((string) $row['status'] === 'queued') {
            $stmt = Db::pdo()->prepare(
                "SELECT COUNT(*) FROM matchmaking_queue
                 WHERE mode = ? AND status = 'queued' AND id <= ?
                   AND last_seen_at >= DATE_SUB(NOW(3), INTERVAL ? SECOND)"
            );
            $stmt->execute([(string) $row['mode'], (int) $row['id'], self::ACTIVE_SECONDS]);
            $state['position'] = max(1, (int) $stmt->fetchColumn());

            $stmt = Db::pdo()->prepare(
                "SELECT COUNT(*) FROM matchmaking_queue
                 WHERE mode = ? AND status = 'queued'
                   AND last_seen_at >= DATE_SUB(NOW(3), INTERVAL ? SECOND)"
            );
            $stmt->execute([(string) $row['mode'], self::ACTIVE_SECONDS]);
            $state['queued'] = (int) $stmt->fetchColumn();
        }

        if ((string) $row['status'] === 'matched') {
            $room = $row['room_id'] !== null ? $this->rooms->getById((int) $row['room_id']) : null;
            $state['code'] = $room !== null ? (string) $room['code'] : null;
            $state['playerId'] = $row['player_id'] !== null ? (int) $row['player_id'] : null;
            $state['token'] = $row['player_token'] !== null ? (string) $row['player_token'] : null;
        }

        return $state;
    }
}

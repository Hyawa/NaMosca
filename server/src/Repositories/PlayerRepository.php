<?php

declare(strict_types=1);

namespace NaMosca\Repositories;

use NaMosca\Core\Db;
use NaMosca\Support\Token;

final class PlayerRepository
{
    public function findByToken(string $token): ?array
    {
        $hash = Token::hash($token);
        if ($hash === '') {
            return null;
        }
        $stmt = Db::pdo()->prepare('SELECT * FROM players WHERE token_hash = ?');
        $stmt->execute([$hash]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    public function lockByToken(string $token): ?array
    {
        $stmt = Db::pdo()->prepare('SELECT * FROM players WHERE token_hash = ? FOR UPDATE');
        $stmt->execute([Token::hash($token)]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    public function listByRoom(int $roomId, bool $forUpdate = false): array
    {
        $sql = 'SELECT * FROM players WHERE room_id = ? ORDER BY seat';
        if ($forUpdate) {
            $sql .= ' FOR UPDATE';
        }
        $stmt = Db::pdo()->prepare($sql);
        $stmt->execute([$roomId]);
        return $stmt->fetchAll();
    }

    public function teamsById(int $roomId): array
    {
        $rows = $this->listByRoom($roomId);
        $teams = [];
        foreach ($rows as $row) {
            if ($row['team'] !== null) {
                $team = (int) $row['team'];
                $teams[$team] = ($teams[$team] ?? 0) + (int) $row['score'];
            }
        }
        ksort($teams);
        return $teams;
    }

    public function nextSeat(int $roomId): int
    {
        $stmt = Db::pdo()->prepare('SELECT COALESCE(MAX(seat), -1) + 1 FROM players WHERE room_id = ?');
        $stmt->execute([$roomId]);
        return (int) $stmt->fetchColumn();
    }

    public function create(array $data): array
    {
        $stmt = Db::pdo()->prepare(
            'INSERT INTO players (room_id, name, name_norm, team, seat, is_host, token_hash)
             VALUES (:room_id, :name, :name_norm, :team, :seat, :is_host, :token_hash)'
        );
        $stmt->execute([
            ':room_id' => $data['room_id'],
            ':name' => $data['name'],
            ':name_norm' => $data['name_norm'],
            ':team' => $data['team'],
            ':seat' => $data['seat'],
            ':is_host' => $data['is_host'] ? 1 : 0,
            ':token_hash' => $data['token_hash'],
        ]);
        $stmt = Db::pdo()->prepare('SELECT * FROM players WHERE id = ?');
        $stmt->execute([(int) Db::pdo()->lastInsertId()]);
        return $stmt->fetch();
    }

    public function touch(int $playerId): void
    {
        $stmt = Db::pdo()->prepare(
            'UPDATE players SET last_seen_at = NOW(), connected = 1 WHERE id = ?'
        );
        $stmt->execute([$playerId]);
    }

    public function setReady(int $playerId, bool $ready): void
    {
        Db::pdo()->prepare('UPDATE players SET is_ready = ? WHERE id = ?')
            ->execute([$ready ? 1 : 0, $playerId]);
    }

    public function count(int $roomId): int
    {
        $stmt = Db::pdo()->prepare('SELECT COUNT(*) FROM players WHERE room_id = ?');
        $stmt->execute([$roomId]);
        return (int) $stmt->fetchColumn();
    }

    public function countInTeam(int $roomId, int $team): int
    {
        $stmt = Db::pdo()->prepare('SELECT COUNT(*) FROM players WHERE room_id = ? AND team = ?');
        $stmt->execute([$roomId, $team]);
        return (int) $stmt->fetchColumn();
    }

    public function leaderboard(int $roomId, bool $byTeam = false): array
    {
        if ($byTeam) {
            $stmt = Db::pdo()->prepare(
                'SELECT team, SUM(score) AS total
                 FROM players WHERE room_id = ? AND team IS NOT NULL
                 GROUP BY team ORDER BY total DESC'
            );
            $stmt->execute([$roomId]);
            return $stmt->fetchAll();
        }
        $stmt = Db::pdo()->prepare(
            'SELECT id, name, seat, team, score, is_host
             FROM players WHERE room_id = ? ORDER BY score DESC, seat ASC'
        );
        $stmt->execute([$roomId]);
        return $stmt->fetchAll();
    }

    public function addPointsToTeam(int $roomId, int $team, int $points): void
    {
        $stmt = Db::pdo()->prepare(
            'UPDATE players SET score = score + ? WHERE room_id = ? AND team = ?'
        );
        $stmt->execute([$points, $roomId, $team]);
    }

    public function addPointsToPlayer(int $playerId, int $points): void
    {
        Db::pdo()->prepare('UPDATE players SET score = score + ? WHERE id = ?')
            ->execute([$points, $playerId]);
    }

    public function lockAllByRoom(int $roomId): array
    {
        $stmt = Db::pdo()->prepare('SELECT * FROM players WHERE room_id = ? ORDER BY seat FOR UPDATE');
        $stmt->execute([$roomId]);
        return $stmt->fetchAll();
    }

    public function setLastAnswerAt(int $playerId, ?string $value): void
    {
        $stmt = $value === null
            ? Db::pdo()->prepare('UPDATE players SET last_answer_at = NULL WHERE id = ?')
            : Db::pdo()->prepare('UPDATE players SET last_answer_at = ? WHERE id = ?');
        $value === null
            ? $stmt->execute([$playerId])
            : $stmt->execute([$value, $playerId]);
    }

    public function findByName(int $roomId, string $nameNorm): ?array
    {
        $stmt = Db::pdo()->prepare('SELECT * FROM players WHERE room_id = ? AND name_norm = ?');
        $stmt->execute([$roomId, $nameNorm]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    public function delete(int $playerId): void
    {
        Db::pdo()->prepare('DELETE FROM players WHERE id = ?')->execute([$playerId]);
    }

    public function transferHost(int $roomId): void
    {
        // Remove o host atual e passa para o de menor assento restante.
        $stmt = Db::pdo()->prepare(
            'SELECT id FROM players WHERE room_id = ? AND is_host = 0 ORDER BY seat LIMIT 1'
        );
        $stmt->execute([$roomId]);
        $next = $stmt->fetchColumn();
        if ($next !== false) {
            Db::pdo()->prepare('UPDATE players SET is_host = 1 WHERE id = ?')->execute([$next]);
        }
    }

    public function dropHostFlag(int $roomId): void
    {
        Db::pdo()->prepare('UPDATE players SET is_host = 0 WHERE room_id = ? AND is_host = 1')
            ->execute([$roomId]);
    }

    public function sweepDisconnected(int $roomId, int $seconds): int
    {
        $stmt = Db::pdo()->prepare(
            'UPDATE players SET connected = 0
             WHERE room_id = ? AND connected = 1 AND last_seen_at < DATE_SUB(NOW(), INTERVAL ? SECOND)'
        );
        $stmt->execute([$roomId, $seconds]);
        return $stmt->rowCount();
    }
}

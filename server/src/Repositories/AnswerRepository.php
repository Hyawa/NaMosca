<?php

declare(strict_types=1);

namespace NaMosca\Repositories;

use NaMosca\Core\Db;

final class AnswerRepository
{
    public function countAtClue(int $roomId, int $round, int $clue, int $playerId): int
    {
        $stmt = Db::pdo()->prepare(
            'SELECT COUNT(*) FROM answers
             WHERE room_id = ? AND round_number = ? AND clue_index = ? AND player_id = ?'
        );
        $stmt->execute([$roomId, $round, $clue, $playerId]);
        return (int) $stmt->fetchColumn();
    }

    public function correctScorersAtClue(int $roomId, int $round, int $clue): array
    {
        $stmt = Db::pdo()->prepare(
            'SELECT a.player_id, p.name, a.created_at
             FROM answers a JOIN players p ON p.id = a.player_id
             WHERE a.room_id = ? AND a.round_number = ? AND a.clue_index = ? AND a.is_correct = 1
             ORDER BY a.created_at ASC'
        );
        $stmt->execute([$roomId, $round, $clue]);
        return $stmt->fetchAll();
    }

    public function scorersOfRound(int $roomId, int $round): array
    {
        $stmt = Db::pdo()->prepare(
            'SELECT p.id, p.name, p.seat, p.team, a.points AS points, a.clue_index AS clue, a.created_at
             FROM answers a JOIN players p ON p.id = a.player_id
             WHERE a.room_id = ? AND a.round_number = ? AND a.is_correct = 1
             ORDER BY a.created_at ASC'
        );
        $stmt->execute([$roomId, $round]);
        return $stmt->fetchAll();
    }

    public function playerScoredInRound(int $roomId, int $round, int $playerId): bool
    {
        $stmt = Db::pdo()->prepare(
            'SELECT COUNT(*) FROM answers
             WHERE room_id = ? AND round_number = ? AND player_id = ? AND is_correct = 1'
        );
        $stmt->execute([$roomId, $round, $playerId]);
        return (int) $stmt->fetchColumn() > 0;
    }

    public function lastAnswerAtMs(int $playerId): ?int
    {
        $stmt = Db::pdo()->prepare(
            'SELECT TIMESTAMPDIFF(MICROSECOND, last_answer_at, NOW(3)) DIV 1000 FROM players WHERE id = ?'
        );
        $stmt->execute([$playerId]);
        $value = $stmt->fetchColumn();
        return $value === null ? null : (int) $value;
    }

    public function record(array $data): void
    {
        $stmt = Db::pdo()->prepare(
            'INSERT INTO answers (room_id, round_number, clue_index, player_id, raw_answer, normalized, is_correct, points, latency_ms)
             VALUES (:room_id, :round_number, :clue_index, :player_id, :raw_answer, :normalized, :is_correct, :points, :latency_ms)'
        );
        $stmt->execute([
            ':room_id' => $data['room_id'],
            ':round_number' => $data['round_number'],
            ':clue_index' => $data['clue_index'],
            ':player_id' => $data['player_id'],
            ':raw_answer' => $data['raw_answer'],
            ':normalized' => $data['normalized'],
            ':is_correct' => $data['is_correct'] ? 1 : 0,
            ':points' => $data['points'],
            ':latency_ms' => $data['latency_ms'],
        ]);
    }

    public function stats(int $roomId): array
    {
        $stmt = Db::pdo()->prepare(
            'SELECT player_id,
                    COUNT(*) AS tries,
                    SUM(is_correct) AS hits,
                    SUM(points) AS points
             FROM answers WHERE room_id = ?
             GROUP BY player_id'
        );
        $stmt->execute([$roomId]);
        $rows = $stmt->fetchAll();
        $stats = [];
        foreach ($rows as $row) {
            $stats[(int) $row['player_id']] = [
                'tries' => (int) $row['tries'],
                'hits' => (int) $row['hits'],
                'points' => (int) $row['points'],
            ];
        }
        return $stats;
    }
}

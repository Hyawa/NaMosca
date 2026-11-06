<?php

declare(strict_types=1);

namespace NaMosca\Repositories;

use NaMosca\Core\Db;

final class CardRepository
{
    /**
     * Sorteia cartas priorizando as menos usadas.
     * @return array<int,array{id:int,answer:string,answer_norm:string,aliases:string,clues:string,category:string,difficulty:string}>
     */
    public function pick(int $count): array
    {
        $stmt = Db::pdo()->prepare(
            'SELECT id, answer, answer_norm, aliases, clues, category, difficulty
             FROM cards
             WHERE active = 1
             ORDER BY (last_used_at IS NULL) DESC, last_used_at ASC, times_used ASC, RAND()
             LIMIT ?'
        );
        $stmt->execute([$count]);
        return $stmt->fetchAll();
    }

    public function get(int $cardId): ?array
    {
        $stmt = Db::pdo()->prepare('SELECT * FROM cards WHERE id = ?');
        $stmt->execute([$cardId]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    public function markUsed(int $cardId): void
    {
        Db::pdo()->prepare(
            'UPDATE cards SET times_used = times_used + 1, last_used_at = NOW() WHERE id = ?'
        )->execute([$cardId]);
    }

    public function markSkippedUnuse(int $cardId): void
    {
        Db::pdo()->prepare(
            'UPDATE cards SET times_used = GREATEST(0, times_used - 1) WHERE id = ?'
        )->execute([$cardId]);
    }

    public function count(): int
    {
        return (int) Db::pdo()->query('SELECT COUNT(*) FROM cards WHERE active = 1')->fetchColumn();
    }

    public function report(int $cardId, ?int $roomId, string $reason): void
    {
        Db::pdo()->prepare(
            'INSERT INTO card_reports (card_id, room_id, reason) VALUES (?, ?, ?)'
        )->execute([$cardId, $roomId, $reason]);
    }
}

<?php

declare(strict_types=1);

namespace NaMosca\Support;

use NaMosca\Core\Db;

final class RateLimiter
{
    /** Janela fixa simples. Devolve true se a chamada é permitida. */
    public static function check(string $bucket, int $max, int $windowSec): bool
    {
        $pdo = Db::pdo();
        $bucket = mb_substr($bucket, 0, 140);
        $select = $pdo->prepare(
            'SELECT hits, (window_start < DATE_SUB(NOW(), INTERVAL ? SECOND)) AS expired
             FROM rate_limits WHERE bucket = ?'
        );
        $update = $pdo->prepare('UPDATE rate_limits SET hits = hits + 1 WHERE bucket = ?');
        $reset = $pdo->prepare('UPDATE rate_limits SET hits = 1, window_start = NOW() WHERE bucket = ?');
        $insert = $pdo->prepare('INSERT INTO rate_limits (bucket, hits, window_start) VALUES (?, 1, NOW())');

        $select->execute([$windowSec, $bucket]);
        $row = $select->fetch();

        if ($row === false) {
            try {
                $insert->execute([$bucket]);
                return true;
            } catch (\PDOException $e) {
                // Concorrencia: já existe, tenta incrementar.
                $update->execute([$bucket]);
                $count = $pdo->prepare('SELECT hits FROM rate_limits WHERE bucket = ?');
                $count->execute([$bucket]);
                return (int) $count->fetchColumn() <= $max;
            }
        }

        if (self::isExpired($row['expired'])) {
            $reset->execute([$bucket]);
            return true;
        }

        if ((int) $row['hits'] >= $max) {
            return false;
        }

        $update->execute([$bucket]);
        return true;
    }

    /** Segundos restantes até a janela atual reabrir. */
    public static function waitSecondsLeft(string $bucket, int $windowSec): int
    {
        $stmt = Db::pdo()->prepare(
            'SELECT GREATEST(0, ? - TIMESTAMPDIFF(SECOND, window_start, NOW())) FROM rate_limits WHERE bucket = ?'
        );
        $stmt->execute([$windowSec, $bucket]);
        return (int) ($stmt->fetchColumn() ?: 0);
    }

    private static function isExpired(mixed $value): bool
    {
        return filter_var($value, FILTER_VALIDATE_BOOL);
    }
}

<?php

declare(strict_types=1);

namespace NaMosca\Core;

use PDO;
use PDOException;

final class Db
{
    private static ?PDO $pdo = null;

    public static function envConnection(string $dbName): PDO
    {
        $host = Env::require('DB_HOST');
        $port = Env::get('DB_PORT', '3306') ?? '3306';
        $user = Env::require('DB_USER');
        $pass = Env::require('DB_PASS');
        return self::connect($host, $port, $dbName, $user, $pass);
    }

    /** PDO principal do app. */
    public static function pdo(): PDO
    {
        if (self::$pdo === null) {
            $host = Env::require('DB_HOST');
            $port = Env::get('DB_PORT', '3306') ?? '3306';
            $user = Env::require('DB_USER');
            $pass = Env::require('DB_PASS');
            self::$pdo = self::connect($host, $port, Env::require('DB_NAME'), $user, $pass);
        }
        return self::$pdo;
    }

    public static function txn(callable $fn): mixed
    {
        $pdo = self::pdo();
        $outer = !$pdo->inTransaction();
        if ($outer) {
            $pdo->beginTransaction();
        }
        try {
            $result = $fn();
            if ($outer) {
                $pdo->commit();
            }
            return $result;
        } catch (\Throwable $e) {
            if ($outer && $pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    private static function connect(string $host, string $port, string $db, string $user, string $pass): PDO
    {
        $dsn = "mysql:host={$host};port={$port};dbname={$db};charset=utf8mb4";
        $options = [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ];
        $pdo = new PDO($dsn, $user, $pass, $options);
        // Datas sempre em UTC para bater com date.timezone = UTC do PHP.
        $pdo->exec("SET time_zone = '+00:00'");
        $pdo->exec("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'");
        return $pdo;
    }
}

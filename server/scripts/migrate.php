<?php

declare(strict_types=1);

namespace NaMosca\Scripts;

use DateTime;
use NaMosca\Core\Db;
use NaMosca\Core\Env;
use PDO;

require __DIR__ . '/../vendor/autoload.php';

Env::load(dirname(__DIR__) . '/.env');

const MIGRATIONS_DIR = __DIR__ . '/../database/migrations';

/**
 * Roda as migrações pendentes na ordem de nome de arquivo.
 * Uso: php server/scripts/migrate.php [--db=namosca_test]
 */
$dbName = 'namosca';
foreach (getopt('', ['db:']) as $key => $value) {
    if ($key === 'db') {
        $dbName = is_string($value) ? $value : $dbName;
    }
}

echo "Migrate: {$dbName}" . PHP_EOL;

$pdo = Db::envConnection($dbName);

$pdo->exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci'
);

$applied = $pdo->query('SELECT version FROM schema_migrations')->fetchAll(PDO::FETCH_COLUMN);
$files = glob(MIGRATIONS_DIR . '/*.sql') ?: [];

if ($files === []) {
    fwrite(STDERR, "Nenhuma migração encontrada em " . MIGRATIONS_DIR . PHP_EOL);
    exit(1);
}

sort($files);

foreach ($files as $file) {
    $version = basename($file, '.sql');
    if (in_array($version, $applied, true)) {
        echo "  = {$version} (já aplicada)" . PHP_EOL;
        continue;
    }

    $sql = (string) file_get_contents($file);
    if ($sql === '') {
        fwrite(STDERR, "Arquivo vazio: {$file}" . PHP_EOL);
        exit(1);
    }

    try {
        $pdo->exec($sql);
        $stmt = $pdo->prepare('INSERT INTO schema_migrations (version) VALUES (?)');
        $stmt->execute([$version]);
        echo "  + {$version} aplicada" . PHP_EOL;
    } catch (\Throwable $e) {
        fwrite(STDERR, "  ! {$version} falhou: {$e->getMessage()}" . PHP_EOL);
        exit(1);
    }
}

// Limpa lotes antigos de rate limit sempre que a migração roda.
$pdo->exec('DELETE FROM rate_limits WHERE window_start < DATE_SUB(NOW(), INTERVAL 1 HOUR)');

echo 'Migrações concluídas em ' . (new DateTime())->format('H:i:s') . PHP_EOL;

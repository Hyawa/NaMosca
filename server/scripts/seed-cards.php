<?php

declare(strict_types=1);

namespace NaMosca\Scripts;

use NaMosca\Core\Db;
use NaMosca\Core\Env;
use NaMosca\Support\Str;

require __DIR__ . '/../vendor/autoload.php';

Env::load(dirname(__DIR__) . '/.env');

/**
 * Importa o baralho curado (database/seed/*.txt) na tabela cards.
 *
 * Formato de cada linha (6 campos separados por pipe):
 *   dificuldade|resposta|alias1,alias2|pista1|pista2|pista3
 *
 * Uso: php server/scripts/seed-cards.php [--db=namosca] [--replace]
 */

$opts = getopt('', ['db:', 'replace']);
$dbName = is_string($opts['db'] ?? false) ? $opts['db'] : 'namosca';
$replace = array_key_exists('replace', $opts);

echo "Seed: {$dbName}" . PHP_EOL;

$pdo = Db::envConnection($dbName);

$sql = $replace
    ? 'REPLACE INTO cards (answer, answer_norm, aliases, clues, category, difficulty, source)
       VALUES (:answer, :answer_norm, :aliases, :clues, :category, :difficulty, :source)'
    : 'INSERT IGNORE INTO cards (answer, answer_norm, aliases, clues, category, difficulty, source)
       VALUES (:answer, :answer_norm, :aliases, :clues, :category, :difficulty, :source)';

$stmt = $pdo->prepare($sql);

$seedDir = dirname(__DIR__) . '/database/seed';
$files = glob($seedDir . '/*.txt') ?: [];

if ($files === []) {
    fwrite(STDERR, "Nenhum arquivo de seed em {$seedDir}" . PHP_EOL);
    exit(1);
}

/** Valida a carta antes de gravar. */
function validate(array $clues, string $answerNorm): ?string
{
    if (count($clues) !== 3) {
        return 'precisa de exatamente 3 pistas';
    }
    foreach ($clues as $clue) {
        $len = mb_strlen(trim($clue));
        if ($len < 4 || $len > 200) {
            return 'pista fora do tamanho (4–200)';
        }
    }
    if (in_array($answerNorm, array_map([Str::class, 'normalizeAnswer'], $clues), true)) {
        return 'pista vaza a resposta';
    }
    return null;
}

$inserted = 0;
$rejected = 0;
$duplicated = 0;
$total = 0;

foreach ($files as $file) {
    $category = basename($file, '.txt');
    $lines = file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];

    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) {
            continue;
        }
        $total++;

        $parts = explode('|', $line);
        if (count($parts) !== 6) {
            $rejected++;
            fwrite(STDERR, "  ! [{$category}] linha com " . count($parts) . " campos (esperado 6): {$line}" . PHP_EOL);
            continue;
        }

        [$difficulty, $answer, $aliasRaw, $clue1, $clue2, $clue3] = $parts;

        $answerNorm = Str::normalizeAnswer($answer);
        if (!in_array($difficulty, ['facil', 'media', 'dificil'], true) || $answerNorm === '') {
            $rejected++;
            fwrite(STDERR, "  ! [{$category}] dificuldade/resposta inválida: {$answer}" . PHP_EOL);
            continue;
        }

        $clues = [trim($clue1), trim($clue2), trim($clue3)];

        $error = validate($clues, $answerNorm);
        if ($error !== null) {
            $rejected++;
            fwrite(STDERR, "  ! [{$category}] {$answer}: {$error}" . PHP_EOL);
            continue;
        }

        $aliases = [$answerNorm];
        foreach (explode(',', $aliasRaw) as $alias) {
            $alias = Str::normalizeAnswer($alias);
            if ($alias !== '') {
                $aliases[] = $alias;
            }
        }
        $aliases = array_values(array_unique($aliases));

        $stmt->execute([
            ':answer'      => trim($answer),
            ':answer_norm' => $answerNorm,
            ':aliases'     => json_encode($aliases, JSON_UNESCAPED_UNICODE),
            ':clues'       => json_encode($clues, JSON_UNESCAPED_UNICODE),
            ':category'    => $category,
            ':difficulty'  => $difficulty,
            ':source'      => 'seed',
        ]);

        if ($stmt->rowCount() > 0) {
            $inserted++;
        } else {
            $duplicated++;
        }
    }
}

$count = (int) $pdo->query('SELECT COUNT(*) FROM cards')->fetchColumn();

echo "Linhas lidas: {$total}" . PHP_EOL;
echo "Inseridas: {$inserted}" . PHP_EOL;
echo "Duplicadas ignoradas: {$duplicated}" . PHP_EOL;
echo "Rejeitadas: {$rejected}" . PHP_EOL;
echo "Total na tabela cards: {$count}" . PHP_EOL;

if ($count < 100) {
    fwrite(STDERR, 'Baralho incompleto! Esperado ~120 cartas.' . PHP_EOL);
    exit(1);
}

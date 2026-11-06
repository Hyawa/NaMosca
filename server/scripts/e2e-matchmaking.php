<?php

declare(strict_types=1);

use NaMosca\Core\Env;

require __DIR__ . '/../vendor/autoload.php';
Env::load(dirname(__DIR__) . '/.env');

/**
 * E2E do matchmaking (fila normal, sem ranque).
 * Uso: php server/scripts/e2e-matchmaking.php
 * Requisito: php -S 127.0.0.1:8080 -t server/public server/public/index.php
 */

$base = 'http://127.0.0.1:8080';
$failures = 0;

function api(string $method, string $path, array $body = [], ?string $token = null): array
{
    global $base;
    $ch = curl_init($base . $path);
    $headers = ['Content-Type: application/json'];
    if ($token !== null) {
        $headers[] = 'Authorization: Bearer ' . $token;
    }
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_POSTFIELDS => $body === [] ? null : json_encode($body, JSON_UNESCAPED_UNICODE),
        CURLOPT_TIMEOUT => 10,
    ]);
    $raw = (string) curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$status, json_decode($raw, true) ?? []];
}

function check(bool $cond, string $label): void
{
    global $failures;
    if ($cond) {
        echo "  ok  {$label}\n";
    } else {
        $failures++;
        echo "  !!  {$label}\n";
    }
}

function enqueue(string $mode, string $name): array
{
    return api('POST', '/matchmaking/queue', ['mode' => $mode, 'nickname' => $name]);
}

// ----------------------------------------------------------------------

echo "== Matchmaking E2E ==\n";

// Rodadas repetidas do teste não devem esbarrar no rate limit local.
$pdo = new PDO(
    sprintf(
        'mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
        (string) Env::get('DB_HOST'),
        (string) Env::get('DB_PORT'),
        (string) Env::get('DB_NAME')
    ),
    (string) Env::get('DB_USER'),
    (string) Env::get('DB_PASS'),
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);
$pdo->exec("DELETE FROM rate_limits WHERE bucket LIKE 'mm:%'");

// ----------------------------------------------------------------------
// 1v1: o segundo da fila fecha a partida na hora.
// ----------------------------------------------------------------------
[$s, $a] = enqueue('duel', 'MM Ana');
check($s === 200 && ($a['status'] ?? '') === 'queued', 'duel: A entra na fila');
check(isset($a['queueToken']) && ($a['queued'] ?? 0) >= 1, 'duel: devolve token e tamanho da fila');

[$s, $b] = enqueue('duel', 'MM Bruno');
check($s === 200 && ($b['status'] ?? '') === 'matched', 'duel: B fecha a partida na entrada');
check(isset($b['code'], $b['token'], $b['playerId']), 'duel: B recebe sessão pronta');

[$s, $a2] = api('GET', '/matchmaking/status', token: (string) $a['queueToken']);
check($s === 200 && ($a2['status'] ?? '') === 'matched', 'duel: A vê partida encontrada no polling');
check(($a2['code'] ?? null) === ($b['code'] ?? false), 'duel: os dois caem na mesma sala');
check(($a2['token'] ?? null) !== ($b['token'] ?? null), 'duel: tokens distintos por jogador');

$code = (string) $b['code'];
[$s, $state] = api('GET', "/rooms/{$code}", token: (string) $a2['token']);
check($s === 200 && ($state['room']['status'] ?? '') === 'playing', 'duel: partida já começa jogando');
check(count($state['players'] ?? []) === 2, 'duel: 2 jogadores na sala');
check(($state['room']['phase'] ?? '') === 'clue', 'duel: primeira pista aberta');

// ----------------------------------------------------------------------
// Cancelamento e apelido duplicado na fila.
// ----------------------------------------------------------------------
[$s, $c] = enqueue('royale', 'MM Carla');
check($s === 200 && ($c['status'] ?? '') === 'queued', 'royale: C entra na fila');

[$s, $dup] = enqueue('royale', 'mm carla');
check($s === 409, 'fila: apelido duplicado no mesmo modo é rejeitado');

[$s, $cancelled] = api('POST', '/matchmaking/cancel', [], (string) $c['queueToken']);
check($s === 200 && ($cancelled['status'] ?? '') === 'cancelled', 'fila: cancelamento ok');

[$s, $c2] = api('GET', '/matchmaking/status', token: (string) $c['queueToken']);
check($s === 200 && ($c2['status'] ?? '') === 'cancelled', 'fila: status cancelado após sair');

// ----------------------------------------------------------------------
// 2v2: quatro jogadores, times equilibrados 2/2.
// ----------------------------------------------------------------------
$teamNames = ['MM D', 'MM E', 'MM F', 'MM G'];
$teamSession = null;
$teamQueue = null;
foreach ($teamNames as $i => $name) {
    [$s, $reply] = enqueue('teams', $name);
    check($s === 200, "teams: {$name} entrou");
    if ($i < 3) {
        $teamQueue = $teamQueue ?? (string) $reply['queueToken'];
    }
    if ($i === 3) {
        $teamSession = $reply;
    }
}

check(($teamSession['status'] ?? '') === 'matched', 'teams: o quarto fecha a partida');
[$s, $waiting] = api('GET', '/matchmaking/status', token: $teamQueue);
check($s === 200 && ($waiting['status'] ?? '') === 'matched', 'teams: o primeiro também é pareado');

$teamCode = (string) ($waiting['code'] ?? '');
[$s, $teamState] = api('GET', "/rooms/{$teamCode}", token: (string) $waiting['token']);
check($s === 200 && count($teamState['players'] ?? []) === 4, 'teams: 4 jogadores na sala');

$teams = array_count_values(array_map(
    static fn (array $p): int => (int) ($p['team'] ?? -1),
    $teamState['players'] ?? []
));
check(($teams[0] ?? 0) === 2 && ($teams[1] ?? 0) === 2, 'teams: times 2/2 balanceados');

// ----------------------------------------------------------------------
// Royale: abre com 3+ depois da paciência de 15 s (simulada no banco).
// ----------------------------------------------------------------------
$royaleNames = ['MM H', 'MM I', 'MM J'];
$royaleToken = null;
foreach ($royaleNames as $name) {
    [$s, $reply] = enqueue('royale', $name);
    check($s === 200 && ($reply['status'] ?? '') === 'queued', "royale: {$name} aguarda (fila < 8)");
    $royaleToken = $royaleToken ?? (string) $reply['queueToken'];
}

$pdo->exec(
    "UPDATE matchmaking_queue
     SET created_at = DATE_SUB(NOW(3), INTERVAL 20 SECOND)
     WHERE mode = 'royale' AND status = 'queued'
       AND name IN ('MM H', 'MM I', 'MM J')"
);

[$s, $royale] = api('GET', '/matchmaking/status', token: $royaleToken);
check($s === 200 && ($royale['status'] ?? '') === 'matched', 'royale: abre com 3 após a paciência');
[$s, $royaleState] = api('GET', '/rooms/' . ($royale['code'] ?? ''), token: (string) $royale['token']);
check($s === 200 && count($royaleState['players'] ?? []) === 3, 'royale: 3 jogadores na sala');

echo "\nFalhas: {$failures}\n";
exit($failures === 0 ? 0 : 1);

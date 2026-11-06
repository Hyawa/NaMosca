<?php

declare(strict_types=1);

use NaMosca\Core\Env;

require __DIR__ . '/../vendor/autoload.php';
Env::load(dirname(__DIR__) . '/.env');

/**
 * Smoke test end-to-end da API Na Mosca! (duelo completo até o fim).
 * Uso: php server/scripts/e2e-smoke.php
 * Requisito: php -S 127.0.0.1:8080 -t server/public server/public/index.php
 */

$base = 'http://127.0.0.1:8080';
$failures = 0;

function api(string $method, string $path, array $body = [], ?string $token = null, array $extraHeaders = []): array
{
    global $base;
    $ch = curl_init($base . $path);
    $headers = ['Content-Type: application/json', ...$extraHeaders];
    if ($token !== null) {
        $headers[] = 'Authorization: Bearer ' . $token;
    }
    $responseHeaders = [];
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_POSTFIELDS => $body === [] ? null : json_encode($body, JSON_UNESCAPED_UNICODE),
        CURLOPT_TIMEOUT => 10,
        CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$responseHeaders): int {
            $parts = explode(':', $line, 2);
            if (count($parts) === 2) {
                $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
            }
            return strlen($line);
        },
    ]);
    $raw = (string) curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$status, json_decode($raw, true) ?? [], $responseHeaders];
}

function answerOfRoom(string $code): string
{
    global $base;
    $pdo = new PDO(
        sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', getenvOr('DB_HOST'), getenvOr('DB_PORT'), getenvOr('DB_NAME')),
        getenvOr('DB_USER'),
        getenvOr('DB_PASS'),
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );
    $pdo->exec("SET time_zone = '+00:00'");
    $stmt = $pdo->prepare(
        'SELECT c.answer FROM rooms ro
         JOIN room_rounds r ON r.room_id = ro.id AND r.round_number = ro.round_number
         JOIN cards c ON c.id = r.card_id
         WHERE ro.code = ?'
    );
    $stmt->execute([$code]);
    return (string) $stmt->fetchColumn();
}

function getenvOr(string $key): string
{
    $value = \NaMosca\Core\Env::get($key);
    if ($value === null) {
        fwrite(STDERR, "Env ausente: {$key}\n");
        exit(1);
    }
    return $value;
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

// ----------------------------------------------------------------------

echo "== Smoke test Na Mosca! ==\n";

[$status, $health] = api('GET', '/health');
check($status === 200, 'health 200');

[$status, $created] = api('POST', '/rooms', ['mode' => 'duel', 'nickname' => 'Ana', 'settings' => ['rounds' => 5]]);
$createdCode = $created['code'] ?? '?';
check($status === 200 && isset($created['code']), "create duel ({$createdCode})");
$code = $created['code'];
$tokenA = $created['token'];

[$status, $joined] = api('POST', "/rooms/{$code}/join", ['nickname' => 'Bruno']);
check($status === 200, 'join B');
$tokenB = $joined['token'];

// Nome duplicado deve falhar
[$status, $dup] = api('POST', "/rooms/{$code}/join", ['nickname' => 'bruno ']);
check($status === 409, 'join com apelido duplicado rejeitado');

// estado inicial
[$status, $state] = api('GET', "/rooms/{$code}", token: $tokenA);
check($status === 200 && $state['room']['status'] === 'lobby', 'estado lobby');
check(count($state['players']) === 2, '2 jogadores');

[$status, $s] = api('POST', "/rooms/{$code}/start", [], $tokenA);
check($status === 409, 'start sem pronto rejeitado');

// Regressão: "pronto" grava em players, não em rooms. O polling por ETag
// precisa enxergar a mudança (antes vinha 304 e a tela ficava congelada).
[$status, , $lobbyHeaders] = api('GET', "/rooms/{$code}", token: $tokenA);
$lobbyEtag = (string) ($lobbyHeaders['etag'] ?? '');
check($status === 200 && $lobbyEtag !== '', 'estado do lobby traz ETag');

[$status] = api('POST', "/rooms/{$code}/ready", [], $tokenA);
check($status === 200, 'A fica pronto');

[$status, $afterReady, $afterHeaders] = api(
    'GET',
    "/rooms/{$code}",
    token: $tokenA,
    extraHeaders: ['If-None-Match: ' . $lobbyEtag],
);
check($status === 200, 'ready invalida o ETag (não devolve 304)');
$meAfter = null;
foreach ($afterReady['players'] ?? [] as $p) {
    if ((int) $p['id'] === (int) $created['playerId']) {
        $meAfter = $p;
    }
}
check(($meAfter['isReady'] ?? false) === true, 'estado reflete A pronto');
$readyEtag = (string) ($afterHeaders['etag'] ?? '');

[$status] = api('POST', "/rooms/{$code}/ready", [], $tokenB);
check($status === 200, 'B fica pronto');

[$status, $allReady] = api(
    'GET',
    "/rooms/{$code}",
    token: $tokenA,
    extraHeaders: ['If-None-Match: ' . $readyEtag],
);
check($status === 200, 'ready de B invalida o ETag');
check(
    array_reduce(
        $allReady['players'] ?? [],
        static fn (bool $ok, array $p): bool => $ok && (bool) $p['isReady'],
        true
    ),
    'todos aparecem prontos'
);

[$status, $result] = api('POST', "/rooms/{$code}/start", [], $tokenA);
check($status === 200, 'start ok');
[$status, $state] = api('GET', "/rooms/{$code}", token: $tokenA);
check($state['room']['status'] === 'playing' && $state['room']['phase'] === 'clue', 'fase clue');
check($state['room']['roundNumber'] === 1, 'rodada 1');
check(count($state['round']['revealedClues']) === 1, '1 pista revelada');
check($state['round']['answer'] === null, 'resposta escondida durante o jogo');

// only 3 tries per clue
[$status, $a1] = api('POST', "/rooms/{$code}/answer", ['guess' => 'abacaxi'], $tokenA);
check($status === 200 && $a1['correct'] === false, 'resposta errada aceita');
[$status, $a2] = api('POST', "/rooms/{$code}/answer", ['guess' => 'banana'], $tokenA);
check($status === 429, 'lockout de 1,5 s aplicado');
usleep(1_600_000);
[$status, $a3] = api('POST', "/rooms/{$code}/answer", ['guess' => 'manga'], $tokenA);
check($status === 200, 'lockout passou');
usleep(1_600_000);

$answer = answerOfRoom($code);
[$status, $win] = api('POST', "/rooms/{$code}/answer", ['guess' => $answer], $tokenB);
check($status === 200 && $win['correct'] === true, 'resposta correta do B');
[$status, $state] = api('GET', "/rooms/{$code}", token: $tokenA);
check($state['room']['phase'] === 'reveal', 'reveal após acerto');
check($state['round']['answer'] !== null, 'resposta visível no reveal');
$playerBId = (int) ($joined['playerId'] ?? -1);
check($state['round']['scorers'][0]['playerId'] === $playerBId, 'B pontuou 10');

// 3ª resposta na mesma pista não deve ser possível: fase reveal
usleep(1_600_000);
[$status, $late] = api('POST', "/rooms/{$code}/answer", ['guess' => $answer], $tokenA);
check($status === 409, 'resposta recusada durante reveal');

// espera o reveal (6 s) e vê a próxima rodada
sleep(7);
[$status, $state] = api('GET', "/rooms/{$code}", token: $tokenA);
check($state['room']['roundNumber'] === 2 && $state['room']['phase'] === 'clue', 'rodada 2 em clue');
check(count($state['round']['revealedClues']) === 1, '1 pista na rodada 2');

// fechar as rodadas 2 a 5 rápido: A e B alternam acertos
for ($round = 2; $round <= 5; $round++) {
    // espera a rodada abrir em modo clue (o servidor avança no polling)
    $opened = false;
    for ($i = 0; $i < 40; $i++) {
        [$s2, $poll] = api('GET', "/rooms/{$code}", token: $tokenA);
        if (($poll['room']['roundNumber'] ?? 0) === $round && ($poll['room']['phase'] ?? '') === 'clue') {
            $opened = true;
            break;
        }
        usleep(500_000);
    }
    check($opened, "rodada {$round} aberta");
    $answer = answerOfRoom($code);
    $who = $round % 2 === 0 ? $tokenB : $tokenA;
    [$status, $win] = api('POST', "/rooms/{$code}/answer", ['guess' => $answer], $who);
    check($status === 200 && $win['correct'] === true, "acerto na rodada {$round}");
}
// espera o jogo encerrar (último reveal pela frente)
$finished = false;
for ($i = 0; $i < 40; $i++) {
    [$status, $state] = api('GET', "/rooms/{$code}", token: $tokenA);
    if (($state['room']['status'] ?? '') === 'finished') {
        $finished = true;
        break;
    }
    usleep(500_000);
}
check($finished, 'partida terminou (result presente)');

// placar: A acertou 1,3,5 = 10+7+4=21? B 2,4 = 20 -> morte súbita resolvida no último
// O resultado depende de quem pontua; apenas validamos coerência:
$ranking = $state['result']['ranking'];
check(count($ranking) === 2, 'ranking com 2 jogadores');

echo "\nFalhas: {$failures}\n";
exit($failures === 0 ? 0 : 1);

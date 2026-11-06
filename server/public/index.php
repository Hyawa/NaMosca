<?php

declare(strict_types=1);

use NaMosca\Core\Env;
use NaMosca\Core\Request;
use NaMosca\Core\Response;
use NaMosca\Core\Router;
use NaMosca\Domain\GameException;
use NaMosca\Http\Controllers\HealthController;
use NaMosca\Http\Controllers\MatchmakingController;
use NaMosca\Http\Controllers\RoomController;

require dirname(__DIR__) . '/vendor/autoload.php';

Env::load(dirname(__DIR__, 1) . '/.env');

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

// ------------------------- CORS ---------------------------------------
$origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
$allowed = Env::get('CORS_ALLOWED_ORIGINS', '*');
$allowedList = array_map('trim', explode(',', (string) $allowed));

if (in_array('*', $allowedList, true) || in_array($origin, $allowedList, true)) {
    header('Access-Control-Allow-Origin: ' . ($origin !== '' ? $origin : '*'));
    header('Vary: Origin');
}
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, If-None-Match');
    header('Access-Control-Max-Age: 86400');
    http_response_code(204);
    exit;
}

// ------------------------- Debug --------------------------------------
if (Env::get('APP_DEBUG', 'false') === 'true') {
    ini_set('display_errors', '1');
    error_reporting(E_ALL);
} else {
    ini_set('display_errors', '0');
}

// ------------------------- Rotas --------------------------------------
$router = new Router();
$health = new HealthController();
$rooms = new RoomController();
$matchmaking = new MatchmakingController();

$router->get('/health', fn (): bool => ($health->health() ?: true));

$router->post('/rooms', fn (): bool => ($rooms->create() ?: true));
$router->get('/rooms/{code}', fn (string $code): bool => ($rooms->state($code) ?: true));
$router->post('/rooms/{code}/join', fn (string $code): bool => ($rooms->join($code) ?: true));
$router->post('/rooms/{code}/ready', fn (): bool => ($rooms->ready() ?: true));
$router->post('/rooms/{code}/start', fn (): bool => ($rooms->start() ?: true));
$router->post('/rooms/{code}/answer', fn (): bool => ($rooms->answer() ?: true));
$router->post('/rooms/{code}/skip-card', fn (): bool => ($rooms->skipCard() ?: true));
$router->post('/rooms/{code}/rematch', fn (): bool => ($rooms->rematch() ?: true));
$router->post('/rooms/{code}/leave', fn (): bool => ($rooms->leave() ?: true));
$router->post('/rooms/{code}/report', fn (string $code): bool => ($rooms->report($code) ?: true));

$router->post('/matchmaking/queue', fn (): bool => ($matchmaking->enter() ?: true));
$router->get('/matchmaking/status', fn (): bool => ($matchmaking->status() ?: true));
$router->post('/matchmaking/cancel', fn (): bool => ($matchmaking->cancel() ?: true));

try {
    $router->dispatch(Request::fromGlobals());
} catch (GameException $e) {
    Response::error($e->getMessage(), $e->status);
} catch (\Throwable $e) {
    if (Env::get('APP_DEBUG', 'false') === 'true') {
        error_log((string) $e);
        Response::error('Erro inesperado: ' . $e->getMessage(), 500);
    } else {
        error_log('[NaMosca] ' . $e->getMessage());
        Response::error('Erro inesperado', 500);
    }
}

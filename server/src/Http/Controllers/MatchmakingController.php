<?php

declare(strict_types=1);

namespace NaMosca\Http\Controllers;

use NaMosca\Core\Request;
use NaMosca\Core\Response;
use NaMosca\Domain\GameException;
use NaMosca\Domain\MatchmakingService;
use NaMosca\Support\RateLimiter;

final class MatchmakingController
{
    // POST /matchmaking/queue — entra na fila
    public function enter(): void
    {
        $request = Request::fromGlobals();
        $body = $request->all();

        $bucket = 'mm:' . $request->ip();
        if (!RateLimiter::check($bucket, 30, 600)) {
            $wait = RateLimiter::waitSecondsLeft($bucket, 600);
            Response::error('Muitas entradas na fila. Tente de novo em ' . $wait . 's.', 429);
            return;
        }

        $service = new MatchmakingService();
        try {
            $reply = $service->enqueue(
                (string) ($body['mode'] ?? 'duel'),
                (string) ($body['nickname'] ?? ''),
            );
            Response::json($reply);
        } catch (GameException $e) {
            Response::error($e->getMessage(), $e->status);
        }
    }

    // GET /matchmaking/status — polling da fila
    public function status(): void
    {
        $service = new MatchmakingService();
        $this->withToken(fn (string $token): array => $service->status($token));
    }

    // POST /matchmaking/cancel — sai da fila
    public function cancel(): void
    {
        $service = new MatchmakingService();
        $this->withToken(fn (string $token): array => $service->cancel($token));
    }

    private function withToken(callable $fn): void
    {
        $token = (new Request('GET', ''))->bearerToken();
        if ($token === null) {
            Response::error('Fila ausente', 401);
            return;
        }

        try {
            Response::json($fn($token));
        } catch (GameException $e) {
            Response::error($e->getMessage(), $e->status);
        }
    }
}

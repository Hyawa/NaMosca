<?php

declare(strict_types=1);

namespace NaMosca\Http\Controllers;

use NaMosca\Core\Db;
use NaMosca\Core\Request;
use NaMosca\Core\Response;
use NaMosca\Domain\GameException;
use NaMosca\Domain\GameEngine;
use NaMosca\Repositories\AnswerRepository;
use NaMosca\Repositories\CardRepository;
use NaMosca\Repositories\PlayerRepository;
use NaMosca\Repositories\RoomRepository;
use NaMosca\Support\RateLimiter;

final class RoomController
{
    private GameEngine $engine;
    private RoomRepository $rooms;
    private PlayerRepository $players;

    public function __construct()
    {
        $this->rooms = new RoomRepository();
        $this->players = new PlayerRepository();
        $this->engine = new GameEngine(
            $this->rooms,
            $this->players,
            new CardRepository(),
            new AnswerRepository(),
        );
    }

    // ------------------------------------------------------------------
    // POST /rooms — criar sala
    // ------------------------------------------------------------------
    public function create(): void
    {
        $request = Request::fromGlobals();
        $body = $request->all();

        $mode = (string) ($body['mode'] ?? 'duel');
        $name = (string) ($body['nickname'] ?? '');
        $settings = (array) ($body['settings'] ?? []);

        $limiter = RateLimiter::check('create:' . $request->ip(), 8, 600);
        if (!$limiter) {
            $wait = RateLimiter::waitSecondsLeft('create:' . $request->ip(), 600);
            Response::error('Muitas salas criadas. Tente de novo em ' . $wait . 's.', 429);
            return;
        }

        $result = $this->engine->createRoom($mode, $name, $settings);
        $this->sendSession($result['room'], $result['player'], $result['token']);
    }

    // ------------------------------------------------------------------
    // POST /rooms/{code}/join — entrar em sala
    // ------------------------------------------------------------------
    public function join(string $code): void
    {
        $request = Request::fromGlobals();
        $body = $request->all();
        $name = (string) ($body['nickname'] ?? '');

        $limiter = RateLimiter::check('join:' . $request->ip(), 30, 600);
        if (!$limiter) {
            Response::error('Muitas tentativas de entrada. Aguarde um instante.', 429);
            return;
        }

        $result = $this->engine->joinRoom($code, $name);
        $this->sendSession($result['room'], $result['player'], $result['token']);
    }

    // ------------------------------------------------------------------
    // GET /rooms/{code} — estado (polling)
    // ------------------------------------------------------------------
    public function state(string $code): void
    {
        $room = $this->rooms->findByCode($code);
        if ($room === null) {
            Response::error('Sala não encontrada', 404);
            return;
        }

        $token = $this->tokenOrError();
        $me = null;
        $reconnected = false;
        if ($token !== null) {
            $me = $this->playerByToken($token);
            if ($me !== null && (int) $me['room_id'] === (int) $room['id']) {
                $reconnected = (int) $me['connected'] === 0;
                $this->players->touch((int) $me['id']);
            } else {
                $me = null;
            }
        }

        $state = Db::txn(function () use ($room, $me, $reconnected): array {
            $room = $this->rooms->lockById((int) $room['id']);
            $this->engine->tick($room);
            $swept = $this->players->sweepDisconnected((int) $room['id'], 12);
            if ($swept > 0 || $reconnected) {
                // connected é visível no estado; sem bump o ETag esconderia a mudança.
                $this->rooms->bumpVersion((int) $room['id']);
            }

            $fresh = $this->rooms->getById((int) $room['id']) ?? $room;
            $meFresh = $me !== null ? $this->freshPlayer((int) $me['id']) : null;
            return $this->engine->projectState($fresh, $meFresh);
        });

        $etag = 'W/"v' . $state['version'] . '"';
        $ifNoneMatch = $_SERVER['HTTP_IF_NONE_MATCH'] ?? '';
        if (is_string($ifNoneMatch) && trim($ifNoneMatch) === $etag) {
            Response::notModified(['ETag' => $etag]);
            return;
        }

        Response::json($state, 200, ['ETag' => $etag]);
    }

    // ------------------------------------------------------------------
    // Ações
    // ------------------------------------------------------------------
    public function ready(): void
    {
        $this->actionsSession(function (string $token): array {
            $this->engine->ready($token);
            return ['ok' => true];
        });
    }

    public function start(): void
    {
        $this->actionsSession(function (string $token): array {
            $this->engine->start($token);
            return ['ok' => true];
        });
    }

    public function answer(): void
    {
        $this->actionsSession(function (string $token): array {
            $request = Request::fromGlobals();
            $guess = (string) ($request->input('guess') ?? '');
            if (trim($guess) === '') {
                throw new GameException(400, 'Resposta vazia');
            }
            return $this->engine->answer($token, $guess);
        }, 200);
    }

    public function skipCard(): void
    {
        $this->actionsSession(function (string $token): array {
            $this->engine->skipCard($token);
            return ['ok' => true];
        });
    }

    public function rematch(): void
    {
        $this->actionsSession(function (string $token): array {
            $this->engine->rematch($token);
            return ['ok' => true];
        });
    }

    public function leave(): void
    {
        $this->actionsSession(function (string $token): array {
            $this->engine->leave($token);
            return ['ok' => true];
        });
    }

    public function report(string $code): void
    {
        $request = Request::fromGlobals();
        $body = $request->all();
        $reason = (string) ($body['reason'] ?? 'outro');

        $this->actionsSession(function (string $token) use ($code, $reason): array {
            $room = $this->rooms->findByCode($code);
            if ($room === null) {
                throw new GameException(404, 'Sala não encontrada');
            }
            // reportar a carta atual da rodada
            $state = Db::txn(function () use ($room): ?array {
                $locked = $this->rooms->lockById((int) $room['id']);
                $this->engine->tick($locked);
                return $locked;
            });
            $card = $state !== null && (int) $state['round_number'] >= 1
                ? $this->engine->roundCard((int) $state['id'], (int) $state['round_number'])
                : null;
            if ($card !== null) {
                (new CardRepository())->report((int) $card['id'], (int) $state['id'], mb_substr($reason, 0, 255));
            }
            return ['ok' => true];
        });
    }

    // ------------------------------------------------------------------
    // Internos
    // ------------------------------------------------------------------

    private function tokenOrError(): ?string
    {
        return (new Request('GET', ''))->bearerToken();
    }

    private function playerByToken(string $token): ?array
    {
        return $this->players->findByToken($token);
    }

    private function freshPlayer(int $playerId): ?array
    {
        $stmt = Db::pdo()->prepare('SELECT * FROM players WHERE id = ?');
        $stmt->execute([$playerId]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    /** Executa uma ação que exige sessão válida (Bearer token). */
    private function actionsSession(callable $fn, int $successStatus = 200): void
    {
        $request = new Request('POST', '');
        $token = $request->bearerToken();
        if ($token === null) {
            Response::error('Sessão ausente', 401);
            return;
        }
        try {
            $result = $fn($token);
            Response::json(is_array($result) ? $result : ['ok' => true], $successStatus);
        } catch (GameException $e) {
            Response::error($e->getMessage(), $e->status);
        }
    }

    private function sendSession(array $room, array $player, string $token): void
    {
        Response::json([
            'code' => (string) $room['code'],
            'mode' => (string) $room['mode'],
            'playerId' => (int) $player['id'],
            'token' => $token,
        ]);
    }
}

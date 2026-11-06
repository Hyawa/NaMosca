<?php

declare(strict_types=1);

namespace NaMosca\Domain;

use NaMosca\Core\Db;
use NaMosca\Repositories\AnswerRepository;
use NaMosca\Repositories\CardRepository;
use NaMosca\Repositories\PlayerRepository;
use NaMosca\Repositories\RoomRepository;
use NaMosca\Support\Str;
use NaMosca\Support\Token;

/** Erro de jogo com código HTTP amigável. */
final class GameException extends \Exception
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}

final class GameEngine
{
    public const REVEAL_SECONDS = 6;
    public const LOCK_MS = 1500;
    public const TRIES_PER_CLUE = 3;
    public const MAX_SUDDEN_DEATHS = 3;

    public const MIN_PLAYERS = ['duel' => 2, 'teams' => 4, 'royale' => 3];
    public const MAX_PLAYERS = ['duel' => 2, 'teams' => 4, 'royale' => 8];

    public function __construct(
        private readonly RoomRepository $rooms,
        private readonly PlayerRepository $players,
        private readonly CardRepository $cards,
        private readonly AnswerRepository $answers,
    ) {
    }

    // ==================================================================
    // Criação e entrada
    // ==================================================================

    public function createRoom(string $mode, string $name, array $settings): array
    {
        $mode = in_array($mode, ['duel', 'teams', 'royale'], true)
            ? $mode
            : throw new GameException(400, 'Modo inválido');

        $rounds = $this->sanitizeRounds($settings['rounds'] ?? 7);
        $clueSeconds = $this->sanitizeClueSeconds($settings['clueSeconds'] ?? 25);
        $clean = Str::shortName($name);
        $cleanNorm = Str::normalizeName($clean);
        if ($cleanNorm === '' || mb_strlen($clean) < 2) {
            throw new GameException(400, 'Apelido muito curto (mínimo 2 caracteres)');
        }

        return Db::txn(function () use ($mode, $rounds, $clueSeconds, $clean, $cleanNorm): array {
            $room = $this->rooms->create([
                'code' => $this->rooms->generateCode(),
                'mode' => $mode,
                'total_rounds' => $rounds,
                'settings' => ['clueSeconds' => $clueSeconds],
            ]);

            $token = Token::generate();
            $player = $this->players->create([
                'room_id' => (int) $room['id'],
                'name' => $clean,
                'name_norm' => $cleanNorm,
                'team' => $mode === 'teams'
                    ? $this->pickTeam((int) $room['id'])
                    : null,
                'seat' => 0,
                'is_host' => true,
                'token_hash' => Token::hash($token),
            ]);

            return ['room' => $room, 'player' => $player, 'token' => $token];
        });
    }

    public function joinRoom(string $code, string $name): array
    {
        $clean = Str::shortName($name);
        $cleanNorm = Str::normalizeName($clean);
        if ($cleanNorm === '' || mb_strlen($clean) < 2) {
            throw new GameException(400, 'Apelido muito curto (mínimo 2 caracteres)');
        }

        return Db::txn(function () use ($code, $clean, $cleanNorm): array {
            $room = $this->lockByCode($code);
            if ((string) $room['status'] !== 'lobby') {
                throw new GameException(409, 'A sala já começou ou encerrou');
            }
            $roomId = (int) $room['id'];
            $mode = (string) $room['mode'];
            $count = $this->players->count($roomId);
            $max = self::MAX_PLAYERS[$mode] ?? 8;
            if ($count >= $max) {
                throw new GameException(409, 'A sala está cheia');
            }
            if ($this->players->findByName($roomId, $cleanNorm) !== null) {
                throw new GameException(409, 'Esse apelido já está em uso na sala');
            }

            $token = Token::generate();
            $player = $this->players->create([
                'room_id' => $roomId,
                'name' => $clean,
                'name_norm' => $cleanNorm,
                'team' => $mode === 'teams' ? $this->pickTeam($roomId) : null,
                'seat' => $this->players->nextSeat($roomId),
                'is_host' => false,
                'token_hash' => Token::hash($token),
            ]);
            $this->bumpVersion($roomId, (string) $room['phase']);
            return ['room' => $room, 'player' => $player, 'token' => $token];
        });
    }

    // ==================================================================
    // Fluxo de sala
    // ==================================================================

    public function ready(string $token): void
    {
        Db::txn(function () use ($token): void {
            $player = $this->players->lockByToken($token);
            if ($player === null) {
                throw new GameException(403, 'Sessão inválida');
            }
            $this->players->setReady((int) $player['id'], !((int) $player['is_ready'] === 1));
            // is_ready vive em players, mas o ETag do polling vem de rooms.version.
            // Sem este bump o cliente recebe 304 e nunca vê o "pronto" mudar.
            $this->rooms->bumpVersion((int) $player['room_id']);
        });
    }

    public function start(string $token): void
    {
        Db::txn(function () use ($token): void {
            $player = $this->players->lockByToken($token);
            if ($player === null) {
                throw new GameException(403, 'Sessão inválida');
            }
            $room = $this->rooms->lockById((int) $player['room_id']);
            $roomId = (int) $room['id'];

            if ((int) $player['is_host'] !== 1) {
                throw new GameException(403, 'Só o host pode iniciar a partida');
            }
            if ((string) $room['status'] !== 'lobby') {
                throw new GameException(409, 'A partida já começou');
            }

            $players = $this->players->lockAllByRoom($roomId);
            $count = count($players);
            $mode = (string) $room['mode'];
            $min = self::MIN_PLAYERS[$mode] ?? 2;
            $max = self::MAX_PLAYERS[$mode] ?? 8;
            if ($count < $min || $count > $max) {
                throw new GameException(409, "Esse modo precisa de {$min} a {$max} jogadores");
            }
            foreach ($players as $p) {
                if ((int) $p['is_ready'] !== 1) {
                    throw new GameException(409, 'Todo mundo precisa dar o "pronto" antes de começar');
                }
            }

            $rounds = (int) $room['total_rounds'];
            $picked = $this->cards->pick($rounds + 3);
            if (count($picked) < $rounds) {
                throw new GameException(503, 'Deck insuficiente');
            }
            for ($i = 0; $i < $rounds; $i++) {
                $this->createRoundRow($roomId, $i + 1, (int) $picked[$i]['id']);
                $this->cards->markUsed((int) $picked[$i]['id']);
            }

            $this->rooms->updateFields($roomId, [
                'status' => 'playing',
                'round_number' => 1,
                'clue_index' => 0,
                'phase' => 'clue',
                'sudden_death' => 0,
            ]);
            $this->setTimer($roomId, $this->clueSeconds($room));
        });
    }

    public function skipCard(string $token): void
    {
        Db::txn(function () use ($token): void {
            $player = $this->players->lockByToken($token);
            if ($player === null) {
                throw new GameException(403, 'Sessão inválida');
            }
            $room = $this->rooms->lockById((int) $player['room_id']);
            $roomId = (int) $room['id'];

            if ((int) $player['is_host'] !== 1) {
                throw new GameException(403, 'Só o host pode pular a carta');
            }
            if ((string) $room['status'] !== 'playing' || (string) $room['phase'] !== 'clue') {
                throw new GameException(409, 'Não é possível agora');
            }
            if ((int) $room['card_skips'] >= 1) {
                throw new GameException(409, 'O host só pode pular uma carta por partida');
            }

            $roundRow = $this->roundRow($roomId, (int) $room['round_number']);
            if ($roundRow === null) {
                throw new GameException(500, 'Rodada inválida');
            }

            $oldCardId = (int) $roundRow['card_id'];
            $fresh = $this->cards->pick(1);
            if ($fresh === []) {
                throw new GameException(503, 'Deck vazio');
            }
            $newCardId = (int) $fresh[0]['id'];

            Db::pdo()->prepare('UPDATE room_rounds SET card_id = ?, skipped = 1 WHERE id = ?')
                ->execute([$newCardId, $roundRow['id']]);
            $this->cards->markSkippedUnuse($oldCardId);
            $this->cards->markUsed($newCardId);

            $this->rooms->updateFields($roomId, [
                'card_skips' => (int) $room['card_skips'] + 1,
                'clue_index' => 0,
                'phase' => 'clue',
            ]);
            $this->setTimer($roomId, $this->clueSeconds($room));
        });
    }

    public function leave(string $token): void
    {
        Db::txn(function () use ($token): void {
            $player = $this->players->lockByToken($token);
            if ($player === null) {
                return;
            }
            $room = $this->rooms->lockById((int) $player['room_id']);
            $roomId = (int) $room['id'];
            $wasHost = (int) $player['is_host'] === 1;

            if ((string) $room['status'] === 'lobby') {
                $this->players->delete((int) $player['id']);
                if ($wasHost) {
                    $this->players->transferHost($roomId);
                }
            } else {
                Db::pdo()->prepare('UPDATE players SET connected = 0 WHERE id = ?')
                    ->execute([$player['id']]);
            }
            $this->bumpVersion($roomId, (string) $room['phase']);
        });
    }

    public function rematch(string $token): void
    {
        Db::txn(function () use ($token): void {
            $player = $this->players->lockByToken($token);
            if ($player === null) {
                throw new GameException(403, 'Sessão inválida');
            }
            $room = $this->rooms->lockById((int) $player['room_id']);
            if ((int) $player['is_host'] !== 1) {
                throw new GameException(403, 'Só o host pode reabrir a sala');
            }
            if ((string) $room['status'] !== 'finished') {
                throw new GameException(409, 'A partida só pode ser reaberta ao terminar');
            }
            $this->rooms->resetForRematch((int) $room['id']);
            Db::pdo()->prepare(
                'UPDATE players SET score = 0, is_ready = 0, last_answer_at = NULL WHERE room_id = ?'
            )->execute([$room['id']]);
        });
    }

    // ==================================================================
    // Resposta
    // ==================================================================

    public function answer(string $token, string $guess): array
    {
        $clean = trim((string) mb_substr($guess, 0, 120));
        if ($clean === '') {
            throw new GameException(400, 'Resposta vazia');
        }

        return Db::txn(function () use ($token, $clean): array {
            $player = $this->players->lockByToken($token);
            if ($player === null) {
                throw new GameException(403, 'Sessão inválida');
            }
            $room = $this->rooms->lockById((int) $player['room_id']);
            $this->tick($room);

            if ((string) $room['status'] !== 'playing' || (string) $room['phase'] !== 'clue') {
                throw new GameException(409, 'A pista não está aberta agora');
            }

            $roomId = (int) $room['id'];
            $round = (int) $room['round_number'];
            $clue = (int) $room['clue_index'];
            $playerId = (int) $player['id'];
            $mode = (string) $room['mode'];

            if ((int) $room['sudden_death'] === 1 && !$this->isLeader($room, $player)) {
                throw new GameException(403, 'A morte súbita é só entre os empatados');
            }

            $used = $this->answers->countAtClue($roomId, $round, $clue, $playerId);
            if ($used >= self::TRIES_PER_CLUE) {
                throw new GameException(409, 'Você já usou as 3 tentativas nesta pista');
            }

            $lockMs = $this->answers->lastAnswerAtMs($playerId);
            if ($lockMs !== null && $lockMs < self::LOCK_MS) {
                throw new GameException(429, 'Aguarde um instante para tentar de novo');
            }

            $roundRow = $this->roundRow($roomId, $round);
            if ($roundRow === null) {
                throw new GameException(500, 'Rodada inválida');
            }
            $card = $this->cards->get((int) $roundRow['card_id']);
            if ($card === null) {
                throw new GameException(500, 'Carta não encontrada');
            }

            $correct = AnswerMatcher::match($card, $clean);
            $points = $correct ? AnswerMatcher::pointsForClue($clue) : 0;

            $this->answers->record([
                'room_id' => $roomId,
                'round_number' => $round,
                'clue_index' => $clue,
                'player_id' => $playerId,
                'raw_answer' => $clean,
                'normalized' => Str::normalizeAnswer($clean),
                'is_correct' => $correct,
                'points' => $points,
                'latency_ms' => 0,
            ]);

            if ($correct) {
                if ($mode === 'duel') {
                    $this->players->addPointsToPlayer($playerId, $points);
                    $this->goReveal($roomId);
                } elseif ($mode === 'teams') {
                    $team = (int) ($player['team'] ?? 0);
                    $this->players->addPointsToTeam($roomId, $team, $points);
                    $this->goReveal($roomId);
                } else { // royale
                    $this->players->addPointsToPlayer($playerId, $points);
                    if ($this->everyoneScored($roomId, $round)) {
                        $this->goReveal($roomId);
                    } else {
                        $this->bumpVersion($roomId, (string) $room['phase']);
                    }
                }
            } else {
                Db::pdo()->prepare('UPDATE players SET last_answer_at = NOW(3) WHERE id = ?')
                    ->execute([$playerId]);
                $this->bumpVersion($roomId, (string) $room['phase']);
            }

            return ['correct' => $correct, 'points' => $points];
        });
    }

    // ==================================================================
    // Relógio do jogo — chamado com lock da sala aberto
    // ==================================================================

    public function tick(array &$room): void
    {
        for ($i = 0; $i < 20; $i++) {
            if ((string) $room['status'] !== 'playing') {
                return;
            }
            $phase = (string) $room['phase'];
            if (($phase !== 'clue' && $phase !== 'reveal') || !$this->rooms->isPhaseExpired((int) $room['id'])) {
                return;
            }
            if ($phase === 'clue') {
                $this->endClue($room);
            } else {
                $this->nextStep($room);
            }
            $room = $this->rooms->getById((int) $room['id']) ?? $room;
        }
    }

    private function endClue(array $room): void
    {
        $roomId = (int) $room['id'];
        $clue = (int) $room['clue_index'];
        if ($clue < 2) {
            $this->rooms->updateFields($roomId, ['clue_index' => $clue + 1, 'phase' => 'clue']);
            $this->setTimer($roomId, $this->clueSeconds($room));
            return;
        }
        $this->goReveal($roomId);
    }

    private function nextStep(array $room): void
    {
        $roomId = (int) $room['id'];
        $roundNum = (int) $room['round_number'];
        $total = (int) $room['total_rounds'];
        $phase = (string) $room['phase'];
        unset($phase);

        Db::pdo()->prepare(
            'UPDATE room_rounds SET resolved_at = NOW() WHERE room_id = ? AND round_number = ? AND resolved_at IS NULL'
        )->execute([$roomId, $roundNum]);

        if ((int) $room['sudden_death'] === 1) {
            $scorers = $this->answers->scorersOfRound($roomId, $roundNum);
            if (count($scorers) === 0 && ($roundNum - $total) < self::MAX_SUDDEN_DEATHS) {
                $this->startSuddenDeath($roomId, $roundNum + 1);
                return;
            }
            $this->finish($roomId);
            return;
        }

        if ($roundNum >= $total) {
            if ((string) $room['mode'] !== 'teams' && count($this->leaderSet($room)) > 1) {
                $this->startSuddenDeath($roomId, $roundNum + 1);
                return;
            }
            $this->finish($roomId);
            return;
        }

        if ($this->roundRow($roomId, $roundNum + 1) === null) {
            $this->finish($roomId);
            return;
        }
        $this->rooms->updateFields($roomId, [
            'round_number' => $roundNum + 1,
            'clue_index' => 0,
            'phase' => 'clue',
        ]);
        $this->setTimer($roomId, $this->clueSeconds($room));
    }

    private function goReveal(int $roomId): void
    {
        $this->rooms->updateFields($roomId, ['phase' => 'reveal']);
        $this->setTimer($roomId, self::REVEAL_SECONDS);
    }

    private function finish(int $roomId): void
    {
        $this->rooms->updateFields($roomId, [
            'status' => 'finished',
            'phase' => 'result',
            'phase_ends_at' => null,
        ]);
    }

    private function startSuddenDeath(int $roomId, int $roundNumber): void
    {
        $fresh = $this->cards->pick(1);
        if ($fresh === []) {
            $this->finish($roomId);
            return;
        }
        $this->createRoundRow($roomId, $roundNumber, (int) $fresh[0]['id']);
        $this->cards->markUsed((int) $fresh[0]['id']);

        $room = $this->rooms->getById($roomId);
        $seconds = $room !== null ? $this->clueSeconds($room) : 25;

        $this->rooms->updateFields($roomId, [
            'sudden_death' => 1,
            'round_number' => $roundNumber,
            'clue_index' => 0,
            'phase' => 'clue',
        ]);
        $this->setTimer($roomId, $seconds);
    }

    // ==================================================================
    // Ajudantes
    // ==================================================================

    private function lockByCode(string $code): array
    {
        $stmt = Db::pdo()->prepare('SELECT * FROM rooms WHERE code = ? FOR UPDATE');
        $stmt->execute([mb_strtoupper(trim($code))]);
        $row = $stmt->fetch();
        if ($row === false) {
            throw new GameException(404, 'Sala não encontrada');
        }
        return $row;
    }

    private function roundRow(int $roomId, int $roundNumber): ?array
    {
        $stmt = Db::pdo()->prepare(
            'SELECT * FROM room_rounds WHERE room_id = ? AND round_number = ?'
        );
        $stmt->execute([$roomId, $roundNumber]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    public function roundCard(int $roomId, int $roundNumber): ?array
    {
        $stmt = Db::pdo()->prepare(
            'SELECT c.id, c.answer, c.answer_norm, c.aliases, c.clues, c.category, c.difficulty
             FROM room_rounds r JOIN cards c ON c.id = r.card_id
             WHERE r.room_id = ? AND r.round_number = ?'
        );
        $stmt->execute([$roomId, $roundNumber]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    private function createRoundRow(int $roomId, int $roundNumber, int $cardId): void
    {
        Db::pdo()->prepare(
            'INSERT INTO room_rounds (room_id, round_number, card_id) VALUES (?, ?, ?)'
        )->execute([$roomId, $roundNumber, $cardId]);
    }

    public function bumpVersion(int $roomId, string $phase): void
    {
        $this->rooms->updateFields($roomId, ['phase' => $phase]);
    }

    private function setTimer(int $roomId, int $seconds): void
    {
        Db::pdo()->prepare(
            'UPDATE rooms SET phase_ends_at = DATE_ADD(NOW(3), INTERVAL ? SECOND) WHERE id = ?'
        )->execute([$seconds, $roomId]);
    }

    private function stats(array $room): array
    {
        return json_decode((string) $room['settings'], true) ?: [];
    }

    private function clueSeconds(array $room): int
    {
        $value = (int) ($this->stats($room)['clueSeconds'] ?? 25);
        return max(10, min(60, $value));
    }

    private function sanitizeRounds(mixed $value): int
    {
        $value = (int) $value;
        return in_array($value, [5, 7, 10], true) ? $value : 7;
    }

    private function sanitizeClueSeconds(mixed $value): int
    {
        $value = (int) $value;
        return in_array($value, [15, 20, 25, 30], true) ? $value : 25;
    }

    private function pickTeam(int $roomId): int
    {
        $teamZero = $this->players->countInTeam($roomId, 0);
        $teamOne = $this->players->countInTeam($roomId, 1);
        return $teamOne < $teamZero ? 1 : 0;
    }

    /** Só quem está empatado no topo pode responder na morte súbita. */
    private function leaderSet(array $room): array
    {
        if ((string) $room['mode'] === 'teams') {
            return [];
        }
        $board = $this->players->leaderboard((int) $room['id']);
        $top = $board === [] ? 0 : (int) $board[0]['score'];
        $leaders = [];
        foreach ($board as $row) {
            if ((int) $row['score'] === $top) {
                $leaders[] = (int) $row['id'];
            }
        }
        return $leaders;
    }

    private function isLeader(array $room, array $player): bool
    {
        $leaders = $this->leaderSet($room);
        if ($leaders === []) {
            return true;
        }
        return in_array((int) $player['id'], $leaders, true);
    }

    private function everyoneScored(int $roomId, int $round): bool
    {
        $players = $this->players->listByRoom($roomId);
        if ($players === []) {
            return false;
        }
        $scorers = $this->answers->scorersOfRound($roomId, $round);
        $scoredIds = array_values(array_unique(array_map(
            static fn (array $r): int => (int) $r['id'],
            $scorers
        )));
        foreach ($players as $p) {
            if ((int) $p['connected'] === 0) {
                continue;
            }
            if (!in_array((int) $p['id'], $scoredIds, true)) {
                return false;
            }
        }
        return true;
    }

    // ==================================================================
    // Projeção de estado para o cliente
    // ==================================================================

    public function projectState(array $room, ?array $me): array
    {
        $status = (string) $room['status'];
        $phase = (string) $room['phase'];
        $roomId = (int) $room['id'];
        $roundNumber = (int) $room['round_number'];

        $playersOut = [];
        foreach ($this->players->listByRoom($roomId) as $p) {
            $playersOut[] = [
                'id' => (int) $p['id'],
                'name' => (string) $p['name'],
                'seat' => (int) $p['seat'],
                'team' => $p['team'] === null ? null : (int) $p['team'],
                'score' => (int) $p['score'],
                'isHost' => (bool) $p['is_host'],
                'isReady' => (bool) $p['is_ready'],
                'connected' => (bool) $p['connected'],
            ];
        }

        $serverNowMs = (int) floor(
            (float) Db::pdo()->query('SELECT UNIX_TIMESTAMP(NOW(3))')->fetchColumn() * 1000
        );

        $state = [
            'version' => (int) $room['version'],
            'serverNow' => $serverNowMs,
            'room' => [
                'code' => (string) $room['code'],
                'mode' => (string) $room['mode'],
                'status' => $status,
                'phase' => $phase,
                'roundNumber' => $roundNumber,
                'totalRounds' => (int) $room['total_rounds'],
                'clueIndex' => (int) $room['clue_index'],
                'suddenDeath' => (bool) $room['sudden_death'],
                'canSkipCard' => (int) $room['card_skips'] < 1,
                'settings' => $this->stats($room),
            ],
            'phaseEndsInMs' => $this->rooms->phaseEndsInMs($roomId),
            'players' => $playersOut,
            'me' => null,
            'round' => null,
            'result' => null,
        ];

        if ($me !== null) {
            $meId = (int) $me['id'];
            $triesLeft = null;
            if ($status === 'playing' && $phase === 'clue') {
                $triesLeft = self::TRIES_PER_CLUE - $this->answers->countAtClue($roomId, $roundNumber, (int) $room['clue_index'], $meId);
            }
            $lockMs = $this->answers->lastAnswerAtMs($meId);
            $lockedForMs = ($lockMs !== null && $lockMs < self::LOCK_MS) ? self::LOCK_MS - $lockMs : 0;
            $state['me'] = [
                'id' => $meId,
                'name' => (string) $me['name'],
                'seat' => (int) $me['seat'],
                'team' => $me['team'] === null ? null : (int) $me['team'],
                'score' => (int) $me['score'],
                'isHost' => (bool) $me['is_host'],
                'isReady' => (bool) $me['is_ready'],
                'triesLeft' => $triesLeft,
                'lockedForMs' => $lockedForMs,
            ];
        }

        $needsRoundPick = $status === 'playing'
            || ($status === 'finished' && $roundNumber >= 1);

        if ($needsRoundPick) {
            $card = $this->roundCard($roomId, $roundNumber);
            if ($card !== null) {
                $clues = json_decode((string) $card['clues'], true);
                $clues = is_array($clues) ? array_values($clues) : [];

                $showAnswer = $phase === 'reveal' || $status === 'finished';
                $revealed = $showAnswer
                    ? array_slice($clues, 0, max(3, count($clues)))
                    : array_slice($clues, 0, (int) $room['clue_index'] + 1);

                $scorers = [];
                foreach ($this->answers->scorersOfRound($roomId, $roundNumber) as $s) {
                    $scorers[] = [
                        'playerId' => (int) $s['id'],
                        'name' => (string) $s['name'],
                        'seat' => isset($s['seat']) ? (int) $s['seat'] : null,
                        'team' => isset($s['team']) ? (int) $s['team'] : null,
                        'points' => (int) $s['points'],
                        'clue' => (int) $s['clue'],
                    ];
                }

                $state['round'] = [
                    'isSuddenDeath' => (bool) $room['sudden_death'],
                    'revealedClues' => $revealed,
                    'activeClue' => $showAnswer ? count($clues) - 1 : (int) $room['clue_index'],
                    'cluePoints' => AnswerMatcher::pointsForClue($showAnswer ? count($clues) - 1 : (int) $room['clue_index']),
                    'answer' => $showAnswer ? (string) $card['answer'] : null,
                    'category' => (string) $card['category'],
                    'scorers' => $scorers,
                ];
            }
        }

        if ($status === 'finished') {
            $stats = $this->answers->stats($roomId);
            $ranking = [];
            foreach ($this->players->leaderboard($roomId) as $row) {
                $id = (int) $row['id'];
                $s = $stats[$id] ?? ['tries' => 0, 'hits' => 0, 'points' => 0];
                $ranking[] = [
                    'id' => $id,
                    'name' => (string) $row['name'],
                    'seat' => (int) $row['seat'],
                    'team' => $row['team'] === null ? null : (int) $row['team'],
                    'score' => (int) $row['score'],
                    'tries' => $s['tries'],
                    'hits' => $s['hits'],
                ];
            }

            $teamScore = $this->players->teamsById($roomId);
            $teamRanking = array_map(
                static fn (array $r): array => [
                    'team' => (int) $r['team'],
                    'score' => (int) $r['total'],
                ],
                array_values($this->players->leaderboard($roomId, true))
            );

            $state['result'] = [
                'ranking' => $ranking,
                'teamScores' => $teamScore,
                'teamRanking' => $teamRanking,
            ];
        }

        return $state;
    }
}

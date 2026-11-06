// Espelho de server/src/Domain/GameEngine.php
// Regras: 3 pistas (10/7/4 pontos), 3 tentativas por pista, lockout de 1,5s,
// morte súbita, skip-card 1x, rematch. Números idênticos ao PHP.
import { query, queryOne, toNumber, withTransaction } from '../db/pool.js';
import { AnswerRepository } from '../repos/answers.js';
import { CardRepository } from '../repos/cards.js';
import { PlayerRepository } from '../repos/players.js';
import { RoomRepository } from '../repos/rooms.js';
import type { CardRow, PlayerRow, RoomRow } from '../repos/types.js';
import { normalizeAnswer, normalizeName, shortName } from '../support/str.js';
import { generateToken, hashToken } from '../support/token.js';
import { matches, parseJsonArray, parseJsonObject, pointsForClue } from './answer-matcher.js';

/** Erro de jogo com código HTTP amigável. */
export class GameException extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const REVEAL_SECONDS = 6;
export const LOCK_MS = 1500;
export const TRIES_PER_CLUE = 3;
export const MAX_SUDDEN_DEATHS = 3;

export const MIN_PLAYERS: Record<string, number> = { duel: 2, teams: 4, royale: 3 };
export const MAX_PLAYERS: Record<string, number> = { duel: 2, teams: 4, royale: 8 };
const MODES = ['duel', 'teams', 'royale'];

export class GameEngine {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly players: PlayerRepository,
    private readonly cards: CardRepository,
    private readonly answers: AnswerRepository,
  ) {}

  // ==================================================================
  // Criação e entrada
  // ==================================================================

  async createRoom(modeRaw: string, nameRaw: string, settings: Record<string, unknown>): Promise<{
    room: RoomRow;
    player: PlayerRow;
    token: string;
  }> {
    const mode = MODES.includes(modeRaw) ? modeRaw : (() => { throw new GameException(400, 'Modo inválido'); })();

    const rounds = sanitizeRounds(settings['rounds'] ?? 7);
    const clueSeconds = sanitizeClueSeconds(settings['clueSeconds'] ?? 25);
    const clean = shortName(nameRaw);
    const cleanNorm = normalizeName(clean);
    if (cleanNorm === '' || [...clean].length < 2) {
      throw new GameException(400, 'Apelido muito curto (mínimo 2 caracteres)');
    }

    return withTransaction(async () => {
      const room = await this.rooms.create({
        code: await this.rooms.generateCode(),
        mode,
        total_rounds: rounds,
        settings: { clueSeconds },
      });

      const token = generateToken();
      const player = await this.players.create({
        room_id: toNumber(room.id),
        name: clean,
        name_norm: cleanNorm,
        team: mode === 'teams' ? await this.pickTeam(toNumber(room.id)) : null,
        seat: 0,
        is_host: true,
        token_hash: hashToken(token),
      });

      return { room, player, token };
    });
  }

  async joinRoom(codeRaw: string, nameRaw: string): Promise<{
    room: RoomRow;
    player: PlayerRow;
    token: string;
  }> {
    const clean = shortName(nameRaw);
    const cleanNorm = normalizeName(clean);
    if (cleanNorm === '' || [...clean].length < 2) {
      throw new GameException(400, 'Apelido muito curto (mínimo 2 caracteres)');
    }

    return withTransaction(async () => {
      const room = await this.lockByCode(codeRaw);
      if (room.status !== 'lobby') {
        throw new GameException(409, 'A sala já começou ou encerrou');
      }
      const roomId = toNumber(room.id);
      const mode = room.mode;
      const count = await this.players.count(roomId);
      const max = MAX_PLAYERS[mode] ?? 8;
      if (count >= max) {
        throw new GameException(409, 'A sala está cheia');
      }
      if (await this.players.findByName(roomId, cleanNorm)) {
        throw new GameException(409, 'Esse apelido já está em uso na sala');
      }

      const token = generateToken();
      const player = await this.players.create({
        room_id: roomId,
        name: clean,
        name_norm: cleanNorm,
        team: mode === 'teams' ? await this.pickTeam(roomId) : null,
        seat: await this.players.nextSeat(roomId),
        is_host: false,
        token_hash: hashToken(token),
      });
      await this.bumpVersion(roomId, room.phase);
      return { room, player, token };
    });
  }

  // ==================================================================
  // Fluxo de sala
  // ==================================================================

  async ready(token: string): Promise<void> {
    await withTransaction(async () => {
      const player = await this.players.lockByToken(token);
      if (!player) {
        throw new GameException(403, 'Sessão inválida');
      }
      await this.players.setReady(toNumber(player.id), !player.is_ready);
      // is_ready vive em players, mas o ETag do polling vem de rooms.version.
      // Sem este bump o cliente recebe 304 e nunca vê o "pronto" mudar.
      await this.rooms.bumpVersion(toNumber(player.room_id));
    });
  }

  async start(token: string): Promise<void> {
    await withTransaction(async () => {
      const player = await this.players.lockByToken(token);
      if (!player) {
        throw new GameException(403, 'Sessão inválida');
      }
      const room = await this.rooms.lockById(toNumber(player.room_id));
      const roomId = toNumber(room.id);

      if (!player.is_host) {
        throw new GameException(403, 'Só o host pode iniciar a partida');
      }
      if (room.status !== 'lobby') {
        throw new GameException(409, 'A partida já começou');
      }

      const players = await this.players.lockAllByRoom(roomId);
      const count = players.length;
      const mode = room.mode;
      const min = MIN_PLAYERS[mode] ?? 2;
      const max = MAX_PLAYERS[mode] ?? 8;
      if (count < min || count > max) {
        throw new GameException(409, `Esse modo precisa de ${min} a ${max} jogadores`);
      }
      for (const p of players) {
        if (!p.is_ready) {
          throw new GameException(409, 'Todo mundo precisa dar o "pronto" antes de começar');
        }
      }

      const rounds = Number(room.total_rounds);
      const picked = await this.cards.pick(rounds + 3);
      if (picked.length < rounds) {
        throw new GameException(503, 'Deck insuficiente');
      }
      for (let i = 0; i < rounds; i++) {
        await this.createRoundRow(roomId, i + 1, toNumber(picked[i]!.id));
        await this.cards.markUsed(toNumber(picked[i]!.id));
      }

      await this.rooms.updateFields(roomId, {
        status: 'playing',
        round_number: 1,
        clue_index: 0,
        phase: 'clue',
        sudden_death: false,
      });
      await this.setTimer(roomId, this.clueSeconds(room));
    });
  }

  async skipCard(token: string): Promise<void> {
    await withTransaction(async () => {
      const player = await this.players.lockByToken(token);
      if (!player) {
        throw new GameException(403, 'Sessão inválida');
      }
      const room = await this.rooms.lockById(toNumber(player.room_id));
      const roomId = toNumber(room.id);

      if (!player.is_host) {
        throw new GameException(403, 'Só o host pode pular a carta');
      }
      if (room.status !== 'playing' || room.phase !== 'clue') {
        throw new GameException(409, 'Não é possível agora');
      }
      if (Number(room.card_skips) >= 1) {
        throw new GameException(409, 'O host só pode pular uma carta por partida');
      }

      const roundRow = await this.roundRow(roomId, Number(room.round_number));
      if (!roundRow) {
        throw new GameException(500, 'Rodada inválida');
      }

      const oldCardId = toNumber(roundRow.card_id);
      const fresh = await this.cards.pick(1);
      if (fresh.length === 0) {
        throw new GameException(503, 'Deck vazio');
      }
      const newCardId = toNumber(fresh[0]!.id);

      await query('UPDATE room_rounds SET card_id = $1, skipped = TRUE WHERE id = $2', [newCardId, roundRow.id]);
      await this.cards.markSkippedUnuse(oldCardId);
      await this.cards.markUsed(newCardId);

      await this.rooms.updateFields(roomId, {
        card_skips: Number(room.card_skips) + 1,
        clue_index: 0,
        phase: 'clue',
      });
      await this.setTimer(roomId, this.clueSeconds(room));
    });
  }

  async leave(token: string): Promise<void> {
    await withTransaction(async () => {
      const player = await this.players.lockByToken(token);
      if (!player) {
        return;
      }
      const room = await this.rooms.lockById(toNumber(player.room_id));
      const roomId = toNumber(room.id);
      const wasHost = player.is_host;

      if (room.status === 'lobby') {
        await this.players.delete(toNumber(player.id));
        if (wasHost) {
          await this.players.transferHost(roomId);
        }
      } else {
        await query('UPDATE players SET connected = FALSE WHERE id = $1', [player.id]);
      }
      await this.bumpVersion(roomId, room.phase);
    });
  }

  async rematch(token: string): Promise<void> {
    await withTransaction(async () => {
      const player = await this.players.lockByToken(token);
      if (!player) {
        throw new GameException(403, 'Sessão inválida');
      }
      const room = await this.rooms.lockById(toNumber(player.room_id));
      if (!player.is_host) {
        throw new GameException(403, 'Só o host pode reabrir a sala');
      }
      if (room.status !== 'finished') {
        throw new GameException(409, 'A partida só pode ser reaberta ao terminar');
      }
      await this.rooms.resetForRematch(toNumber(room.id));
      await query('UPDATE players SET score = 0, is_ready = FALSE, last_answer_at = NULL WHERE room_id = $1', [
        room.id,
      ]);
    });
  }

  // ==================================================================
  // Resposta
  // ==================================================================

  async answer(token: string, guessRaw: string): Promise<{ correct: boolean; points: number }> {
    const clean = [...guessRaw].slice(0, 120).join('').trim();
    if (clean === '') {
      throw new GameException(400, 'Resposta vazia');
    }

    return withTransaction(async () => {
      const player = await this.players.lockByToken(token);
      if (!player) {
        throw new GameException(403, 'Sessão inválida');
      }
      let room = await this.rooms.lockById(toNumber(player.room_id));
      room = await this.tick(room);

      if (room.status !== 'playing' || room.phase !== 'clue') {
        throw new GameException(409, 'A pista não está aberta agora');
      }

      const roomId = toNumber(room.id);
      const round = Number(room.round_number);
      const clue = Number(room.clue_index);
      const playerId = toNumber(player.id);
      const mode = room.mode;

      if (room.sudden_death && !(await this.isLeader(room, player))) {
        throw new GameException(403, 'A morte súbita é só entre os empatados');
      }

      const used = await this.answers.countAtClue(roomId, round, clue, playerId);
      if (used >= TRIES_PER_CLUE) {
        throw new GameException(409, 'Você já usou as 3 tentativas nesta pista');
      }

      const lockMs = await this.answers.lastAnswerAtMs(playerId);
      if (lockMs !== null && lockMs < LOCK_MS) {
        throw new GameException(429, 'Aguarde um instante para tentar de novo');
      }

      const roundRow = await this.roundRow(roomId, round);
      if (!roundRow) {
        throw new GameException(500, 'Rodada inválida');
      }
      const card = await this.cards.get(toNumber(roundRow.card_id));
      if (!card) {
        throw new GameException(500, 'Carta não encontrada');
      }

      const correct = matches(card, clean);
      const points = correct ? pointsForClue(clue) : 0;

      await this.answers.record({
        room_id: roomId,
        round_number: round,
        clue_index: clue,
        player_id: playerId,
        raw_answer: clean,
        normalized: normalizeAnswer(clean),
        is_correct: correct,
        points,
        latency_ms: 0,
      });

      if (correct) {
        if (mode === 'duel') {
          await this.players.addPointsToPlayer(playerId, points);
          await this.goReveal(roomId);
        } else if (mode === 'teams') {
          const team = Number(player.team ?? 0);
          await this.players.addPointsToTeam(roomId, team, points);
          await this.goReveal(roomId);
        } else {
          // royale
          await this.players.addPointsToPlayer(playerId, points);
          if (await this.everyoneScored(roomId, round)) {
            await this.goReveal(roomId);
          } else {
            await this.bumpVersion(roomId, room.phase);
          }
        }
      } else {
        await query('UPDATE players SET last_answer_at = NOW() WHERE id = $1', [playerId]);
        await this.bumpVersion(roomId, room.phase);
      }

      return { correct, points };
    });
  }

  // ==================================================================
  // Relógio do jogo — chamado com lock da sala aberto
  // ==================================================================

  async tick(room: RoomRow): Promise<RoomRow> {
    let current = room;
    for (let i = 0; i < 20; i++) {
      if (current.status !== 'playing') {
        return current;
      }
      const phase = current.phase;
      if ((phase !== 'clue' && phase !== 'reveal') || !(await this.rooms.isPhaseExpired(toNumber(current.id)))) {
        return current;
      }
      if (phase === 'clue') {
        await this.endClue(current);
      } else {
        await this.nextStep(current);
      }
      current = (await this.rooms.getById(toNumber(current.id))) ?? current;
    }
    return current;
  }

  private async endClue(room: RoomRow): Promise<void> {
    const roomId = toNumber(room.id);
    const clue = Number(room.clue_index);
    if (clue < 2) {
      await this.rooms.updateFields(roomId, { clue_index: clue + 1, phase: 'clue' });
      await this.setTimer(roomId, this.clueSeconds(room));
      return;
    }
    await this.goReveal(roomId);
  }

  private async nextStep(room: RoomRow): Promise<void> {
    const roomId = toNumber(room.id);
    const roundNum = Number(room.round_number);
    const total = Number(room.total_rounds);

    await query(
      'UPDATE room_rounds SET resolved_at = NOW() WHERE room_id = $1 AND round_number = $2 AND resolved_at IS NULL',
      [roomId, roundNum],
    );

    if (room.sudden_death) {
      const scorers = await this.answers.scorersOfRound(roomId, roundNum);
      if (scorers.length === 0 && roundNum - total < MAX_SUDDEN_DEATHS) {
        await this.startSuddenDeath(roomId, roundNum + 1);
        return;
      }
      await this.finish(roomId);
      return;
    }

    if (roundNum >= total) {
      if (room.mode !== 'teams' && (await this.leaderSet(room)).length > 1) {
        await this.startSuddenDeath(roomId, roundNum + 1);
        return;
      }
      await this.finish(roomId);
      return;
    }

    if (!(await this.roundRow(roomId, roundNum + 1))) {
      await this.finish(roomId);
      return;
    }
    await this.rooms.updateFields(roomId, {
      round_number: roundNum + 1,
      clue_index: 0,
      phase: 'clue',
    });
    await this.setTimer(roomId, this.clueSeconds(room));
  }

  private async goReveal(roomId: number): Promise<void> {
    await this.rooms.updateFields(roomId, { phase: 'reveal' });
    await this.setTimer(roomId, REVEAL_SECONDS);
  }

  private async finish(roomId: number): Promise<void> {
    await this.rooms.updateFields(roomId, {
      status: 'finished',
      phase: 'result',
      phase_ends_at: null,
    });
  }

  private async startSuddenDeath(roomId: number, roundNumber: number): Promise<void> {
    const fresh = await this.cards.pick(1);
    if (fresh.length === 0) {
      await this.finish(roomId);
      return;
    }
    await this.createRoundRow(roomId, roundNumber, toNumber(fresh[0]!.id));
    await this.cards.markUsed(toNumber(fresh[0]!.id));

    const room = await this.rooms.getById(roomId);
    const seconds = room ? this.clueSeconds(room) : 25;

    await this.rooms.updateFields(roomId, {
      sudden_death: true,
      round_number: roundNumber,
      clue_index: 0,
      phase: 'clue',
    });
    await this.setTimer(roomId, seconds);
  }

  // ==================================================================
  // Ajudantes
  // ==================================================================

  private async lockByCode(code: string): Promise<RoomRow> {
    const row = await queryOne<RoomRow>('SELECT * FROM rooms WHERE code = $1 FOR UPDATE', [
      code.trim().toUpperCase(),
    ]);
    if (!row) {
      throw new GameException(404, 'Sala não encontrada');
    }
    return row;
  }

  private async roundRow(roomId: number, roundNumber: number): Promise<{ id: string; card_id: string } | undefined> {
    return queryOne<{ id: string; card_id: string }>(
      'SELECT * FROM room_rounds WHERE room_id = $1 AND round_number = $2',
      [roomId, roundNumber],
    );
  }

  async roundCard(roomId: number, roundNumber: number): Promise<CardRow | undefined> {
    return queryOne<CardRow>(
      `SELECT c.id, c.answer, c.answer_norm, c.aliases, c.clues, c.category, c.difficulty
         FROM room_rounds r JOIN cards c ON c.id = r.card_id
        WHERE r.room_id = $1 AND r.round_number = $2`,
      [roomId, roundNumber],
    );
  }

  private async createRoundRow(roomId: number, roundNumber: number, cardId: number): Promise<void> {
    await query('INSERT INTO room_rounds (room_id, round_number, card_id) VALUES ($1, $2, $3)', [
      roomId,
      roundNumber,
      cardId,
    ]);
  }

  async bumpVersion(roomId: number, phase: string): Promise<void> {
    await this.rooms.updateFields(roomId, { phase });
  }

  private async setTimer(roomId: number, seconds: number): Promise<void> {
    await query('UPDATE rooms SET phase_ends_at = NOW() + make_interval(secs => $1) WHERE id = $2', [seconds, roomId]);
  }

  private stats(room: RoomRow): Record<string, unknown> {
    return parseJsonObject(room.settings);
  }

  private clueSeconds(room: RoomRow): number {
    const value = Number(this.stats(room)['clueSeconds'] ?? 25);
    return Math.max(10, Math.min(60, Number.isFinite(value) ? value : 25));
  }

  private async pickTeam(roomId: number): Promise<number> {
    const teamZero = await this.players.countInTeam(roomId, 0);
    const teamOne = await this.players.countInTeam(roomId, 1);
    return teamOne < teamZero ? 1 : 0;
  }

  /** Só quem está empatado no topo pode responder na morte súbita. */
  private async leaderSet(room: RoomRow): Promise<number[]> {
    if (room.mode === 'teams') {
      return [];
    }
    const board = await this.players.leaderboard(toNumber(room.id));
    const top = board.length === 0 ? 0 : toNumber(board[0]!['score']);
    const leaders: number[] = [];
    for (const row of board) {
      if (toNumber(row['score']) === top) {
        leaders.push(toNumber(row['id']));
      }
    }
    return leaders;
  }

  private async isLeader(room: RoomRow, player: PlayerRow): Promise<boolean> {
    const leaders = await this.leaderSet(room);
    if (leaders.length === 0) {
      return true;
    }
    return leaders.includes(toNumber(player.id));
  }

  private async everyoneScored(roomId: number, round: number): Promise<boolean> {
    const players = await this.players.listByRoom(roomId);
    if (players.length === 0) {
      return false;
    }
    const scorers = await this.answers.scorersOfRound(roomId, round);
    const scoredIds = [...new Set(scorers.map((r) => toNumber(r.id)))];
    for (const p of players) {
      if (!p.connected) {
        continue;
      }
      if (!scoredIds.includes(toNumber(p.id))) {
        return false;
      }
    }
    return true;
  }

  // ==================================================================
  // Projeção de estado para o cliente
  // ==================================================================

  async projectState(room: RoomRow, me: PlayerRow | null): Promise<Record<string, unknown>> {
    const status = room.status;
    const phase = room.phase;
    const roomId = toNumber(room.id);
    const roundNumber = Number(room.round_number);

    const playersList = await this.players.listByRoom(roomId);
    const playersOut = playersList.map((p) => ({
      id: toNumber(p.id),
      name: p.name,
      seat: Number(p.seat),
      team: p.team === null || p.team === undefined ? null : Number(p.team),
      score: Number(p.score),
      isHost: Boolean(p.is_host),
      isReady: Boolean(p.is_ready),
      connected: Boolean(p.connected),
    }));

    const state: Record<string, unknown> = {
      version: Number(room.version),
      serverNow: Date.now(),
      room: {
        code: room.code,
        mode: room.mode,
        status,
        phase,
        roundNumber,
        totalRounds: Number(room.total_rounds),
        clueIndex: Number(room.clue_index),
        suddenDeath: Boolean(room.sudden_death),
        canSkipCard: Number(room.card_skips) < 1,
        settings: this.stats(room),
      },
      phaseEndsInMs: await this.rooms.phaseEndsInMs(roomId),
      players: playersOut,
      me: null,
      round: null,
      result: null,
    };

    if (me !== null) {
      const meId = toNumber(me.id);
      let triesLeft: number | null = null;
      if (status === 'playing' && phase === 'clue') {
        triesLeft = TRIES_PER_CLUE - (await this.answers.countAtClue(roomId, roundNumber, Number(room.clue_index), meId));
      }
      const lockMs = await this.answers.lastAnswerAtMs(meId);
      const lockedForMs = lockMs !== null && lockMs < LOCK_MS ? LOCK_MS - lockMs : 0;
      state['me'] = {
        id: meId,
        name: me.name,
        seat: Number(me.seat),
        team: me.team === null || me.team === undefined ? null : Number(me.team),
        score: Number(me.score),
        isHost: Boolean(me.is_host),
        isReady: Boolean(me.is_ready),
        triesLeft,
        lockedForMs,
      };
    }

    const needsRoundPick = status === 'playing' || (status === 'finished' && roundNumber >= 1);

    if (needsRoundPick) {
      const card: CardRow | undefined = await this.roundCard(roomId, roundNumber);
      if (card) {
        const clues: string[] = parseJsonArray(card.clues).filter((c): c is string => typeof c === 'string');
        const showAnswer = phase === 'reveal' || status === 'finished';
        const revealed = showAnswer ? clues.slice(0, Math.max(3, clues.length)) : clues.slice(0, Number(room.clue_index) + 1);

        const scorers = (await this.answers.scorersOfRound(roomId, roundNumber)).map((s) => ({
          playerId: toNumber(s.id),
          name: s.name,
          seat: s.seat === null || s.seat === undefined ? null : Number(s.seat),
          team: s.team === null || s.team === undefined ? null : Number(s.team),
          points: Number(s.points),
          clue: Number(s.clue),
        }));

        const activeClue = showAnswer ? clues.length - 1 : Number(room.clue_index);
        state['round'] = {
          isSuddenDeath: Boolean(room.sudden_death),
          revealedClues: revealed,
          activeClue,
          cluePoints: pointsForClue(activeClue),
          answer: showAnswer ? card.answer : null,
          category: card.category,
          scorers,
        };
      }
    }

    if (status === 'finished') {
      const stats = await this.answers.stats(roomId);
      const board = await this.players.leaderboard(roomId);
      const ranking = board.map((row) => {
        const id = toNumber(row['id']);
        const s = stats[id] ?? { tries: 0, hits: 0, points: 0 };
        return {
          id,
          name: String(row['name']),
          seat: toNumber(row['seat']),
          team: row['team'] === null || row['team'] === undefined ? null : toNumber(row['team']),
          score: toNumber(row['score']),
          tries: s.tries,
          hits: s.hits,
        };
      });

      const teamScore = await this.players.teamsById(roomId);
      const teamBoard = await this.players.leaderboard(roomId, true);
      const teamRanking = teamBoard.map((r) => ({
        team: toNumber(r['team']),
        score: toNumber(r['total']),
      }));

      state['result'] = {
        ranking,
        teamScores: teamScore,
        teamRanking,
      };
    }

    return state;
  }
}

function sanitizeRounds(value: unknown): number {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : 0;
  const int = Number.isFinite(n) ? Math.trunc(n) : 0;
  return [5, 7, 10].includes(int) ? int : 7;
}

function sanitizeClueSeconds(value: unknown): number {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : 0;
  const int = Number.isFinite(n) ? Math.trunc(n) : 0;
  return [15, 20, 25, 30].includes(int) ? int : 25;
}

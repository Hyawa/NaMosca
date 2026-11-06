// Tipos do estado que o servidor envia.

export type Mode = 'duel' | 'teams' | 'royale'
export type Status = 'lobby' | 'playing' | 'finished' | 'closed'
export type Phase = 'idle' | 'clue' | 'reveal' | 'result'

export interface PlayerState {
  id: number
  name: string
  seat: number
  team: number | null
  score: number
  isHost: boolean
  isReady: boolean
  connected: boolean
}

export interface MeState extends PlayerState {
  triesLeft: number | null
  lockedForMs: number
}

export interface ScorerState {
  playerId: number
  name: string
  seat: number | null
  team: number | null
  points: number
  clue: number
}

export interface RoundState {
  isSuddenDeath: boolean
  revealedClues: string[]
  activeClue: number
  cluePoints: number
  answer: string | null
  category: string
  scorers: ScorerState[]
}

export interface RankRow {
  id: number
  name: string
  seat: number
  team: number | null
  score: number
  tries: number
  hits: number
}

export interface ResultState {
  ranking: RankRow[]
  teamScores: Record<string, number>
  teamRanking: { team: number; score: number }[]
}

export interface RoomFrame {
  version: number
  serverNow: number
  room: {
    code: string
    mode: Mode
    status: Status
    phase: Phase
    roundNumber: number
    totalRounds: number
    clueIndex: number
    suddenDeath: boolean
    canSkipCard: boolean
    settings: { rounds?: number; clueSeconds?: number }
  }
  phaseEndsInMs: number | null
  players: PlayerState[]
  me: MeState | null
  round: RoundState | null
  result: ResultState | null
}

export interface SessionReply {
  code: string
  mode: Mode
  playerId: number
  token: string
}

export interface Identity {
  code: string
  playerId: number
  token: string
  name: string
}

export type QueueStatus = 'queued' | 'matched' | 'cancelled' | 'expired'

export interface QueueReply {
  status: QueueStatus
  mode: Mode
  name: string
  queuedMs: number
  position?: number
  queued?: number
  code?: string | null
  playerId?: number | null
  token?: string | null
}

export interface QueueEnterReply extends QueueReply {
  /** Token opaco da vaga na fila (Bearer para status/cancel). */
  queueToken: string
}

/** Vaga persistida no navegador para sobreviver a um refresh durante a fila. */
export interface PendingQueue {
  token: string
  mode: Mode
  name: string
  startedAt: number
}

export const MODE_LABEL: Record<Mode, string> = {
  duel: '1v1 · Duelo',
  teams: '2v2 · Duplas',
  royale: '3–8 · Royale',
}

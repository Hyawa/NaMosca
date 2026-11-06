import type {
  Identity,
  Mode,
  PendingQueue,
  QueueEnterReply,
  QueueReply,
  RoomFrame,
  SessionReply,
} from './types.ts'

export class ApiError extends Error {
  public readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api'
const SESSION_KEY = 'namosca:session:v1'
const NICK_KEY = 'namosca:nickname'
const QUEUE_KEY = 'namosca:queue:v1'

interface RawSession {
  code: string
  playerId: number
  token: string
  name: string
}

export function saveIdentity(identity: Identity): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(identity))
}

export function loadIdentity(): Identity | null {
  const raw = localStorage.getItem(SESSION_KEY)
  if (raw === null) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as RawSession
    if (!parsed || typeof parsed.code !== 'string' || typeof parsed.token !== 'string') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function clearIdentity(): void {
  localStorage.removeItem(SESSION_KEY)
}

export function saveNickname(value: string): void {
  if (value.trim() !== '') {
    localStorage.setItem(NICK_KEY, value.trim())
  }
}

export function loadNickname(): string {
  return localStorage.getItem(NICK_KEY) ?? ''
}

export function savePendingQueue(pending: PendingQueue): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(pending))
}

export function loadPendingQueue(): PendingQueue | null {
  const raw = localStorage.getItem(QUEUE_KEY)
  if (raw === null) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as PendingQueue
    if (
      !parsed ||
      typeof parsed.token !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.mode !== 'string'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function clearPendingQueue(): void {
  localStorage.removeItem(QUEUE_KEY)
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string | null,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const response = await fetch(BASE_URL + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!response.ok) {
    const message =
      parsed !== null && typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `Erro ${response.status}`
    throw new ApiError(response.status, message)
  }
  return parsed as T
}

export async function createRoom(
  nickname: string,
  mode: string,
  settings: { rounds: number; clueSeconds: number },
): Promise<SessionReply> {
  return call<SessionReply>('POST', '/rooms', { nickname, mode, settings })
}

export async function joinRoom(code: string, nickname: string): Promise<SessionReply> {
  return call<SessionReply>(`POST`, `/rooms/${encodeURIComponent(code)}/join`, { nickname })
}

export async function fetchState(
  code: string,
  token: string | null,
  etag: string | null,
): Promise<{ state: RoomFrame | null; etag: string | null }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  if (etag) {
    headers['If-None-Match'] = etag
  }
  const response = await fetch(BASE_URL + `/rooms/${encodeURIComponent(code)}`, {
    method: 'GET',
    headers,
  })
  if (response.status === 304) {
    return { state: null, etag }
  }
  const text = await response.text()
  if (!response.ok) {
    let message = `Erro ${response.status}`
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed.error === 'string') {
        message = parsed.error
      }
    } catch {
      /* corpo sem json */
    }
    throw new ApiError(response.status, message)
  }
  const state = JSON.parse(text) as RoomFrame
  return { state, etag: `W/"v${state.version}"` }
}

export function markReady(code: string, token: string): Promise<unknown> {
  return call('POST', `/rooms/${encodeURIComponent(code)}/ready`, {}, token)
}

export function startGame(code: string, token: string): Promise<unknown> {
  return call('POST', `/rooms/${encodeURIComponent(code)}/start`, {}, token)
}

export function sendAnswer(code: string, token: string, guess: string): Promise<{ correct: boolean; points: number }> {
  return call('POST', `/rooms/${encodeURIComponent(code)}/answer`, { guess }, token)
}

export function skipCard(code: string, token: string): Promise<unknown> {
  return call('POST', `/rooms/${encodeURIComponent(code)}/skip-card`, {}, token)
}

export function rematch(code: string, token: string): Promise<unknown> {
  return call('POST', `/rooms/${encodeURIComponent(code)}/rematch`, {}, token)
}

export function leaveRoom(code: string, token: string): Promise<unknown> {
  return call('POST', `/rooms/${encodeURIComponent(code)}/leave`, {}, token)
}

export function reportCard(code: string, token: string, reason: string): Promise<unknown> {
  return call('POST', `/rooms/${encodeURIComponent(code)}/report`, { reason }, token)
}

export function enterQueue(nickname: string, mode: Mode): Promise<QueueEnterReply> {
  return call<QueueEnterReply>('POST', '/matchmaking/queue', { nickname, mode })
}

export function queueStatus(queueToken: string): Promise<QueueReply> {
  return call<QueueReply>('GET', '/matchmaking/status', undefined, queueToken)
}

export function cancelQueue(queueToken: string): Promise<unknown> {
  return call('POST', '/matchmaking/cancel', {}, queueToken)
}

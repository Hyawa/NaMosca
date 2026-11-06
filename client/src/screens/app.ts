import {
  ApiError,
  clearIdentity,
  clearPendingQueue,
  enterQueue,
  fetchState,
  loadIdentity,
  loadPendingQueue,
  queueStatus,
  saveIdentity,
  savePendingQueue,
} from '../api/client.ts'
import type {
  Identity,
  Mode,
  PendingQueue,
  QueueReply,
  RoomFrame,
} from '../api/types.ts'
import { toast } from '../ui/dom.ts'
import { GameView } from './game.ts'
import { HomeView } from './home.ts'
import { LobbyView } from './lobby.ts'
import { QueueView } from './queue.ts'
import { ResultView } from './result.ts'
import type { View } from './view.ts'

const POLL_CLUE_MS = 1200
const POLL_IDLE_MS = 1700
const POLL_RESULT_MS = 4000
const POLL_HIDDEN_MS = 5000
const POLL_SLOW_MS = 3500

type SessionScreen = 'lobby' | 'game' | 'result'

function desiredScreen(frame: RoomFrame): SessionScreen {
  if (frame.room.status === 'playing') {
    return 'game'
  }
  if (frame.room.status === 'finished') {
    return 'result'
  }
  return 'lobby'
}

function currentScreen(view: View | null): SessionScreen | 'home' {
  if (view instanceof GameView) {
    return 'game'
  }
  if (view instanceof ResultView) {
    return 'result'
  }
  if (view instanceof LobbyView) {
    return 'lobby'
  }
  return 'home'
}

export class App {
  private readonly root: HTMLElement
  private view: View | null = null
  private identity: Identity | null = null
  private pollCode: string | null = null
  private pollEtag: string | null = null
  private pollGen: number = 0
  private lastFrame: RoomFrame | null = null
  private readonly urlCode: string | null

  constructor(root: HTMLElement) {
    this.root = root
    this.urlCode = (new URLSearchParams(location.search).get('c') ?? '').toUpperCase() || null
  }

  async boot(): Promise<void> {
    const pending = loadPendingQueue()
    if (pending !== null) {
      try {
        const reply = await queueStatus(pending.token)
        if (reply.status === 'matched') {
          if (this.completeMatch(reply, pending)) {
            return
          }
        } else if (reply.status === 'queued') {
          this.showQueue(pending)
          return
        } else {
          clearPendingQueue()
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          clearPendingQueue()
        } else {
          // Servidor fora do ar: preserva a vaga para tentar de novo no refresh.
          this.showHome(this.urlCode)
          toast('Servidor indisponível. Tente de novo em instantes.', 'bad')
          return
        }
      }
    }

    const stored = loadIdentity()
    const code = this.urlCode ?? stored?.code ?? null

    if (stored !== null && code !== null && stored.code === code) {
      try {
        const { state } = await fetchState(code, stored.token, null)
        if (state !== null) {
          this.enterSession(code, stored)
          this.consume(state)
          // Poll agendado por enterSession/pollOnce já está vivo.
          return
        }
      } catch (err) {
        if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
          clearIdentity()
        } else {
          // Servidor fora do ar: mostra a home sem apagar a sessão.
          this.showHome(this.urlCode)
          toast('Servidor indisponível. Tente de novo em instantes.', 'bad')
          return
        }
      }
    }
    this.showHome(this.urlCode)
  }

  showHome(prefill: string | null = null): void {
    this.stopPolling()
    this.identity = null
    this.lastFrame = null
    this.view?.destroy()
    this.view = null
    const home = new HomeView(
      {
        onEnterSession: (code, identity) => {
          this.enterSession(code, identity)
          return Promise.resolve()
        },
        onQueue: (nickname, mode) => this.startQueue(nickname, mode),
      },
      prefill,
    )
    this.resetRoot(home.element)
    this.view = home
  }

  private async startQueue(nickname: string, mode: Mode): Promise<void> {
    const reply = await enterQueue(nickname, mode)
    const pending: PendingQueue = {
      token: reply.queueToken,
      mode,
      name: nickname,
      startedAt: Date.now() - reply.queuedMs,
    }
    savePendingQueue(pending)

    if (reply.status === 'matched') {
      this.completeMatch(reply, pending)
      return
    }
    this.showQueue(pending)
  }

  private showQueue(pending: PendingQueue): void {
    this.stopPolling()
    this.identity = null
    this.lastFrame = null
    const view = new QueueView({
      pending,
      onMatched: (reply) => {
        this.completeMatch(reply, pending)
      },
      onCancelled: () => this.showHome(),
      onError: (err) => toast(err.message, 'bad'),
    })
    this.view?.destroy()
    this.view = view
    this.attachToRoot(view.element)
  }

  private completeMatch(reply: QueueReply, pending: PendingQueue): boolean {
    if (reply.code == null || reply.token == null || reply.playerId == null) {
      clearPendingQueue()
      toast('A partida foi encontrada, mas a sessão veio incompleta.', 'bad')
      this.showHome()
      return false
    }
    const identity: Identity = {
      code: reply.code,
      playerId: reply.playerId,
      token: reply.token,
      name: pending.name,
    }
    clearPendingQueue()
    saveIdentity(identity)
    this.enterSession(identity.code, identity)
    return true
  }

  enterSession(code: string, identity: Identity): void {
    this.stopPolling()
    this.pollCode = code
    this.identity = identity
    this.pollEtag = null
    this.lastFrame = null

    const lobby = new LobbyView({
      identity,
      onActionError: (err) => this.handleActionError(err),
      onLeft: () => void this.showHome(),
    })
    this.view?.destroy()
    this.view = lobby
    this.attachToRoot(lobby.element)
    void this.pollOnce()
  }

  private handleActionError(err: Error): void {
    if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
      this.sessionDied(err.message)
      return
    }
    toast(err.message, 'bad')
  }

  private sessionDied(message: string): void {
    clearIdentity()
    this.stopPolling()
    this.identity = null
    toast(message, 'bad')
    this.showHome()
  }

  private stopPolling(): void {
    this.pollGen++
    this.pollCode = null
    this.pollEtag = null
  }

  private nextDelayMs(): number {
    if (document.hidden) {
      return POLL_HIDDEN_MS
    }
    const frame = this.lastFrame
    if (frame === null) {
      return POLL_IDLE_MS
    }
    if (frame.room.status === 'playing') {
      return frame.room.phase === 'clue' ? POLL_CLUE_MS : POLL_IDLE_MS
    }
    if (frame.room.status === 'finished') {
      return POLL_RESULT_MS
    }
    return POLL_IDLE_MS
  }

  private async pollOnce(): Promise<void> {
    const gen = ++this.pollGen
    const code = this.pollCode
    const identity = this.identity
    if (code === null || identity === null) {
      return
    }

    let hadError = false
    try {
      const { state, etag } = await fetchState(code, identity.token, this.pollEtag)
      if (gen !== this.pollGen) {
        return
      }
      if (state !== null) {
        this.pollEtag = etag
        this.consume(state)
      }
      // 304: nada mudou; o timer local segue e o poll reinicia.
    } catch (err) {
      if (err instanceof ApiError) {
        if ([401, 403, 404].includes(err.status)) {
          this.sessionDied(err.message)
          return
        }
        hadError = true
        toast(err.message, 'bad')
      } else {
        hadError = true
        toast('Sem resposta do servidor; tentando de novo…', 'bad')
      }
    } finally {
      if (gen === this.pollGen && this.pollCode !== null) {
        const delay = hadError ? POLL_SLOW_MS : this.nextDelayMs()
        window.setTimeout(() => void this.pollOnce(), delay)
      }
    }
  }

  // ------------------------------------------------------------------
  // Roteamento por status: lobby → jogo → resultado
  // ------------------------------------------------------------------

  private consume(frame: RoomFrame): void {
    this.lastFrame = frame
    const identity = this.identity
    if (identity === null) {
      return
    }

    // Lobby — mas se a view atual já é o lobby, apenas atualiza.
    const want = desiredScreen(frame)
    const have = currentScreen(this.view)

    if (have === want) {
      if (this.view instanceof HomeView) {
        return
      }
      this.view?.update(frame)
      return
    }

    let next: View
    if (want === 'game') {
      next = new GameView({
        identity,
        onActionError: (err) => this.handleActionError(err),
        onLeft: () => void this.showHome(),
      })
    } else if (want === 'result') {
      next = new ResultView({
        identity,
        onActionError: (err) => this.handleActionError(err),
        onLeft: () => void this.showHome(),
      })
    } else {
      next = new LobbyView({
        identity,
        onActionError: (err) => this.handleActionError(err),
        onLeft: () => void this.showHome(),
      })
    }

    this.view?.destroy()
    this.view = next
    this.attachToRoot(next.element)
    next.update(frame)
  }

  // ------------------------------------------------------------------
  // DOM
  // ------------------------------------------------------------------

  /** Coloca um elemento novo preservando o container de toasts. */
  private attachToRoot(element: HTMLElement): void {
    const toasts = this.root.querySelector('#toasts')
    this.root.innerHTML = ''
    this.root.appendChild(element)
    if (toasts instanceof HTMLElement) {
      this.root.appendChild(toasts)
    } else {
      const fresh = document.createElement('div')
      fresh.id = 'toasts'
      this.root.appendChild(fresh)
    }
    window.scrollTo(0, 0)
  }

  private resetRoot(element: HTMLElement): void {
    this.root.innerHTML = ''
    this.attachToRoot(element)
  }
}

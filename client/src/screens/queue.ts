import {
  ApiError,
  cancelQueue,
  clearPendingQueue,
  queueStatus,
} from '../api/client.ts'
import type { PendingQueue, QueueReply } from '../api/types.ts'
import { MODE_LABEL } from '../api/types.ts'
import { el, toast } from '../ui/dom.ts'
import { targetLogo } from '../ui/layout.ts'
import type { View } from './view.ts'

const POLL_MS = 1500

export interface QueueDeps {
  pending: PendingQueue
  onMatched: (reply: QueueReply) => void
  onCancelled: () => void
  onError: (err: Error) => void
}

/**
 * Tela de fila: polling do /matchmaking/status até a partida ser montada.
 * Quando o servidor devolve status "matched", o App assume e entra na sala.
 */
export class QueueView implements View {
  public readonly element: HTMLElement
  private readonly deps: QueueDeps
  private stopped = false
  private cancelling = false
  private pollTimer: number | null = null
  private tickTimer: number | null = null
  private startedAt = 0

  constructor(deps: QueueDeps) {
    this.deps = deps
    this.startedAt = deps.pending.startedAt > 0 ? deps.pending.startedAt : 0
    this.element = el(`
      <main class="screen queue-screen">
        <header class="topbar">
          <div class="brand-mini">${targetLogo(22)} <span class="brand-name">Na Mosca!</span></div>
          <div class="phase-line">Matchmaking</div>
          <div class="top-actions">
            <button id="cancel-top" class="btn btn-ghost">Sair da fila</button>
          </div>
        </header>

        <section class="queue-main">
          <div class="card queue-panel">
            <div class="queue-art">${targetLogo(76)}</div>
            <h1>Procurando partida</h1>
            <p class="queue-mode" id="queue-mode">${MODE_LABEL[deps.pending.mode]}</p>

            <div class="queue-stats">
              <div><b id="elapsed">0s</b><span>na fila</span></div>
              <div><b id="position">–</b><span>posição</span></div>
              <div><b id="queued">–</b><span>jogadores</span></div>
            </div>

            <p class="queue-status" id="queue-status" aria-live="polite">Procurando jogadores…</p>
            <button id="cancel" class="btn btn-secondary">Cancelar</button>
            <p class="hint">Assim que a sala fechar, a partida começa automaticamente.</p>
          </div>
        </section>
      </main>
    `)
    this.bind()
    this.tickTimer = window.setInterval(() => this.tick(), 1000)
    void this.poll()
  }

  private bind(): void {
    this.element.querySelector('#cancel')!.addEventListener('click', () => void this.cancel())
    this.element.querySelector('#cancel-top')!.addEventListener('click', () => void this.cancel())
  }

  private async poll(): Promise<void> {
    if (this.stopped) {
      return
    }
    try {
      const reply = await queueStatus(this.deps.pending.token)
      if (this.stopped) {
        return
      }

      if (reply.status === 'matched') {
        this.finish(reply)
        return
      }
      if (reply.status === 'cancelled' || reply.status === 'expired') {
        this.fail(reply.status === 'expired' ? 'Sua vaga na fila expirou.' : 'Você saiu da fila.')
        return
      }

      this.render(reply)
    } catch (err) {
      if (this.stopped) {
        return
      }
      if (err instanceof ApiError && err.status === 404) {
        this.fail('Sua vaga na fila expirou.')
        return
      }
      this.setStatus('Sem resposta do servidor; tentando de novo…')
    }

    if (!this.stopped) {
      this.pollTimer = window.setTimeout(() => void this.poll(), POLL_MS)
    }
  }

  private render(reply: QueueReply): void {
    if (this.startedAt === 0) {
      this.startedAt = Date.now() - reply.queuedMs
    }
    this.element.querySelector('#queue-mode')!.textContent = MODE_LABEL[reply.mode]
    this.element.querySelector('#position')!.textContent = String(reply.position ?? '–')
    this.element.querySelector('#queued')!.textContent = String(reply.queued ?? '–')
    this.setStatus(`Procurando jogadores… ${reply.queued ?? 0} na fila`)
    this.tick()
  }

  private tick(): void {
    if (this.stopped) {
      return
    }
    const seconds =
      this.startedAt === 0 ? 0 : Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000))
    const text = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
    this.element.querySelector('#elapsed')!.textContent = text
  }

  private setStatus(text: string): void {
    this.element.querySelector('#queue-status')!.textContent = text
  }

  private finish(reply: QueueReply): void {
    this.stop()
    if (reply.code == null || reply.token == null || reply.playerId == null) {
      this.deps.onError(new Error('A partida foi encontrada, mas a sessão veio incompleta.'))
      clearPendingQueue()
      this.deps.onCancelled()
      return
    }
    this.deps.onMatched(reply)
  }

  private fail(message: string): void {
    this.stop()
    clearPendingQueue()
    toast(message, 'info')
    this.deps.onCancelled()
  }

  private async cancel(): Promise<void> {
    if (this.cancelling) {
      return
    }
    this.cancelling = true
    this.disableCancel(true)
    this.setStatus('Saindo da fila…')
    try {
      await cancelQueue(this.deps.pending.token)
    } catch {
      /* se a vaga já morreu, sair da fila localmente é suficiente */
    }
    this.stop()
    clearPendingQueue()
    this.deps.onCancelled()
  }

  private disableCancel(disabled: boolean): void {
    for (const selector of ['#cancel', '#cancel-top']) {
      const button = this.element.querySelector<HTMLButtonElement>(selector)
      if (button !== null) {
        button.disabled = disabled
      }
    }
  }

  private stop(): void {
    this.stopped = true
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  update(): void {
    /* a fila tem estado próprio; o App não injeta frames de sala aqui */
  }

  destroy(): void {
    this.stop()
    this.element.remove()
  }
}

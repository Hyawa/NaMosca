import {
  clearIdentity,
  markReady,
  startGame,
  leaveRoom,
} from '../api/client.ts'
import type { Identity, RoomFrame } from '../api/types.ts'
import { MODE_LABEL } from '../api/types.ts'
import { el, escapeHtml, toast } from '../ui/dom.ts'
import { TEAM_NAME, targetLogo } from '../ui/layout.ts'

export interface LobbyDeps {
  identity: Identity
  onActionError: (err: Error) => void
  onLeft: () => void
}

export class LobbyView {
  public readonly element: HTMLElement
  private readonly deps: LobbyDeps
  private frame: RoomFrame | null = null

  constructor(deps: LobbyDeps) {
    this.deps = deps
    this.element = el(`
      <main class="screen lobby">
        <header class="topbar">
          <div class="brand-mini">${targetLogo(22)} <span class="brand-name">Na Mosca!</span></div>
          <div class="top-actions">
            <button id="leave" class="btn btn-ghost">Sair</button>
          </div>
        </header>
        <section class="lobby-main">
          <div class="code-box">
            <span class="code-label">Código da sala</span>
            <div class="code-display" id="code-display">····</div>
            <button id="copy" class="btn btn-secondary">Copiar link</button>
          </div>
          <p class="mode-line" id="mode-line"></p>
          <p class="rules-mini" id="rules-mini"></p>
          <div class="lobby-grid">
            <section class="panel">
              <h2>Na mesa <span id="count" class="muted"></span></h2>
              <ol id="players" class="players"></ol>
            </section>
            <aside class="panel">
              <h2>Suas contas</h2>
              <div id="actions"></div>
            </aside>
          </div>
        </section>
      </main>
    `)
    this.bind()
  }

  private bind(): void {
    this.element.querySelector('#copy')!.addEventListener('click', () => {
      const code = this.frame?.room.code ?? ''
      const url = `${location.origin}${location.pathname}?c=${code}`
      void navigator.clipboard
        ?.writeText(url)
        .then(() => toast('Link copiado', 'good'))
        .catch(() => toast('Copie manualmente: ' + url, 'info'))
    })
    this.element.querySelector('#leave')!.addEventListener('click', () => {
      void leaveRoom(this.deps.identity.code, this.deps.identity.token)
        .catch(() => undefined)
        .finally(() => {
          clearIdentity()
          this.deps.onLeft()
        })
    })
    this.element.querySelector('#actions')!.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      const btn = target.closest('button')
      if (btn === null) {
        return
      }
      const { id } = btn
      if (id === 'toggle-ready') {
        void markReady(this.deps.identity.code, this.deps.identity.token).catch(
          (err) => this.deps.onActionError(err as Error),
        )
      } else if (id === 'start') {
        void startGame(this.deps.identity.code, this.deps.identity.token).catch(
          (err) => this.deps.onActionError(err as Error),
        )
      }
    })
  }

  update(frame: RoomFrame): void {
    if (this.frame === frame) {
      /* ignora repetições */
    }
    this.frame = frame
    const mode = frame.room.mode
    this.element.querySelector<HTMLDivElement>('#code-display')!.textContent = frame.room.code
    this.element.querySelector('#mode-line')!.textContent =
      `${MODE_LABEL[mode]} · ${frame.room.totalRounds} rodadas · ${frame.room.settings.clueSeconds ?? 25} s por pista`

    const rules: Record<string, string> = {
      duel: 'Duelo: o primeiro acerto encerra a rodada.',
      teams: 'Duplas: o acerto de qualquer membro vale para o time.',
      royale: 'Royale: cada jogador pontua uma vez por rodada.',
    }
    this.element.querySelector('#rules-mini')!.textContent = rules[mode] ?? ''

    const list = this.element.querySelector<HTMLOListElement>('#players')!
    list.innerHTML = frame.players
      .map((p) => {
        const team =
          mode === 'teams' && p.team !== null
            ? `<span class="team-dot t${p.team}">${TEAM_NAME[p.team] ?? ''}</span>`
            : ''
        return `<li class="${p.connected ? '' : 'off'}">
          <span class="seat">${p.seat + 1}</span>
          <span class="name">${escapeHtml(p.name)}${p.isHost ? ' <span class="crown">★</span>' : ''}</span>
          ${team}
          <span class="ready-dot ${p.isReady ? 'on' : ''}">${p.isReady ? 'pronto' : 'aguardando'}</span>
        </li>`
      })
      .join('')
    this.element.querySelector('#count')!.textContent = `(${frame.players.length})`

    const me = frame.players.find((p) => p.id === this.deps.identity.playerId)
    const actions = this.element.querySelector<HTMLDivElement>('#actions')!
    const isHost = me?.isHost ?? false
    const allReady = frame.players.length > 1 && frame.players.every((p) => p.isReady)
    const minNeeded = mode === 'duel' ? 2 : mode === 'teams' ? 4 : 3
    const enough = frame.players.length >= minNeeded

    actions.innerHTML = `
      <button id="toggle-ready" class="btn ${me?.isReady ? 'btn-ghost' : 'btn-secondary'}">
        ${me?.isReady ? 'Tirar o pronto' : 'Estou pronto'}
      </button>
      ${isHost
        ? `<button id="start" class="btn btn-primary" ${allReady && enough ? '' : 'disabled'}>
             ${enough ? 'Começar a partida' : `Faltam jogadores (mín. ${minNeeded})`}
           </button>`
        : ''}
    `
  }

  destroy(): void {
    this.element.remove()
  }
}

import {
  clearIdentity,
  leaveRoom,
  reportCard,
  sendAnswer,
  skipCard,
} from '../api/client.ts'
import type { Identity, RoomFrame } from '../api/types.ts'
import { MODE_LABEL } from '../api/types.ts'
import { beep, createClock, el, escapeHtml, timerRing, toast } from '../ui/dom.ts'
import { scoreboard, targetLogo } from '../ui/layout.ts'

export interface GameDeps {
  identity: Identity
  onActionError: (err: Error) => void
  onLeft: () => void
}

const REVEAL_TOTAL_MS = 6000

export class GameView {
  public readonly element: HTMLElement
  private readonly deps: GameDeps
  private frame: RoomFrame | null = null
  private clock: () => number = () => Date.now()
  private timerRaf: number | null = null
  private timerGen = 0
  private lastTickSecond = -1
  private lockoutTimeout: number | null = null

  constructor(deps: GameDeps) {
    this.deps = deps
    this.element = el(`
      <main class="screen game">
        <header class="topbar">
          <div class="brand-mini">${targetLogo(22)} <span class="brand-name">Na Mosca!</span></div>
          <div class="phase-line" id="phase-line"></div>
          <div class="top-actions">
            <button id="skip" class="btn btn-ghost hidden">Pular carta</button>
            <button id="report" class="btn btn-ghost" title="Algo estranho na carta? Reporte">⚠</button>
            <button id="leave" class="btn btn-ghost">Abandonar</button>
          </div>
        </header>

        <div class="game-grid">
          <aside class="board-col" id="board-col"></aside>

          <section class="stage">
            <div class="clue-card" id="clue-card" aria-live="polite"></div>
            <div class="timer-host" id="timer-host" aria-hidden="true"></div>
            <div class="round-scorers" id="round-scorers" aria-live="polite"></div>
          </section>

          <section class="input-panel" id="input-panel">
            <form id="guess-form" autocomplete="off">
              <label class="guess-label" for="guess">Sua resposta</label>
              <div class="guess-row">
                <input id="guess" type="text" maxlength="80" placeholder="Dê o palpite" />
                <button id="send" class="btn btn-primary" type="submit">Enviar</button>
              </div>
              <div class="tries" id="tries" title="Tentativas restantes"></div>
              <div class="locknote" id="locknote" role="status"></div>
            </form>
            <div class="scored-note hidden" id="scored-note"></div>
          </section>
        </div>
      </main>
    `)
    this.bind()
  }

  private bind(): void {
    const form = this.element.querySelector<HTMLFormElement>('#guess-form')!
    const input = this.element.querySelector<HTMLInputElement>('#guess')!

    form.addEventListener('submit', (e) => {
      e.preventDefault()
      void this.submitGuess(input.value)
    })

    this.element.querySelector('#skip')!.addEventListener('click', () => {
      void skipCard(this.deps.identity.code, this.deps.identity.token)
        .then(() => toast('Carta trocada', 'good'))
        .catch((err) => this.deps.onActionError(err as Error))
    })
    this.element.querySelector('#report')!.addEventListener('click', () => {
      void reportCard(this.deps.identity.code, this.deps.identity.token, 'reportada pelo jogador')
        .then(() => toast('Carta reportada, valeu!', 'info'))
        .catch((err) => this.deps.onActionError(err as Error))
    })
    this.element.querySelector('#leave')!.addEventListener('click', () => {
      void leaveRoom(this.deps.identity.code, this.deps.identity.token)
        .catch(() => undefined)
        .finally(() => {
          clearIdentity()
          this.deps.onLeft()
        })
    })
  }

  private async submitGuess(value: string): Promise<void> {
    const guess = value.trim()
    if (guess === '') {
      return
    }
    const input = this.element.querySelector<HTMLInputElement>('#guess')!
    const sendBtn = this.element.querySelector<HTMLButtonElement>('#send')!
    sendBtn.disabled = true
    try {
      const reply = await sendAnswer(this.deps.identity.code, this.deps.identity.token, guess)
      if (reply.correct) {
        beep('good')
        input.value = ''
        toast('Na mosca! Acertou, mizeravi.', 'good')
      } else {
        beep('bad')
        toast('Não foi. Tenta de novo.', 'bad')
      }
    } catch (err) {
      beep('bad')
      this.deps.onActionError(err as Error)
    } finally {
      sendBtn.disabled = false
      input.focus()
    }
  }

  update(frame: RoomFrame): void {
    const phaseChanged = this.frame?.room.phase !== frame.room.phase
    const prevClue = this.frame?.room.clueIndex
    const prevRound = this.frame?.room.roundNumber
    this.frame = frame
    this.clock = createClock(frame.serverNow)

    this.renderTopbar(frame)
    this.renderScoreboard(frame)
    this.renderRound(frame, phaseChanged || prevClue !== frame.room.clueIndex || prevRound !== frame.room.roundNumber)
    this.renderScorers(frame)
    this.renderInputZone(frame)
    this.restartTimer(frame)
  }

  private renderTopbar(frame: RoomFrame): void {
    const { room } = frame
    const phaseLabel =
      room.phase === 'clue' ? 'Pista' : room.phase === 'reveal' ? 'Revelação' : room.phase === 'result' ? 'Resultado' : 'Aguarde'
    const sudden = room.suddenDeath ? ' <span class="sd-badge">morte súbita</span>' : ''
    const shownRound = Math.max(1, Math.min(room.roundNumber, room.totalRounds))
    this.element.querySelector('#phase-line')!.innerHTML =
      `<b>${MODE_LABEL[room.mode]}</b> · Rodada ${shownRound}/${room.totalRounds} · ${phaseLabel}${sudden}`

    const skip = this.element.querySelector<HTMLButtonElement>('#skip')!
    skip.classList.toggle('hidden', !(room.canSkipCard && (frame.me?.isHost ?? false) && room.phase === 'clue'))
  }

  private renderScoreboard(frame: RoomFrame): void {
    const col = this.element.querySelector<HTMLDivElement>('#board-col')!
    const key = JSON.stringify([
      frame.players.map((p) => [p.id, p.score, p.connected, p.team, p.isHost, p.isReady]),
      frame.me?.id ?? null,
    ])
    if (col.dataset.key === key) {
      return
    }
    col.dataset.key = key
    col.innerHTML = ''
    col.appendChild(scoreboard(frame, frame.me?.id ?? null))
  }

  private roundKey(frame: RoomFrame): string {
    const round = frame.round
    if (round === null) {
      return 'empty'
    }
    return `k${frame.room.roundNumber}-${round.activeClue}-${round.revealedClues.length}-${round.answer ?? 'n'}-${round.isSuddenDeath}`
  }

  private renderRound(frame: RoomFrame, force: boolean): void {
    const zone = this.element.querySelector<HTMLDivElement>('#clue-card')!
    const round = frame.round
    if (round === null) {
      zone.innerHTML = `<div class="empty-state">Aguardando a próxima rodada…</div>`
      return
    }
    const key = this.roundKey(frame)
    if (!force && zone.dataset.key === key) {
      return
    }
    zone.dataset.key = key

    const clues = round.revealedClues
      .map(
        (clue, i) => `
        <li class="clue ${i === round.activeClue ? 'active' : ''}">
          <span class="clue-number">Pista ${i + 1}</span>
          <span class="clue-points">${10 - i * 3} pts</span>
          <span class="clue-text">${escapeHtml(clue)}</span>
        </li>`,
      )
      .join('')

    const revealBlock =
      round.answer !== null
        ? `<div class="reveal-box">
             <div class="reveal-answer">${escapeHtml(round.answer)}</div>
             <div class="reveal-caption">era a resposta</div>
           </div>`
        : ''

    zone.innerHTML = `
      <div class="clue-head">
        <span class="cat-chip">${escapeHtml(round.category)}</span>
        ${round.isSuddenDeath ? '<span class="sd-badge">morte súbita</span>' : ''}
        ${round.answer === null ? `<span class="clue-pts-note">esta pista vale ${round.cluePoints} pts</span>` : ''}
      </div>
      <ul class="clues">${clues}</ul>
      ${revealBlock}
    `

    if (round.answer !== null && force) {
      beep('good')
    }
  }

  private renderScorers(frame: RoomFrame): void {
    const host = this.element.querySelector<HTMLDivElement>('#round-scorers')!
    const round = frame.round
    const scorers = round?.scorers ?? []
    const key = scorers.map((s) => `${s.playerId}:${s.points}`).join('|')
    if (host.dataset.key === key) {
      return
    }
    host.dataset.key = key
    if (scorers.length === 0) {
      host.innerHTML = round !== null && round.answer !== null ? '<p class="no-scores">Ninguém pontuou nesta rodada.</p>' : ''
      return
    }
    host.innerHTML = `
      <div class="scorers">${scorers
        .map((s) => `<span class="scorer-chip">${escapeHtml(s.name)} <b>+${s.points}</b></span>`)
        .join('')}</div>
      <p class="scorers-note">Acertaram nesta rodada</p>`
  }

  private renderInputZone(frame: RoomFrame): void {
    const form = this.element.querySelector<HTMLFormElement>('#guess-form')!
    const scoredNote = this.element.querySelector<HTMLDivElement>('#scored-note')!
    const tries = this.element.querySelector<HTMLDivElement>('#tries')!
    const locknote = this.element.querySelector<HTMLDivElement>('#locknote')!
    const input = this.element.querySelector<HTMLInputElement>('#guess')!
    const send = this.element.querySelector<HTMLButtonElement>('#send')!

    if (this.lockoutTimeout !== null) {
      window.clearTimeout(this.lockoutTimeout)
      this.lockoutTimeout = null
    }

    const phase = frame.room.phase
    const me = frame.me

    if (frame.room.status !== 'playing' || me === null) {
      form.classList.add('hidden')
      scoredNote.classList.add('hidden')
      tries.innerHTML = ''
      locknote.textContent = ''
      return
    }

    const clueOpen = phase === 'clue' && frame.round !== null
    const alreadyScored = (frame.round?.scorers.some((s) => s.playerId === me.id) ?? false) && me.triesLeft !== null

    if (!clueOpen || me.triesLeft === null) {
      form.classList.add('hidden')
      scoredNote.classList.add('hidden')
      tries.innerHTML = ''
      locknote.textContent = ''
      return
    }

    if (alreadyScored) {
      form.classList.add('hidden')
      scoredNote.classList.remove('hidden')
      scoredNote.textContent = 'Na mosca! Você já pontuou nesta rodada. Espera o resto.'
      return
    }

    scoredNote.classList.add('hidden')
    form.classList.remove('hidden')

    const triesLeft = me.triesLeft
    const dots = [0, 1, 2]
      .map((i) => `<span class="dot ${i < triesLeft ? 'left' : 'used'}"></span>`)
      .join('')
    tries.innerHTML = `<span class="tries-label">Tentativas</span>${dots}`

    if (me.lockedForMs > 0) {
      input.disabled = true
      send.disabled = true
      locknote.textContent = 'Calma: aguarde um instante para tentar de novo…'
      this.lockoutTimeout = window.setTimeout(() => {
        this.lockoutTimeout = null
        input.disabled = false
        send.disabled = false
        if (document.activeElement !== input) {
          input.focus()
        }
        locknote.textContent = ''
      }, me.lockedForMs)
      return
    }

    input.disabled = false
    send.disabled = false
    locknote.textContent = ''
  }

  /** Reinicia o anel de contagem a cada atualização do servidor. */
  private restartTimer(frame: RoomFrame): void {
    this.timerGen++
    if (this.timerRaf !== null) {
      cancelAnimationFrame(this.timerRaf)
      this.timerRaf = null
    }
    if (frame.room.status !== 'playing' || frame.phaseEndsInMs === null) {
      this.element.querySelector<HTMLDivElement>('#timer-host')!.innerHTML = ''
      this.lastTickSecond = -1
      return
    }

    const gen = this.timerGen
    const totalSeconds =
      frame.room.phase === 'clue' ? (frame.room.settings.clueSeconds ?? 25) : REVEAL_TOTAL_MS / 1000
    const endsAt = this.clock() + frame.phaseEndsInMs
    const ringHost = this.element.querySelector<HTMLDivElement>('#timer-host')!

    const loop = (): void => {
      if (gen !== this.timerGen) {
        return
      }
      const leftMs = Math.max(0, endsAt - this.clock())
      const leftSec = Math.ceil(leftMs / 1000)
      if (leftSec !== this.lastTickSecond) {
        this.lastTickSecond = leftSec
        ringHost.innerHTML = `<div class="timer-wrap">${timerRing(leftSec, totalSeconds)}</div>`
        if (leftSec <= 5 && leftSec > 0 && this.frame?.room.phase === 'clue') {
          beep('tick')
        }
      }
      this.timerRaf = requestAnimationFrame(loop)
    }
    this.timerRaf = requestAnimationFrame(loop)
  }

  destroy(): void {
    this.timerGen++
    if (this.timerRaf !== null) {
      cancelAnimationFrame(this.timerRaf)
      this.timerRaf = null
    }
    if (this.lockoutTimeout !== null) {
      window.clearTimeout(this.lockoutTimeout)
      this.lockoutTimeout = null
    }
    this.element.remove()
  }
}

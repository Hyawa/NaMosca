import { clearIdentity, leaveRoom, rematch } from '../api/client.ts'
import type { Identity, RoomFrame, RankRow } from '../api/types.ts'
import { el, escapeHtml, toast } from '../ui/dom.ts'
import { targetLogo, TEAM_NAME } from '../ui/layout.ts'

export interface ResultDeps {
  identity: Identity
  onActionError: (err: Error) => void
  onLeft: () => void
}

interface Line {
  name: string
  score: number
  tries: number
  hits: number
  isHost: boolean
  isMe: boolean
  team: number | null
}

export class ResultView {
  public readonly element: HTMLElement
  private readonly deps: ResultDeps

  constructor(deps: ResultDeps) {
    this.deps = deps
    this.element = el(`
      <main class="screen result">
        <header class="topbar">
          <div class="brand-mini">${targetLogo(22)} <span class="brand-name">Na Mosca!</span></div>
          <div class="phase-line" id="phase-line">Resultado</div>
          <div class="top-actions"></div>
        </header>

        <section class="result-main">
          <h1 id="headline" class="result-headline">Partida encerrada!</h1>
          <div id="podium" class="podium"></div>
          <div id="teams" class="teams-box hidden"></div>
          <section class="panel">
            <h2>Tiros a poste</h2>
            <div class="table-scroll">
              <table class="rank-table">
                <thead>
                  <tr><th>#</th><th>Quem</th><th>Pontos</th><th>Acertos</th><th>Tiros</th></tr>
                </thead>
                <tbody id="rank-body"></tbody>
              </table>
            </div>
          </section>
          <div id="actions-re" class="result-actions"></div>
        </section>
      </main>
    `)
    this.bind()
  }

  private bind(): void {
    this.element.querySelector('#actions-re')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button')
      if (btn === null) {
        return
      }
      if (btn.id === 'rematch') {
        void rematch(this.deps.identity.code, this.deps.identity.token)
          .then(() => toast('Sala reaberta no lobby', 'good'))
          .catch((err) => this.deps.onActionError(err as Error))
      } else if (btn.id === 'leave') {
        void leaveRoom(this.deps.identity.code, this.deps.identity.token)
          .catch(() => undefined)
          .finally(() => {
            clearIdentity()
            this.deps.onLeft()
          })
      }
    })
  }

  update(frame: RoomFrame): void {
    const result = frame.result
    this.element.querySelector('#phase-line')!.textContent =
      `Resultado · sala ${frame.room.code}`

    if (result === null) {
      this.element.querySelector('#headline')!.textContent = 'Aguarde: fechando a partida…'
      return
    }

    const meId = this.deps.identity.playerId
    const lines: Line[] = result.ranking.map((r: RankRow) => ({
      name: r.name,
      score: r.score,
      tries: r.tries,
      hits: r.hits,
      isHost: false,
      isMe: r.id === meId,
      team: r.team,
    }))

    // Manchetes
    const mode = frame.room.mode
    let headline = 'Fim de jogo!'
    if (mode === 'teams') {
      const top = result.teamRanking[0]
      const second = result.teamRanking[1]
      if (top !== undefined && (second === undefined || top.score === second.score)) {
        headline = 'Empate entre os times!'
      } else if (top !== undefined) {
        headline = `${TEAM_NAME[top.team] ?? 'O time'} levou!`
      }
    } else if (lines.length > 0) {
      const top = lines[0]!
      const tie = lines[1] !== undefined && lines[1]!.score === top.score
      headline = tie ? 'Empate no topo!' : `${top.name} levou a partida!`
    }
    this.element.querySelector('#headline')!.textContent = headline

    // Pódio simples: primeiro (e segundo, terceiro) em linha.
    const medal = ['🥇', '🥈', '🥉']
    const podiumHost = this.element.querySelector<HTMLDivElement>('#podium')!
    const topCount = mode === 'teams' ? 0 : Math.min(3, lines.length)
    podiumHost.innerHTML = lines
      .slice(0, topCount)
      .map(
        (line, i) =>
          `<div class="podium-slot pos-${i + 1}${line.isMe ? ' me' : ''}">
            <span class="medal">${medal[i]}</span>
            <span class="p-name">${escapeHtml(line.name)}</span>
            <span class="p-score">${line.score} pts</span>
          </div>`,
      )
      .join('')

    // Times (só no modo duplas)
    const teamsBox = this.element.querySelector<HTMLDivElement>('#teams')!
    if (mode === 'teams') {
      teamsBox.classList.remove('hidden')
      teamsBox.innerHTML = result.teamRanking
        .map(
          (t, i) =>
            `<div class="team-line${i === 0 ? ' leader' : ''}">
               <span class="team-dot t${t.team}">${TEAM_NAME[t.team] ?? ''}</span>
               <b>${t.score} pts</b>
             </div>`,
        )
        .join('<hr class="team-sep" />')
    } else {
      teamsBox.classList.add('hidden')
    }

    // Tabela completa
    const body = this.element.querySelector<HTMLElement>('#rank-body')!
    body.innerHTML = lines
      .map(
        (line, i) =>
          `<tr class="${line.isMe ? 'me' : ''}">
            <td>${i + 1}</td>
            <td>${escapeHtml(line.name)}</td>
            <td>${line.score}</td>
            <td>${line.hits}</td>
            <td>${line.tries}</td>
          </tr>`,
      )
      .join('')

    // Ações
    const meRow = frame.players.find((p) => p.id === meId)
    const isHost = meRow?.isHost ?? false
    const actions = this.element.querySelector<HTMLDivElement>('#actions-re')!
    actions.innerHTML = `
      ${isHost
        ? '<button id="rematch" class="btn btn-primary">Revanche</button>'
        : '<p class="hint">O anfitrião decide a revanche. Enquanto isso, conversem.</p>'}
      <button id="leave" class="btn btn-ghost">Sair da sala</button>
    `
  }

  destroy(): void {
    this.element.remove()
  }
}

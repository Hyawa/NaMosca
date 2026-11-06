import { createRoom, joinRoom, loadNickname, saveNickname } from '../api/client.ts'
import type { Identity, Mode } from '../api/types.ts'
import { el, escapeHtml, toast } from '../ui/dom.ts'
import { targetLogo } from '../ui/layout.ts'

export interface HomeDeps {
  onEnterSession: (code: string, identity: Identity) => Promise<void>
  onQueue: (nickname: string, mode: Mode) => Promise<void>
}

export class HomeView {
  public readonly element: HTMLElement
  private readonly deps: HomeDeps
  private readonly prefill: string | null
  private mode: Mode = 'duel'

  constructor(deps: HomeDeps, prefill: string | null = null) {
    this.deps = deps
    this.prefill = prefill
    this.element = el(`
      <main class="screen home">
        <header class="home-hero">
          <div class="logo">${targetLogo(72)}</div>
          <h1>Na Mosca!</h1>
          <p class="tagline">3 pistas, 1 resposta, nenhum amigo a salvo.</p>
        </header>

        <section class="home-actions">
          <div class="card form-card play-card">
            <h2 class="play-title">Jogar agora</h2>
            <p class="play-sub">Entre na fila e a gente monta a partida pra você.</p>

            <label class="field">
              <span>Como todos vão te chamar</span>
              <input id="nick" type="text" maxlength="24" placeholder="Seu apelido" autocomplete="nickname" />
            </label>

            <div class="tabs" role="tablist" aria-label="Modo de jogo">
              <button type="button" class="tab active" data-mode="duel">1v1</button>
              <button type="button" class="tab" data-mode="teams">2v2</button>
              <button type="button" class="tab" data-mode="royale">Royale</button>
            </div>

            <button id="play" class="btn btn-primary btn-lg">Jogar</button>
            <p class="hint" id="mode-hint">1v1: dois jogadores, quem acerta primeiro leva os pontos.</p>
          </div>

          <details class="howto private">
            <summary>Jogar com amigos (sala privada)</summary>
            <p class="hint private-hint">
              Crie uma sala, compartilhe o código e comece quando todos estiverem prontos.
            </p>

            <div class="private-grid">
              <div class="card form-card">
                <div class="option-row">
                  <label class="field-inline">
                    <span>Rodadas</span>
                    <select id="rounds">
                      <option value="5">5</option>
                      <option value="7" selected>7</option>
                      <option value="10">10</option>
                    </select>
                  </label>
                  <label class="field-inline">
                    <span>Segundos por pista</span>
                    <select id="clueSeconds">
                      <option value="15">15</option>
                      <option value="20">20</option>
                      <option value="25" selected>25</option>
                      <option value="30">30</option>
                    </select>
                  </label>
                </div>
                <button id="create" class="btn btn-secondary">Criar sala</button>
              </div>

              <div class="card form-card">
                <label class="field">
                  <span>Código da sala</span>
                  <input id="code" class="code-input" inputmode="latin" maxlength="4" placeholder="ABCD" autocomplete="off" />
                </label>
                <button id="join" class="btn btn-secondary">Entrar na sala</button>
              </div>
            </div>
          </details>
        </section>

        <details class="howto">
          <summary>Como jogar</summary>
          <ol>
            <li>Um tema escondido tem <b>3 pistas</b>, reveladas aos poucos.</li>
            <li>Pontos por pista: <b>10 · 7 · 4</b>. Quem acertar primeiro, na mosca.</li>
            <li><b>3 tentativas</b> por pista, com uma pausa de 1,5 s entre erros.</li>
            <li><b>1v1/2v2:</b> o primeiro acerto encerra a rodada. <b>Royale:</b> cada jogador pontua uma vez por rodada.</li>
            <li>Empatou no fim? Morte súbita decide.</li>
          </ol>
        </details>
      </main>
    `)
    this.bind()
  }

  private bind(): void {
    const nick = this.element.querySelector<HTMLInputElement>('#nick')!
    nick.value = loadNickname()

    const hint = this.element.querySelector<HTMLParagraphElement>('#mode-hint')!
    const hints: Record<Mode, string> = {
      duel: '1v1: dois jogadores, quem acerta primeiro leva os pontos.',
      teams: '2v2: quatro jogadores em duplas, times equilibrados automaticamente.',
      royale: '3 a 8 jogadores: todos podem pontuar uma vez por rodada.',
    }
    this.element.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.mode = (tab.dataset.mode as Mode | undefined) ?? 'duel'
        this.element.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'))
        tab.classList.add('active')
        hint.textContent = hints[this.mode]
      })
    })

    const codeInput = this.element.querySelector<HTMLInputElement>('#code')!
    if (this.prefill) {
      codeInput.value = this.prefill
    }
    codeInput.value = (codeInput.value || this.prefill || '').toUpperCase()

    this.element.querySelector('#play')!.addEventListener('click', () => {
      void this.queueUp(nick.value)
    })
    this.element.querySelector('#create')!.addEventListener('click', () => {
      void this.createRoom(this.mode, nick.value)
    })
    this.element.querySelector('#join')!.addEventListener('click', () => {
      void this.joinRoomSession(codeInput.value, nick.value)
    })
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        void this.joinRoomSession(codeInput.value, nick.value)
      }
    })
  }

  private async queueUp(nickname: string): Promise<void> {
    const clean = nickname.trim()
    if (clean.length < 2) {
      toast('Escolha um apelido de 2 letras ou mais', 'bad')
      return
    }
    saveNickname(clean)
    try {
      await this.deps.onQueue(clean, this.mode)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Não foi possível entrar na fila', 'bad')
    }
  }

  private async createRoom(mode: Mode, nickname: string): Promise<void> {
    const clean = nickname.trim()
    if (clean.length < 2) {
      toast('Escolha um apelido de 2 letras ou mais', 'bad')
      return
    }
    saveNickname(clean)
    try {
      const rounds = Number(this.element.querySelector<HTMLSelectElement>('#rounds')!.value)
      const clueSeconds = Number(this.element.querySelector<HTMLSelectElement>('#clueSeconds')!.value)
      const reply = await createRoom(clean, mode, { rounds, clueSeconds })
      const identity: Identity = {
        code: reply.code,
        playerId: reply.playerId,
        token: reply.token,
        name: clean,
      }
      await this.deps.onEnterSession(reply.code, identity)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Não foi possível criar a sala', 'bad')
    }
  }

  private async joinRoomSession(codeRaw: string, nickname: string): Promise<void> {
    const code = codeRaw.trim().toUpperCase()
    const clean = nickname.trim()
    if (code.length < 2) {
      toast('Informe o código da sala', 'bad')
      return
    }
    if (clean.length < 2) {
      toast('Escolha um apelido de 2 letras ou mais', 'bad')
      return
    }
    saveNickname(clean)
    try {
      const reply = await joinRoom(code, clean)
      const identity: Identity = {
        code: reply.code,
        playerId: reply.playerId,
        token: reply.token,
        name: clean,
      }
      await this.deps.onEnterSession(code, identity)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Não foi possível entrar', 'bad')
    }
  }

  /** Escapa nomes antes de renderizar. */
  static label(text: string): string {
    return escapeHtml(text)
  }

  update(): void {
    /* HomeView é estática */
  }

  destroy(): void {
    this.element.remove()
  }
}

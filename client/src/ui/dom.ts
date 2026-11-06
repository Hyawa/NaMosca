export function el(html: string): HTMLElement {
  const tpl = document.createElement('template')
  tpl.innerHTML = html.trim()
  const node = tpl.content.firstElementChild
  if (!(node instanceof HTMLElement)) {
    throw new Error('HTML inválido em el()')
  }
  return node
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Toast rápido (mensagem automática que some). */
export function toast(text: string, kind: 'good' | 'bad' | 'info' = 'info'): void {
  const host = document.getElementById('toasts') ?? document.body
  const node = el(`<div class="toast toast-${kind}" role="status">${escapeHtml(text)}</div>`)
  host.appendChild(node)
  setTimeout(() => {
    node.classList.add('toast-out')
    setTimeout(() => node.remove(), 400)
  }, 2200)
}

/** Som curto via WebAudio (sem arquivos). */
let audioCtx: AudioContext | null = null

export function beep(kind: 'good' | 'bad' | 'tick'): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return
  }
  try {
    audioCtx = audioCtx ?? new AudioContext()
    const ctx = audioCtx
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    const t = ctx.currentTime
    if (kind === 'good') {
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(660, t)
      osc.frequency.exponentialRampToValueAtTime(990, t + 0.12)
      gain.gain.setValueAtTime(0.08, t)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3)
      osc.start(t)
      osc.stop(t + 0.32)
    } else if (kind === 'bad') {
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(220, t)
      osc.frequency.exponentialRampToValueAtTime(110, t + 0.18)
      gain.gain.setValueAtTime(0.06, t)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25)
      osc.start(t)
      osc.stop(t + 0.26)
    } else {
      osc.type = 'sine'
      osc.frequency.setValueAtTime(1200, t)
      gain.gain.setValueAtTime(0.03, t)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09)
      osc.start(t)
      osc.stop(t + 0.1)
    }
  } catch {
    /* sem áudio, sem drama */
  }
}

/** Fecha a diferença entre o relógio do servidor e o local. */
export function createClock(serverNowMs: number): () => number {
  const offset = serverNowMs - Date.now()
  return () => Date.now() + offset
}

/** Anel SVG de contagem regressiva. */
export function timerRing(secondsLeft: number, total: number): string {
  const ratio = total > 0 ? Math.max(0, Math.min(1, secondsLeft / total)) : 0
  const radius = 42
  const circumference = 2 * Math.PI * radius
  const dash = circumference * ratio
  const hue = ratio < 0.25 ? 'ring-danger' : ratio < 0.5 ? 'ring-warn' : 'ring-ok'
  return `
    <svg class="ring ${hue}" viewBox="0 0 100 100" aria-hidden="true">
      <circle class="ring-bg" cx="50" cy="50" r="${radius}" />
      <circle class="ring-fg" cx="50" cy="50" r="${radius}"
        stroke-dasharray="${dash.toFixed(1)} ${circumference.toFixed(1)}"
        transform="rotate(-90 50 50)" />
      <text x="50" y="58" text-anchor="middle" class="ring-label">${Math.max(0, Math.ceil(secondsLeft))}</text>
    </svg>`
}

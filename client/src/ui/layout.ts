import type { PlayerState, RoomFrame } from '../api/types.ts'
import { el, escapeHtml } from './dom.ts'

export const TEAM_NAME: Record<number, string> = {
  0: 'Time Vermelho',
  1: 'Time Amarelo',
}

export function playerChip(p: PlayerState, opts: { meId: number | null; mode: RoomFrame['room']['mode'] }): string {
  const mark = p.isHost ? ' <span class="crown" title="Host">★</span>' : ''
  const face = p.connected ? '' : ' <span class="offline" title="Desconectado">·</span>'
  const me = opts.meId === p.id ? ' chip-me' : ''
  const team = opts.mode === 'teams' && p.team !== null ? ` chip-team-${p.team}` : ''
  return `<span class="chip${me}${team}"><b>${escapeHtml(p.name)}</b>${mark}${face}
    <i class="chip-score">${p.score}</i></span>`
}

export function scoreboard(frame: RoomFrame, meId: number | null): HTMLElement {
  const mode = frame.room.mode
  const rows = frame.players
    .map(
      (p) => `<li class="score-row${meId === p.id ? ' me' : ''}${p.connected ? '' : ' off'}">
        <span class="seat">${p.seat + 1}</span>
        <span class="name">${escapeHtml(p.name)}${p.isHost ? ' <span class="crown">★</span>' : ''}</span>
        ${mode === 'teams' && p.team !== null ? `<span class="team-dot t${p.team}">${TEAM_NAME[p.team] ?? ''}</span>` : ''}
        <span class="points">${p.score}</span>
      </li>`,
    )
    .join('')

  let teams = ''
  if (mode === 'teams') {
    const sums: Record<number, number> = { 0: 0, 1: 0 }
    for (const p of frame.players) {
      if (p.team !== null) {
        sums[p.team] = (sums[p.team] ?? 0) + p.score
      }
    }
    teams = `<div class="team-score">
      <span class="t0">Vermelho ${sums[0]}</span>
      <span class="t1">Amarelo ${sums[1]}</span>
    </div>`
  }

  return el(`<section class="scoreboard" aria-label="Placar">
    <h2>Placar</h2>
    <ol>${rows}</ol>
    ${teams}
  </section>`)
}

/** Alvo pintado em SVG inline (identidade "Na Mosca!"). */
export function targetLogo(size = 54): string {
  return `
  <svg class="target" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">
    <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" stroke-width="5"/>
    <circle cx="32" cy="32" r="16" fill="none" stroke="currentColor" stroke-width="4"/>
    <circle cx="32" cy="32" r="6" fill="currentColor"/>
  </svg>`
}

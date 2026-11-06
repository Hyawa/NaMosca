// Espelho de server/src/Domain/AnswerMatcher.php
import { normalizeAnswer } from '../support/str.js';

export const POINTS = [10, 7, 4] as const;

/** Erro de digitação tolerado no match por distância. */
const MAX_TOLERANCE = 1;
const MIN_LEN_FOR_TOLERANCE = 7;

/**
 * Verifica se o palpite casou com a resposta ou um dos aliases.
 * cardRow é uma linha da tabela cards.
 */
export function matches(card: { answer_norm: string; aliases: unknown }, guess: string): boolean {
  const guessNorm = normalizeAnswer(guess);
  if (guessNorm === '') {
    return false;
  }

  const candidates = [card.answer_norm];
  const aliases = parseJsonArray(card.aliases);
  for (const alias of aliases) {
    if (typeof alias === 'string') {
      const normAlias = normalizeAnswer(alias);
      if (normAlias !== '') {
        candidates.push(normAlias);
      }
    }
  }
  const unique = [...new Set(candidates)];

  for (const candidate of unique) {
    if (guessNorm === candidate) {
      return true;
    }
    if ([...candidate].length >= MIN_LEN_FOR_TOLERANCE && levenshtein(guessNorm, candidate) <= MAX_TOLERANCE) {
      return true;
    }
  }
  return false;
}

export function pointsForClue(clueIndex: number): number {
  return POINTS[clueIndex] ?? 4;
}

export function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function levenshtein(a: string, b: string): number {
  const aChars = [...a];
  const bChars = [...b];
  const n = aChars.length;
  const m = bChars.length;
  if (n === 0) return m;
  if (m === 0) return n;
  // Duas linhas da matriz de distância (O(n*m), sem alocar a tabela inteira).
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = aChars[i - 1] === bChars[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m]!;
}

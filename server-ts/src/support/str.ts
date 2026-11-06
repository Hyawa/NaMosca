// Espelho de server/src/Support/Str.php
// Normalização: minúsculas, sem acento (NFD + remoção de marcas Mn),
// mantendo apenas letras e números (e espaços, no caso de nomes).

/**
 * Normalização de respostas: minúsculas, sem acento, sem pontuação,
 * sem espaços. "Pão de Queijo" -> "paodequeijo".
 */
export function normalizeAnswer(raw: string): string {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === '') {
    return '';
  }
  const decomposed = s.normalize('NFD');
  // Remove marcas diacríticas (~, ^, ´, `) que ficaram após NFD.
  const withoutMarks = decomposed.replace(/\p{Mn}+/gu, '');
  // Mantém apenas letras e números.
  return withoutMarks.replace(/[^\p{L}\p{Nd}]+/gu, '');
}

export function normalizeName(raw: string): string {
  const s = (raw ?? '').trim().toLowerCase();
  const decomposed = s.normalize('NFD');
  const withoutMarks = decomposed.replace(/\p{Mn}+/gu, '');
  const kept = withoutMarks.replace(/[^\p{L}\p{Nd} ]+/gu, '');
  return kept.trim().replace(/\s+/gu, ' ');
}

/** Apelido exibível: trim, colapsa espaços, corta no limite (conta caracteres, não bytes). */
export function shortName(raw: string, max = 24): string {
  const s = (raw ?? '').trim().replace(/\s+/gu, ' ');
  const chars = [...s];
  if (chars.length > max) {
    return chars.slice(0, max).join('');
  }
  return s;
}

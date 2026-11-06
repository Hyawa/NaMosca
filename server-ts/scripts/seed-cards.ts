// Espelho de server/scripts/seed-cards.php
// Importa o baralho curado (database/seed/*.txt) na tabela cards.
// Formato de cada linha (6 campos separados por pipe):
//   dificuldade|resposta|alias1,alias2|pista1|pista2|pista3
// Uso: pnpm db:seed [--replace]
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';
import { normalizeAnswer } from '../src/support/str.js';

function validate(clues: string[], answerNorm: string): string | null {
  if (clues.length !== 3) {
    return 'precisa de exatamente 3 pistas';
  }
  for (const clue of clues) {
    const len = [...clue.trim()].length;
    if (len < 4 || len > 200) {
      return 'pista fora do tamanho (4–200)';
    }
  }
  if (clues.some((c) => normalizeAnswer(c) === answerNorm)) {
    return 'pista vaza a resposta';
  }
  return null;
}

async function main(): Promise<void> {
  const replace = process.argv.includes('--replace');
  console.log('Seed: postgres');

  const here = dirname(fileURLToPath(import.meta.url));
  const seedDir = join(here, '..', 'database', 'seed');
  const files = readdirSync(seedDir)
    .filter((f) => f.endsWith('.txt'))
    .sort();

  if (files.length === 0) {
    console.error(`Nenhum arquivo de seed em ${seedDir}`);
    process.exit(1);
  }

  let inserted = 0;
  let rejected = 0;
  let duplicated = 0;
  let total = 0;

  for (const file of files) {
    const category = basename(file, '.txt');
    const lines = readFileSync(join(seedDir, file), 'utf8').split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) {
        continue;
      }
      total++;

      const parts = line.split('|');
      if (parts.length !== 6) {
        rejected++;
        console.error(`  ! [${category}] linha com ${parts.length} campos (esperado 6): ${line}`);
        continue;
      }

      const [difficulty, answer, aliasRaw, clue1, clue2, clue3] = parts as [string, string, string, string, string, string];

      const answerNorm = normalizeAnswer(answer);
      if (!['facil', 'media', 'dificil'].includes(difficulty) || answerNorm === '') {
        rejected++;
        console.error(`  ! [${category}] dificuldade/resposta inválida: ${answer}`);
        continue;
      }

      const clues = [clue1!.trim(), clue2!.trim(), clue3!.trim()];

      const error = validate(clues, answerNorm);
      if (error !== null) {
        rejected++;
        console.error(`  ! [${category}] ${answer}: ${error}`);
        continue;
      }

      const aliasesSet = new Set<string>([answerNorm]);
      for (const alias of aliasRaw!.split(',')) {
        const norm = normalizeAnswer(alias);
        if (norm !== '') {
          aliasesSet.add(norm);
        }
      }
      const aliases = [...aliasesSet];

      // --replace atualiza a carta existente (ON CONFLICT DO UPDATE é o
      // equivalente seguro ao REPLACE INTO do MySQL com chaves estrangeiras);
      // sem --replace, duplicadas são ignoradas como INSERT IGNORE.
      const res = await pool.query(
        `INSERT INTO cards (answer, answer_norm, aliases, clues, category, difficulty, source)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, 'seed')
         ON CONFLICT (answer_norm) ${replace ? `DO UPDATE SET answer = EXCLUDED.answer, aliases = EXCLUDED.aliases, clues = EXCLUDED.clues, category = EXCLUDED.category, difficulty = EXCLUDED.difficulty, source = EXCLUDED.source` : 'DO NOTHING'}`,
        [answer.trim(), answerNorm, JSON.stringify(aliases), JSON.stringify(clues), category, difficulty],
      );
      if (res.rowCount && res.rowCount > 0) {
        inserted++;
      } else {
        duplicated++;
      }
    }
  }

  const countRow = await pool.query('SELECT COUNT(*) AS n FROM cards');
  const count = Number((countRow.rows[0] as { n: string | number } | undefined)?.n ?? 0);

  console.log(`Linhas lidas: ${total}`);
  console.log(`Inseridas: ${inserted}`);
  console.log(`Duplicadas ignoradas: ${duplicated}`);
  console.log(`Rejeitadas: ${rejected}`);
  console.log(`Total na tabela cards: ${count}`);

  await pool.end();

  if (count < 100) {
    console.error('Baralho incompleto! Esperado ~120 cartas.');
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});

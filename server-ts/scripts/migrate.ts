// Espelho de server/scripts/migrate.php
// Roda as migrações pendentes na ordem de nome de arquivo, idempotente.
// Uso: pnpm db:migrate  (DATABASE_URL / PG* já definidos)
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, '..', 'database', 'migrations');

  console.log('Migrate: postgres');

  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (version)
    )`,
  );

  const appliedRows = (await pool.query('SELECT version FROM schema_migrations')).rows as Array<{ version: string }>;
  const applied = new Set(appliedRows.map((r) => r.version));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.error(`Nenhuma migração encontrada em ${migrationsDir}`);
    process.exit(1);
  }

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) {
      console.log(`  = ${version} (já aplicada)`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    if (sql.trim() === '') {
      console.error(`Arquivo vazio: ${file}`);
      process.exit(1);
    }
    try {
      // Arquivos com múltiplos comandos: `pool.query` aceita via parâmetro simples
      // apenas um comando quando há binds; sem binds, pg executa multi-statement.
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      console.log(`  + ${version} aplicada`);
    } catch (err) {
      console.error(`  ! ${version} falhou: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  // Limpa lotes antigos de rate limit sempre que a migração roda.
  await pool.query(`DELETE FROM rate_limits WHERE window_start < NOW() - make_interval(secs => 3600)`);

  console.log(`Migrações concluídas em ${new Date().toTimeString().slice(0, 8)}`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});

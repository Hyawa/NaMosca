// Espelho de server/src/Core/Env.php + config do servidor.
// Lê .env na raiz do servidor (mesma regra do PHP) e depois process.env.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadDotEnv(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const pos = line.indexOf('=');
    if (pos === -1) {
      continue;
    }
    const key = line.slice(0, pos).trim();
    let value = line.slice(pos + 1).trim();
    value = value.replace(/^["']|["']$/g, '');
    if (key !== '' && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// server-ts/src/config -> server-ts/ (em dev, via tsx) ou dist/config -> server-ts/ (compilado).
const thisDir = dirname(fileURLToPath(import.meta.url));
loadDotEnv(join(thisDir, '..', '..', '.env'));
loadDotEnv(join(process.cwd(), '.env'));
loadDotEnv(resolve('.env'));

export const config = {
  port: Number(process.env.PORT ?? 3000),
  appEnv: process.env.APP_ENV ?? 'local',
  appDebug: (process.env.APP_DEBUG ?? 'false') === 'true',
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== ''),
  databaseUrl: process.env.DATABASE_URL ?? '',
  pgHost: process.env.PGHOST ?? 'localhost',
  pgPort: Number(process.env.PGPORT ?? 5432),
  pgDatabase: process.env.PGDATABASE ?? 'namosca',
  pgUser: process.env.PGUSER ?? 'namosca',
  pgPassword: process.env.PGPASSWORD ?? 'namosca',
  pgSslMode: process.env.PGSSLMODE ?? '',
};

export function requirePgConfig(): void {
  if (config.databaseUrl) {
    return;
  }
  if (!config.pgDatabase || !config.pgUser) {
    throw new Error(
      'Configuração do banco ausente: defina DATABASE_URL ou PGHOST/PGDATABASE/PGUSER/PGPASSWORD.',
    );
  }
}

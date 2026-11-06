# Na Mosca! — backend TypeScript (server-ts)

Port de `../server` (PHP 8.3 + PDO + MySQL) para **Node.js + Hono + PostgreSQL**.
A API HTTP é idêntica: mesmas rotas, mesmos JSON, mesmos códigos de status,
ETag/polling, Bearer token e regras de jogo — o cliente em `../client` não
precisa de nenhuma alteração.

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js >= 20 |
| Framework | Hono 4 + `@hono/node-server` |
| Linguagem | TypeScript strict (compila para `dist/` com `tsc`) |
| Banco | PostgreSQL via `pg` (node-postgres), SQL parametrizado, sem ORM |
| Pacotes | pnpm |
| Deploy alvo | Render (serviço web Node nativo + Render Postgres) |

Estrutura espelha o PHP para revisão lado a lado:

```text
server-ts/
  src/
    index.ts                 bootstrap (serve)
    config/env.ts            Core/Env.php + porta/debug
    db/pool.ts               Core/Db.php (pool, query, transação reentrante)
    http/router.ts           public/index.php (CORS, rotas, /api + raiz)
    http/controllers/        Health|Rooms|Matchmaking
    domain/                  GameEngine | MatchmakingService | AnswerMatcher
    repos/                   Room|Player|Card|Answer repositories
    support/                 Str | Token | RateLimiter | responses
  database/migrations/  database/seed/  scripts/  tests/unit/
```

## Setup local

### 1. Banco PostgreSQL

Opção A — Docker:

```bash
docker run --name namosca-pg -e POSTGRES_USER=namosca -e POSTGRES_PASSWORD=namosca \
  -e POSTGRES_DB=namosca -p 5432:5432 -d postgres:16
```

Opção B — PostgreSQL local instalado. Para uma instância rápida no Windows:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\initdb.exe" -D "$PWD\pgdata" -U namosca --auth=trust
& "C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe" -D "$PWD\pgdata" -o "-p 5432" -l pg.log start
& "C:\Program Files\PostgreSQL\18\bin\createdb.exe" -h 127.0.0.1 -p 5432 -U namosca namosca
```

### 2. Configuração

Copie `.env.example` para `.env` (ou defina as variáveis no shell):

```text
DATABASE_URL=            # opcional; sem ela, usa as PG* abaixo
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=namosca
PGUSER=namosca
PGPASSWORD=namosca
PORT=3000
CORS_ALLOWED_ORIGINS=*    # ou https://seu-front.example.com
APP_ENV=local
APP_DEBUG=false
```

### 3. Instalar, migrar, semear, rodar

```bash
pnpm install
pnpm db:migrate     # aplica database/migrations/*.sql (idempotente)
pnpm db:seed        # importa database/seed/*.txt (120 cartas)
pnpm dev            # tsx watch src/index.ts
# produção:
pnpm build && pnpm start
```

Testes (unitários, sem banco):

```bash
pnpm test
```

## Endpoints (idênticos ao PHP)

Servidos na raiz **e** sob `/api` (o cliente usa `BASE_URL '/api'`).
Erros sempre como `{"error": "mensagem"}`.

| Método | Rota | Função |
|---|---|---|
| GET | `/health` | `{ ok: true, app: "Na Mosca!", env }` |
| POST | `/rooms` | `{ nickname, mode, settings{rounds, clueSeconds} }` -> `{ code, mode, playerId, token }` |
| GET | `/rooms/:code` | estado completo; `ETag: W/"v<version>"` + 304 com `If-None-Match` |
| POST | `/rooms/:code/join` | `{ nickname }` -> `{ code, mode, playerId, token }` |
| POST | `/rooms/:code/ready` | alterna pronto (host não precisa) |
| POST | `/rooms/:code/start` | host, lobby, todos prontos |
| POST | `/rooms/:code/answer` | `{ guess }` -> `{ correct, points }` |
| POST | `/rooms/:code/skip-card` | host, 1x por partida |
| POST | `/rooms/:code/rematch` | host, após `finished` |
| POST | `/rooms/:code/leave` | sai da sala (host transfere no lobby) |
| POST | `/rooms/:code/report` | `{ reason }` reporta a carta da rodada |
| POST | `/matchmaking/queue` | `{ nickname, mode }` -> `{ queueToken, status, ... }` |
| GET | `/matchmaking/status` | polling; `Bearer <queueToken>` |
| POST | `/matchmaking/cancel` | sai da fila |

Regras mantidas: 3 pistas (10/7/4 pontos), 3 tentativas por pista, lockout de
1,5 s, morte súbita (empate no topo), matchmaking FIFO por modo (duel 2,
teams 4, royale 8 — abre com 3+ após 15 s), códigos de sala de 4 caracteres,
token opaco (guarda-se só o SHA-256).

## Deploy no Render

Há um Blueprint em `render.yaml` (serviço `namosca-api` + banco `namosca-db`):

1. Render Dashboard → **New → Blueprint** → selecione este repositório
   (ou `render.yaml` deste diretório).
2. O Blueprint cria o Postgres e o serviço web (Node 20, root `server-ts`):
   - **build**: `pnpm install --frozen-lockfile && pnpm build`
   - **pre-deploy**: `pnpm db:migrate && pnpm db:seed`
   - **start**: `pnpm start`
   - **health check**: `/health`
3. Defina no serviço (todas já como env vars):
   - `DATABASE_URL` — **obrigatória** (a connection string do Postgres;
     o Render a injeta automaticamente ao vincular `namosca-db`).
   - `CORS_ALLOWED_ORIGINS` — ex.: `https://<seu-site>.onrender.com` (ou `*`).
   - `APP_ENV=production`, `APP_DEBUG=false`.
4. O `PORT` é fornecido pelo Render; se precisar fixar, defina `PORT=10000`
   (o código lê `process.env.PORT` e usa 3000 por padrão em local).
5. Sem Docker: o serviço usa o runtime Node nativo do Render.

Sem Blueprint, o equivalente manual: crie um Web Service Node com
`rootDir = server-ts`, os comandos acima, um Render Postgres e a
`DATABASE_URL` do banco como variável de ambiente.

## Notas da portabilidade (diferenças intencionais)

- **PostgreSQL vs MySQL**: `ENUM` → `TEXT` + `CHECK`, `JSON` → `JSONB`,
  `DATETIME` → `TIMESTAMPTZ`, `BIGINT UNSIGNED AUTO_INCREMENT` → `BIGSERIAL`.
  Nomes de tabelas/colunas mantidos. `ON UPDATE CURRENT_TIMESTAMP` virou
  trigger `set_updated_at()`.
- **`GET_LOCK` → `pg_advisory_lock`** no matchmaking; **transações**
  reentrantes via `AsyncLocalStorage` (mesma semântica do `Db::txn`).
- **`--replace` do seed**: usa `ON CONFLICT ... DO UPDATE` (equivalente
  seguro ao `REPLACE INTO` sob chaves estrangeiras); sem `--replace`,
  duplicadas são ignoradas como `INSERT IGNORE`.
- **`me` no estado** omite `connected`, exatamente como no PHP (o cliente
  já lida), e os IDs `BIGINT` são expostos como números.
- **Sem dependências extras** além de `hono`, `@hono/node-server`, `pg` e
  ferramentas de dev (`typescript`, `tsx`, `@types/*`). Não há ORM.

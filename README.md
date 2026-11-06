# Na Mosca!

Jogo online de **3 pistas**: uma resposta escondida, três pistas que valem **10 · 7 · 4 pontos** e quem *deduz primeiro* leva a rodada — na mosca!

- **1v1 (duelo)** — o primeiro acerto encerra a rodada.
- **2v2 (duplas)** — times equilibrados automaticamente; o acerto vale para o time.
- **Battle royale (3–8)** — cada jogador pontua uma vez por rodada.
- **Matchmaking normal** — botão *Jogar* → fila FIFO por modo → partida montada e iniciada automaticamente. Salas privadas continuam disponíveis.
- **Morte súbita** ao empatar no fim (duelo e royale; no máximo 3 tentativas).
- Baralho curado de **120 cartas** (40 fáceis / 40 médias / 40 difíceis em 8 categorias).

## Stack

| Camada | Tecnologia | Pasta |
| --- | --- | --- |
| Client | TypeScript + Vite, DOM/CSS puro (sem framework) | `client/` |
| Server | PHP 8.3+ (front controller próprio, sem framework), PDO | `server/` |
| Banco | MySQL 8.0, UTC, `DATETIME(3)` | `server/database/migrations/` |

Servidor **autoritativo**: fases (`clue`/`reveal`/`result`) e cronômetro ficam no banco (`phase_ends_at`), comparados com `NOW(3)`. O client sincroniza por **polling HTTP** a cada ~1,2–1,7 s durante o jogo (ETag/304 quando nada mudou).

```text
client (Vite 5173)  --proxy /api-->  PHP 127.0.0.1:8080  -->  MySQL 3306
```

## Estrutura do projeto

```text
NaMosca/
├── client/                  # SPA em TypeScript + Vite
│   ├── public/
│   └── src/
│       ├── api/             # cliente HTTP, polling e sessão
│       ├── screens/         # home, fila, lobby, jogo e resultado
│       └── ui/              # componentes e helpers de interface
├── server/                  # API em PHP
│   ├── public/              # front controller + .htaccess
│   ├── src/
│   │   ├── Core/            # router, request/response, env, banco
│   │   ├── Domain/          # regras do jogo
│   │   ├── Http/            # controllers
│   │   ├── Repositories/    # acesso a dados
│   │   └── Support/         # normalização, tokens, rate limit
│   ├── database/
│   │   ├── migrations/      # schema versionado
│   │   └── seed/            # baralho curado (120 cartas)
│   ├── scripts/             # migrate, seed e testes e2e
│   └── tests/               # PHPUnit
├── docs/
│   └── AMBIENTE.md          # guia detalhado de ambiente no Windows
└── README.md
```

## Requisitos

- **PHP 8.3+** com as extensões `pdo_mysql`, `curl`, `json`, `mbstring` e `intl`
- **MySQL 8.0**
- **Node.js 20.19+** (recomendado 22+) e **pnpm** (ou npm)
- **Composer 2**

> No Windows, o passo a passo completo de instalação e verificação está em [`docs/AMBIENTE.md`](docs/AMBIENTE.md).

## Como rodar localmente

### 1. Banco de dados

Crie os bancos `namosca` e `namosca_test` e um usuário com acesso a ambos:

```sql
CREATE DATABASE IF NOT EXISTS namosca
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE DATABASE IF NOT EXISTS namosca_test
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'namosca'@'localhost'
  IDENTIFIED BY 'TROQUE_ESTA_SENHA';
CREATE USER IF NOT EXISTS 'namosca'@'127.0.0.1'
  IDENTIFIED BY 'TROQUE_ESTA_SENHA';

GRANT ALL PRIVILEGES ON namosca.* TO 'namosca'@'localhost';
GRANT ALL PRIVILEGES ON namosca.* TO 'namosca'@'127.0.0.1';
GRANT ALL PRIVILEGES ON namosca_test.* TO 'namosca'@'localhost';
GRANT ALL PRIVILEGES ON namosca_test.* TO 'namosca'@'127.0.0.1';

FLUSH PRIVILEGES;
```

### 2. Server (API)

```bash
cd server

# crie o arquivo de ambiente e ajuste DB_USER / DB_PASS
cp .env.example .env        # Windows (PowerShell): copy .env.example .env

composer install
php scripts/migrate.php                  # schema em namosca
php scripts/migrate.php --db=namosca_test
php scripts/seed-cards.php               # carrega as 120 cartas

php -S 127.0.0.1:8080 -t public public/index.php
```

API em `http://127.0.0.1:8080` — teste com `GET /api/health`.

### 3. Client (SPA)

Em outra janela:

```bash
cd client
pnpm install
pnpm dev
```

Acesse **http://localhost:5173**. O Vite faz proxy de `/api` para `http://127.0.0.1:8080`.

> Alternativa sem pnpm: use `npm install` e `npm run dev`. O projeto versiona `pnpm-lock.yaml`.

## Variáveis de ambiente

O server lê `server/.env` (veja `server/.env.example`). Esse arquivo **não é versionado**.

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `APP_ENV` | `local` | Ambiente da aplicação |
| `APP_DEBUG` | `true` | Exibe detalhes de erros (desligue em produção) |
| `APP_URL` | `http://localhost:5173` | URL do client |
| `API_URL` | `http://localhost:8080` | URL da API |
| `DB_HOST` | `127.0.0.1` | Host do MySQL |
| `DB_PORT` | `3306` | Porta do MySQL |
| `DB_NAME` | `namosca` | Banco principal |
| `DB_TEST_NAME` | `namosca_test` | Banco de testes |
| `DB_USER` | `namosca` | Usuário do banco |
| `DB_PASS` | — | Senha do banco |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173` | Origens permitidas (separadas por vírgula) |
| `GEMINI_API_KEY` | — | Chave opcional para geração de cartas por IA |
| `OPENROUTER_API_KEY` | — | Chave opcional para geração de cartas por IA |

## Como jogar

1. Clique em **Jogar**, escolha o modo e espere na fila. Quando a sala fechar, a partida começa sozinha.
2. Quer jogar com amigos? Abra **Jogar com amigos (sala privada)**, crie a sala e compartilhe o **código de 4 letras** (ou o link `?c=CODIGO`).
3. Na sala privada, todos marcam **"Estou pronto"**; o host inicia.
4. Cada rodada mostra 3 pistas. Palpite errado trava por 1,5 s; são **3 tentativas por pista**.
5. No fim das rodadas, vence quem somar mais pontos — ou a morte súbita decide.

O host pode **pular 1 carta** por partida (`Pular carta`).

### Matchmaking

Fila FIFO, sem MMR/ranque (normal game):

| Modo | Fecha com | Observação |
| --- | --- | --- |
| `duel` | 2 jogadores | imediato |
| `teams` | 4 jogadores | times 2v2 equilibrados |
| `royale` | 8 jogadores | abre com 3+ após 15 s de espera |

Quem está na fila faz heartbeat pelo `GET /matchmaking/status`; vagas sem polling por 25 s expiram. Ao fechar, o servidor cria a sala, marca todos como prontos e inicia a partida na mesma transação.

## Scripts úteis

| Comando | O que faz |
| --- | --- |
| `php server/scripts/migrate.php` | Aplica migrações pendentes (idempotente) |
| `php server/scripts/migrate.php --db=namosca_test` | Migra o banco de testes |
| `php server/scripts/seed-cards.php [--replace] [--db=...]` | Carrega/recarrega o baralho |
| `php server/scripts/e2e-smoke.php` | Partida de duelo completa contra a API real |
| `php server/scripts/e2e-matchmaking.php` | Fila, cancelamento e pareamento contra a API real |
| `cd server && composer test` | Testes unitários (PHPUnit) |
| `cd client && pnpm build` | Build de produção (`tsc` estrito + Vite) |
| `cd client && pnpm preview` | Serve o build localmente |

> Os scripts `e2e-*` exigem a API rodando em `http://127.0.0.1:8080` e o banco migrado/semeado. `0 falhas` = verde.

## API

Todos os endpoints ficam sob `/api` (via proxy do Vite):

```text
POST /rooms                  cria sala           { nickname, mode, settings }
GET  /rooms/{code}           polling (ETag)
POST /rooms/{code}/join      entra na sala
POST /rooms/{code}/ready     alterna pronto
POST /rooms/{code}/start     host inicia
POST /rooms/{code}/answer    { guess }
POST /rooms/{code}/skip-card host pula carta (1×/partida)
POST /rooms/{code}/rematch   host reabre no lobby
POST /rooms/{code}/leave     sai
POST /rooms/{code}/report    reporta a carta atual
GET  /health

POST /matchmaking/queue      entra na fila      { nickname, mode }
GET  /matchmaking/status     polling da fila (Bearer do token da vaga)
POST /matchmaking/cancel     sai da fila
```

Sessão: **Bearer token opaco** (hash SHA-256 salvo no banco), guardado no `localStorage`.

## Testes

```bash
cd server
composer test
```

Os testes unitários cobrem normalização de respostas/nomes, casamento de alternativas e utilitários. Testes de integração da API ainda estão no roadmap.

## Segurança

- Nunca comite `server/.env` nem chaves de IA (o `.gitignore` já cobre esses arquivos).
- As chaves de IA ficam apenas no servidor, nunca no client.
- Use uma senha de banco diferente entre local e produção.
- Em produção, defina `APP_DEBUG=false` e restrinja `CORS_ALLOWED_ORIGINS`.
- O jogo não tem login nem e-mail na v1: apenas apelido e token local.

## Roadmap

- [x] Servidor autoritativo + polling + ETag
- [x] Baralho curado (120 cartas)
- [x] Duelos, duplas e battle royale + morte súbita
- [x] Matchmaking normal (fila FIFO por modo)
- [x] Testes unitários (PHPUnit)
- [ ] Testes de integração da API
- [ ] Geração de cartas por IA (Gemini/OpenRouter) com benchmark e fallback — tabelas `ai_model_health` / `ai_usage` já prontas

## Licença

Projeto pessoal, sem licença de uso definida.

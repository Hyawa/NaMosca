# AMBIENTE.md — Na Mosca!

Guia de instalação e verificação do ambiente local no Windows.

- **Projeto:** `D:\Jogos\Tabuleiro\NaMosca`
- **Máquina:** Windows 10/11 x64
- **Atualizado em:** 05/11/2026
- **Objetivo:** rodar client (Vite/TypeScript) e server (PHP/MySQL) localmente, sem Docker e sem scripts portáteis.

---

## 1. Resumo do que o projeto precisa

O projeto tem três partes:

| Parte | Tecnologia | Como roda localmente |
|---|---|---|
| Client | TypeScript + Vite | `pnpm dev` na porta 5173 |
| Server/API | PHP 8.3+ + PDO | `php -S` na porta 8080 |
| Banco | MySQL 8.0 | Serviço do Windows na porta 3306 |

Fluxo local:

```text
Navegador → Vite (5173) → proxy /api → PHP (8080) → MySQL (3306)
```

**Apache não é obrigatório localmente.** O servidor embutido do PHP é oficial e suficiente. Apache será usado no deploy (Docker), e o `.htaccess` já fica pronto no projeto. Se você quiser Apache mesmo assim, há uma seção opcional no fim.

---

## 2. O que já está instalado nesta máquina

Verificado em 05/11/2026:

| Ferramenta | Versão atual | Status | Ação |
|---|---:|---|---|
| Node.js | v26.12.1 | ✅ OK | Nenhuma |
| npm | 12.0.1 | ✅ OK | Nenhuma |
| pnpm | 12.16.1 | ✅ OK | Nenhuma |
| PHP | 8.5.6 NTS | ✅ OK | Habilitar extensões |
| Composer | 2.9.8 | ✅ OK | Nenhuma |
| Git | 2.56.0 | ✅ OK | Nenhuma |
| MySQL | — | ❌ Falta | Instalar 8.0 |
| Apache | — | ⚪ Opcional | Só se quiser paridade |

Caminhos atuais:

```text
PHP:      C:\php-8.5.6-nts-Win32-vs17-x64\php.exe
php.ini:  C:\php-8.5.6-nts-Win32-vs17-x64\php.ini
Composer: C:\composer\composer.bat
Node:     C:\Program Files\nodejs\node.exe
```

Extensões PHP já ativas:

```text
curl, openssl, mbstring, pdo_mysql, PDO, json, mysqlnd
```

Extensões que faltam:

```text
intl, fileinfo, zip
```

- `intl` é usado para normalizar acentos nas respostas.
- `fileinfo` e `zip` são usados pelo Composer/PHPUnit.
- Se `intl` não puder ser habilitado, me avise: eu implemento uma normalização alternativa sem `intl`.

---

## 3. O que falta fazer

Marque conforme concluir:

- [ ] Instalar **MySQL 8.0 Community Server**
- [ ] Adicionar o `bin` do MySQL ao `PATH`
- [ ] Criar os bancos `namosca` e `namosca_test`
- [ ] Criar o usuário `namosca`
- [ ] Habilitar `intl`, `fileinfo` e `zip` no `php.ini`
- [ ] Configurar o CA bundle do PHP para HTTPS (Gemini/OpenRouter)
- [ ] Rodar o checklist da seção 12
- [ ] (Opcional) Instalar Apache

---

## 4. Node.js

**Não precisa reinstalar.** A versão v26.12.1 atende com folga (o mínimo do Vite é Node 20.19+).

Se um dia precisar reinstalar:

1. Baixe o instalador LTS em: https://nodejs.org/en/download
2. Marque **Add to PATH**.
3. Feche e abra o terminal.
4. Verifique:

```powershell
node -v
npm -v
pnpm -v
```

Se o pnpm sumir:

```powershell
corepack enable
corepack prepare pnpm@latest --activate
```

ou:

```powershell
npm install -g pnpm
```

> Observação: há mais de um `pnpm` no PATH (`Author Software\nvm`, `AppData\Local\pnpm`, `AppData\Roaming\npm`). Funciona, mas se aparecer conflito, use o primeiro do `where.exe pnpm`.

---

## 5. PHP 8.3+

A versão 8.5.6 NTS já está correta para CLI e servidor embutido. **Não use Apache com ela** (Apache `mod_php` exige build Thread Safe). Para o nosso fluxo (PHP CLI + `php -S`), NTS é o ideal.

### 5.1 Editar o php.ini

Abra exatamente este arquivo:

```text
C:\php-8.5.6-nts-Win32-vs17-x64\php.ini
```

Confira se existe uma linha `extension_dir` ativa. Se estiver comentada, ajuste para:

```ini
extension_dir = "C:\php-8.5.6-nts-Win32-vs17-x64\ext"
```

Habilite/garanta estas linhas (remova o `;` do começo, se necessário):

```ini
extension=curl
extension=fileinfo
extension=intl
extension=mbstring
extension=openssl
extension=pdo_mysql
extension=zip
```

> Não duplique linhas que já estão ativas. Se aparecer `Module already loaded`, remova a duplicata.

Ajustes recomendados para desenvolvimento:

```ini
memory_limit = 256M
max_execution_time = 120
date.timezone = UTC
error_reporting = E_ALL
display_errors = On
log_errors = On
```

`max_execution_time = 120` evita que a geração de cartas por IA estoure o tempo padrão de 30 s.

### 5.2 CA bundle (obrigatório para IA)

Sem isso, chamadas HTTPS para Gemini/OpenRouter podem falhar com `cURL error 60`.

No PowerShell:

```powershell
New-Item -ItemType Directory -Force "C:\php-8.5.6-nts-Win32-vs17-x64\extras\ssl"
Invoke-WebRequest -Uri "https://curl.se/ca/cacert.pem" -OutFile "C:\php-8.5.6-nts-Win32-vs17-x64\extras\ssl\cacert.pem"
```

Adicione ao `php.ini`:

```ini
curl.cainfo = "C:\php-8.5.6-nts-Win32-vs17-x64\extras\ssl\cacert.pem"
openssl.cafile = "C:\php-8.5.6-nts-Win32-vs17-x64\extras\ssl\cacert.pem"
```

### 5.3 Verificar

Feche e reabra o terminal e rode:

```powershell
php --ini
php -m | Select-String "intl|fileinfo|zip|pdo_mysql|curl|openssl|mbstring"
```

Esperado: todas as extensões listadas.

Teste HTTPS:

```powershell
php -r "echo file_get_contents('https://api.github.com/zen');"
```

Se retornar uma frase, o CA bundle está funcionando.

---

## 6. MySQL 8.0

### 6.1 Baixar e instalar

1. Baixe o **MySQL Installer for Windows**:  
   https://dev.mysql.com/downloads/installer/
2. Se o instalador não listar a série 8.0, use os arquivos da série 8.0:  
   https://dev.mysql.com/downloads/mysql/8.0.html
3. Executar o instalador como administrador.
4. Escolha **Custom**.
5. Selecione:
   - **MySQL Server 8.0.x** (obrigatório)
   - **MySQL Workbench 8.0.x** (opcional, mas útil para inspecionar tabelas)
6. Em **Configuration**:
   - Type and Networking: **Development Computer**
   - TCP/IP: **porta 3306**
   - Authentication: **Use Strong Password Encryption** (`caching_sha2_password`)
   - Root Password: crie uma senha forte e guarde
   - Windows Service: **MySQL80**, iniciar automaticamente
7. Execute a configuração e finalize.

### 6.2 Adicionar ao PATH

Adicione ao `PATH` do usuário:

```text
C:\Program Files\MySQL\MySQL Server 8.0\bin
```

Feche e reabra o terminal. Verifique:

```powershell
mysql --version
```

Esperado: `mysql  Ver 8.0.x ...`

### 6.3 Criar bancos e usuário

Abra o **MySQL Workbench** ou o terminal e conecte como `root`. Execute:

```sql
CREATE DATABASE IF NOT EXISTS namosca
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

CREATE DATABASE IF NOT EXISTS namosca_test
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

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

> Troque `TROQUE_ESTA_SENHA` por uma senha local. Ela vai no `server/.env`, que **não** será commitado.

### 6.4 Testar

```powershell
mysql -u namosca -p -h 127.0.0.1 -P 3306 -e "SELECT VERSION(); SHOW DATABASES;"
```

Esperado: versão 8.0.x e os bancos `namosca` e `namosca_test`.

Teste pelo PHP:

```powershell
php -r "new PDO('mysql:host=127.0.0.1;port=3306;dbname=namosca;charset=utf8mb4','namosca','TROQUE_ESTA_SENHA'); echo 'MySQL OK';"
```

Se aparecer `MySQL OK`, está pronto.

### 6.5 Serviço do Windows

```powershell
Get-Service MySQL80
Start-Service MySQL80
Stop-Service MySQL80
```

`Start-Service`/`Stop-Service` podem exigir PowerShell como administrador.

### 6.6 Se a porta 3306 estiver ocupada

Descubra o processo:

```powershell
netstat -ano | findstr :3306
```

Opções:
- Parar o outro MySQL/MariaDB.
- Reconfigurar o MySQL para 3307 e ajustar `DB_PORT=3307` no `.env`.

> Não use o MariaDB do XAMPP para este projeto. O alvo é MySQL 8.0.

---

## 7. Apache (opcional)

### Recomendação: não instalar agora

Para o desenvolvimento local, usaremos:

```text
Vite (5173) + PHP embutido (8080) + MySQL (3306)
```

Isso não é gambiarra: é o servidor de desenvolvimento oficial do PHP. O Apache entra apenas no deploy (Docker/Render). O projeto terá `.htaccess` e front controller prontos para ele.

### Se você quiser Apache mesmo assim

#### Opção A — Laragon Full (mais fácil)

1. Baixe: https://laragon.org/download/
2. Instale o **Laragon Full** (inclui Apache, PHP, MySQL e Composer).
3. Use o terminal do Laragon.
4. Aponte um virtual host para:
   ```text
   D:\Jogos\Tabuleiro\NaMosca\server\public
   ```
5. Ative `mod_rewrite` e `AllowOverride All`.
6. Escolha PHP 8.3+ e MySQL 8.0 no Laragon.

Atenção: **não misture** o PHP/MySQL do Laragon com o PHP/MySQL global. Escolha um dos dois para o projeto.

#### Opção B — Apache Lounge + PHP Thread Safe (manual)

O PHP atual é **NTS** e não funciona como módulo do Apache. Para `mod_php`, baixe um build **Thread Safe** separado.

1. Apache Lounge: https://www.apachelounge.com/download/
2. PHP Thread Safe: https://windows.php.net/download/
3. Extraia o Apache em `C:\Apache24`.
4. Extraia o PHP TS em `C:\php-8.5-ts`.
5. Configure `C:\Apache24\conf\httpd.conf`:

```apache
Define SRVROOT "C:/Apache24"
ServerRoot "C:/Apache24"
Listen 8080
ServerName localhost:8080

LoadModule rewrite_module modules/mod_rewrite.so
LoadModule php_module "C:/php-8.5-ts/php8apache2_4.dll"
AddHandler application/x-httpd-php .php
PHPIniDir "C:/php-8.5-ts"

DocumentRoot "D:/Jogos/Tabuleiro/NaMosca/server/public"
<Directory "D:/Jogos/Tabuleiro/NaMosca/server/public">
    Options FollowSymLinks
    AllowOverride All
    Require all granted
</Directory>
```

6. Inicie:

```powershell
C:\Apache24\bin\httpd.exe
```

7. Teste: http://localhost:8080/api/health

> Se usar Apache, **não rode** o `php -S` ao mesmo tempo. O Vite continua apontando para `http://127.0.0.1:8080`.

---

## 8. Composer

Já instalado (2.9.8). Verifique:

```powershell
composer -V
composer diagnose
```

Se precisar reinstalar: https://getcomposer.org/download/

Depois que o projeto existir:

```powershell
cd D:\Jogos\Tabuleiro\NaMosca
composer install --working-dir=server
```

O `vendor/` do server ficará em `server/vendor/`.

---

## 9. Git

Já instalado (2.56.0). Se ainda não configurou:

```powershell
git config --global user.name "Seu Nome"
git config --global user.email "seu@email.com"
git config --global core.longpaths true
```

---

## 10. Variáveis de ambiente

O arquivo real será `server/.env` (não versionado). Modelo:

```dotenv
APP_ENV=local
APP_DEBUG=true
APP_URL=http://localhost:5173
API_URL=http://localhost:8080

DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=namosca
DB_TEST_NAME=namosca_test
DB_USER=namosca
DB_PASS=TROQUE_ESTA_SENHA

CORS_ALLOWED_ORIGINS=http://localhost:5173

AI_PROVIDER=auto
GEMINI_API_KEY=
OPENROUTER_API_KEY=
AI_MODEL_CHAIN=
```

No client, `client/.env.local`:

```dotenv
VITE_API_URL=/api
```

Em desenvolvimento, o Vite faz proxy de `/api` para `http://127.0.0.1:8080`.

---

## 11. Portas usadas

| Porta | Serviço | Obrigatória |
|---:|---|---|
| 5173 | Vite (client) | Sim |
| 8080 | PHP API | Sim |
| 3306 | MySQL 8.0 | Sim |
| 80/443 | Apache (opcional) | Não |
| 3307 | MySQL alternativo | Só se 3306 conflitar |

---

## 12. Checklist de verificação

Rode tudo e confira:

```powershell
node -v
npm -v
pnpm -v
php -v
php --ini
php -m | Select-String "intl|fileinfo|zip|pdo_mysql|curl|openssl|mbstring"
composer -V
git --version
mysql --version
mysqladmin ping -h 127.0.0.1 -u namosca -p
```

Teste do banco pelo PHP:

```powershell
php -r "new PDO('mysql:host=127.0.0.1;port=3306;dbname=namosca;charset=utf8mb4','namosca','TROQUE_ESTA_SENHA'); echo 'MySQL OK';"
```

Teste de HTTPS:

```powershell
php -r "echo file_get_contents('https://api.github.com/zen');"
```

Tudo certo quando:

- [ ] `node -v` mostra v20.19+ (aqui v26.12.1)
- [ ] `pnpm -v` funciona
- [ ] `php -v` mostra 8.3+ (aqui 8.5.6)
- [ ] `php -m` lista `intl`, `fileinfo`, `zip`, `pdo_mysql`, `curl`, `openssl`, `mbstring`
- [ ] `composer -V` funciona
- [ ] `mysql --version` mostra 8.0.x
- [ ] `mysqladmin ping` responde `mysqld is alive`
- [ ] O teste PDO imprime `MySQL OK`
- [ ] O teste HTTPS imprime uma frase

---

## 13. Primeiro start do projeto

Depois que eu criar o projeto:

```powershell
cd D:\Jogos\Tabuleiro\NaMosca
pnpm install
composer install --working-dir=server
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`pnpm dev` vai subir:

- Vite em http://localhost:5173
- PHP API em http://localhost:8080

Testes:

- App: http://localhost:5173
- Health check: http://localhost:8080/api/health

Se o MySQL não estiver rodando:

```powershell
Start-Service MySQL80
```

---

## 14. Troubleshooting

| Sintoma | Causa provável | Solução |
|---|---|---|
| `php` não reconhecido | PHP fora do PATH | Adicionar `C:\php-8.5.6-nts-Win32-vs17-x64` ao PATH |
| `intl` não carrega | `extension_dir` errado ou DLL ausente | Conferir `php.ini`, reiniciar terminal, verificar DLLs ICU |
| `Module already loaded` | Extensão duplicada no php.ini | Remover a linha duplicada |
| `cURL error 60` | CA bundle ausente | Configurar `curl.cainfo` e `openssl.cafile` |
| `cURL error 28` | Timeout de rede/IA | Testar internet; aumentar timeout no provider |
| `SQLSTATE[HY000] [2002]` | MySQL parado/porta errada | `Get-Service MySQL80`, conferir porta 3306 |
| `SQLSTATE[HY000] [1045]` | Usuário/senha errados | Recriar usuário `namosca`, conferir `.env` |
| `SQLSTATE[HY000] [2054]` | Autenticação `caching_sha2` incompatível | Atualizar PHP ou recriar usuário com plugin compatível |
| `mysql` não reconhecido | `bin` fora do PATH | Adicionar `C:\Program Files\MySQL\MySQL Server 8.0\bin` |
| Porta 3306 ocupada | Outro MySQL/MariaDB | Parar o outro ou usar 3307 |
| Porta 8080 ocupada | Outro processo | `netstat -ano | findstr :8080`; matar ou trocar porta |
| Porta 5173 ocupada | Outra instância do Vite | Fechar ou usar `--port 5174` |
| `ECONNREFUSED` no proxy | PHP API não está rodando | Verificar `pnpm dev` e a porta 8080 |
| `Cannot find module 'vite'` | Dependências não instaladas | `pnpm install` |
| Acentos/emoji quebrados no banco | Charset errado | Usar `utf8mb4` e `utf8mb4_0900_ai_ci` |
| `429` da IA | Quota free atingida | Fallback automático; aguardar reset ou usar outro modelo |
| JSON inválido da IA | Modelo não seguiu o schema | Validador descarta e tenta o próximo modelo |
| Apache não inicia | Porta 80/8080 ocupada ou VC++ faltando | Conferir portas e instalar VC++ Redistributable |
| `ExecutionPolicy` bloqueia `.ps1` | Política do PowerShell | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| Firewall pede permissão | Node/PHP abrindo porta | Permitir apenas redes privadas |

---

## 15. O que NÃO é necessário

- Docker / Docker Desktop
- WSL
- XAMPP, WAMP ou Laragon (a menos que você escolha a opção Apache)
- Redis
- Python
- Java / Android SDK
- Servidor WebSocket
- TypeScript global (o Vite instala local)
- PHPUnit global (o Composer instala local)

Apache também é opcional no dia a dia.

---

## 16. Segurança

- Nunca commitar `server/.env`.
- Chaves de IA ficam apenas no servidor, nunca no client.
- Use uma senha local diferente da senha de produção.
- MySQL local deve escutar apenas em `127.0.0.1`.
- Não exponha a porta 3306 na internet.
- Free tiers de IA podem usar prompts para treinamento; não envie dados pessoais.
- O jogo não terá login nem e-mail na v1; apenas apelido e token local.

---

## 17. O que me enviar quando terminar

Rode e cole o resultado (sem senhas):

```powershell
node -v
pnpm -v
php -v
composer -V
mysql --version
```

E confirme:

- [ ] Os bancos `namosca` e `namosca_test` existem.
- [ ] O teste PDO imprimiu `MySQL OK`.
- [ ] `intl`, `fileinfo` e `zip` aparecem no `php -m`.
- [ ] Você quer ou não instalar Apache.

Com isso, eu começo a fase 1 do projeto.

// Espelho de server/public/index.php (bootstrap): Hono + @hono/node-server.
import { serve } from '@hono/node-server';
import { config, requirePgConfig } from './config/env.js';
import { createApp } from './http/router.js';

async function main(): Promise<void> {
  requirePgConfig();

  const app = createApp();

  serve(
    {
      fetch: app.fetch,
      port: config.port,
    },
    (info) => {
      console.log(`[NaMosca] API ouvindo em http://localhost:${info.port} (env=${config.appEnv})`);
    },
  );
}

main().catch((err) => {
  console.error('[NaMosca] falha ao iniciar:', err);
  process.exit(1);
});

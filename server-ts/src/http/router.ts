// Espelho de server/public/index.php: CORS, rotas e prefixo /api.
// O PHP remove o prefixo /api no Request; aqui o mesmo conjunto de rotas
// é servido na raiz E sob /api (o cliente usa BASE_URL '/api').
import { Hono } from 'hono';
import { config } from '../config/env.js';
import { unexpected } from '../support/responses.js';
import * as health from './controllers/health.js';
import * as match from './controllers/matchmaking.js';
import * as rooms from './controllers/rooms.js';

const ROUTES: Array<{ method: string; pattern: RegExp }> = [
  { method: 'GET', pattern: /^\/health$/ },
  { method: 'POST', pattern: /^\/rooms$/ },
  { method: 'GET', pattern: /^\/rooms\/[^/]+$/ },
  { method: 'POST', pattern: /^\/rooms\/[^/]+\/join$/ },
  { method: 'POST', pattern: /^\/rooms\/[^/]+\/ready$/ },
  { method: 'POST', pattern: /^\/rooms\/[^/]+\/start$/ },
  { method: 'POST', pattern: /^\/rooms\/[^/]+\/answer$/ },
  { method: 'POST', pattern: /^\/rooms\/[^/]+\/skip-card$/ },
  { method: 'POST', pattern: /^\/rooms\/[^/]+\/rematch$/ },
  { method: 'POST', pattern: /^\/rooms\/[^/]+\/leave$/ },
  { method: 'POST', pattern: /^\/rooms\/[^/]+\/report$/ },
  { method: 'POST', pattern: /^\/matchmaking\/queue$/ },
  { method: 'GET', pattern: /^\/matchmaking\/status$/ },
  { method: 'POST', pattern: /^\/matchmaking\/cancel$/ },
];

function buildApi(): Hono {
  const api = new Hono();

  api.get('/health', health.health);

  api.post('/rooms', rooms.create);
  api.get('/rooms/:code', rooms.state);
  api.post('/rooms/:code/join', rooms.join);
  api.post('/rooms/:code/ready', rooms.ready);
  api.post('/rooms/:code/start', rooms.start);
  api.post('/rooms/:code/answer', rooms.answer);
  api.post('/rooms/:code/skip-card', rooms.skipCard);
  api.post('/rooms/:code/rematch', rooms.rematch);
  api.post('/rooms/:code/leave', rooms.leave);
  api.post('/rooms/:code/report', rooms.report);

  api.post('/matchmaking/queue', match.enter);
  api.get('/matchmaking/status', match.status);
  api.post('/matchmaking/cancel', match.cancel);

  return api;
}

export function createApp(): Hono {
  const app = new Hono();
  const api = buildApi();

  // ------------------------- CORS ---------------------------------------
  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin') ?? '';
    const allowed = config.corsAllowedOrigins;
    const allowAny = allowed.includes('*');
    if (allowAny || allowed.includes(origin)) {
      c.header('Access-Control-Allow-Origin', origin !== '' ? origin : '*');
      c.header('Vary', 'Origin');
    }
    c.header('X-Content-Type-Options', 'nosniff');
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-None-Match');
      c.header('Access-Control-Max-Age', '86400');
      return c.body(null, 204);
    }
    await next();
  });

  // Mesmo conjunto sob / e /api (compatível com CLIENT BASE_URL '/api'
  // e com chamadas diretas a /health).
  app.route('/', api);
  app.route('/api', api);

  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    const stripped = path.startsWith('/api') && path.length > 4 ? path.slice(4) : path;
    const method = c.req.method;
    const pathExists = ROUTES.some((r) => r.pattern.test(stripped));
    if (pathExists) {
      return c.json({ error: 'Method Not Allowed' }, 405);
    }
    void method;
    return c.json({ error: 'Not Found' }, 404);
  });

  app.onError((err, c) => unexpected(c, err));

  return app;
}

// Espelho de server/src/Http/Controllers/HealthController.php
import type { Context } from 'hono';
import { config } from '../../config/env.js';

export async function health(c: Context) {
  return c.json({ ok: true, app: 'Na Mosca!', env: config.appEnv });
}

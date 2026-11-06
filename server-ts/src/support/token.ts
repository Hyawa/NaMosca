// Espelho de server/src/Support/Token.php
import { createHash, randomBytes } from 'node:crypto';

/** Token transparente entregue ao cliente (guardado no localStorage). */
export function generateToken(): string {
  return randomBytes(24).toString('base64url').replace(/=+$/, '');
}

/** Hash SHA-256 para persistir no banco. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

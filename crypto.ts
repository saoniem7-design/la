import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * AES-256-GCM envelope:  v<keyVersion>.<iv>.<authTag>.<ciphertext>   (all base64url)
 * The key-version prefix lets you rotate TOKEN_ENC_KEY by re-encrypting lazily.
 * In production, prefer a KMS (AWS KMS / GCP KMS / Vault) to hold the key.
 */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.tokenEncKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [`v${config.tokenEncKeyVersion}`, iv, tag, ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decrypt(envelope: string): string {
  const [, ivB64, tagB64, ctB64] = envelope.split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.tokenEncKey, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * lib/security.js
 * Server-side password hashing (Node crypto scrypt) and random token generation.
 * Preview-only auth system for HAKU Community / 教育者のサロン 灯.
 */
import { scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(String(password), salt, KEYLEN);
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  const derived = await scryptAsync(String(password), salt, KEYLEN);
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ブラウザへ返してはいけないパスワード関連の項目（ハッシュ・ダイジェスト等）を、再帰的に取り除いた「コピー」を返す。
// 保存されているデータ自体は変更しない（認証処理は保存済みの値をそのまま使う）。
const SECRET_KEY_RE = /^(password|passwd|pwd)$|password[_-]?hash|hashed[_-]?password|password[_-]?digest|pass[_-]?hash/i;
export function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) continue;
      out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

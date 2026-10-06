// ローカルE2E用：本物の管理API・会員API・会員ホーム配信・管理画面を、メモリ上のRedisで動かすサーバー。
// 本物のRedis（Preview/Production）には一切接続しない。使い方は tests-e2e-local/README.md。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO_URL = new URL('../', import.meta.url);
const REPO = fileURLToPath(REPO_URL);
const require = createRequire(REPO + 'package.json');
const RedisMock = require('ioredis-mock');
const U = (p) => new URL(p, REPO_URL).href;

process.env.VERCEL_ENV = 'preview';
const store = await import(U('api/_lib/store.redis.js'));
store.__setRedisForTests(new RedisMock({ host: 'e2e-' + Date.now(), port: 6379 }));
const security = await import(U('api/_lib/security.js'));
const { default: adminHandler } = await import(U('api/admin.js'));
const { default: authHandler } = await import(U('api/community-auth.js'));
const { default: homeHandler } = await import(U('api/haku-home.js'));

export const ADMIN = { email: 'admin@example.test', password: 'AdminTest-12345' };
export const MEMBER_PASSWORD = 'MemberTest-12345';

async function addMember(community, { email, fullName, kana, display, app = 'approved', membership = 'active', password = true }) {
  await store.saveUser({ email, fullName, fullNameKana: kana, displayName: display, ...(password ? { passwordHash: await security.hashPassword(MEMBER_PASSWORD) } : {}) });
  await store.createApplication(community, { email, fullName, fullNameKana: kana, displayName: display, reason: 'テスト', referrerName: '紹介者' });
  if (app !== 'pending') await store.resolveApplication(community, email, app, 'seed');
  if (membership) await store.setMembership(community, email, { status: membership });
}

export async function seed() {
  await store.saveAdminUser({ email: ADMIN.email, passwordHash: await security.hashPassword(ADMIN.password), role: process.env.E2E_ADMIN_ROLE || 'super_admin', active: true });
  await addMember('haku', { email: 'nishiyama.taro@example.com', fullName: '西山 太郎', kana: 'にしやま たろう', display: 'タロウ' });
  await addMember('haku', { email: 'Hanako.Nishiyama@Example.com', fullName: '西山 花子', kana: 'にしやま はなこ', display: 'ハナ' });
  await addMember('haku', { email: 'jiro.yamada@example.com', fullName: '山田 次郎', kana: 'やまだ じろう', display: 'ジロー' });
  await addMember('haku', { email: 'MIKU.sato@example.com', fullName: '佐藤 みく', kana: 'さとう みく', display: 'Miku', membership: 'canceling' });
  await addMember('haku', { email: 'ichiro.suzuki@example.com', fullName: '鈴木 一郎', kana: 'すずき いちろう', display: 'イチロー', membership: null });
  await addMember('haku', { email: 'pending.takahashi@example.com', fullName: '高橋 未来', kana: 'たかはし みらい', display: 'ミライ', app: 'pending', membership: null });
  await addMember('haku', { email: 'canceled.tanaka@example.com', fullName: '田中 守', kana: 'たなか まもる', display: 'マモル', membership: 'canceled' });
  await addMember('tomoshibi', { email: 'tomo.teacher@example.com', fullName: '灯 先生', kana: 'ともし せんせい', display: 'トモ' });
}

const adapt = (handler) => async (nreq, nres) => {
  const u = new URL(nreq.url, 'http://localhost');
  const chunks = []; for await (const c of nreq) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body; if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
  nreq.query = Object.fromEntries(u.searchParams); nreq.body = body;
  nres.status = (c) => { nres.statusCode = c; return nres; };
  nres.json = (o) => { nres.setHeader('Content-Type', 'application/json; charset=utf-8'); nres.end(JSON.stringify(o)); return nres; };
  nres.send = (s) => { if (!nres.getHeader('Content-Type')) nres.setHeader('Content-Type', 'text/plain'); nres.end(s); return nres; };
  nres.redirect = (c, l) => { nres.statusCode = c; nres.setHeader('Location', l); nres.end(); return nres; };
  try { await handler(nreq, nres); } catch (e) { console.error('handler error', e); nres.statusCode = 500; nres.end('err'); }
};

export function start() {
  const routes = { '/api/admin': adapt(adminHandler), '/api/community-auth': adapt(authHandler), '/haku-community-home': adapt(homeHandler) };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (routes[u.pathname]) return routes[u.pathname](req, res);
    let f = null;
    if (u.pathname === '/admin-community' || u.pathname === '/admin-community.html') f = path.join(REPO, 'admin-community.html');
    else if (u.pathname.startsWith('/lp-assets/')) f = path.join(REPO, u.pathname);
    if (f && fs.existsSync(f)) {
      res.writeHead(200, { 'Content-Type': f.endsWith('.png') ? 'image/png' : f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
      return fs.createReadStream(f).pipe(res);
    }
    res.writeHead(404); res.end('nf');
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, base: 'http://localhost:' + server.address().port })));
}
export { store };

/**
 * 管理APIのレスポンスに、パスワードのハッシュ等が含まれないことのテスト。
 * あわせて、保存されているハッシュ自体は残っていて、ログイン（会員・管理者）が従来どおり動くことを確認する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import * as store from '../api/_lib/store.redis.js';
import { hashPassword, stripSecrets } from '../api/_lib/security.js';

store.__setRedisForTests(new RedisMock({ host: 'mock-admin-secrets', port: 6379 }));
process.env.VERCEL_ENV = 'preview';
const { default: adminHandler } = await import('../api/admin.js');
const { default: authHandler } = await import('../api/community-auth.js');

function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.getHeader = (k) => res.headers[k.toLowerCase()];
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}
let ipSeq = 0;
async function call(handler, cookie, action, { method = 'GET', body = {}, query = {} } = {}) {
  const n = ++ipSeq;
  const ip = `10.2.${(n >> 8) & 255}.${n & 255}`;
  const res = fakeRes();
  await handler({ method, query: { action, ...query }, body, headers: { cookie: cookie || '', host: 'example.test', 'x-forwarded-for': ip }, socket: { remoteAddress: ip } }, res);
  return { status: res.statusCode, body: res.body };
}
const admin = (cookie, action, opts) => call(adminHandler, cookie, action, opts);
const auth = (cookie, action, opts) => call(authHandler, cookie, action, opts);

const PASSWORD = 'Correct-Horse-9';
const EMAIL = 'secret.check@example.com';
const ADMIN_EMAIL = 'root.check@example.com';
const ADMIN_PASSWORD = 'Admin-Pass-77';
let userHash; let adminHash;

test('準備：ハッシュ付きの会員・管理者を作る', async () => {
  userHash = await hashPassword(PASSWORD);
  adminHash = await hashPassword(ADMIN_PASSWORD);
  await store.saveUser({ email: EMAIL, displayName: 'ひみつ', fullName: '秘密 太郎', fullNameKana: 'ひみつ たろう', passwordHash: userHash });
  await store.createApplication('haku', { email: EMAIL, fullName: '秘密 太郎', fullNameKana: 'ひみつ たろう', displayName: 'ひみつ' });
  await store.resolveApplication('haku', EMAIL, 'approved', 'test');
  await store.setMembership('haku', EMAIL, { status: 'active' });
  await store.saveAdminUser({ email: ADMIN_EMAIL, passwordHash: adminHash, role: 'super_admin', active: true });
});

test('管理者：会員詳細・会員一覧・ポイント関連のレスポンスにハッシュが含まれない', async () => {
  const login = await admin('', 'login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert.equal(login.status, 200, '管理者ログインは従来どおり成功');
  const sid = await store.createAdminSession({ actorId: ADMIN_EMAIL, role: 'super_admin' });
  const cookie = `ht_admin_session=${sid}`;

  const detail = await admin(cookie, 'member-detail', { query: { email: EMAIL } });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.ok, true);
  assert.equal(detail.body.user.fullName, '秘密 太郎', '会員詳細の表示項目は残っている');
  assert.equal(detail.body.user.email, EMAIL);
  assert.equal(detail.body.haku.membership.status, 'active');
  assert.equal('passwordHash' in detail.body.user, false, 'user.passwordHash が無い');

  const responses = {
    'member-detail': detail,
    members: await admin(cookie, 'members', { query: { community: 'haku' } }),
    'points-member': await admin(cookie, 'points-member', { query: { email: EMAIL } }),
    'points-recent': await admin(cookie, 'points-recent'),
    whoami: await admin(cookie, 'whoami'),
  };
  assert.equal(responses.members.body.members.some((m) => m.email === EMAIL), true, '会員一覧に対象会員が出る');
  for (const [name, r] of Object.entries(responses)) {
    assert.equal(r.status, 200, name);
    const text = JSON.stringify(r.body);
    assert.equal(/password|passwd|hash/i.test(text), false, `${name}: パスワード/ハッシュ関連の項目が無い`);
    assert.equal(text.includes(userHash), false, `${name}: 会員のハッシュ値が無い`);
    assert.equal(text.includes(adminHash), false, `${name}: 管理者のハッシュ値が無い`);
  }
});

test('会員側：me のレスポンスにもハッシュが含まれない', async () => {
  const sid = await store.createSession(EMAIL);
  const me = await auth(`ht_session=${sid}`, 'me');
  assert.equal(me.body.ok, true);
  const text = JSON.stringify(me.body);
  assert.equal(/password|hash/i.test(text), false);
  assert.equal(text.includes(userHash), false);
});

test('保存されているハッシュは消えていない／会員ログインは従来どおり', async () => {
  const stored = await store.getUser(EMAIL);
  assert.equal(stored.passwordHash, userHash, '保存データのハッシュは変更されていない');
  const ok = await auth('', 'login', { method: 'POST', body: { community: 'haku', email: EMAIL, password: PASSWORD } });
  assert.equal(ok.status, 200, `正しいパスワードでログインできる: ${JSON.stringify(ok.body)}`);
  const ng = await auth('', 'login', { method: 'POST', body: { community: 'haku', email: EMAIL, password: 'wrong-password' } });
  assert.equal(ng.status, 401, '間違ったパスワードは拒否');
  const adminNg = await admin('', 'login', { method: 'POST', body: { email: ADMIN_EMAIL, password: 'wrong' } });
  assert.equal(adminNg.status, 401);
});

test('stripSecrets：入れ子・配列も除外し、元のオブジェクトは変更しない', () => {
  const src = { a: 1, passwordHash: 'x', n: { password_hash: 'y', hashedPassword: 'z', passwordDigest: 'd', keep: 2 }, list: [{ passwordHash: 'q', ok: true }], displayName: 'ok', passwordSetAt: 123 };
  const out = stripSecrets(src);
  assert.deepEqual(out, { a: 1, n: { keep: 2 }, list: [{ ok: true }], displayName: 'ok', passwordSetAt: 123 });
  assert.equal(src.passwordHash, 'x');
  assert.equal(src.n.password_hash, 'y');
});

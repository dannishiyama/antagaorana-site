/**
 * 管理API（api/admin.js）のHAKUポイント操作・会員一覧・ログイン確認のテスト。
 * メモリ上のRedisモックに対して実行する（本物のRedisには接続しない）。
 *   npm install --no-save --legacy-peer-deps ioredis@5 ioredis-mock react@18 react-dom@18
 *   node --test "tests-unit/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import * as store from '../api/_lib/store.redis.js';

store.__setRedisForTests(new RedisMock({ host: 'mock-admin-points', port: 6379 }));
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
  const ip = `10.1.${(n >> 8) & 255}.${n & 255}`;
  const res = fakeRes();
  await handler({ method, query: { action, ...query }, body, headers: { cookie: cookie || '', host: 'example.test', 'x-forwarded-for': ip }, socket: { remoteAddress: ip } }, res);
  return { status: res.statusCode, body: res.body };
}
const admin = (cookie, action, opts) => call(adminHandler, cookie, action, opts);
const post = (cookie, action, body) => admin(cookie, action, { method: 'POST', body });

let seq = 0;
async function member({ membership = 'active', app = 'approved', name = '山田太郎' } = {}) {
  const email = `m${++seq}_${Date.now()}@example.com`;
  await store.saveUser({ email, displayName: name, fullName: name, fullNameKana: 'やまだたろう' });
  await store.createApplication('haku', { email, fullName: name, fullNameKana: 'やまだたろう', displayName: name });
  if (app !== 'pending') await store.resolveApplication('haku', email, app, 'test');
  if (membership) await store.setMembership('haku', email, { status: membership });
  const sid = await store.createSession(email);
  return { email, sid, cookie: `ht_session=${sid}` };
}
async function adminCookie(role = 'super_admin', actorId = 'admin@example.com') {
  return `ht_admin_session=${await store.createAdminSession({ actorId, role })}`;
}
const rid = () => `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

test('whoami：管理者ログインがあれば200、なければ401（ページを開き直したときの復元用）', async () => {
  assert.equal((await admin('', 'whoami')).status, 401);
  const c = await adminCookie('staff', 'staff@example.com');
  const r = await admin(c, 'whoami');
  assert.equal(r.status, 200); assert.equal(r.body.actorId, 'staff@example.com'); assert.equal(r.body.role, 'staff');
  const m = await member();
  assert.equal((await admin(m.cookie, 'whoami')).status, 401, '一般会員のCookieは管理者として扱われない');
});

test('会員一覧：ポイントを持つのは会員資格（Membership）がある人だけ。操作可否が明示される', async () => {
  const active = await member({ membership: 'active' });
  const canceling = await member({ membership: 'canceling' });
  const canceled = await member({ membership: 'canceled' });
  const unpaid = await member({ membership: null });
  const pending = await member({ membership: null, app: 'pending' });
  const c = await adminCookie();
  const list = (await admin(c, 'members', { query: { community: 'haku' } })).body.members;
  const get = (m) => list.find((x) => x.email === m.email);
  assert.equal(get(active).canOperatePoints, true);   assert.equal(get(active).points, 0);
  assert.equal(get(canceling).canOperatePoints, true);
  assert.equal(get(canceled).canOperatePoints, false); assert.equal(get(canceled).points, 0);
  assert.equal(get(unpaid).canOperatePoints, false);  assert.equal(get(unpaid).points, null);
  assert.equal(get(pending).canOperatePoints, false); assert.equal(get(pending).points, null);
  assert.ok(get(active).fullName && get(active).fullNameKana && get(active).displayName && get(active).email, '検索に必要な項目が揃っている');
});

test('付与→調整→取消。現在ポイントは台帳から算出され、会員側と一致する', async () => {
  const m = await member();
  const c = await adminCookie('super_admin', 'owner@example.com');
  assert.equal((await post(c, 'points-grant', { email: m.email, amount: 100, reason: '朝会', requestId: rid() })).body.balance, 100);
  assert.equal((await post(c, 'points-grant', { email: m.email, amount: 50, reason: '', requestId: rid() })).body.balance, 150);
  const adj = await post(c, 'points-adjust', { email: m.email, amount: -20, reason: '訂正', requestId: rid() });
  assert.equal(adj.body.balance, 130);
  const view = (await admin(c, 'points-member', { query: { email: m.email } })).body;
  assert.equal(view.balance, 130); assert.equal(view.canOperate, true); assert.equal(view.fullName, '山田太郎');
  assert.deepEqual(view.entries.map((e) => [e.kind, e.delta]), [['admin_adjust', -20], ['admin_grant', 50], ['admin_grant', 100]]);
  assert.ok(view.entries.every((e) => e.actorId === 'owner@example.com' && e.id && e.createdAt), '操作者・ID・日時が記録される');
  const mine = (await call(authHandler, m.cookie, 'points-me')).body;
  assert.equal(mine.balance, 130, '会員側の残高と一致');
  assert.deepEqual(mine.entries.map((e) => e.delta), [-20, 50, 100]);
  const rev = await post(c, 'points-reverse', { entryId: view.entries[2].id, reason: '誤付与', requestId: rid() });
  assert.equal(rev.body.balance, 30);
  const after = (await admin(c, 'points-member', { query: { email: m.email } })).body;
  assert.equal(after.entries.length, 4, '元の履歴は消えず、取消の行が追加される');
  assert.equal(after.entries[0].reversalOf, view.entries[2].id);
  assert.equal(after.entries.find((e) => e.id === view.entries[2].id).reversed, true);
  assert.equal((await post(c, 'points-reverse', { entryId: view.entries[2].id, reason: '二重', requestId: rid() })).status, 409, '二重取消は不可');
});

test('同じ操作IDの再送・同時送信では二重付与にならない', async () => {
  const m = await member();
  const c = await adminCookie();
  const id = rid();
  const rs = await Promise.all(Array.from({ length: 6 }, () => post(c, 'points-grant', { email: m.email, amount: 40, reason: '連打', requestId: id })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(rs.filter((r) => !r.body.duplicate).length, 1);
  assert.equal((await admin(c, 'points-member', { query: { email: m.email } })).body.balance, 40);
  const conflict = await post(c, 'points-grant', { email: m.email, amount: 99, reason: '別内容', requestId: id });
  assert.equal(conflict.status, 409, '同じ操作IDで内容が違えば拒否（取り違え防止）');
});

test('管理者ロールを問わず、ログイン済みの管理者は付与・調整・取消ができる', async () => {
  const m = await member();
  const staff = await adminCookie('staff', 'staff@example.com');
  assert.equal((await post(staff, 'points-grant', { email: m.email, amount: 10, requestId: rid() })).status, 200);
  assert.equal((await post(staff, 'points-adjust', { email: m.email, amount: -3, reason: '調整', requestId: rid() })).status, 200);
  const entries = (await admin(staff, 'points-member', { query: { email: m.email } })).body.entries;
  assert.equal((await post(staff, 'points-reverse', { entryId: entries[0].id, reason: '取消', requestId: rid() })).status, 200, '調整(-3)の取消');
  // 取り消すと残高がマイナスになる場合は、取消もできない（台帳の整合性）
  assert.equal((await post(staff, 'points-adjust', { email: m.email, amount: -10, reason: '減らす', requestId: rid() })).status, 200);
  assert.equal((await post(staff, 'points-reverse', { entryId: entries[1].id, reason: '取消', requestId: rid() })).status, 409);
});

test('会員資格がない・存在しない人には付与も調整もできない', async () => {
  const c = await adminCookie();
  const unpaid = await member({ membership: null });
  const canceled = await member({ membership: 'canceled' });
  const send = (email) => post(c, 'points-grant', { email, amount: 10, requestId: rid() });
  assert.deepEqual([(await send(unpaid.email)).status, (await send(unpaid.email)).body.code], [404, 'not_member']);
  assert.deepEqual([(await send(canceled.email)).status, (await send(canceled.email)).body.code], [409, 'not_active_member']);
  assert.equal((await send('nobody@example.com')).status, 404);
  assert.equal((await post(c, 'points-adjust', { email: canceled.email, amount: 5, reason: 'x', requestId: rid() })).status, 409);
  assert.equal((await send('')).status, 400);
});

test('入力値の検証（空・0・文字・負数・小数・巨大・残高超過・理由必須）', async () => {
  const m = await member();
  const c = await adminCookie();
  const g = (amount, extra = {}) => post(c, 'points-grant', { email: m.email, amount, reason: '', requestId: rid(), ...extra });
  for (const bad of ['', null, undefined, 0, '0', 'abc', -5, '-5', 1.5, 1e9, 1000001]) assert.equal((await g(bad)).status, 400, `不正値: ${bad}`);
  assert.equal((await g(100, { requestId: 'short' })).status, 400, '操作IDの形式不正');
  assert.equal((await g(100, { reason: 'あ'.repeat(201) })).status, 400, '理由が長すぎる');
  assert.equal((await post(c, 'points-adjust', { email: m.email, amount: -5, reason: '', requestId: rid() })).status, 400, '調整は理由が必須');
  assert.equal((await post(c, 'points-adjust', { email: m.email, amount: -5, reason: '残高0でマイナス', requestId: rid() })).status, 409, '残高を超える減算は不可');
  assert.equal((await post(c, 'points-reverse', { entryId: 'nope', reason: 'x', requestId: rid() })).status, 404);
  assert.equal((await admin(c, 'points-member', { query: { email: m.email } })).body.balance, 0, '一度も保存されていない');
});

test('一般会員・未ログインは、ポイントの閲覧・付与・調整・取消・履歴・会員一覧のどれも不可', async () => {
  const m = await member();
  const target = await member();
  for (const cookie of [m.cookie, '']) {
    for (const action of ['points-grant', 'points-adjust', 'points-reverse']) {
      assert.equal((await post(cookie, action, { email: target.email, amount: 1000, reason: 'x', requestId: rid(), entryId: 'x' })).status, 401, action);
    }
    assert.equal((await admin(cookie, 'points-recent')).status, 401);
    assert.equal((await admin(cookie, 'points-member', { query: { email: target.email } })).status, 401);
    assert.equal((await admin(cookie, 'members', { query: { community: 'haku' } })).status, 401);
  }
  assert.equal((await post(m.cookie, 'points-grant', { email: m.email, amount: 1000, requestId: rid() })).status, 401, '自分への付与も不可');
  // 会員向けAPIに付与の入口は存在しない
  assert.equal((await call(authHandler, m.cookie, 'points-grant', { method: 'POST', body: { email: m.email, amount: 1000 } })).status, 400);
  assert.equal((await call(authHandler, m.cookie, 'points-me')).body.balance, 0);
});

test('全会員の履歴：会員名・種別・理由・操作者・日時が付く（確認用）', async () => {
  const m = await member({ name: '西山花子' });
  const c = await adminCookie('super_admin', 'owner@example.com');
  await post(c, 'points-grant', { email: m.email, amount: 70, reason: '履歴の確認', requestId: rid() });
  const r = await admin(c, 'points-recent');
  assert.equal(r.status, 200);
  const e = r.body.entries.find((x) => x.email === m.email);
  assert.equal(e.fullName, '西山花子'); assert.equal(e.displayName, '西山花子');
  assert.deepEqual([e.delta, e.kind, e.reason, e.actorId], [70, 'admin_grant', '履歴の確認', 'owner@example.com']);
  assert.ok(e.createdAt && e.id);
});

test('付与・調整・取消は操作履歴（監査ログ）にも残る', async () => {
  const m = await member();
  const c = await adminCookie('super_admin', 'audit@example.com');
  await post(c, 'points-grant', { email: m.email, amount: 10, requestId: rid() });
  await post(c, 'points-adjust', { email: m.email, amount: 5, reason: '調整', requestId: rid() });
  const entries = (await admin(c, 'points-member', { query: { email: m.email } })).body.entries;
  await post(c, 'points-reverse', { entryId: entries[0].id, reason: '取消', requestId: rid() });
  const log = (await admin(c, 'audit-log')).body.entries.filter((e) => e.targetId === m.email).map((e) => e.action).sort();
  assert.deepEqual(log, ['point_adjust', 'point_grant', 'point_reverse']);
});

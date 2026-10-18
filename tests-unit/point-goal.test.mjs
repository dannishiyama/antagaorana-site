/**
 * HAKUポイントの個人目標（api/_lib/point-goal.js ＋ api/community-auth.js の points-goal-set / points-me）のテスト。
 * 確かめること：検証（0・負数・小数・異常値）／本人だけ（他会員・未ログイン・無効な会員資格は不可）／
 * 目標を変えても残高・履歴は変わらない／会員ごとに独立／解除／不正なOrigin／目標を直接書き込んでも台帳に影響しない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import * as store from '../api/_lib/store.redis.js';

store.__setRedisForTests(new RedisMock({ host: 'mock-point-goal', port: 6379 }));
process.env.VERCEL_ENV = 'preview';
const { default: authHandler } = await import('../api/community-auth.js');
const { grantPoints } = await import('../api/_lib/points.js');
const { parseGoal } = await import('../api/_lib/point-goal.js');

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
async function call(cookie, action, { method = 'GET', body = {}, origin = 'https://example.test' } = {}) {
  const n = ++ipSeq; const ip = `10.7.${(n >> 8) & 255}.${n & 255}`;
  const res = fakeRes();
  await authHandler({ method, query: { action }, body, headers: { cookie: cookie || '', host: 'example.test', origin, 'x-forwarded-for': ip }, socket: { remoteAddress: ip } }, res);
  return { status: res.statusCode, body: res.body };
}
let seq = 0;
async function member(membership = 'active') {
  const email = `g${++seq}_${Date.now()}@example.com`;
  await store.saveUser({ email, displayName: 'テスト', fullName: 'テスト', fullNameKana: 'てすと' });
  await store.createApplication('haku', { email, fullName: 'テスト', fullNameKana: 'てすと', displayName: 'テスト' });
  await store.resolveApplication('haku', email, 'approved', 'test');
  if (membership) await store.setMembership('haku', email, { status: membership });
  return { email, cookie: `ht_session=${await store.createSession(email)}` };
}
const setGoal = (cookie, goal, opts) => call(cookie, 'points-goal-set', { method: 'POST', body: { goal }, ...opts });

test('検証：1〜100,000の整数だけ。0・負数・小数・文字・指数・異常に大きい値・空は拒否', () => {
  for (const ok of [1, 300, '300', ' 45 ', 100000]) assert.equal(typeof parseGoal(ok), 'number');
  for (const bad of [0, -5, 1.5, '1.5', 'abc', '1e3', 100001, 99999999999, Infinity, NaN, null, undefined, '', '０', '３００', '1,000', {}, []]) assert.throws(() => parseGoal(bad), (e) => e.code === 'bad_goal', String(bad));
});

test('設定・変更・解除。未設定は null。目標を変えても残高・履歴は変わらない', async () => {
  const m = await member();
  await grantPoints({ email: m.email, amount: 30, reason: 'テスト付与', actorId: 'admin@example.com', requestId: `r-${Date.now()}` });
  const before = (await call(m.cookie, 'points-me')).body;
  assert.equal(before.goal, null, '未設定は null');
  assert.equal(before.balance, 30);
  assert.equal((await setGoal(m.cookie, 300)).body.goal, 300);
  assert.equal((await call(m.cookie, 'points-me')).body.goal, 300);
  assert.equal((await setGoal(m.cookie, 500)).body.goal, 500);
  const after = (await call(m.cookie, 'points-me')).body;
  assert.deepEqual([after.balance, after.total, after.entries.length, after.entries[0].delta], [before.balance, before.total, before.entries.length, 30], '目標を変えても台帳は同じ');
  assert.equal((await setGoal(m.cookie, null)).body.goal, null, '解除');
  assert.equal((await call(m.cookie, 'points-me')).body.goal, null);
  assert.equal((await call(m.cookie, 'points-me')).body.balance, 30);
});

test('不正な値は400で、保存済みの目標は変わらない', async () => {
  const m = await member();
  await setGoal(m.cookie, 200);
  for (const bad of [0, -1, 2.5, 'x', 1e9, '']) {
    const r = await setGoal(m.cookie, bad);
    if (bad === '') { assert.equal(r.status, 200, '空は解除'); await setGoal(m.cookie, 200); continue; }
    assert.equal(r.status, 400, String(bad));
  }
  assert.equal((await call(m.cookie, 'points-me')).body.goal, 200);
});

test('会員ごとに独立／本人以外は読めない・変えられない（メールアドレスを指定する経路が無い）', async () => {
  const a = await member(); const b = await member();
  await setGoal(a.cookie, 100); await setGoal(b.cookie, 900);
  assert.equal((await call(a.cookie, 'points-me')).body.goal, 100);
  assert.equal((await call(b.cookie, 'points-me')).body.goal, 900);
  // リクエストにメールアドレスを入れても、無視される（セッションの本人にだけ作用）
  await call(a.cookie, 'points-goal-set', { method: 'POST', body: { goal: 111, email: b.email } });
  assert.equal((await call(b.cookie, 'points-me')).body.goal, 900, '他の会員の目標は変わらない');
  assert.equal((await call(a.cookie, 'points-me')).body.goal, 111);
  assert.equal((await call(a.cookie, 'points-me')).body.email, undefined, '他人の情報は返さない');
});

test('未ログイン・無効な会員資格・GET・不正なOriginは拒否', async () => {
  assert.equal((await setGoal('', 100)).status, 401);
  const canceled = await member('canceled');
  assert.equal((await setGoal(canceled.cookie, 100)).status, 403);
  const m = await member();
  assert.equal((await call(m.cookie, 'points-goal-set', { method: 'GET' })).status, 405);
  assert.equal((await setGoal(m.cookie, 100, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(m.cookie, 'points-me')).body.goal, null, '拒否された操作は保存されない');
});

test('ポイントの付与・取消は、目標に影響されない（目標はあくまで本人の目安）', async () => {
  const m = await member();
  await setGoal(m.cookie, 10);
  await grantPoints({ email: m.email, amount: 50, reason: '目標を超える付与', actorId: 'admin@example.com', requestId: `r2-${Date.now()}` });
  const v = (await call(m.cookie, 'points-me')).body;
  assert.deepEqual([v.balance, v.goal], [50, 10], '目標を超えても、残高はそのまま（達成の表示は画面側）');
});

test('これまでの積み重ね（grown）：社会貢献に使っても減らない。残高（balance）とは別。調整・取消は反映される', async () => {
  const m = await member();
  await grantPoints({ email: m.email, amount: 1350, reason: '付与', actorId: 'admin@example.com', requestId: `gr-${Date.now()}` });
  const P = await import('../api/_lib/points.js');
  await P.holdForDonation({ email: m.email, amount: 1000, idempotencyKey: `hold:grown-${Date.now()}`, refId: 'DN-TEST', actorId: m.email });
  const v = (await call(m.cookie, 'points-me')).body;
  assert.deepEqual([v.balance, v.grown], [350, 1350], '使うと残高は減るが、積み重ねは減らない');
  await P.adjustPoints({ email: m.email, amount: -50, reason: '調整', requestId: `adj-${Date.now()}`, actorId: 'admin@example.com' });
  assert.deepEqual([(await call(m.cookie, 'points-me')).body.grown], [1300], '調整は反映される');
});

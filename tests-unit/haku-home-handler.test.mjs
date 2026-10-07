/**
 * 会員ホームの配信（api/haku-home.js）を、本物のセッション判定のまま、メモリ上のRedisモックで通して確認する。
 * 本物のRedis（Preview/Production）には接続しない。
 *   npm install --no-save --legacy-peer-deps ioredis@5 ioredis-mock react@18 react-dom@18
 *   node --test "tests-unit/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import * as store from '../api/_lib/store.redis.js';

store.__setRedisForTests(new RedisMock({ host: 'mock-haku-home', port: 6379 }));
const { default: handler } = await import('../api/haku-home.js');

function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {}, location: null };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.redirect = (c, loc) => { res.statusCode = c; res.location = loc; return res; };
  return res;
}
async function get(cookie) {
  const res = fakeRes();
  await handler({ method: 'GET', headers: { cookie: cookie || '', host: 'example.test' }, query: {} }, res);
  return res;
}

let seq = 0;
async function member(status = 'active', displayName = '山田太郎') {
  const email = `home${++seq}_${Date.now()}@example.com`;
  await store.saveUser({ email, displayName, fullName: '山田太郎', fullNameKana: 'やまだたろう' });
  await store.createApplication('haku', { email });
  await store.resolveApplication('haku', email, 'approved', 'test');
  await store.setMembership('haku', email, { status });
  const sid = await store.createSession(email);
  return { email, sid };
}

test('未ログインはログインページへ（本文は返さない）', async () => {
  const r = await get('');
  assert.equal(r.statusCode, 302);
  assert.equal(r.location, '/haku-community/login/');
  assert.equal(r.body, null);
});

test('会員（有効）には新しい画面が返り、未置換のプレースホルダーも管理者リンクもない', async () => {
  const m = await member();
  const r = await get(`ht_session=${m.sid}`);
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.equal(r.headers['cache-control'], 'no-store');
  const html = r.body;
  assert.ok(html.includes('<div class="side">') && html.includes('class="side-member"'));
  assert.ok(html.includes('HAKU Community') && html.includes('教育支援団体'));
  assert.ok(!/\{\{[^}]*\}\}/.test(html));
  assert.ok(!html.includes('/haku-community/admin'));
  assert.ok(!html.includes('株式会社'));
});

test('有効な運営ログイン（ht_admin_session）がある場合だけ、管理画面へのリンクがHTMLに入る', async () => {
  const m = await member();
  const adminSid = await store.createAdminSession({ actorId: 'admin@example.com', role: 'super_admin' });
  const withAdmin = await get(`ht_session=${m.sid}; ht_admin_session=${adminSid}`);
  assert.ok(withAdmin.body.includes('/haku-community/admin/'));
  const fakeAdmin = await get(`ht_session=${m.sid}; ht_admin_session=forged-session-id`);
  assert.ok(!fakeAdmin.body.includes('/haku-community/admin'), '偽の運営セッションでは出ない');
  const none = await get(`ht_session=${m.sid}`);
  assert.ok(!none.body.includes('/haku-community/admin'));
});

test('表示名はHTMLとスクリプトの両方で安全に埋め込まれる', async () => {
  const m = await member('active', '</script><script>alert(1)</script>"<img src=x onerror=alert(2)>');
  const r = await get(`ht_session=${m.sid}`);
  assert.equal(r.statusCode, 200);
  assert.ok(!r.body.includes('<script>alert(1)'));
  assert.ok(!r.body.includes('<img src=x onerror'));
});

test('解約予約中（canceling）は引き続き表示、解約済み・未承認はログインへ戻す', async () => {
  const canceling = await member('canceling');
  assert.equal((await get(`ht_session=${canceling.sid}`)).statusCode, 200);
  const canceled = await member('canceled');
  assert.equal((await get(`ht_session=${canceled.sid}`)).statusCode, 302);
  const email = `pending_${Date.now()}@example.com`;
  await store.saveUser({ email, displayName: 'x', fullName: 'x', fullNameKana: 'えっくす' });
  await store.createApplication('haku', { email }); // 承認前（pending）のまま
  await store.setMembership('haku', email, { status: 'active' });
  const sid = await store.createSession(email);
  assert.equal((await get(`ht_session=${sid}`)).statusCode, 302, '承認前は見せない');
});

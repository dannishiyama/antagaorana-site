/**
 * 月ごとの振り返り・1か月前のあなたから（api/_lib/reflection.js ＋ community-auth.js）のテスト。メモリ上のRedisだけを使う。
 * 確かめること：登録・編集・閲覧／任意（空は不可）／検証／本人のみ（他人・未ログイン・無効な会員資格は不可。管理APIに経路がない）／
 *   二重保存・競合／1か月前の表示（本人の公開投稿・約束・振り返り）／元の記録の編集・削除・非表示との整合／いまの気持ちの保存・削除。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import * as store from '../api/_lib/store.redis.js';

store.__setRedisForTests(new RedisMock({ host: 'mock-reflect', port: 6379 }));
process.env.VERCEL_ENV = 'preview';
const { default: authHandler } = await import('../api/community-auth.js');
const { default: adminHandler } = await import('../api/admin.js');
const R = await import('../api/_lib/reflection.js');

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
async function call(handler, cookie, action, { method = 'GET', body = {}, query = {}, origin = 'https://example.test' } = {}) {
  const n = ++ipSeq; const ip = `10.12.${(n >> 8) & 255}.${n & 255}`;
  const res = fakeRes();
  await handler({ method, query: { action, ...query }, body, headers: { cookie: cookie || '', host: 'example.test', origin, 'x-forwarded-for': ip }, socket: { remoteAddress: ip } }, res);
  return { status: res.statusCode, body: res.body };
}
const mem = (c, a, o) => call(authHandler, c, a, o);
const post = (c, a, body, o) => mem(c, a, { method: 'POST', body, ...o });
let seq = 0;
async function member(membership = 'active') {
  const email = `r${++seq}_${Date.now()}@example.com`;
  await store.saveUser({ email, displayName: '振り返り会員', fullName: '振り返り会員', fullNameKana: 'ふりかえり' });
  await store.createApplication('haku', { email, fullName: '振り返り会員', fullNameKana: 'ふりかえり', displayName: '振り返り会員' });
  await store.resolveApplication('haku', email, 'approved', 'test');
  if (membership) await store.setMembership('haku', email, { status: membership });
  return { email, cookie: `ht_session=${await store.createSession(email)}` };
}
const thisMonth = R.currentMonth();
const prevMonth = (() => { const d = new Date(`${thisMonth}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
const save = (m, body) => post(m.cookie, 'reflect-save', { month: thisMonth, ...body });
// 約30日前に書いた公開投稿を、直接つくる（作成日時を過去にする）
async function oldPost(m, daysAgo, { body = '1か月前に書いたことば', status = 'published' } = {}) {
  const rec = await store.createPost('haku', { authorEmail: m.email, title: '昔の題名', body, category: 'today_did' });
  const at = Date.now() - daysAgo * 86400e3;
  const key = `ht:post:${rec.id}`;
  const raw = JSON.parse(await store.getRedis().get(key));
  await store.getRedis().set(key, JSON.stringify({ ...raw, createdAt: at, updatedAt: at, status }));
  return rec.id;
}

test('振り返り：登録・閲覧・編集。入力は任意（空は保存できない）。項目ごとに500文字まで', async () => {
  const m = await member();
  assert.deepEqual((await mem(m.cookie, 'reflect-list')).body.reflections, [], '最初は空');
  assert.equal((await save(m, {})).status, 400, '空は保存できない');
  assert.equal((await save(m, { noticed: '   ' })).status, 400);
  const r = await save(m, { noticed: '朝の時間を大切にできた', nextMonth: '早く寝る' });
  assert.equal(r.status, 200); assert.equal(r.body.reflection.noticed, '朝の時間を大切にできた'); assert.equal(r.body.reflection.practiced, '');
  const list = (await mem(m.cookie, 'reflect-list')).body;
  assert.deepEqual([list.reflections.length, list.reflections[0].month, list.currentMonth], [1, thisMonth, thisMonth]);
  const edit = await save(m, { noticed: '朝の時間を大切にできた', practiced: '10分の散歩', nextMonth: '早く寝る', baseUpdatedAt: r.body.reflection.updatedAt });
  assert.equal(edit.status, 200);
  assert.equal((await mem(m.cookie, 'reflect-list')).body.reflections[0].practiced, '10分の散歩');
  assert.equal((await save(m, { noticed: 'あ'.repeat(501) })).status, 400);
  assert.equal((await save(m, { noticed: 'あ'.repeat(500) })).status, 200);
  const after = await post(m.cookie, 'reflect-save', { month: prevMonth, changed: '先月のふりかえり' });
  assert.equal(after.status, 200);
  assert.deepEqual((await mem(m.cookie, 'reflect-list')).body.reflections.map((x) => x.month), [thisMonth, prevMonth], '新しい月が先');
  await post(m.cookie, 'reflect-delete', { month: prevMonth });
  assert.equal((await mem(m.cookie, 'reflect-list')).body.reflections.length, 1, '削除できる');
});

test('検証：月の形式・未来の月・不正な値は拒否。制御文字は除かれる', async () => {
  const m = await member();
  for (const month of ['2026-13', '2026-1', 'abc', '', '2099-01', '2024-12', '../x']) assert.equal((await post(m.cookie, 'reflect-save', { month, noticed: 'x' })).status, 400, month);
  const r = await save(m, { noticed: '改行' + String.fromCharCode(0) + 'あり<b>タグ</b>' });
  assert.equal(r.body.reflection.noticed, '改行あり<b>タグ</b>', '制御文字は除去。タグは文字として保存（画面側でエスケープ）');
  assert.equal((await post(m.cookie, 'reflect-delete', { month: 'bad' })).status, 400);
});

test('二重保存・競合：同じ内容の再送は更新日時が変わらない／別画面の更新を気づかず上書きしない', async () => {
  const m = await member();
  const a = await save(m, { noticed: '同じ内容' });
  const again = await save(m, { noticed: '同じ内容' });
  assert.deepEqual([again.body.unchanged, again.body.reflection.updatedAt], [true, a.body.reflection.updatedAt]);
  const b = await save(m, { noticed: '更新した内容', baseUpdatedAt: a.body.reflection.updatedAt });
  assert.equal(b.status, 200);
  const stale = await save(m, { noticed: '古い画面からの保存', baseUpdatedAt: a.body.reflection.updatedAt });
  assert.deepEqual([stale.status, stale.body.code], [409, 'conflict']);
  assert.equal((await mem(m.cookie, 'reflect-list')).body.reflections[0].noticed, '更新した内容');
  const many = await Promise.all([1, 2, 3, 4].map(() => save(m, { noticed: '連打' })));
  assert.ok(many.every((r) => r.status === 200));
  assert.equal((await mem(m.cookie, 'reflect-list')).body.reflections.length, 1, '1か月は1件');
});

test('本人のみ：他の会員・未ログイン・無効な会員資格は、読めない・変えられない。管理APIに経路がない', async () => {
  const a = await member(); const b = await member();
  await save(a, { noticed: 'Aだけの非公開の記録' });
  assert.ok(!JSON.stringify((await mem(b.cookie, 'reflect-list')).body).includes('Aだけの'));
  const forged = await post(b.cookie, 'reflect-save', { month: thisMonth, noticed: 'Bの記録', email: a.email });
  assert.equal(forged.status, 200);
  assert.equal((await mem(a.cookie, 'reflect-list')).body.reflections[0].noticed, 'Aだけの非公開の記録', 'メールアドレスを指定しても、Aの記録は変わらない');
  assert.equal((await mem('', 'reflect-list')).status, 401);
  assert.equal((await post('', 'reflect-save', { month: thisMonth, noticed: 'x' })).status, 401);
  const canceled = await member('canceled');
  assert.equal((await mem(canceled.cookie, 'reflect-list')).status, 403);
  assert.equal((await save(canceled, { noticed: 'x' })).status, 403);
  assert.equal((await mem(a.cookie, 'reflect-save', { method: 'GET' })).status, 405);
  assert.equal((await post(a.cookie, 'reflect-save', { month: thisMonth, noticed: 'x' }, { origin: 'https://evil.example' })).status, 403);
  // 管理画面のAPIから、非公開の記録は読めない
  const adminCookie = `ht_admin_session=${await store.createAdminSession({ actorId: 'admin@example.com', role: 'super_admin' })}`;
  for (const action of ['reflect-list', 'reflect-echo', 'reflections', 'reflect-get']) {
    const r = await call(adminHandler, adminCookie, action, { query: { email: a.email } });
    assert.ok(!JSON.stringify(r.body || {}).includes('Aだけの'), action);
  }
  const detail = await call(adminHandler, adminCookie, 'member-detail', { query: { email: a.email } });
  assert.ok(!JSON.stringify(detail.body || {}).includes('Aだけの'), '会員詳細にも含まれない');
});

test('1か月前のあなたから：本人の約30日前の公開投稿を表示。他人の投稿・直近・古すぎるもの・非表示は出さない', async () => {
  const a = await member(); const b = await member();
  assert.deepEqual((await mem(a.cookie, 'reflect-echo')).body, { ok: true, item: null, response: null }, '記録が無いときは空');
  await oldPost(b, 30, { body: 'Bの投稿は、Aには出ない' });
  await oldPost(a, 3, { body: '3日前（まだ早い）' });
  await oldPost(a, 90, { body: '90日前（遠すぎる）' });
  await oldPost(a, 31, { body: '非表示にされた投稿', status: 'hidden' });
  assert.equal((await mem(a.cookie, 'reflect-echo')).body.item, null);
  const id = await oldPost(a, 29, { body: 'Aの1か月前のことば' });
  const e = (await mem(a.cookie, 'reflect-echo')).body;
  assert.deepEqual([e.item.kind, e.item.id, e.item.text, e.item.label], ['post', id, 'Aの1か月前のことば', '公開したことば']);
  assert.ok(!JSON.stringify(e).includes('Bの投稿'));
  // 元の投稿を編集・削除すると、表示にも反映される
  await store.updatePost(id, { body: '編集したことば' });
  assert.equal((await mem(a.cookie, 'reflect-echo')).body.item.text, '編集したことば');
  await store.deletePost(id);
  assert.equal((await mem(a.cookie, 'reflect-echo')).body.item, null, '削除したら出ない');
});

test('1か月前：約束・振り返りも対象。いまの気持ち（任意）を保存・編集・削除できる。元が消えれば返信も表示されない', async () => {
  const m = await member(); const o = await member();
  const g = await store.createGoalFixture(m.email, '毎朝6時に起きる');
  const key = `ht:fixture:goal:${g.id}`;
  await store.getRedis().set(key, JSON.stringify({ ...JSON.parse(await store.getRedis().get(key)), createdAt: Date.now() - 30 * 86400e3 }));
  await store.getRedis().zadd(`ht:fixture:goals:${m.email}`, Date.now() - 30 * 86400e3, g.id);
  const e = (await mem(m.cookie, 'reflect-echo')).body;
  assert.deepEqual([e.item.kind, e.item.text, e.item.label], ['goal', '毎朝6時に起きる', '今月の約束']);
  const s1 = await post(m.cookie, 'reflect-echo-save', { kind: 'goal', id: g.id, text: '続けられている。もう少し夜も整えたい。' });
  assert.equal(s1.status, 200);
  assert.equal((await mem(m.cookie, 'reflect-echo')).body.response.text, '続けられている。もう少し夜も整えたい。');
  assert.equal((await post(m.cookie, 'reflect-echo-save', { kind: 'goal', id: g.id, text: '編集した気持ち' })).status, 200);
  assert.equal((await mem(m.cookie, 'reflect-echo')).body.response.text, '編集した気持ち');
  assert.equal((await post(m.cookie, 'reflect-echo-save', { kind: 'goal', id: g.id, text: 'あ'.repeat(501) })).status, 400);
  // 他人の記録には、返信できない
  assert.equal((await post(o.cookie, 'reflect-echo-save', { kind: 'goal', id: g.id, text: 'のぞき見' })).status, 404);
  assert.equal((await post(m.cookie, 'reflect-echo-save', { kind: 'secret', id: g.id, text: 'x' })).status, 400);
  assert.equal((await post(m.cookie, 'reflect-echo-save', { kind: 'goal', id: g.id, text: '' })).body.response, null, '空にすると削除');
  assert.equal((await mem(m.cookie, 'reflect-echo')).body.response, null);
  await store.deleteGoalFixture(m.email, g.id).catch(() => {});
});

test('1か月前：約30日前に書いた月ごとの振り返りも対象（本人のみ）', async () => {
  const m = await member();
  const now = Date.now();
  await R.saveReflection(m.email, { month: prevMonth, noticed: '先月の気づき', nextMonth: '来月の大切なこと' }, now - 30 * 86400e3);
  const e = (await mem(m.cookie, 'reflect-echo')).body;
  assert.equal(e.item.kind, 'reflection');
  assert.match(e.item.text, /先月の気づき/);
  assert.equal(e.item.id, prevMonth);
});

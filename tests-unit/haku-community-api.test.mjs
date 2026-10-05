/**
 * 会員向けAPI（予約・ことば・今月の約束）の動作テスト。
 * メモリ上のRedisモックに対して実行する。本物のRedis（Preview/Production）には一切接続しない。
 *
 * 実行方法（ioredis-mockは ioredis 5系向けで package.json の6系と合わないため、package.json には追加せず、
 * ローカルで都度 --no-save で入れる。リポジトリの依存関係は変わらない）:
 *   npm install --no-save --legacy-peer-deps ioredis@5 ioredis-mock
 *   node --test "tests-unit/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import * as store from '../api/_lib/store.redis.js';

store.__setRedisForTests(new RedisMock({ host: 'mock-community-api', port: 6379 }));
process.env.VERCEL_ENV = 'preview';
const { default: handler } = await import('../api/community-auth.js');

/* ─── 簡易のリクエスト／レスポンス ─── */
function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}
// レート制限（IPごとの回数）の影響を受けないよう、呼び出しごとに別のIPを使う。
// レート制限そのものは本番コードで有効（ここでは回数制限の挙動は検証しない）。
let ipSeq = 0;
async function call(sessionId, action, { method = 'GET', body = {}, query = {} } = {}) {
  const n = ++ipSeq;
  const ip = `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  const req = {
    method,
    query: { action, ...query },
    body,
    headers: { cookie: sessionId ? `ht_session=${sessionId}` : '', host: 'example.test', 'x-forwarded-for': ip },
    socket: { remoteAddress: ip },
  };
  const res = fakeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
}
const post = (sid, action, body) => call(sid, action, { method: 'POST', body });

let seq = 0;
async function newMember(role = 'member') {
  const email = `member${++seq}_${Date.now()}@example.com`;
  await store.saveUser({ email, displayName: `会員${seq}`, fullName: '山田太郎', fullNameKana: 'やまだたろう' });
  await store.setMembership('haku', email, { status: 'active', role });
  const sid = await store.createSession(email);
  return { email, sid };
}
async function newEvent(fields = {}) {
  return store.createEvent('haku', { title: 'テスト用の集まり', type: 'morning', startsAt: new Date(Date.now() + 5 * 86400000).toISOString(), ...fields });
}
const listState = async (sid, id) => (await call(sid, 'events-list')).body.events.find((e) => e.id === id);

/* ═════ 予約 ═════ */
test('参加できる。2回送っても1人は1回だけ（二重登録されない）', async () => {
  const a = await newMember(); const ev = await newEvent({ capacity: 5 });
  const r1 = await post(a.sid, 'events-join', { eventId: ev.id });
  assert.equal(r1.status, 200);
  const r2 = await post(a.sid, 'events-join', { eventId: ev.id });
  assert.equal(r2.status, 200); assert.equal(r2.body.alreadyJoined, true);
  const e = await listState(a.sid, ev.id);
  assert.equal(e.participantCount, 1); assert.equal(e.state, 'joined'); assert.equal(e.joined, true);
});

test('定員いっぱいになると満席。満席の人は参加できず、参加済みの人は引き続き「参加予定」', async () => {
  const [a, b, c] = [await newMember(), await newMember(), await newMember()];
  const ev = await newEvent({ capacity: 2 });
  assert.equal((await post(a.sid, 'events-join', { eventId: ev.id })).status, 200);
  assert.equal((await post(b.sid, 'events-join', { eventId: ev.id })).status, 200);
  const full = await post(c.sid, 'events-join', { eventId: ev.id });
  assert.equal(full.status, 409); assert.equal(full.body.code, 'full');
  assert.equal((await listState(c.sid, ev.id)).state, 'full');
  assert.equal((await listState(a.sid, ev.id)).state, 'joined');
  assert.equal((await listState(a.sid, ev.id)).participantCount, 2);
});

test('同時に大勢が申し込んでも、定員を超えて登録されない', async () => {
  const members = await Promise.all(Array.from({ length: 12 }, () => newMember()));
  const ev = await newEvent({ capacity: 3 });
  const results = await Promise.all(members.map((m) => post(m.sid, 'events-join', { eventId: ev.id })));
  assert.equal(results.filter((r) => r.status === 200).length, 3);
  assert.equal(results.filter((r) => r.status === 409).length, 9);
  assert.equal(await store.countEventParticipants(ev.id), 3);
});

test('開催済みの集まりには、参加できない・取り消せない（記録は残る）', async () => {
  const a = await newMember(); const b = await newMember();
  const ev = await newEvent({ startsAt: new Date(Date.now() + 3600 * 1000).toISOString() });
  assert.equal((await post(a.sid, 'events-join', { eventId: ev.id })).status, 200);
  // 開始時刻が過ぎた状態にする（管理者が日時を過去に直した場合と同じ）
  await store.updateEvent(ev.id, { startsAt: new Date(Date.now() - 3600 * 1000).toISOString() });
  const e = await listState(a.sid, ev.id);
  assert.equal(e.state, 'ended'); assert.equal(e.isPast, true);
  const join = await post(b.sid, 'events-join', { eventId: ev.id });
  assert.equal(join.status, 409); assert.equal(join.body.code, 'ended');
  const leave = await post(a.sid, 'events-leave', { eventId: ev.id });
  assert.equal(leave.status, 409); assert.equal(leave.body.code, 'ended');
  assert.equal(await store.isEventParticipant(ev.id, a.email), true, '開催済みの参加記録は消えない');
});

test('受付終了：新しく参加はできないが、参加済みの人は取り消せる。再び受付中にすると参加できる', async () => {
  const a = await newMember(); const b = await newMember();
  const ev = await newEvent();
  await post(a.sid, 'events-join', { eventId: ev.id });
  await store.updateEvent(ev.id, { registration: 'closed' });
  assert.equal((await listState(b.sid, ev.id)).state, 'closed');
  const blocked = await post(b.sid, 'events-join', { eventId: ev.id });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'closed');
  assert.equal((await listState(a.sid, ev.id)).state, 'joined');
  assert.equal((await post(a.sid, 'events-leave', { eventId: ev.id })).status, 200);
  await store.updateEvent(ev.id, { registration: 'open' });
  assert.equal((await post(b.sid, 'events-join', { eventId: ev.id })).status, 200);
});

test('中止：状態は「中止」になり、参加できない', async () => {
  const a = await newMember();
  const ev = await newEvent();
  await store.updateEvent(ev.id, { registration: 'cancelled' });
  assert.equal((await listState(a.sid, ev.id)).state, 'cancelled');
  const r = await post(a.sid, 'events-join', { eventId: ev.id });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'cancelled');
});

test('取り消し：参加していない人の取り消しは何も起きず成功。取り消した後に再参加できる。2回取り消しても1人分だけ減る', async () => {
  const a = await newMember(); const b = await newMember();
  const ev = await newEvent({ capacity: 5 });
  await post(a.sid, 'events-join', { eventId: ev.id });
  await post(b.sid, 'events-join', { eventId: ev.id });
  assert.equal((await post(a.sid, 'events-leave', { eventId: ev.id })).status, 200);
  const again = await post(a.sid, 'events-leave', { eventId: ev.id });
  assert.equal(again.status, 200); assert.equal(again.body.alreadyLeft, true);
  assert.equal(await store.countEventParticipants(ev.id), 1, 'b は残っている');
  assert.equal((await post(a.sid, 'events-join', { eventId: ev.id })).status, 200);
  assert.equal(await store.countEventParticipants(ev.id), 2);
});

test('日程調整中（開始時刻なし）の集まりは、開催済み扱いにならず参加できる', async () => {
  const a = await newMember();
  const ev = await newEvent({ startsAt: null });
  assert.equal((await post(a.sid, 'events-join', { eventId: ev.id })).status, 200);
  assert.equal((await listState(a.sid, ev.id)).isPast, false);
});

test('不正な受付状況の値は保存されない', async () => {
  const ev = await newEvent();
  const updated = await store.updateEvent(ev.id, { registration: 'bogus' });
  assert.equal(updated.registration, 'open');
  assert.deepEqual(store.EVENT_REGISTRATION_VALUES, ['open', 'closed', 'cancelled']);
});

test('ログインしていない・会員資格がない場合は、予約も一覧も使えない', async () => {
  const ev = await newEvent();
  assert.equal((await post(null, 'events-join', { eventId: ev.id })).status, 401);
  assert.equal((await call(null, 'events-list')).status, 401);
  const email = `nomember_${Date.now()}@example.com`;
  await store.saveUser({ email, displayName: 'x', fullName: 'x', fullNameKana: 'えっくす' });
  const sid = await store.createSession(email);
  assert.equal((await post(sid, 'events-join', { eventId: ev.id })).status, 403);
  assert.equal((await call(sid, 'events-list')).status, 403);
});

/* ═════ ことば ═════ */
const POST = { title: '', body: '今日は静かに過ごせました。', category: 'today_did' };

test('同じ操作ID（requestId）で2回送っても、投稿は1件だけ', async () => {
  const a = await newMember();
  const requestId = 'req-' + Date.now() + '-aaaa';
  const r1 = await post(a.sid, 'posts-create', { ...POST, requestId });
  const r2 = await post(a.sid, 'posts-create', { ...POST, requestId });
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.equal(r2.body.duplicate, true); assert.equal(r2.body.id, r1.body.id);
  assert.equal((await call(a.sid, 'posts-mine')).body.posts.length, 1);
});

test('同時に同じ操作IDが届いても、投稿は1件だけ', async () => {
  const a = await newMember();
  const requestId = 'req-' + Date.now() + '-bbbb';
  await Promise.all(Array.from({ length: 6 }, () => post(a.sid, 'posts-create', { ...POST, requestId })));
  assert.equal((await call(a.sid, 'posts-mine')).body.posts.length, 1);
});

test('違う操作IDなら別の投稿として保存される', async () => {
  const a = await newMember();
  await post(a.sid, 'posts-create', { ...POST, requestId: 'req-' + Date.now() + '-cccc' });
  await post(a.sid, 'posts-create', { ...POST, requestId: 'req-' + Date.now() + '-dddd' });
  assert.equal((await call(a.sid, 'posts-mine')).body.posts.length, 2);
});

test('文字化け（置換文字）を含む投稿は保存を断る。制御文字は除かれる', async () => {
  const a = await newMember();
  const bad = await post(a.sid, 'posts-create', { ...POST, body: '文字化け' + String.fromCharCode(0xFFFD) });
  assert.equal(bad.status, 400);
  const ok = await post(a.sid, 'posts-create', { ...POST, body: 'こんにちは\u0007‮です' });
  assert.equal(ok.status, 200);
  const mine = (await call(a.sid, 'posts-mine')).body.posts;
  assert.equal(mine[0].body, 'こんにちはです');
});

test('HTMLに見える文字列は、そのまま文字として保存・返却される（表示側でエスケープする）', async () => {
  const a = await newMember();
  const r = await post(a.sid, 'posts-create', { ...POST, body: '<script>alert(1)</script> & "q"' });
  assert.equal(r.status, 200);
  const list = (await call(a.sid, 'posts-list', { query: { limit: '50' } })).body.posts;
  assert.ok(list.some((p) => p.body === '<script>alert(1)</script> & "q"'));
});

test('過去に保存された文字化け投稿は、会員の一覧に出ない', async () => {
  const a = await newMember();
  const legacy = await store.createPost('haku', { authorEmail: a.email, title: '', body: '古い' + String.fromCharCode(0xFFFD, 0xFFFD), category: 'today_did' });
  const fine = await store.createPost('haku', { authorEmail: a.email, title: '', body: '読める投稿', category: 'today_did' });
  const ids = (await call(a.sid, 'posts-list', { query: { limit: '50' } })).body.posts.map((p) => p.id);
  assert.ok(!ids.includes(legacy.id)); assert.ok(ids.includes(fine.id));
  const mineIds = (await call(a.sid, 'posts-mine')).body.posts.map((p) => p.id);
  assert.ok(!mineIds.includes(legacy.id));
});

test('他人のことばは編集・削除できない', async () => {
  const a = await newMember(); const b = await newMember();
  const id = (await post(a.sid, 'posts-create', { ...POST, requestId: 'req-' + Date.now() + '-eeee' })).body.id;
  assert.equal((await post(b.sid, 'posts-update', { id, ...POST })).status, 403);
  assert.equal((await post(b.sid, 'posts-delete', { id })).status, 403);
  assert.equal((await post(a.sid, 'posts-delete', { id })).status, 200);
});

/* ═════ 今月の約束 ═════ */
test('今月の約束は3つまで。同じ文言は重ねない。同じ操作IDは1件だけ', async () => {
  const a = await newMember();
  const add = (text, requestId) => post(a.sid, 'goals-add', { text, requestId });
  const rid = () => 'goal-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const same = rid();
  assert.equal((await add('毎朝6時に起きる', same)).status, 200);
  const dupId = await add('毎朝6時に起きる', same);
  assert.equal(dupId.status, 200); assert.equal(dupId.body.duplicate, true);
  const dupText = await add('毎朝6時に起きる', rid());
  assert.equal(dupText.status, 409); assert.equal(dupText.body.code, 'duplicate');
  assert.equal((await add('読書30分', rid())).status, 200);
  assert.equal((await add('散歩', rid())).status, 200);
  const over = await add('四つ目', rid());
  assert.equal(over.status, 409); assert.equal(over.body.code, 'limit');
  assert.equal((await call(a.sid, 'goals-list')).body.goals.length, 3);
});

test('記録（スタンプ）は「できた／まだ」を明示して送ると、連打・再送しても二重に反転しない', async () => {
  const a = await newMember();
  const goal = (await post(a.sid, 'goals-add', { text: '運動する' })).body.goal;
  await post(a.sid, 'goals-toggle-stamp', { goalId: goal.id, day: 3, done: true });
  const again = await post(a.sid, 'goals-toggle-stamp', { goalId: goal.id, day: 3, done: true });
  assert.deepEqual(again.body.goal.stamps, [3]);
  const off = await post(a.sid, 'goals-toggle-stamp', { goalId: goal.id, day: 3, done: false });
  assert.deepEqual(off.body.goal.stamps, []);
  const off2 = await post(a.sid, 'goals-toggle-stamp', { goalId: goal.id, day: 3, done: false });
  assert.deepEqual(off2.body.goal.stamps, []);
  const legacy = await post(a.sid, 'goals-toggle-stamp', { goalId: goal.id, day: 4 }); // 従来の反転動作も維持
  assert.deepEqual(legacy.body.goal.stamps, [4]);
});

test('他人の約束には触れない', async () => {
  const a = await newMember(); const b = await newMember();
  const goal = (await post(a.sid, 'goals-add', { text: 'ひみつ' })).body.goal;
  assert.equal((await post(b.sid, 'goals-toggle-stamp', { goalId: goal.id, day: 1, done: true })).status, 404);
  assert.equal((await post(b.sid, 'goals-delete', { goalId: goal.id })).status, 404);
});

test('文字化けした約束は保存を断る', async () => {
  const a = await newMember();
  assert.equal((await post(a.sid, 'goals-add', { text: 'x' + String.fromCharCode(0xFFFD) })).status, 400);
});

/* ═════ HAKUポイント（会員側は自分の分だけ。付与APIは会員側に存在しない） ═════ */
test('points-me は本人の分だけを返し、会員が付与・調整を呼ぶことはできない', async () => {
  const a = await newMember();
  const me = await call(a.sid, 'points-me');
  assert.equal(me.status, 200); assert.equal(me.body.balance, 0); assert.deepEqual(me.body.entries, []);
  for (const act of ['points-grant', 'points-adjust', 'points-reverse']) {
    const r = await post(a.sid, act, { email: a.email, amount: 100 });
    assert.equal(r.status, 400, `${act} は会員APIに存在しない`);
  }
});

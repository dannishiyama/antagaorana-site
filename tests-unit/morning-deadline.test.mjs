/**
 * 朝の集まりの参加申請の締切：開催日の「前々日」の23:59:59.999（日本時間）まで。
 *   例）10/10開催 → 10/8 23:59:59.999 まで可能、10/9 0:00:00 から新規の参加は不可。
 * 判定はサーバー側（api/_lib/morning.js の joinBlock）。ここでは境界の時刻を細かく確かめる。
 * 時刻は Date.now を差し替えて再現する。Googleへの通信は偽物（本物のGoogleには接続しない）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import * as store from '../api/_lib/store.redis.js';

store.__setRedisForTests(new RedisMock({ host: 'mock-morning-deadline', port: 6379 }));
process.env.VERCEL_ENV = 'preview';
const { default: authHandler } = await import('../api/community-auth.js');
const { joinBlock, leaveBlock, joinDeadlineMs, joinOpenFrom, jstToday, MORNING_CONFIG } = await import('../api/_lib/morning.js');
const { __setFetchForTests } = await import('../api/_lib/google-meet.js');

const at = (iso) => Date.parse(iso); // 例: '2026-10-08T23:59:59.999+09:00'
const realNow = Date.now;
function withNow(ms, fn) { Date.now = () => ms; return Promise.resolve().then(fn).finally(() => { Date.now = realNow; }); }

/* ═════════ 純粋な判定：境界 ═════════ */
test('10/10開催：10/8 23:58・23:59・23:59:59.999 は可能、10/9 00:00:00.000 以降は不可（23:59で締め切らない）', () => {
  const D = '2026-10-10';
  assert.equal(MORNING_CONFIG.joinDeadlineDaysBefore, 2);
  assert.equal(joinBlock(D, at('2026-10-08T23:58:00+09:00')), null);
  assert.equal(joinBlock(D, at('2026-10-08T23:59:00+09:00')), null, '23:59:00 では締め切らない');
  assert.equal(joinBlock(D, at('2026-10-08T23:59:30.000+09:00')), null);
  assert.equal(joinBlock(D, at('2026-10-08T23:59:59.999+09:00')), null, '23:59:59.999 まで可能');
  assert.equal(joinBlock(D, at('2026-10-09T00:00:00.000+09:00')), 'deadline', '10/9 0:00 から不可');
  assert.equal(joinBlock(D, at('2026-10-09T00:00:00.001+09:00')), 'deadline');
  assert.equal(joinBlock(D, at('2026-10-09T12:00:00+09:00')), 'deadline');
  assert.equal(joinBlock(D, at('2026-10-10T05:30:00+09:00')), 'deadline', '当日も不可');
  assert.equal(joinBlock(D, at('2026-10-11T08:00:00+09:00')), 'past', '過ぎた日');
  assert.equal(joinDeadlineMs(D), at('2026-10-09T00:00:00.000+09:00'));
  assert.equal(joinDeadlineMs(D) - 1, at('2026-10-08T23:59:59.999+09:00'));
});

test('日本時間で判定する（UTCの日付ではなく、JSTの0:00＝UTC 15:00 が境目）', () => {
  const D = '2026-10-10';
  assert.equal(joinBlock(D, Date.parse('2026-10-08T14:59:59.999Z')), null, 'UTC 14:59:59.999 = JST 23:59:59.999');
  assert.equal(joinBlock(D, Date.parse('2026-10-08T15:00:00.000Z')), 'deadline', 'UTC 15:00 = JST 10/9 0:00');
  assert.equal(joinBlock(D, Date.parse('2026-10-08T00:00:00.000Z')), null, 'UTC 10/8 0:00 = JST 10/8 9:00');
  assert.equal(joinBlock(D, Date.parse('2026-10-09T00:00:00.000Z')), 'deadline', 'UTC 10/9 0:00 = JST 10/9 9:00');
});

test('月末・年末年始・うるう年の境界', () => {
  const cases = [
    // [開催日, 最後に可能な瞬間, 最初に不可の瞬間]
    ['2026-11-01', '2026-10-30T23:59:59.999+09:00', '2026-10-31T00:00:00.000+09:00'],   // 月末→翌月1日開催
    ['2026-10-31', '2026-10-29T23:59:59.999+09:00', '2026-10-30T00:00:00.000+09:00'],   // 月末開催
    ['2026-12-01', '2026-11-29T23:59:59.999+09:00', '2026-11-30T00:00:00.000+09:00'],   // 30日の月
    ['2027-01-01', '2026-12-30T23:59:59.999+09:00', '2026-12-31T00:00:00.000+09:00'],   // 元日開催（大晦日0:00から不可）
    ['2027-01-02', '2026-12-31T23:59:59.999+09:00', '2027-01-01T00:00:00.000+09:00'],   // 年末年始をまたぐ
    ['2027-01-03', '2027-01-01T23:59:59.999+09:00', '2027-01-02T00:00:00.000+09:00'],
    ['2027-03-01', '2027-02-27T23:59:59.999+09:00', '2027-02-28T00:00:00.000+09:00'],   // うるう年でない2月
    ['2028-03-01', '2028-02-28T23:59:59.999+09:00', '2028-02-29T00:00:00.000+09:00'],   // うるう年の2月29日
    ['2028-02-29', '2028-02-27T23:59:59.999+09:00', '2028-02-28T00:00:00.000+09:00'],
  ];
  for (const [d, ok, ng] of cases) {
    assert.equal(joinBlock(d, at(ok)), null, `${d}: ${ok} は可能`);
    assert.equal(joinBlock(d, at(ng)), 'deadline', `${d}: ${ng} は不可`);
    assert.equal(joinDeadlineMs(d), at(ng), `${d}: 締切の瞬間`);
  }
});

test('「いま申請できる最初の開催日」は、日本時間の今日の2日後', () => {
  assert.equal(joinOpenFrom(at('2026-10-10T00:00:00+09:00')), '2026-10-12');
  assert.equal(joinOpenFrom(at('2026-10-10T23:59:59.999+09:00')), '2026-10-12');
  assert.equal(joinOpenFrom(at('2026-10-11T00:00:00+09:00')), '2026-10-13');
  assert.equal(joinOpenFrom(Date.parse('2026-10-10T15:00:00Z')), '2026-10-13', 'UTC 15:00 = JST 翌日0:00');
  assert.equal(joinOpenFrom(at('2026-12-31T12:00:00+09:00')), '2027-01-02');
  assert.equal(jstToday(at('2026-10-10T08:00:00+09:00')), '2026-10-10');
});

test('取消は既存仕様のまま（締切後も、開催日より前なら取り消せる／過去日は不可）', () => {
  assert.equal(leaveBlock('2026-10-10', at('2026-10-09T08:00:00+09:00')), null);
  assert.equal(leaveBlock('2026-10-10', at('2026-10-10T08:00:00+09:00')), null);
  assert.equal(leaveBlock('2026-10-10', at('2026-10-11T08:00:00+09:00')), 'past');
});

/* ═════════ API：直接呼び出しでも締切を回避できない ═════════ */
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
async function call(cookie, action, { method = 'GET', body = {}, query = {} } = {}) {
  const n = ++ipSeq;
  const ip = `10.5.${(n >> 8) & 255}.${n & 255}`;
  const res = fakeRes();
  await authHandler({ method, query: { action, ...query }, body, headers: { cookie: cookie || '', host: 'example.test', 'x-forwarded-for': ip }, socket: { remoteAddress: ip } }, res);
  return { status: res.statusCode, body: res.body };
}
const get = (c, a, q) => call(c, a, { query: q });
const post = (c, a, b) => call(c, a, { method: 'POST', body: b });
let seq = 0;
async function member(name) {
  const email = `dl${++seq}_${Date.now()}@example.com`;
  await store.saveUser({ email, displayName: name, fullName: `氏名${name}`, fullNameKana: 'しめい', passwordHash: 'x:y' });
  await store.createApplication('haku', { email, fullName: `氏名${name}`, fullNameKana: 'しめい', displayName: name });
  await store.resolveApplication('haku', email, 'approved', 'test');
  await store.setMembership('haku', email, { status: 'active' });
  return { email, name, cookie: `ht_session=${await store.createSession(email)}` };
}

async function memberAt(name, ms) { return withNow(ms, () => member(name)); } // その時刻にセッションを作る（セッションの期限が、差し替えた時刻と食い違わないように）

test('API：10/10開催の参加表明は、10/8 23:59:59.999 までは成功し、10/9 0:00 からは409（deadline）。イベントも作られない', async () => {
  const D = '2026-10-10';
  const a = await member('あや'); const b = await member('ぼん'); const c = await member('かい');
  const r1 = await withNow(at('2026-10-08T23:58:00+09:00'), () => post(a.cookie, 'morning-join', { date: D }));
  assert.equal(r1.status, 200); assert.equal(r1.body.day.count, 1);
  const r2 = await withNow(at('2026-10-08T23:59:59.999+09:00'), () => post(b.cookie, 'morning-join', { date: D }));
  assert.equal(r2.status, 200, '23:59:59.999 でも参加できる'); assert.equal(r2.body.day.count, 2);
  const r3 = await withNow(at('2026-10-09T00:00:00.000+09:00'), () => post(c.cookie, 'morning-join', { date: D }));
  assert.equal(r3.status, 409); assert.equal(r3.body.code, 'deadline'); assert.equal(r3.body.error, '参加受付は終了しました。');
  assert.equal(await store.countEventParticipants(`morning-${D}`), 2, '締切後は人数が増えない');
});

test('API：締切後に参加者が0人の日は、イベントが作られない（直接APIを叩いても同じ）。本文に偽の時刻を入れても無効', async () => {
  const D = '2026-11-20';
  const a = await memberAt('あや', at('2026-11-18T12:00:00+09:00'));
  const forged = await withNow(at('2026-11-19T10:00:00+09:00'), () => post(a.cookie, 'morning-join', { date: D, now: at('2026-11-01T00:00:00+09:00'), asOf: '2026-11-01', force: true }));
  assert.equal(forged.status, 409);
  assert.equal(await store.getEvent(`morning-${D}`), null);
  const ok = await withNow(at('2026-11-18T23:59:59.999+09:00'), () => post(a.cookie, 'morning-join', { date: D }));
  assert.equal(ok.status, 200);
});

test('API：締切後も、参加者一覧は見える・参加済み会員の状態は維持・取消は既存どおり・Meet取得も止めない', async () => {
  const D = '2026-12-20';
  process.env.GOOGLE_MEET_CLIENT_ID = 'i'; process.env.GOOGLE_MEET_CLIENT_SECRET = 's'; process.env.GOOGLE_MEET_REFRESH_TOKEN = 'r';
  let spaces = 0;
  __setFetchForTests(async (url) => {
    const j = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (String(url).includes('oauth2')) return j(200, { access_token: 't' });
    spaces++; return j(200, { name: 'spaces/x', meetingUri: `https://meet.google.com/zzz${spaces}-aaaa-bbb`, meetingCode: 'c' });
  });
  const t0 = at('2026-12-18T12:00:00+09:00');
  const a = await memberAt('あや', t0); const b = await memberAt('ぼん', t0); const c = await memberAt('かい', t0);
  await withNow(at('2026-12-18T20:00:00+09:00'), async () => { await post(a.cookie, 'morning-join', { date: D }); await post(b.cookie, 'morning-join', { date: D }); });
  const after = at('2026-12-19T09:00:00+09:00'); // 締切後（前日）
  const view = await withNow(after, () => get(c.cookie, 'morning-month', { month: '2026-12' }));
  const day = view.body.days.find((d) => d.date === D);
  assert.equal(day.count, 2); assert.deepEqual(day.participants.map((p) => p.name).sort(), ['あや', 'ぼん']);
  assert.ok(view.body.joinOpenFrom > D, '画面が「受付終了」と判断できる情報（最初に申請できる日）が返る');
  assert.equal(joinOpenFrom(after), '2026-12-21');
  const next = await withNow(after, () => get(a.cookie, 'morning-month', { month: '2026-12' }));
  assert.equal(next.body.days.find((d) => d.date === D).joined, true, '参加済みの状態は維持');
  const meet = await withNow(after, () => get(a.cookie, 'morning-meet', { date: D }));
  assert.equal(meet.status, 200); assert.equal(meet.body.status, 'ready', 'Meetは締切を理由に止めない');
  assert.equal((await withNow(after, () => get(c.cookie, 'morning-meet', { date: D }))).status, 403, '未参加者は取得できない');
  const join = await withNow(after, () => post(c.cookie, 'morning-join', { date: D }));
  assert.equal(join.status, 409); assert.equal(join.body.code, 'deadline');
  const leave = await withNow(after, () => post(b.cookie, 'morning-leave', { date: D }));
  assert.equal(leave.status, 200); assert.equal(leave.body.day.count, 1, '取消は既存仕様のまま');
  const again = await withNow(after, () => post(b.cookie, 'morning-join', { date: D }));
  assert.equal(again.status, 409, '取り消した人も、締切後は再び参加表明できない');
  for (const k of ['GOOGLE_MEET_CLIENT_ID', 'GOOGLE_MEET_CLIENT_SECRET', 'GOOGLE_MEET_REFRESH_TOKEN']) delete process.env[k];
});

test('API：年末年始・月末の開催日でも、締切の瞬間でAPIの結果が切り替わる', async () => {
  for (const [d, ok, ng] of [['2027-01-02', '2026-12-31T23:59:59.999+09:00', '2027-01-01T00:00:00.000+09:00'], ['2027-03-01', '2027-02-27T23:59:59.999+09:00', '2027-02-28T00:00:00.000+09:00']]) {
    const a = await memberAt('あや', at(ok)); const m = await memberAt('ぼん', at(ok));
    assert.equal((await withNow(at(ng), () => post(m.cookie, 'morning-join', { date: d }))).status, 409, `${d} ${ng}`);
    assert.equal((await withNow(at(ok), () => post(a.cookie, 'morning-join', { date: d }))).status, 200, `${d} ${ok}`);
  }
});

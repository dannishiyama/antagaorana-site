/**
 * 朝の集まりの「開催日ごとの Google Meet」のテスト。
 * Google への通信は、すべてこのテスト内の偽物（fetch差し替え）。本物のGoogleには一切接続しない。
 *   node --test "tests-unit/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import * as store from '../api/_lib/store.redis.js';

store.__setRedisForTests(new RedisMock({ host: 'mock-morning-meet', port: 6379 }));
process.env.VERCEL_ENV = 'preview';
const { default: authHandler } = await import('../api/community-auth.js');
const { __setFetchForTests, createMeetSpace, meetConfig, MeetError } = await import('../api/_lib/google-meet.js');
const { jstToday, addDays } = await import('../api/_lib/morning.js');
const { legacyMeetUrl } = await import('../api/_lib/morning-meet.js');

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
  const ip = `10.4.${(n >> 8) & 255}.${n & 255}`;
  const res = fakeRes();
  await authHandler({ method, query: { action, ...query }, body, headers: { cookie: cookie || '', host: 'example.test', 'x-forwarded-for': ip }, socket: { remoteAddress: ip } }, res);
  return { status: res.statusCode, body: res.body };
}
const get = (c, a, q) => call(c, a, { query: q });
const post = (c, a, b) => call(c, a, { method: 'POST', body: b });

let seq = 0;
async function member(name, { status = 'active' } = {}) {
  const email = `mt${++seq}_${Date.now()}@example.com`;
  await store.saveUser({ email, displayName: name, fullName: `氏名${name}`, fullNameKana: 'しめい', passwordHash: 'x:y' });
  await store.createApplication('haku', { email, fullName: `氏名${name}`, fullNameKana: 'しめい', displayName: name });
  await store.resolveApplication('haku', email, 'approved', 'test');
  if (status) await store.setMembership('haku', email, { status });
  const sid = await store.createSession(email);
  return { email, name, cookie: `ht_session=${sid}` };
}
const day = (n) => addDays(jstToday(), n);

// ── 偽のGoogle：呼ばれた回数を数え、毎回ちがう会議を返す ──
const google = { tokenCalls: 0, spaceCalls: 0, delay: 0, failSpaces: false, failToken: false, bodies: [] };
function installFakeGoogle() {
  google.tokenCalls = 0; google.spaceCalls = 0; google.failSpaces = false; google.failToken = false; google.bodies = []; google.delay = 0;
  __setFetchForTests(async (url, init) => {
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      google.tokenCalls++;
      return google.failToken ? json(400, { error: 'invalid_grant' }) : json(200, { access_token: 'fake-access-token' });
    }
    if (String(url) === 'https://meet.googleapis.com/v2/spaces') {
      google.spaceCalls++;
      google.bodies.push({ auth: init.headers.Authorization, body: init.body });
      if (google.delay) await new Promise((r) => setTimeout(r, google.delay));
      if (google.failSpaces) return json(403, { error: { message: 'forbidden' } });
      const code = `fk${google.spaceCalls}-abcd-efg`;
      return json(200, { name: `spaces/sp${google.spaceCalls}`, meetingUri: `https://meet.google.com/${code}`, meetingCode: code });
    }
    return json(404, {});
  });
}
function configure(on) {
  for (const k of ['GOOGLE_MEET_CLIENT_ID', 'GOOGLE_MEET_CLIENT_SECRET', 'GOOGLE_MEET_REFRESH_TOKEN', 'GOOGLE_MEET_ACCESS_TYPE']) delete process.env[k];
  if (on) { process.env.GOOGLE_MEET_CLIENT_ID = 'id'; process.env.GOOGLE_MEET_CLIENT_SECRET = 'secret'; process.env.GOOGLE_MEET_REFRESH_TOKEN = 'refresh'; }
}

test('Google側が未設定で、暫定の共通Meetも無効なときは、URLを作らず「準備中」状態を返す（架空のURLは出さない）', async () => {
  configure(false); installFakeGoogle(); process.env.HAKU_LEGACY_MEET_URL = '';
  assert.equal(meetConfig().configured, false);
  await assert.rejects(createMeetSpace(), (e) => e instanceof MeetError && e.code === 'unconfigured');
  const date = day(11);
  const a = await member('あや');
  assert.equal((await post(a.cookie, 'morning-join', { date })).status, 200, '参加表明はMeetが未設定でも成功する');
  const r = await get(a.cookie, 'morning-meet', { date });
  assert.equal(r.status, 200); assert.equal(r.body.ok, false); assert.equal(r.body.status, 'unavailable'); assert.equal(r.body.url, undefined);
  assert.equal(google.tokenCalls + google.spaceCalls, 0, 'Googleへは一切通信しない');
  assert.equal(await store.getMorningMeet(date), null, 'URLは保存されない');
});

test('暫定：Google未設定の間は、従来の共通Meetを参加表明済みの有効会員にだけ返す。未参加・取消後・中止・過去日・解約済みには返さず、他のAPIにも出さない。別のURLは作らない', async () => {
  delete process.env.HAKU_LEGACY_MEET_URL; configure(false); installFakeGoogle();
  const legacy = legacyMeetUrl();
  assert.ok(legacy && /^https:\/\/meet\.google\.com\//.test(legacy));
  const date = day(30), other = day(31);
  const a = await member('あや'); const b = await member('ぼん'); const c = await member('かい', { status: null });
  const join = await post(a.cookie, 'morning-join', { date });
  assert.equal(join.status, 200);
  const ok = await get(a.cookie, 'morning-meet', { date });
  assert.equal(ok.status, 200); assert.equal(ok.body.status, 'ready'); assert.equal(ok.body.url, legacy, '共通Meetだけを返す（別のURLを作らない）');
  assert.equal(google.tokenCalls + google.spaceCalls, 0, 'Googleへは通信しない・新しい会議は作らない');
  assert.equal(await store.getMorningMeet(date), null, '日付別の保存もしない');
  assert.equal((await get('', 'morning-meet', { date })).status, 401);
  assert.equal((await get(c.cookie, 'morning-meet', { date })).status, 403, '会員資格がない');
  const nb = await get(b.cookie, 'morning-meet', { date });
  assert.equal(nb.status, 403); assert.equal(nb.body.url, undefined, '未参加者には返さない');
  await post(b.cookie, 'morning-join', { date: other });
  assert.equal((await get(b.cookie, 'morning-meet', { date })).status, 403, '別の日の参加者にも返さない');
  const outputs = [join, await get(b.cookie, 'morning-month', { month: date.slice(0, 7) }), await get(a.cookie, 'morning-month', { month: date.slice(0, 7) }), await get(a.cookie, 'morning-next'), await get(a.cookie, 'events-list'), await get(a.cookie, 'me'), nb];
  for (const r of outputs) assert.ok(!JSON.stringify(r.body).includes('meet.google.com'), 'Meet URLがMeet取得API以外に出ている');
  const html = (await import('node:fs')).readFileSync(new URL('../api/_templates/haku-community-home.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('meet.google.com/' + legacy.split('/').pop()), 'テンプレート（HTML）にURLが埋め込まれていない');
  await post(a.cookie, 'morning-leave', { date });
  assert.equal((await get(a.cookie, 'morning-meet', { date })).status, 403, '参加を取り消したら返さない');
  await post(a.cookie, 'morning-join', { date });
  const ev = await store.getEvent(`morning-${date}`); await store.updateEvent(ev.id, { registration: 'cancelled' });
  assert.equal((await get(a.cookie, 'morning-meet', { date })).status, 409, '中止の日は返さない');
  assert.equal((await get(a.cookie, 'morning-meet', { date: addDays(jstToday(), -1) })).status, 409, '過去日は返さない');
});

test('Google設定を入れると、自動で日付別Meetに切り替わり、共通Meetは使われなくなる（切替機構）', async () => {
  delete process.env.HAKU_LEGACY_MEET_URL; configure(true); installFakeGoogle();
  const legacy = legacyMeetUrl();
  const d1 = day(32), d2 = day(33);
  const a = await member('あや');
  await post(a.cookie, 'morning-join', { date: d1 }); await post(a.cookie, 'morning-join', { date: d2 });
  const r1 = await get(a.cookie, 'morning-meet', { date: d1 }); const r2 = await get(a.cookie, 'morning-meet', { date: d2 });
  assert.ok(r1.body.url !== legacy && r2.body.url !== legacy && r1.body.url !== r2.body.url, '日付別の別々のURL');
  assert.equal(google.spaceCalls, 2);
  configure(false);
});

test('設定済み：その日専用のMeetを作る（Googleの正式API・同日は同じURL・別の日は別のURL）', async () => {
  configure(true); installFakeGoogle();
  const d1 = day(12), d2 = day(13);
  const a = await member('あや'); const b = await member('ぼん');
  await post(a.cookie, 'morning-join', { date: d1 });
  assert.equal(google.spaceCalls, 1, '最初の参加表明でその日のMeetが作られる');
  assert.equal(google.bodies[0].auth, 'Bearer fake-access-token');
  const ra = await get(a.cookie, 'morning-meet', { date: d1 });
  assert.equal(ra.body.status, 'ready'); assert.match(ra.body.url, /^https:\/\/meet\.google\.com\/[a-z0-9-]+$/);
  await post(b.cookie, 'morning-join', { date: d1 });
  const rb = await get(b.cookie, 'morning-meet', { date: d1 });
  assert.equal(rb.body.url, ra.body.url, '同じ日の参加者は同じURL');
  assert.equal(google.spaceCalls, 1, '同じ日に重複して作らない');
  await post(a.cookie, 'morning-join', { date: d2 });
  const rd2 = await get(a.cookie, 'morning-meet', { date: d2 });
  assert.notEqual(rd2.body.url, ra.body.url, '別の日は別のURL');
  assert.equal(google.spaceCalls, 2);
  assert.equal((await store.getMorningMeet(d1)).url, ra.body.url, '日付とURLが保存されている');
});

test('同時に参加表明・同時にMeetを要求しても、その日のMeetは1件だけ', async () => {
  configure(true); installFakeGoogle(); google.delay = 120;
  const date = day(14);
  const ms = await Promise.all(['い1', 'い2', 'い3', 'い4', 'い5', 'い6'].map((n) => member(n)));
  const joins = await Promise.all(ms.map((m) => post(m.cookie, 'morning-join', { date })));
  assert.ok(joins.every((r) => r.status === 200));
  assert.equal(google.spaceCalls, 1, 'Googleでの作成は1回だけ');
  const urls = await Promise.all(ms.map((m) => get(m.cookie, 'morning-meet', { date })));
  assert.equal(new Set(urls.map((r) => r.body.url)).size, 1, '全員が同じURL');
  assert.equal(google.spaceCalls, 1);
});

test('Meet URLの保護：未ログイン401・未参加403・取消した人403・別の日の参加者は取れない・過去日は不可・解約済みは不可', async () => {
  configure(true); installFakeGoogle();
  const date = day(15), other = day(16);
  const a = await member('あや'); const b = await member('ぼん'); const c = await member('かい', { status: null });
  await post(a.cookie, 'morning-join', { date });
  assert.equal((await get('', 'morning-meet', { date })).status, 401);
  assert.equal((await get(c.cookie, 'morning-meet', { date })).status, 403, '会員資格がない');
  const nb = await get(b.cookie, 'morning-meet', { date });
  assert.equal(nb.status, 403); assert.equal(nb.body.code, 'not_joined'); assert.equal(nb.body.url, undefined);
  await post(b.cookie, 'morning-join', { date: other });
  assert.equal((await get(b.cookie, 'morning-meet', { date })).status, 403, '別の日に参加しているだけでは、その日のURLは取れない');
  assert.equal((await get(a.cookie, 'morning-meet', { date })).body.status, 'ready');
  await post(a.cookie, 'morning-leave', { date });
  assert.equal((await get(a.cookie, 'morning-meet', { date })).status, 403, '参加を取り消したら取れない');
  assert.equal((await get(a.cookie, 'morning-meet', { date: addDays(jstToday(), -1) })).status, 409, '過去日');
  assert.equal((await get(a.cookie, 'morning-meet', { date: 'bad' })).status, 400);
  await post(b.cookie, 'morning-join', { date });
  await store.setMembership('haku', b.email, { status: 'canceled' });
  assert.equal((await get(b.cookie, 'morning-meet', { date })).status, 403, '解約済みの会員は取れない');
});

test('Meet URLは、Meet取得API以外のどのレスポンスにも含まれない', async () => {
  configure(true); installFakeGoogle();
  const date = day(17);
  const a = await member('あや'); const b = await member('ぼん');
  const join = await post(a.cookie, 'morning-join', { date });
  const url = (await get(a.cookie, 'morning-meet', { date })).body.url;
  assert.ok(url);
  const outputs = [join, await get(b.cookie, 'morning-month', { month: date.slice(0, 7) }), await get(a.cookie, 'morning-month', { month: date.slice(0, 7) }),
    await get(b.cookie, 'morning-next'), await get(a.cookie, 'morning-next'), await get(a.cookie, 'events-list'), await get(a.cookie, 'me'), await post(b.cookie, 'morning-join', { date })];
  for (const r of outputs) {
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes('meet.google.com') && !text.includes(url.split('/').pop()), 'URLが他のAPIに出ている');
  }
});

test('中止になった日はMeetを返さない', async () => {
  configure(true); installFakeGoogle();
  const date = day(18);
  const a = await member('あや');
  await post(a.cookie, 'morning-join', { date });
  const ev = await store.getEvent(`morning-${date}`);
  await store.updateEvent(ev.id, { registration: 'cancelled' });
  const r = await get(a.cookie, 'morning-meet', { date });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'cancelled'); assert.equal(r.body.url, undefined);
});

test('Google側のエラー：参加表明は成功し、Meet取得は「error」状態（保存されない）→ 復旧後は作成される', async () => {
  configure(true); installFakeGoogle(); google.failSpaces = true;
  const date = day(19);
  const a = await member('あや');
  const j = await post(a.cookie, 'morning-join', { date });
  assert.equal(j.status, 200, '参加表明は失敗させない');
  const r1 = await get(a.cookie, 'morning-meet', { date });
  assert.equal(r1.status, 503); assert.equal(r1.body.status, 'error'); assert.equal(r1.body.url, undefined);
  assert.equal(await store.getMorningMeet(date), null, '失敗した会議は保存しない');
  google.failSpaces = false;
  const r2 = await get(a.cookie, 'morning-meet', { date });
  assert.equal(r2.body.status, 'ready', '再試行で作成される（ロックが残っていない）');
  installFakeGoogle(); google.failToken = true;
  const d2 = day(20); await post(a.cookie, 'morning-join', { date: d2 });
  assert.equal((await get(a.cookie, 'morning-meet', { date: d2 })).body.status, 'error', '認証エラーもerror状態');
});

test('Meet APIの応答のURLの形が違うときは、保存せずエラー', async () => {
  configure(true);
  __setFetchForTests(async (url) => (String(url).includes('oauth2')
    ? { ok: true, status: 200, json: async () => ({ access_token: 't' }) }
    : { ok: true, status: 200, json: async () => ({ name: 'spaces/x', meetingUri: 'https://evil.example/abc' }) }));
  await assert.rejects(createMeetSpace(), (e) => e.code === 'api');
});

test('入室管理（アクセス種別）は環境変数で指定でき、Googleに渡される。不正な値は無視', async () => {
  configure(true); installFakeGoogle();
  process.env.GOOGLE_MEET_ACCESS_TYPE = 'trusted';
  await createMeetSpace();
  assert.deepEqual(JSON.parse(google.bodies[0].body), { config: { accessType: 'TRUSTED' } });
  process.env.GOOGLE_MEET_ACCESS_TYPE = 'bogus';
  await createMeetSpace();
  assert.deepEqual(JSON.parse(google.bodies[1].body), {});
  configure(false);
});

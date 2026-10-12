/**
 * 朝の集まり：スタンプ＋HAKUポイント（実参加で10pt）と、Google Meetの参加履歴による出席確認のテスト。
 * Googleとの通信はすべてこのテスト内の偽物。本物のGoogleには一切接続しない（実Googleでの確認は未実施）。
 *   node --test "tests-unit/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import * as store from '../api/_lib/store.redis.js';

store.__setRedisForTests(new RedisMock({ host: 'mock-attendance', port: 6379 }));
process.env.VERCEL_ENV = 'preview';
const { default: authHandler } = await import('../api/community-auth.js');
const { default: adminHandler } = await import('../api/admin.js');
const att = await import('../api/_lib/morning-attendance.js');
const meetAtt = await import('../api/_lib/meet-attendance.js');
const { __setFetchForTests } = await import('../api/_lib/google-meet.js');
const { MORNING_CONFIG, jstToday, addDays } = await import('../api/_lib/morning.js');
const points = await import('../api/_lib/points.js');

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
async function call(handler, cookie, action, { method = 'GET', body = {}, query = {}, headers = {} } = {}) {
  const n = ++ipSeq; const ip = `10.8.${(n >> 8) & 255}.${n & 255}`;
  const res = fakeRes();
  await handler({ method, query: { action, ...query }, body, headers: { cookie: cookie || '', host: 'localhost:3000', 'x-forwarded-for': ip, ...headers }, socket: { remoteAddress: ip } }, res);
  return { status: res.statusCode, body: res.body };
}
const A = (cookie, action, query) => call(adminHandler, cookie, action, { query });
const AP = (cookie, action, body) => call(adminHandler, cookie, action, { method: 'POST', body });
const M = (cookie, action, query) => call(authHandler, cookie, action, { query });
const adminCookie = async () => `ht_admin_session=${await store.createAdminSession({ actorId: 'admin@example.com', role: 'super_admin' })}`;

let seq = 0;
async function member(name, { status = 'active' } = {}) {
  const email = `at${++seq}_${Date.now()}@example.com`;
  await store.saveUser({ email, displayName: name, fullName: `氏名${name}`, fullNameKana: 'しめい', passwordHash: 'x:y' });
  await store.createApplication('haku', { email, fullName: `氏名${name}`, fullNameKana: 'しめい', displayName: name });
  await store.resolveApplication('haku', email, 'paid', 'test');
  if (status) await store.setMembership('haku', email, { status });
  return { email, name, cookie: `ht_session=${await store.createSession(email)}` };
}
const past = (n) => addDays(jstToday(), -n);
const balance = (email) => points.getBalance(email);
const ledger = async (email) => (await points.getAdminMemberView(email)).entries;
async function joinDay(date, email) { await store.ensureMorningEvent(date, 'test'); return store.joinEventAtomic(store.morningEventId(date), email, null); }

/* ═════════ 付与・二重付与の防止 ═════════ */
test('実参加の確認で10pt＋スタンプ。参加表明だけでは0pt。ポイントは既存の台帳に1行だけ記録される', async () => {
  const m = await member('はなこ'); const date = past(3);
  await joinDay(date, m.email); // 参加表明だけ
  assert.equal(await balance(m.email), 0); assert.deepEqual(await att.getStampDates(m.email, date.slice(0, 7)), []);
  const r = await att.confirmAttendance({ date, email: m.email, source: 'admin', actorId: 'a', reason: 'テスト' });
  assert.equal(r.status, 'confirmed'); assert.equal(r.record.points, 10); assert.equal(MORNING_CONFIG.attendancePoints, 10);
  assert.equal(await balance(m.email), 10);
  const rows = await ledger(m.email);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].kind, rows[0].delta, rows[0].refType, rows[0].refId], ['morning_attendance', 10, 'morning_attendance', date]);
  assert.equal(rows[0].email, m.email, '会員ID（メール）が台帳に残る');
  assert.deepEqual(await att.getStampDates(m.email, date.slice(0, 7)), [date]);
  assert.equal((await att.getAttendance(date, m.email)).eventId, `morning-${date}`, '開催日・イベントIDが記録される');
});

test('二重付与なし：同じ日・同じ会員は、何度でも・同時に確定しても1回だけ。台帳と残高が一致する', async () => {
  const m = await member('どうじ'); const date = past(2);
  const rs = await Promise.allSettled(Array.from({ length: 6 }, () => att.confirmAttendance({ date, email: m.email, source: 'admin', actorId: 'a', reason: 'r' })));
  assert.ok(rs.every((r) => r.status === 'fulfilled' || r.reason.code === 'busy'), '同時のものは「処理中」になるか成功');
  const again = await att.confirmAttendance({ date, email: m.email, source: 'admin', actorId: 'a', reason: 'r' });
  assert.equal(again.status, 'already');
  assert.equal(await balance(m.email), 10);
  const rows = await ledger(m.email);
  assert.equal(rows.length, 1);
  assert.equal(rows.reduce((s, e) => s + e.delta, 0), await balance(m.email), '台帳の合計＝残高');
  // 別の日は別に1回ずつ
  await att.confirmAttendance({ date: past(1), email: m.email, source: 'admin', actorId: 'a', reason: 'r' });
  assert.equal(await balance(m.email), 20);
});

test('取消・訂正：履歴を消さず相殺。スタンプも消える。取消のあとの再確定でも残高が正しい', async () => {
  const m = await member('とりけし'); const date = past(4);
  await att.confirmAttendance({ date, email: m.email, source: 'admin', actorId: 'a', reason: 'r' });
  await assert.rejects(att.cancelAttendance({ date, email: m.email, actorId: 'a', reason: '' }), (e) => e.code === 'reason_required');
  await att.cancelAttendance({ date, email: m.email, actorId: 'a', reason: '誤記録' });
  assert.equal(await balance(m.email), 0);
  assert.deepEqual(await att.getStampDates(m.email, date.slice(0, 7)), []);
  let rows = await ledger(m.email);
  assert.deepEqual(rows.map((e) => e.delta).sort((a, b) => a - b), [-10, 10], '履歴は2行（付与と取消）で、消えていない');
  assert.ok(rows.some((e) => e.kind === 'admin_reversal' && e.reversalOf));
  await assert.rejects(att.cancelAttendance({ date, email: m.email, actorId: 'a', reason: 'もう一度' }), (e) => e.code === 'not_attended', '二重の取消はできない');
  const re = await att.confirmAttendance({ date, email: m.email, source: 'admin', actorId: 'a', reason: '再確定' });
  assert.equal(re.status, 'confirmed'); assert.equal(re.record.gen, 2);
  assert.equal(await balance(m.email), 10, '再確定で、また10pt（二重にならない）');
  assert.deepEqual(await att.getStampDates(m.email, date.slice(0, 7)), [date]);
  await att.cancelAttendance({ date, email: m.email, actorId: 'a', reason: '再度取消' });
  rows = await ledger(m.email);
  assert.equal(rows.length, 4); assert.equal(await balance(m.email), 0);
  assert.equal(rows.reduce((s, e) => s + e.delta, 0), 0);
});

test('管理者の手動ポイント操作でその付与を取り消した場合も、スタンプは消え、再確定で付与し直される（台帳と記録が食い違わない）', async () => {
  const m = await member('てどうとりけし'); const date = past(5);
  const r = await att.confirmAttendance({ date, email: m.email, source: 'admin', actorId: 'a', reason: 'r' });
  await points.reversePoints({ entryId: r.record.entryId, reason: '手動で取消', requestId: 'manual-rev-12345678', actorId: 'admin' });
  assert.equal(await balance(m.email), 0);
  assert.deepEqual(await att.getStampDates(m.email, date.slice(0, 7)), [], '台帳で取り消された出席のスタンプは出ない');
  const re = await att.confirmAttendance({ date, email: m.email, source: 'admin', actorId: 'a', reason: '再確定' });
  assert.equal(re.status, 'confirmed'); assert.equal(await balance(m.email), 10);
});

test('確定できない場合：未来の日・有効でない会員・不正な日付。付与されない', async () => {
  const ok = await member('みらい');
  await assert.rejects(att.confirmAttendance({ date: addDays(jstToday(), 3), email: ok.email, source: 'admin', actorId: 'a' }), (e) => e.code === 'future');
  const gone = await member('たいかい', { status: 'canceled' });
  await assert.rejects(att.confirmAttendance({ date: past(1), email: gone.email, source: 'admin', actorId: 'a' }), (e) => e.code === 'not_member');
  const none = await member('みかいいん', { status: null });
  await assert.rejects(att.confirmAttendance({ date: past(1), email: none.email, source: 'admin', actorId: 'a' }), (e) => e.code === 'not_member');
  await assert.rejects(att.confirmAttendance({ date: '2026-13-40', email: ok.email, source: 'admin', actorId: 'a' }), (e) => e.code === 'invalid_date');
  await assert.rejects(att.confirmAttendance({ date: past(1), email: ok.email, source: 'self', actorId: 'a' }), (e) => e.code === 'invalid_source', '本人の申告では確定できない');
  for (const e of [ok, gone, none]) assert.equal(await balance(e.email), 0);
});

test('ポイント数は設定（MORNING_CONFIG.attendancePoints）の一か所で変えられる。既存の付与は変わらない', async () => {
  const a = await member('せっていA'); const b = await member('せっていB');
  await att.confirmAttendance({ date: past(1), email: a.email, source: 'admin', actorId: 'x', reason: 'r' });
  const saved = MORNING_CONFIG.attendancePoints; MORNING_CONFIG.attendancePoints = 25;
  try { await att.confirmAttendance({ date: past(1), email: b.email, source: 'admin', actorId: 'x', reason: 'r' }); } finally { MORNING_CONFIG.attendancePoints = saved; }
  assert.deepEqual([await balance(a.email), await balance(b.email)], [10, 25]);
});

/* ═════════ 会員のスタンプ表示 ═════════ */
test('スタンプAPI：本人が実際に参加した日だけ。他の会員の記録・参加表明だけの日は含めない。月の範囲を検査', async () => {
  const me = await member('じぶん'); const other = await member('ひと');
  const d1 = past(6); const d2 = past(7);
  await att.confirmAttendance({ date: d1, email: me.email, source: 'admin', actorId: 'a', reason: 'r' });
  await att.confirmAttendance({ date: d2, email: other.email, source: 'admin', actorId: 'a', reason: 'r' });
  await joinDay(past(8), me.email); // 参加表明だけ
  const months = [...new Set([d1, d2, past(8)].map((d) => d.slice(0, 7)))];
  const stamps = (await Promise.all(months.map((mo) => M(me.cookie, 'morning-stamps', { month: mo })))).flatMap((r) => r.body.stamps);
  assert.deepEqual(stamps, [d1], '自分の参加日だけ');
  assert.equal((await M(me.cookie, 'morning-stamps', { month: 'bad' })).status, 400);
  assert.equal((await M(me.cookie, 'morning-stamps', { month: '1999-01' })).status, 400);
  assert.equal((await M('', 'morning-stamps', { month: d1.slice(0, 7) })).status, 401, '未ログインは不可');
  const nonMember = await member('ひかいいん', { status: null });
  assert.equal((await M(nonMember.cookie, 'morning-stamps', { month: d1.slice(0, 7) })).status, 403);
  const pv = await M(me.cookie, 'points-me'); assert.equal(pv.status, 200);
  assert.equal(pv.body.balance, 10); assert.ok(pv.body.entries.some((e) => e.kindLabel === '朝の集まりへの参加' && e.delta === 10), 'ポイント履歴に反映');
});

/* ═════════ Google Meet の参加履歴との照合（偽のGoogle） ═════════ */
const G = { records: [], participants: {}, sessions: {}, fail: null, calls: [] };
function installGoogle() {
  G.calls = []; G.fail = null;
  __setFetchForTests(async (url) => {
    const u = String(url); G.calls.push(u);
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (u.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'fake' });
    if (G.fail) return json(G.fail, { error: 'x' });
    const path = new URL(u).pathname.replace('/v2/', '');
    if (path === 'conferenceRecords') return json(200, { conferenceRecords: G.records });
    let m = /^(conferenceRecords\/[^/]+)\/participants$/.exec(path);
    if (m) return json(200, { participants: G.participants[m[1]] || [] });
    m = /^(conferenceRecords\/[^/]+\/participants\/[^/]+)\/participantSessions$/.exec(path);
    if (m) return json(200, { participantSessions: G.sessions[m[1]] || [] });
    return json(404, {});
  });
}
const withGoogle = async (fn, { rule = '15', configured = true } = {}) => {
  const keep = { id: process.env.GOOGLE_MEET_CLIENT_ID, sec: process.env.GOOGLE_MEET_CLIENT_SECRET, rt: process.env.GOOGLE_MEET_REFRESH_TOKEN, rule: process.env.MORNING_ATTENDANCE_MIN_MINUTES };
  if (configured) Object.assign(process.env, { GOOGLE_MEET_CLIENT_ID: 'cid', GOOGLE_MEET_CLIENT_SECRET: 'sec', GOOGLE_MEET_REFRESH_TOKEN: 'rt' }); else { delete process.env.GOOGLE_MEET_CLIENT_ID; delete process.env.GOOGLE_MEET_CLIENT_SECRET; delete process.env.GOOGLE_MEET_REFRESH_TOKEN; }
  if (rule === null) delete process.env.MORNING_ATTENDANCE_MIN_MINUTES; else process.env.MORNING_ATTENDANCE_MIN_MINUTES = rule;
  installGoogle();
  try { return await fn(); } finally { for (const [k, v] of [['GOOGLE_MEET_CLIENT_ID', keep.id], ['GOOGLE_MEET_CLIENT_SECRET', keep.sec], ['GOOGLE_MEET_REFRESH_TOKEN', keep.rt], ['MORNING_ATTENDANCE_MIN_MINUTES', keep.rule]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } __setFetchForTests(null); }
};
const T = (min) => new Date(Date.UTC(2026, 9, 1, 21, 0, 0) + min * 60000).toISOString();
function setConference({ spaceName, people, ended = true }) {
  G.records = [{ name: 'conferenceRecords/c1', space: spaceName, startTime: T(0), ...(ended ? { endTime: T(60) } : {}) }];
  G.participants = { 'conferenceRecords/c1': people.map((p, i) => ({ name: `conferenceRecords/c1/participants/p${i}`, ...p.who })) };
  G.sessions = Object.fromEntries(people.map((p, i) => [`conferenceRecords/c1/participants/p${i}`, p.sessions]));
}
const sess = (a, b) => ({ startTime: T(a), endTime: T(b) });

test('Google照合：確定されるのは「結び付け済みのGoogleアカウント＋参加表明済み＋有効会員＋条件を満たす滞在」だけ。ほかは付与しない', async () => {
  await withGoogle(async () => {
    const date = past(20); const space = `spaces/s${Date.now()}`;
    const [a, b, c, d, e] = await Promise.all(['ええ', 'びい', 'しい', 'でぃ', 'いい'].map((n) => member(n)));
    await store.saveMorningMeetOnce(date, { url: 'https://meet.google.com/aaa-bbbb-ccc', spaceName: space, meetingCode: 'aaabbbbccc' });
    for (const x of [a, c, d, e]) await joinDay(date, x.email); // b は参加表明していない
    await att.linkGoogleIdentity('users/1001', a.email); await att.linkGoogleIdentity('users/1002', b.email); await att.linkGoogleIdentity('users/1004', d.email); await att.linkGoogleIdentity('users/1005', e.email);
    setConference({ spaceName: space, people: [
      { who: { signedinUser: { user: 'users/1001', displayName: '表示名が全然ちがう' } }, sessions: [sess(0, 10), sess(20, 45)] }, // a：合計35分 → 出席
      { who: { signedinUser: { user: 'users/1002', displayName: 'びい' } }, sessions: [sess(0, 60)] }, // b：結び付け済みだが参加表明なし → 付与しない
      { who: { anonymousUser: { displayName: 'しい' } }, sessions: [sess(0, 60)] }, // c：表示名が会員と同じでも、匿名は会員と判断しない → 確認待ち
      { who: { signedinUser: { user: 'users/1004', displayName: 'でぃ' } }, sessions: [sess(0, 5)] }, // d：5分 → 条件（15分）未満
      { who: { signedinUser: { user: 'users/9999', displayName: 'いい' } }, sessions: [sess(0, 60)] }, // e本人かもしれないが、別の識別子（未結び付け）→ 確認待ち
    ] });
    const r = await meetAtt.syncDayAttendance(date);
    assert.deepEqual([r.status, r.confirmed, r.pending, r.belowRule, r.notRegistered], ['done', 1, 2, 1, 1]);
    assert.equal(await balance(a.email), 10); assert.deepEqual(await att.getStampDates(a.email, date.slice(0, 7)), [date]);
    for (const x of [b, c, d, e]) { assert.equal(await balance(x.email), 0, '付与しない'); assert.deepEqual(await att.getStampDates(x.email, date.slice(0, 7)), []); }
    const pending = await att.listPending(date);
    assert.deepEqual(pending.map((p) => p.kind).sort(), ['anonymous', 'signedin']);
    // 再実行しても二重に付与されない
    const again = await meetAtt.syncDayAttendance(date);
    assert.equal(again.already, 1); assert.equal(await balance(a.email), 10); assert.equal((await ledger(a.email)).length, 1);
  });
});

test('Google照合：未設定・出席条件が未設定・会議なし（共通Meet）・会議が終了していない・API障害のときは、何も付与しない（誤付与なし）', async () => {
  const date = past(21); const space = `spaces/t${Date.now()}`;
  const m = await member('あんぜん'); await joinDay(date, m.email); await att.linkGoogleIdentity('users/2001', m.email);
  const conf = () => setConference({ spaceName: space, people: [{ who: { signedinUser: { user: 'users/2001', displayName: 'x' } }, sessions: [sess(0, 60)] }] });
  // Google未設定
  await withGoogle(async () => { assert.equal((await meetAtt.syncDayAttendance(date)).status, 'unconfigured'); assert.equal(G.calls.length, 0, 'Googleへは問い合わせない'); }, { configured: false });
  // 出席条件が未設定（未確定）
  await withGoogle(async () => { conf(); assert.equal((await meetAtt.syncDayAttendance(date)).status, 'rule_unset'); assert.equal(G.calls.length, 0); }, { rule: null });
  // 日付別Meetがない（暫定の共通Meetだけ）
  await withGoogle(async () => { conf(); assert.equal((await meetAtt.syncDayAttendance(date)).status, 'no_meet'); });
  await store.saveMorningMeetOnce(date, { url: 'https://meet.google.com/aaa-bbbb-ddd', spaceName: space, meetingCode: 'x' });
  // 会議がまだ終了していない／滞在中のセッションがある
  await withGoogle(async () => { conf(); G.records[0].endTime = undefined; delete G.records[0].endTime; assert.equal((await meetAtt.syncDayAttendance(date)).status, 'in_progress'); });
  await withGoogle(async () => { conf(); G.sessions['conferenceRecords/c1/participants/p0'] = [{ startTime: T(0) }]; assert.equal((await meetAtt.syncDayAttendance(date)).status, 'in_progress'); });
  // API障害・権限不足：例外（何も確定していない）
  for (const code of [500, 403, 429]) {
    await withGoogle(async () => { conf(); G.fail = code; await assert.rejects(meetAtt.syncDayAttendance(date), (e) => e.name === 'Error' && /Google/.test(e.message)); });
  }
  assert.equal(await balance(m.email), 0); assert.deepEqual(await att.getStampDates(m.email, date.slice(0, 7)), []);
  // 条件が整えば付与される（0分＝参加の記録があれば出席。条件の値は運営が決める）
  await withGoogle(async () => { conf(); assert.equal((await meetAtt.syncDayAttendance(date)).confirmed, 1); }, { rule: '0' });
  assert.equal(await balance(m.email), 10);
});

test('Google照合：自動の定期実行は、MORNING_ATTENDANCE_AUTO=1 のときだけ。CRON_SECRETが必要', async () => {
  process.env.CRON_SECRET = 'cron-test-secret';
  try {
    assert.equal((await call(adminHandler, '', 'attendance-cron', {})).status, 401);
    assert.equal((await call(adminHandler, '', 'attendance-cron', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const off = await call(adminHandler, '', 'attendance-cron', { headers: { authorization: 'Bearer cron-test-secret' } });
    assert.deepEqual([off.status, off.body.skipped], [200, 'auto_disabled']);
  } finally { delete process.env.CRON_SECRET; }
});

/* ═════════ 管理画面：出席訂正・確認待ち ═════════ */
test('管理API：出席訂正（理由必須）・確認待ちの結び付け・Google照合の実行。管理者以外は使えない', async () => {
  const adm = await adminCookie(); const date = past(30);
  const m = await member('かんり'); await joinDay(date, m.email);
  for (const [a, opts] of [['attendance-day', { date }], ['attendance-set', { date, email: m.email, op: 'confirm', reason: 'x' }], ['attendance-sync', { date }], ['attendance-link', { date }]]) {
    const r = a === 'attendance-day' ? await A('', a, opts) : await AP('', a, opts);
    assert.equal(r.status, 401, a);
  }
  const day0 = await A(adm, 'attendance-day', { date });
  assert.equal(day0.status, 200); assert.equal(day0.body.pointsPerAttendance, 10);
  assert.deepEqual(day0.body.automation, { googleConfigured: false, dateMeet: false, legacyMeetOnly: true, ruleSet: false, minMinutes: null, autoEnabled: false });
  assert.deepEqual(day0.body.members.map((x) => [x.email, x.joined, x.attendance]), [[m.email, true, 'none']]);
  assert.equal((await AP(adm, 'attendance-set', { date, email: m.email, op: 'confirm', reason: '' })).status, 400, '理由なしは不可');
  assert.equal((await AP(adm, 'attendance-set', { date, email: m.email, op: 'confirm', reason: 'Meet画面で出席を確認' })).status, 200);
  assert.equal(await balance(m.email), 10);
  assert.equal((await A(adm, 'attendance-day', { date })).body.members[0].attendance, 'attended');
  assert.equal((await AP(adm, 'attendance-set', { date, email: m.email, op: 'cancel', reason: '誤記録' })).status, 200);
  assert.equal(await balance(m.email), 0);
  assert.equal((await AP(adm, 'attendance-set', { date, email: m.email, op: 'cancel', reason: '二重' })).status, 404);
  assert.equal((await A(adm, 'attendance-day', { date: 'bad' })).status, 400);
  // Google照合の実行：設定前は何もしない
  const sync = await AP(adm, 'attendance-sync', { date }); assert.deepEqual([sync.status, sync.body.status], [200, 'unconfigured']);
  // 確認待ちの結び付け：結び付けると以後は自動で照合される
  await att.setPending(date, [{ participantKey: 'users/7777', kind: 'signedin', displayName: 'ゲスト', minutes: 30, at: 1 }, { participantKey: 'conferenceRecords/c1/participants/anon', kind: 'anonymous', displayName: 'とおりすがり', minutes: 20, at: 1 }]);
  const day1 = await A(adm, 'attendance-day', { date });
  assert.deepEqual(day1.body.pending.map((p) => [p.kind, p.linkable]).sort(), [['anonymous', false], ['signedin', true]]);
  assert.equal((await AP(adm, 'attendance-link', { date, participantKey: 'users/7777', email: m.email, reason: '' })).status, 400);
  const link = await AP(adm, 'attendance-link', { date, participantKey: 'users/7777', email: m.email, reason: '本人と確認' });
  assert.deepEqual([link.status, link.body.linked], [200, true]);
  assert.equal(await att.emailByGoogleIdentity('users/7777'), m.email);
  assert.equal(await balance(m.email), 10, '結び付けと同時に確定（再確定のため新しい世代で付与）');
  assert.equal((await att.listPending(date)).length, 1, '解決した分は確認待ちから消える');
  const anon = await AP(adm, 'attendance-link', { date, participantKey: 'conferenceRecords/c1/participants/anon', email: m.email, reason: '匿名の参加' });
  assert.equal(anon.body.linked, false, '匿名の参加は、アカウントの結び付けはしない');
  assert.equal(await att.emailByGoogleIdentity('conferenceRecords/c1/participants/anon'), null);
});

test('既存の管理者によるポイント付与・調整・取消は、これまでどおり使える（朝の出席の台帳行も同じ画面に出る）', async () => {
  const adm = await adminCookie(); const m = await member('てどう');
  const g = await AP(adm, 'points-grant', { email: m.email, amount: 5, reason: '手動', requestId: 'manual-grant-1234' });
  assert.equal(g.status, 200);
  await att.confirmAttendance({ date: past(1), email: m.email, source: 'admin', actorId: 'a', reason: 'r' });
  const detail = await A(adm, 'points-member', { email: m.email });
  assert.equal(detail.body.balance, 15);
  const att1 = detail.body.entries.find((e) => e.kind === 'morning_attendance');
  const rev = await AP(adm, 'points-reverse', { entryId: att1.id, reason: '管理画面から取消', requestId: 'manual-rev-87654321' });
  assert.equal(rev.status, 200); assert.equal(rev.body.balance, 5);
});

test('出席の条件1分（暫定）：同じ日の入退室を合算して、合計1分以上で出席。重なった時間は二重に数えない。59秒は出席にしない', async () => {
  const { unionMs } = meetAtt;
  const m = (a, b) => [Date.parse(T(a)), Date.parse(T(b))];
  assert.equal(unionMs([m(0, 10), m(5, 15)]), 15 * 60000, '重なりは1回分');
  assert.equal(unionMs([m(0, 1), m(10, 11)]), 2 * 60000, '離れた入退室は合算');
  assert.equal(unionMs([m(0, 10), m(2, 4)]), 10 * 60000, '含まれる時間は数えない');
  assert.equal(unionMs([]), 0);
  await withGoogle(async () => {
    const date = past(22); const space = `spaces/m${Date.now()}`;
    const [a, b, c, d] = await Promise.all(['いち', 'にい', 'さん', 'よん'].map((n) => member(n)));
    await store.saveMorningMeetOnce(date, { url: 'https://meet.google.com/mmm-mmmm-mmm', spaceName: space, meetingCode: 'mmm' });
    for (const x of [a, b, c, d]) { await joinDay(date, x.email); }
    await att.linkGoogleIdentity('users/3001', a.email); await att.linkGoogleIdentity('users/3002', b.email); await att.linkGoogleIdentity('users/3003', c.email); await att.linkGoogleIdentity('users/3004', d.email);
    const S = (s0, s1) => ({ startTime: new Date(Date.UTC(2026, 9, 1, 21, 0, s0)).toISOString(), endTime: new Date(Date.UTC(2026, 9, 1, 21, 0, s1)).toISOString() });
    setConference({ spaceName: space, people: [
      { who: { signedinUser: { user: 'users/3001', displayName: 'a' } }, sessions: [S(0, 30), S(300, 330)] }, // 30秒＋30秒（入り直し）= 60秒 → 出席
      { who: { signedinUser: { user: 'users/3002', displayName: 'b' } }, sessions: [S(0, 59)] }, // 59秒 → 出席にしない
      { who: { signedinUser: { user: 'users/3003', displayName: 'c' } }, sessions: [S(0, 40), S(20, 50)] }, // 重なり：実際は50秒 → 出席にしない（二重計上しない）
      { who: { signedinUser: { user: 'users/3004', displayName: 'd' } }, sessions: [S(0, 600), S(0, 600)] }, // 2台で同時に10分 → 出席
    ] });
    const r = await meetAtt.syncDayAttendance(date);
    assert.deepEqual([r.status, r.confirmed, r.belowRule], ['done', 2, 2]);
    assert.deepEqual([await balance(a.email), await balance(b.email), await balance(c.email), await balance(d.email)], [10, 0, 0, 10]);
  }, { rule: '1' });
});

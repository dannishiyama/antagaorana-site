/**
 * 朝の集まり（日ごとの参加表明・カレンダー）とプロフィール画像のAPIテスト。
 * メモリ上のRedisモックに対して、実際のAPI関数（api/community-auth.js・api/admin.js）を呼ぶ。
 *   npm install --no-save --legacy-peer-deps ioredis@5 ioredis-mock react@18 react-dom@18
 *   node --test "tests-unit/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import RedisMock from 'ioredis-mock';
import * as store from '../api/_lib/store.redis.js';

store.__setRedisForTests(new RedisMock({ host: 'mock-morning-avatar', port: 6379 }));
process.env.VERCEL_ENV = 'preview';
const { default: authHandler } = await import('../api/community-auth.js');
const { default: adminHandler } = await import('../api/admin.js');
const { jstToday, addDays, joinBlock, leaveBlock, MORNING_CONFIG, monthDates, isValidDate } = await import('../api/_lib/morning.js');
const { parseAvatarDataUrl, AvatarError } = await import('../api/_lib/avatar.js');

function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {}, raw: null };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.getHeader = (k) => res.headers[k.toLowerCase()];
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { if (Buffer.isBuffer(b)) res.raw = b; else res.body = b; return res; };
  return res;
}
let ipSeq = 0;
async function call(handler, cookie, action, { method = 'GET', body = {}, query = {} } = {}) {
  const n = ++ipSeq;
  const ip = `10.3.${(n >> 8) & 255}.${n & 255}`;
  const res = fakeRes();
  await handler({ method, query: { action, ...query }, body, headers: { cookie: cookie || '', host: 'example.test', 'x-forwarded-for': ip }, socket: { remoteAddress: ip } }, res);
  return { status: res.statusCode, body: res.body, raw: res.raw, headers: res.headers };
}
const get = (cookie, action, query) => call(authHandler, cookie, action, { query });
const post = (cookie, action, body) => call(authHandler, cookie, action, { method: 'POST', body });

let seq = 0;
async function member(name, { status = 'active' } = {}) {
  const email = `mo${++seq}_${Date.now()}@example.com`;
  await store.saveUser({ email, displayName: name, fullName: `氏名${name}`, fullNameKana: 'しめい', passwordHash: 'x:y' });
  await store.createApplication('haku', { email, fullName: `氏名${name}`, fullNameKana: 'しめい', displayName: name });
  await store.resolveApplication('haku', email, 'approved', 'test');
  if (status) await store.setMembership('haku', email, { status });
  const sid = await store.createSession(email);
  return { email, name, cookie: `ht_session=${sid}` };
}
const today = jstToday();
const tomorrow = addDays(today, 1);
const day = (n) => addDays(today, n);
const dayOf = (r, date) => r.body.days.find((d) => d.date === date);

/* ═════════ 朝の集まり ═════════ */
test('参加者がいない日は「開催予定なし」。月の一覧にも出ない', async () => {
  const a = await member('あや');
  const r = await get(a.cookie, 'morning-month', { month: tomorrow.slice(0, 7) });
  assert.equal(r.status, 200);
  assert.equal(dayOf(r, tomorrow), undefined, '誰も参加していない日は一覧にない（開催予定なし）');
  assert.equal((await get(a.cookie, 'morning-next')).body.next, null);
  assert.equal(await store.getEvent(`morning-${tomorrow}`), null, '参加表明の前にイベントは作られない');
});

test('最初の1人の参加表明で開催予定になり、ほかの会員にも見える。二人目で更新、取消も反映される', async () => {
  const date = day(3);
  const a = await member('あや'); const b = await member('ぼん');
  const ja = await post(a.cookie, 'morning-join', { date });
  assert.equal(ja.status, 200);
  assert.equal(ja.body.day.status, 'scheduled'); assert.equal(ja.body.day.count, 1); assert.equal(ja.body.day.joined, true);
  assert.ok(await store.getEvent(`morning-${date}`), '参加表明でイベントが作られる');

  const vb = await get(b.cookie, 'morning-month', { month: date.slice(0, 7) });
  const d1 = dayOf(vb, date);
  assert.equal(d1.count, 1); assert.equal(d1.joined, false, 'Bから見て自分は未参加');
  assert.deepEqual(d1.participants.map((p) => p.name), ['あや']);

  const jb = await post(b.cookie, 'morning-join', { date });
  assert.equal(jb.body.day.count, 2);
  assert.deepEqual(jb.body.day.participants.map((p) => p.name), ['ぼん', 'あや'], '自分が先頭');
  const va = dayOf(await get(a.cookie, 'morning-month', { month: date.slice(0, 7) }), date);
  assert.equal(va.count, 2); assert.deepEqual(va.participants.map((p) => p.name), ['あや', 'ぼん']);

  const la = await post(a.cookie, 'morning-leave', { date });
  assert.equal(la.status, 200); assert.equal(la.body.day.count, 1);
  const vb2 = dayOf(await get(b.cookie, 'morning-month', { month: date.slice(0, 7) }), date);
  assert.equal(vb2.count, 1); assert.deepEqual(vb2.participants.map((p) => p.name), ['ぼん']);

  await post(b.cookie, 'morning-leave', { date });
  const none = dayOf(await get(b.cookie, 'morning-month', { month: date.slice(0, 7) }), date);
  assert.equal(none, undefined, '全員が取り消すと、また「開催予定なし」');
});

test('同じ会員の二重参加はできない（連打・同時送信でも1人分）', async () => {
  const date = day(4);
  const a = await member('あや');
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => post(a.cookie, 'morning-join', { date })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(rs.filter((r) => !r.body.alreadyJoined).length, 1, '新規に参加できたのは1回だけ');
  assert.equal(await store.countEventParticipants(`morning-${date}`), 1);
  assert.equal((await post(a.cookie, 'morning-leave', { date })).body.alreadyLeft, false);
  assert.equal((await post(a.cookie, 'morning-leave', { date })).body.alreadyLeft, true, '参加していないのに取消しても、何も壊れない');
});

test('最初の複数人が同時に参加表明しても、その日のイベントは1件・参加者は全員', async () => {
  const date = day(5);
  const ms = await Promise.all(['い1', 'い2', 'い3', 'い4', 'い5'].map((n) => member(n)));
  const rs = await Promise.all(ms.map((m) => post(m.cookie, 'morning-join', { date })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(await store.countEventParticipants(`morning-${date}`), 5);
  const events = (await store.listEvents('haku')).filter((e) => e.id === `morning-${date}`);
  assert.equal(events.length, 1, 'イベントは1件だけ');
});

test('過去日・不正な日付・先すぎる日は参加表明も取消もできない（今日はできる）', async () => {
  const a = await member('あや');
  const yesterday = addDays(today, -1);
  const p = await post(a.cookie, 'morning-join', { date: yesterday });
  assert.equal(p.status, 409); assert.equal(p.body.code, 'past');
  assert.equal(await store.getEvent(`morning-${yesterday}`), null, '過去日のイベントは作られない');
  assert.equal((await post(a.cookie, 'morning-leave', { date: yesterday })).status, 409);
  for (const bad of ['', 'abc', '2026-02-30', '2026-13-01', '20261001', "2026-10-01'; DROP", undefined]) {
    assert.equal((await post(a.cookie, 'morning-join', { date: bad })).status, 400, String(bad));
  }
  assert.equal((await post(a.cookie, 'morning-join', { date: day(MORNING_CONFIG.maxDaysAhead + 1) })).status, 409);
  assert.equal((await post(a.cookie, 'morning-join', { date: today })).status, 200, '今日は参加できる');
  assert.equal(joinBlock(today), null); assert.equal(leaveBlock(today), null);
  assert.equal(isValidDate('2028-02-29'), true); assert.equal(isValidDate('2027-02-29'), false);
  assert.equal(monthDates('2026-02').length, 28);
});

test('参加者の表示は表示名とアイコンIDだけ。氏名・メールアドレスは他の会員に出ない', async () => {
  const date = day(6);
  const a = await member('あや'); const b = await member('ぼん');
  await post(a.cookie, 'morning-join', { date });
  const r = await get(b.cookie, 'morning-month', { month: date.slice(0, 7) });
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes('@example.com') && !text.includes('氏名') && !text.includes('しめい'), text);
  assert.deepEqual(Object.keys(dayOf(r, date).participants[0]).sort(), ['avatarId', 'me', 'name']);
});

test('有効な会員だけが使える（未ログイン401・未入会/解約済み403）。解約済みの人は参加者に出ない', async () => {
  const date = day(7);
  assert.equal((await get('', 'morning-month')).status, 401);
  assert.equal((await post('', 'morning-join', { date })).status, 401);
  const none = await member('なし', { status: null });
  assert.equal((await post(none.cookie, 'morning-join', { date })).status, 403);
  const a = await member('あや'); const c = await member('かい');
  await post(a.cookie, 'morning-join', { date }); await post(c.cookie, 'morning-join', { date });
  await store.setMembership('haku', c.email, { status: 'canceled' });
  const r = await get(a.cookie, 'morning-month', { month: date.slice(0, 7) });
  assert.deepEqual(dayOf(r, date).participants.map((p) => p.name), ['あや']);
  assert.equal((await post(c.cookie, 'morning-join', { date })).status, 403);
  await store.setMembership('haku', c.email, { status: 'canceling' });
  const r2 = await get(a.cookie, 'morning-month', { month: date.slice(0, 7) });
  assert.equal(dayOf(r2, date).count, 2, '解約予約中は、まだ会員');
});

test('ホーム用 morning-next：自分が参加予定の直近を優先、なければ開催予定の直近', async () => {
  const a = await member('あや'); const b = await member('ぼん');
  const d1 = day(20), d2 = day(25);
  await post(a.cookie, 'morning-join', { date: d1 });
  await post(b.cookie, 'morning-join', { date: d2 });
  const na = await get(a.cookie, 'morning-next');
  const nb = await get(b.cookie, 'morning-next');
  assert.equal(na.body.next.date <= d1, true);
  assert.equal(nb.body.next.joined, true); assert.equal(nb.body.next.date, d2, '自分が参加予定の日を優先');
  const c = await member('ちよ');
  const nc = await get(c.cookie, 'morning-next');
  assert.equal(nc.body.next.joined, false); assert.ok(nc.body.next.count >= 1);
});

test('月の範囲外・不正な月は断る', async () => {
  const a = await member('あや');
  assert.equal((await get(a.cookie, 'morning-month', { month: '2020-01' })).status, 400);
  assert.equal((await get(a.cookie, 'morning-month', { month: '2099-01' })).status, 400);
  assert.equal((await get(a.cookie, 'morning-month', { month: 'bad' })).status, 400);
});

test('既存イベント機能との整合：日ごとの朝の集まりは events-list に混ざらず、events-join/leave では操作できない', async () => {
  const date = day(8);
  const a = await member('あや');
  await post(a.cookie, 'morning-join', { date });
  const list = await get(a.cookie, 'events-list');
  assert.equal(list.body.events.some((e) => e.id === `morning-${date}`), false);
  assert.equal((await post(a.cookie, 'events-join', { eventId: `morning-${date}` })).status, 400);
  assert.equal((await post(a.cookie, 'events-leave', { eventId: `morning-${date}` })).status, 400);
  // 通常のイベント（管理者が作る）の予約・取消は従来どおり
  const ev = await store.createEvent('haku', { type: 'meet', title: '秋の集まり', startsAt: new Date(Date.now() + 5 * 86400000).toISOString(), capacity: 2 });
  assert.equal((await post(a.cookie, 'events-join', { eventId: ev.id })).status, 200);
  const l2 = await get(a.cookie, 'events-list');
  assert.equal(l2.body.events.find((e) => e.id === ev.id).joined, true);
  assert.equal((await post(a.cookie, 'events-leave', { eventId: ev.id })).status, 200);
});

test('管理画面：参加者がいる日だけ表示（会員画面と同じデータ）。運営が中止にすると参加できない', async () => {
  const date = day(9);
  const a = await member('あや'); const b = await member('ぼん');
  const admin = `ht_admin_session=${await store.createAdminSession({ actorId: 'admin@example.com', role: 'super_admin' })}`;
  const before = await call(adminHandler, admin, 'events-list');
  assert.equal(before.body.events.some((e) => e.id === `morning-${date}`), false);
  await post(a.cookie, 'morning-join', { date });
  const mid = await call(adminHandler, admin, 'events-list');
  const ev = mid.body.events.find((e) => e.id === `morning-${date}`);
  assert.ok(ev); assert.equal(ev.participantCount, 1); assert.equal(ev.title, '朝の集まり'); assert.equal(ev.allDay, true);
  const upd = await call(adminHandler, admin, 'events-update', { method: 'POST', body: { id: ev.id, registration: 'cancelled' } });
  assert.equal(upd.status, 200);
  const jb = await post(b.cookie, 'morning-join', { date });
  assert.equal(jb.status, 409); assert.equal(jb.body.code, 'cancelled');
  const v = dayOf(await get(b.cookie, 'morning-month', { month: date.slice(0, 7) }), date);
  assert.equal(v.status, 'cancelled');
  await post(a.cookie, 'morning-leave', { date });
  const after = await call(adminHandler, admin, 'events-list');
  assert.equal(after.body.events.some((e) => e.id === `morning-${date}`), false, '参加者が0人になった日は、管理画面にも出ない');
});

/* ═════════ プロフィール画像 ═════════ */
function crcTable() { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; }
const CRC = crcTable();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x7f);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function jpeg(w, h) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]), sof, Buffer.from([0xff, 0xd9])]);
}
function webp(w, h, { animated = false } = {}) {
  const body = Buffer.alloc(30); body.write('WEBP', 0, 'ascii');
  if (animated) { body.write('VP8X', 4, 'ascii'); body.writeUInt32LE(10, 8); body[12] = 0x02; body.writeUIntLE(w - 1, 16, 3); body.writeUIntLE(h - 1, 19, 3); }
  else { body.write('VP8 ', 4, 'ascii'); body.writeUInt32LE(10, 8); body.writeUInt16LE(w, 18); body.writeUInt16LE(h, 20); }
  const head = Buffer.alloc(8); head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
const url = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

test('画像検査：JPEG・PNG・WebPの正方形だけ通す', () => {
  assert.equal(parseAvatarDataUrl(url('image/png', png(64, 64))).mime, 'image/png');
  assert.equal(parseAvatarDataUrl(url('image/jpeg', jpeg(256, 256))).width, 256);
  assert.equal(parseAvatarDataUrl(url('image/webp', webp(128, 128))).height, 128);
});
test('画像検査：SVG・GIF・HTML・形式の偽装・巨大・極小・動くWebP・外部URLは拒否', () => {
  const bad = (v) => assert.throws(() => parseAvatarDataUrl(v), AvatarError, String(v).slice(0, 40));
  bad('data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64'));
  bad('data:image/gif;base64,' + Buffer.from('GIF89a').toString('base64'));
  bad('data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64'));
  bad(url('image/png', Buffer.from('<script>alert(1)</script>')));                // 宣言はPNGだが中身はHTML
  bad(url('image/jpeg', png(64, 64)));                                            // 宣言と中身が違う
  bad(url('image/png', png(8, 8)));                                               // 小さすぎる
  bad(url('image/png', png(2000, 2000).subarray(0, 60)));                         // 大きすぎる縦横（ヘッダだけ）
  bad(url('image/webp', webp(128, 128, { animated: true })));                     // 動く画像
  bad('https://example.com/a.png');                                               // 外部URL
  bad('//evil.example/a.png'); bad(''); bad(null); bad(undefined); bad({ a: 1 });
  bad('data:image/png;base64,' + 'A'.repeat(400000));                             // 容量オーバー
  bad('data:image/png;base64,@@@@');                                              // base64でない
});

test('プロフィール画像：保存→他の会員にも表示→変更→削除（初期状態に戻る）', async () => {
  const date = day(10);
  const a = await member('あや'); const b = await member('ぼん');
  assert.equal((await get(a.cookie, 'me')).body.avatarId, null, '最初は未設定（頭文字表示）');
  const set = await post(a.cookie, 'avatar-set', { image: url('image/jpeg', jpeg(256, 256)) });
  assert.equal(set.status, 200); assert.match(set.body.avatarId, /^[a-f0-9]{16}$/);
  const id1 = set.body.avatarId;
  assert.equal((await get(a.cookie, 'me')).body.avatarId, id1, '再読み込み後も維持（保存されている）');
  assert.equal((await store.getUser(a.email)).avatarId, id1, '正は User.avatarId の1か所');

  // 朝の集まりの参加者アイコン：同じ avatarId を使う
  await post(a.cookie, 'morning-join', { date });
  const seen = dayOf(await get(b.cookie, 'morning-month', { month: date.slice(0, 7) }), date).participants[0];
  assert.equal(seen.avatarId, id1);

  // 画像そのものは、ログイン中の会員だけが取得でき、安全なヘッダ付きで返る
  const img = await get(b.cookie, 'avatar', { id: id1 });
  assert.equal(img.status, 200); assert.equal(img.headers['content-type'], 'image/jpeg');
  assert.equal(img.headers['x-content-type-options'], 'nosniff');
  assert.match(img.headers['content-security-policy'], /default-src 'none'/);
  assert.ok(img.raw.length > 10 && img.raw[0] === 0xff);
  assert.equal((await get('', 'avatar', { id: id1 })).status, 401, '未ログインでは取得できない');
  assert.equal((await get(b.cookie, 'avatar', { id: '../../etc/passwd' })).status, 404);
  assert.equal((await get(b.cookie, 'avatar', { id: 'ffffffffffffffff' })).status, 404);

  // 変更：古い画像は消え、新しいIDになる
  const set2 = await post(a.cookie, 'avatar-set', { image: url('image/png', png(64, 64)) });
  const id2 = set2.body.avatarId;
  assert.notEqual(id2, id1);
  assert.equal((await get(b.cookie, 'avatar', { id: id1 })).status, 404, '古い画像は残らない');
  assert.equal((await get(b.cookie, 'avatar', { id: id2 })).headers['content-type'], 'image/png');

  // 削除：初期状態に戻る（参加者表示も頭文字に）
  const del = await post(a.cookie, 'avatar-delete', {});
  assert.equal(del.status, 200); assert.equal(del.body.avatarId, null);
  assert.equal((await get(a.cookie, 'me')).body.avatarId, null);
  assert.equal((await get(b.cookie, 'avatar', { id: id2 })).status, 404);
  const seen2 = dayOf(await get(b.cookie, 'morning-month', { month: date.slice(0, 7) }), date).participants[0];
  assert.equal(seen2.avatarId, null);
  assert.equal((await post(a.cookie, 'avatar-delete', {})).status, 200, '未設定での削除も安全');
});

test('プロフィール画像：不正な入力は400で、保存済みの画像・ユーザー情報に影響しない', async () => {
  const a = await member('あや');
  const good = await post(a.cookie, 'avatar-set', { image: url('image/png', png(64, 64)) });
  for (const image of ['data:image/svg+xml;base64,PHN2Zy8+', 'https://example.com/x.png', url('image/png', Buffer.from('not an image')), '', undefined, 123]) {
    const r = await post(a.cookie, 'avatar-set', { image });
    assert.equal(r.status, 400, String(image).slice(0, 30));
  }
  assert.equal((await get(a.cookie, 'me')).body.avatarId, good.body.avatarId, '失敗しても元の画像のまま');
  assert.equal((await post('', 'avatar-set', { image: url('image/png', png(64, 64)) })).status, 401);
  const none = await member('なし', { status: null });
  assert.equal((await post(none.cookie, 'avatar-set', { image: url('image/png', png(64, 64)) })).status, 403);
});

test('表示名の変更（既存のプロフィール更新API）：表示名だけ変えられ、パスワードのハッシュ等は変わらない', async () => {
  const a = await member('あや');
  const before = await store.getUser(a.email);
  const r = await post(a.cookie, 'update-profile', { displayName: 'あやこ' });
  assert.equal(r.status, 200); assert.equal(r.body.displayName, 'あやこ');
  const after = await store.getUser(a.email);
  assert.equal(after.passwordHash, before.passwordHash); assert.equal(after.fullName, before.fullName);
  assert.equal((await post(a.cookie, 'update-profile', { displayName: '   ' })).status, 400);
});

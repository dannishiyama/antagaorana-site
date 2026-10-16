/**
 * ポイント利用申請（社会貢献）のテスト：api/_lib/donation.js ＋ donation-admin.js ＋ community-auth.js / admin.js の経路。
 * メモリ上のRedisだけを使う（本物には接続しない。メールも実際には送らない）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import * as store from '../api/_lib/store.redis.js';

store.__setRedisForTests(new RedisMock({ host: 'mock-donation', port: 6379 }));
process.env.VERCEL_ENV = 'preview';
delete process.env.DONATION_ENABLED;
const { default: authHandler } = await import('../api/community-auth.js');
const { default: adminHandler } = await import('../api/admin.js');
const P = await import('../api/_lib/points.js');
const D = await import('../api/_lib/donation.js');
const { deps: mailDeps } = await import('../api/_lib/donation-mail.js');

const sent = [];
mailDeps.send = async (m) => { sent.push(m); return { data: { id: 'x' } }; };

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
  const n = ++ipSeq; const ip = `10.9.${(n >> 8) & 255}.${n & 255}`;
  const res = fakeRes();
  await handler({ method, query: { action, ...query }, body, headers: { cookie: cookie || '', host: 'example.test', origin, 'x-forwarded-for': ip }, socket: { remoteAddress: ip } }, res);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}
const mem = (cookie, action, opts) => call(authHandler, cookie, action, opts);
const adm = (cookie, action, opts) => call(adminHandler, cookie, action, opts);
const admPost = (cookie, action, body, opts) => adm(cookie, action, { method: 'POST', body, ...opts });
let seq = 0;
async function member({ points = 1350, membership = 'active', name = 'テスト会員' } = {}) {
  const email = `d${++seq}_${Date.now()}@example.com`;
  await store.saveUser({ email, displayName: name, fullName: name, fullNameKana: 'てすと' });
  await store.createApplication('haku', { email, fullName: name, fullNameKana: 'てすと', displayName: name });
  await store.resolveApplication('haku', email, 'approved', 'test');
  if (membership) await store.setMembership('haku', email, { status: membership });
  if (points > 0) await P.grantPoints({ email, amount: points, reason: 'テスト', actorId: 'admin@example.com', requestId: `g-${seq}-${Date.now()}` });
  return { email, cookie: `ht_session=${await store.createSession(email)}` };
}
const adminCookie = async (role = 'super_admin') => `ht_admin_session=${await store.createAdminSession({ actorId: 'admin@example.com', role })}`;
let rseq = 0; const rid = () => `req-${Date.now()}-${++rseq}-${Math.random().toString(36).slice(2, 8)}`;
const create = (m, body = {}) => mem(m.cookie, 'donation-create', { method: 'POST', body: { causeId: 'india', requestId: rid(), ...body } });
const bal = (m) => P.getBalance(m.email);

test('申請：1,350ptから1,000pt申請 → 利用できるポイントは350pt。確保が台帳に残り、申請中になる', async () => {
  const m = await member();
  const r = await create(m);
  assert.equal(r.status, 200); assert.equal(r.body.request.status, 'pending'); assert.equal(r.body.request.points, 1000); assert.equal(r.body.balance, 350);
  assert.equal(await bal(m), 350);
  const v = (await mem(m.cookie, 'points-me')).body;
  assert.equal(v.balance, 350);
  assert.ok(v.entries.some((e) => e.kind === 'donation_hold' && e.delta === -1000 && /確保/.test(e.kindLabel)));
  const mine = (await mem(m.cookie, 'donation-mine')).body.requests;
  assert.deepEqual([mine.length, mine[0].statusLabel], [1, '申請中']);
  assert.equal((await mem(m.cookie, 'donation-config')).body.balance, 350);
});

test('残高不足では申請できない（何も作られず、ポイントも変わらない）', async () => {
  const m = await member({ points: 999 });
  const r = await create(m);
  assert.equal(r.status, 409); assert.equal(r.body.code, 'insufficient');
  assert.equal(await bal(m), 999);
  assert.equal((await mem(m.cookie, 'donation-mine')).body.requests.length, 0);
  const none = await member({ points: 0 });
  assert.equal((await create(none)).status, 409);
});

test('不正な値：支援先が存在しない／操作IDが不正／ポイント数はサーバーが決める（画面から変えられない）', async () => {
  const m = await member();
  assert.equal((await create(m, { causeId: 'nonexistent' })).status, 409);
  assert.equal((await create(m, { requestId: 'x' })).status, 400);
  const r = await create(m, { points: 1, amount: 1, delta: 1 });
  assert.equal(r.body.request.points, 1000, '送られた値は無視される');
  assert.equal(await bal(m), 350);
});

test('同時申請でも二重利用できない（1,350ptで3並列 → 1件だけ。2,000ptで3並列 → 2件）', async () => {
  const a = await member({ points: 1350 });
  const rs = await Promise.all([create(a), create(a), create(a)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(await bal(a), 350);
  assert.equal((await mem(a.cookie, 'donation-mine')).body.requests.length, 1);
  const b = await member({ points: 2000 });
  const rs2 = await Promise.all([create(b), create(b), create(b)]);
  assert.deepEqual(rs2.map((r) => r.status).sort(), [200, 200, 409]);
  assert.equal(await bal(b), 0);
});

test('冪等：同じ操作IDの再送・連打は、1件だけ（確保も1回）。同じ操作IDで別の支援先は拒否', async () => {
  const m = await member({ points: 5000 });
  const body = { causeId: 'india', requestId: rid() };
  const rs = await Promise.all([1, 2, 3, 4].map(() => mem(m.cookie, 'donation-create', { method: 'POST', body })));
  assert.ok(rs.every((r) => r.status === 200 || r.status === 409));
  const ok = rs.filter((r) => r.status === 200);
  assert.ok(ok.length >= 1 && new Set(ok.map((r) => r.body.request.id)).size === 1, '同じ申請ID');
  assert.equal(await bal(m), 4000);
  const again = await mem(m.cookie, 'donation-create', { method: 'POST', body });
  assert.deepEqual([again.status, again.body.duplicate, await bal(m)], [200, true, 4000]);
  const other = await D.saveCause({ name: 'テスト用の別の支援先', status: 'published', actorId: 't' });
  const conflict = await mem(m.cookie, 'donation-create', { method: 'POST', body: { causeId: other.id, requestId: body.requestId } });
  assert.equal(conflict.status, 409);
  assert.equal(await bal(m), 4000);
});

test('支援先：停止すると選べない／公開中だけが会員に出る／既存の申請は支援先名を保持', async () => {
  const m = await member({ points: 3000 });
  const c = await D.saveCause({ name: '新しい支援先（テスト）', status: 'published', actorId: 't' });
  assert.ok((await mem(m.cookie, 'donation-config')).body.causes.some((x) => x.id === c.id));
  const r = await create(m, { causeId: c.id });
  assert.equal(r.status, 200);
  await D.saveCause({ id: c.id, name: '新しい支援先（テスト）', status: 'stopped', actorId: 't' });
  assert.ok(!(await mem(m.cookie, 'donation-config')).body.causes.some((x) => x.id === c.id));
  assert.equal((await create(m, { causeId: c.id })).status, 409);
  assert.equal((await mem(m.cookie, 'donation-mine')).body.requests.find((x) => x.id === r.body.request.id).causeName, '新しい支援先（テスト）');
});

test('却下：確保が解除されポイントが戻る。二重に解除されない。理由は必須。承認後の却下は不可', async () => {
  const m = await member(); const c = await adminCookie();
  const id = (await create(m)).body.request.id;
  assert.equal((await admPost(c, 'donation-reject', { id, reason: '' })).status, 400);
  assert.equal(await bal(m), 350);
  const rj = await admPost(c, 'donation-reject', { id, reason: '内容の確認ができないため' });
  assert.equal(rj.status, 200); assert.equal(rj.body.request.status, 'rejected'); assert.equal(rj.body.request.holdState, 'released');
  assert.equal(await bal(m), 1350);
  const again = await admPost(c, 'donation-reject', { id, reason: '再送' });
  assert.deepEqual([again.status, again.body.duplicate, await bal(m)], [200, true, 1350]);
  const view = (await mem(m.cookie, 'points-me')).body;
  assert.ok(view.entries.some((e) => e.kind === 'donation_release' && e.delta === 1000), '履歴は消えず、解除が追記される');
  assert.ok(view.entries.some((e) => e.kind === 'donation_hold'));
  assert.equal((await admPost(c, 'donation-approve', { id })).status, 409, '却下済みは承認できない');
  const mine = (await mem(m.cookie, 'donation-mine')).body.requests[0];
  assert.ok(!('rejectReason' in mine) && !('memo' in mine) && !('transfer' in mine));
});

test('取消（未処理）：確保が解除される。承認後は通常の取消ではできず、例外処理（理由＋申請IDの確認）が必要', async () => {
  const m = await member(); const c = await adminCookie();
  const a = (await create(m)).body.request.id;
  assert.equal((await admPost(c, 'donation-cancel', { id: a, reason: '会員からの依頼' })).body.request.status, 'cancelled');
  assert.equal(await bal(m), 1350);
  const b = (await create(m)).body.request.id;
  await admPost(c, 'donation-approve', { id: b });
  assert.equal((await admPost(c, 'donation-cancel', { id: b, reason: 'x' })).status, 409, '承認後は通常の取消不可');
  assert.equal((await admPost(c, 'donation-exception-cancel', { id: b, reason: '', confirm: b })).status, 400);
  assert.equal((await admPost(c, 'donation-exception-cancel', { id: b, reason: '誤承認', confirm: 'DN-wrong' })).status, 400);
  assert.equal(await bal(m), 350);
  const ex = await admPost(c, 'donation-exception-cancel', { id: b, reason: '誤って承認したため', confirm: b });
  assert.equal(ex.status, 200); assert.equal(ex.body.request.cancelledAfterApproval, true);
  assert.equal(await bal(m), 1350);
  assert.equal((await admPost(c, 'donation-exception-cancel', { id: b, reason: '再送', confirm: b })).body.duplicate, true);
  assert.equal(await bal(m), 1350, '二重に戻らない');
});

test('承認→振込登録→振込完了。承認だけでは完了にならない。振込完了には日付・金額・振込先が必須', async () => {
  const m = await member(); const c = await adminCookie();
  const id = (await create(m)).body.request.id;
  const ap = await admPost(c, 'donation-approve', { id });
  assert.deepEqual([ap.body.request.status, ap.body.request.holdState, ap.body.request.statusLabel], ['approved', 'consumed', '承認済み・振込待ち']);
  assert.equal(await bal(m), 350, '承認しても残高は変わらない（確保が利用に確定）');
  assert.equal((await admPost(c, 'donation-approve', { id })).body.duplicate, true);
  assert.equal((await mem(m.cookie, 'donation-mine')).body.requests[0].statusLabel, '承認済み・振込待ち');
  const early = await admPost(c, 'donation-complete', { id });
  assert.equal(early.status, 409); assert.equal(early.body.code, 'transfer_required');
  for (const bad of [{ amountYen: 0 }, { amountYen: -5 }, { amountYen: 1.5 }, { amountYen: 'abc' }, { date: '2026-02-30' }, { date: '' }, { destination: '' }]) {
    const r = await admPost(c, 'donation-transfer', { id, amountYen: 3000, date: '2026-10-31', destination: '（テスト）寄付先', reference: 'REF-1', ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await admPost(c, 'donation-complete', { id })).status, 409, '不正な登録では完了にならない');
  const reg = await admPost(c, 'donation-transfer', { id, amountYen: 3000, date: '2026-10-31', destination: '（テスト）寄付先', reference: 'REF-1' });
  assert.equal(reg.status, 200); assert.equal(reg.body.request.status, 'approved', '登録だけでは完了にならない');
  const done = await admPost(c, 'donation-complete', { id });
  assert.deepEqual([done.status, done.body.request.status, done.body.request.statusLabel], [200, 'completed', '振込完了']);
  assert.equal((await admPost(c, 'donation-complete', { id })).body.duplicate, true);
  assert.equal(await bal(m), 350);
  assert.equal((await admPost(c, 'donation-exception-cancel', { id, reason: 'x', confirm: id })).status, 409, '振込完了後はこの操作で戻せない');
  const mine = (await mem(m.cookie, 'donation-mine')).body.requests[0];
  assert.ok(!JSON.stringify(mine).includes('3000') && !('transfer' in mine), '会員には金額・振込先を見せない');
  const detail = (await adm(c, 'donation-detail', { query: { id } })).body;
  assert.deepEqual(detail.log.map((l) => l.type).filter((t) => !t.startsWith('mail')), ['created', 'approved', 'transfer_registered', 'completed']);
});

test('権限：一般会員・未ログインは管理操作できない／他会員の申請は見えず操作もできない／会員でない人は申請できない', async () => {
  const a = await member(); const b = await member(); const c = await adminCookie();
  const id = (await create(a)).body.request.id;
  for (const action of ['donation-approve', 'donation-reject', 'donation-complete', 'donation-cancel', 'donation-transfer']) {
    assert.equal((await admPost(a.cookie, action, { id, reason: 'x' })).status, 401, action);
    assert.equal((await admPost('', action, { id, reason: 'x' })).status, 401, action);
  }
  assert.equal((await adm(a.cookie, 'donation-list')).status, 401);
  assert.equal((await adm(a.cookie, 'donation-csv')).status, 401);
  assert.equal((await mem(b.cookie, 'donation-mine')).body.requests.length, 0, '他会員の申請は見えない');
  const canceled = await member({ membership: 'canceled' });
  assert.equal((await create(canceled)).status, 403);
  assert.equal((await mem('', 'donation-mine')).status, 401);
  assert.equal((await mem(a.cookie, 'donation-create', { method: 'GET' })).status, 405);
  assert.equal((await mem(a.cookie, 'donation-create', { method: 'POST', body: { causeId: 'india', requestId: rid() }, origin: 'https://evil.example' })).status, 403);
  assert.equal((await adm(c, 'donation-list')).status, 200);
  const mod = await adminCookie('community_moderator');
  assert.equal((await admPost(mod, 'donation-cause-save', { name: 'x', status: 'published' })).status, 403, '支援先の変更は最高管理者のみ');
  assert.equal((await admPost(c, 'donation-approve', { id: 'DN-00000000-ZZZZZZ' })).status, 404);
  assert.equal((await admPost(c, 'donation-approve', { id: '../../etc' })).status, 404);
});

test('通常の「取消」では、確保・解除の履歴を直接戻せない（申請管理からだけ）', async () => {
  const m = await member(); const c = await adminCookie();
  await create(m);
  const e = (await adm(c, 'points-member', { query: { email: m.email } })).body.entries.find((x) => x.kind === 'donation_hold');
  const r = await admPost(c, 'points-reverse', { entryId: e.id, reason: 'テスト', requestId: rid() });
  assert.equal(r.status, 409);
  assert.equal(await bal(m), 350);
});

test('通知：申請受付・運営への通知・承認・却下・振込完了が1回ずつ送られる。重複しない', async () => {
  sent.length = 0;
  const m = await member(); const c = await adminCookie();
  const id = (await create(m)).body.request.id;
  assert.equal(sent.length, 2);
  assert.ok(sent.some((x) => x.to[0] === m.email && /受け付けました/.test(x.subject)));
  assert.ok(sent.some((x) => x.to[0] !== m.email && /新しい申請/.test(x.subject)));
  await admPost(c, 'donation-approve', { id }); await admPost(c, 'donation-approve', { id });
  assert.equal(sent.filter((x) => /承認されました/.test(x.subject)).length, 1);
  await admPost(c, 'donation-transfer', { id, amountYen: 1200, date: '2026-10-31', destination: '（テスト）' });
  await admPost(c, 'donation-complete', { id }); await admPost(c, 'donation-complete', { id });
  assert.equal(sent.filter((x) => /寄付が完了/.test(x.subject)).length, 1);
  const m2 = await member(); const id2 = (await create(m2)).body.request.id;
  await admPost(c, 'donation-reject', { id: id2, reason: 'テスト' });
  assert.equal(sent.filter((x) => /について/.test(x.subject) && x.to[0] === m2.email).length, 1);
  assert.ok(sent.every((x) => !/円|寄附金控除|控除/.test(x.text)), '金額や控除に触れない');
});

test('メール送信に失敗しても、申請・ポイント・振込の記録は消えない（失敗は履歴に残る）', async () => {
  const saved = mailDeps.send;
  mailDeps.send = async () => { throw new Error('smtp down'); };
  try {
    const m = await member(); const c = await adminCookie();
    const r = await create(m);
    assert.equal(r.status, 200);
    const id = r.body.request.id;
    assert.equal(await bal(m), 350);
    assert.equal((await admPost(c, 'donation-approve', { id })).status, 200);
    await admPost(c, 'donation-transfer', { id, amountYen: 500, date: '2026-10-31', destination: '（テスト）' });
    assert.equal((await admPost(c, 'donation-complete', { id })).body.request.status, 'completed');
    const log = (await adm(c, 'donation-detail', { query: { id } })).body.log;
    assert.ok(log.some((l) => l.type === 'mail_failed'));
    assert.equal((await mem(m.cookie, 'donation-mine')).body.requests[0].status, 'completed');
  } finally { mailDeps.send = saved; }
});

test('一覧・検索・絞り込み・並び替え・集計・CSV（数式の無害化）', async () => {
  const m = await member({ points: 4000, name: '=SUM(1)検索用' }); const c = await adminCookie();
  const ids = []; for (let i = 0; i < 3; i++) ids.push((await create(m)).body.request.id);
  await admPost(c, 'donation-approve', { id: ids[0] });
  await admPost(c, 'donation-note', { id: ids[1], memo: '@メモ,カンマ"引用"' });
  await admPost(c, 'donation-reject', { id: ids[2], reason: 'テスト' });
  const all = (await adm(c, 'donation-list', { query: { q: m.email } })).body;
  assert.equal(all.requests.length, 3);
  assert.equal((await adm(c, 'donation-list', { query: { q: m.email, status: 'approved' } })).body.requests.length, 1);
  assert.equal((await adm(c, 'donation-list', { query: { q: ids[1].toLowerCase() } })).body.requests[0].id, ids[1], '申請IDで検索');
  assert.equal((await adm(c, 'donation-list', { query: { q: m.email, sort: 'old' } })).body.requests[0].id, ids[0]);
  const s = all.summary.find((x) => x.causeId === 'india');
  assert.ok(s.statuses.approved.count >= 1 && s.totalPoints >= 2000);
  const csv = (await adm(c, 'donation-csv', { query: { q: m.email } }));
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.ok(String(csv.body).startsWith('﻿申請ID,会員名'));
  assert.ok(String(csv.body).includes("'=SUM(1)検索用") && String(csv.body).includes(`"'@メモ,カンマ""引用"""`), '数式として実行されない・正しくエスケープされる');
  assert.equal(String(csv.body).trim().split('\r\n').length, 4);
  assert.equal((await adm(c, 'donation-list', { query: { from: '2099-01-01' } })).body.requests.length, 0, '期間で絞り込み');
});

test('本番では、DONATION_ENABLED=1 になるまで、申請を受け付けない（会員・管理とも）', async () => {
  const m = await member(); const c = await adminCookie();
  process.env.VERCEL_ENV = 'production';
  try {
    assert.deepEqual((await mem(m.cookie, 'donation-config')).body, { ok: true, enabled: false });
    assert.equal((await create(m)).status, 403);
    assert.equal((await adm(c, 'donation-list')).status, 403);
    assert.equal(await bal(m), 1350);
    process.env.DONATION_ENABLED = '1';
    assert.equal((await mem(m.cookie, 'donation-config')).body.enabled, true);
  } finally { process.env.VERCEL_ENV = 'preview'; delete process.env.DONATION_ENABLED; }
});

test('既存機能：ポイント付与・目標設定・履歴は、申請の前後で壊れない／灯のキーとは別', async () => {
  const m = await member({ points: 1100 });
  await mem(m.cookie, 'points-goal-set', { method: 'POST', body: { goal: 500 } });
  await create(m);
  await P.grantPoints({ email: m.email, amount: 10, reason: '付与', actorId: 'admin@example.com', requestId: rid() });
  const v = (await mem(m.cookie, 'points-me')).body;
  assert.deepEqual([v.balance, v.goal, v.total], [110, 500, 3]);
  const keys = await store.getRedis().keys('ht:donation:*');
  assert.ok(keys.length > 0 && keys.every((k) => !k.includes('salon')));
});

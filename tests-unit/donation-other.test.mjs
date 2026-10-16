/**
 * 支援先の拡張のテスト：運営が登録する支援先（登録・編集・公開／非公開／受付停止・表示順）と、会員の「その他の支援先」（運営の承認が必要）。
 * メモリ上のRedisだけを使う。ポイント・申請・却下の処理は、既存の donation.test.mjs と同じ仕組みを共有している。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import * as store from '../api/_lib/store.redis.js';

store.__setRedisForTests(new RedisMock({ host: 'mock-donation-other', port: 6379 }));
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
  const n = ++ipSeq; const ip = `10.11.${(n >> 8) & 255}.${n & 255}`;
  const res = fakeRes();
  await handler({ method, query: { action, ...query }, body, headers: { cookie: cookie || '', host: 'example.test', origin, 'x-forwarded-for': ip }, socket: { remoteAddress: ip } }, res);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}
const mem = (c, a, o) => call(authHandler, c, a, o);
const adm = (c, a, o) => call(adminHandler, c, a, o);
const admPost = (c, a, b) => adm(c, a, { method: 'POST', body: b });
let seq = 0;
async function member({ points = 1350, membership = 'active' } = {}) {
  const email = `o${++seq}_${Date.now()}@example.com`;
  await store.saveUser({ email, displayName: '希望会員', fullName: '希望会員', fullNameKana: 'きぼう' });
  await store.createApplication('haku', { email, fullName: '希望会員', fullNameKana: 'きぼう', displayName: '希望会員' });
  await store.resolveApplication('haku', email, 'approved', 'test');
  if (membership) await store.setMembership('haku', email, { status: membership });
  if (points > 0) await P.grantPoints({ email, amount: points, reason: 'テスト', actorId: 'admin@example.com', requestId: `go-${seq}-${Date.now()}` });
  return { email, cookie: `ht_session=${await store.createSession(email)}` };
}
const adminCookie = async (role = 'super_admin') => `ht_admin_session=${await store.createAdminSession({ actorId: 'admin@example.com', role })}`;
let rseq = 0; const rid = () => `oreq-${Date.now()}-${++rseq}-${Math.random().toString(36).slice(2, 8)}`;
const create = (m, body = {}) => mem(m.cookie, 'donation-create', { method: 'POST', body: { causeId: 'india', requestId: rid(), ...body } });
const createOther = (m, other = {}, extra = {}) => create(m, { causeId: 'other', other: { name: 'テスト教育基金（架空）', url: 'https://example.org/fund', reason: '学びの機会を届けたいため', ...other }, ...extra });
const bal = (m) => P.getBalance(m.email);

test('支援先の管理：登録・編集・公開／非公開／受付停止・表示順。会員側に動的に出る（HTMLの書き換え不要）', async () => {
  const c = await adminCookie();
  const m = await member();
  const a = (await admPost(c, 'donation-cause-save', { name: '新しい支援先A（テスト）', description: '説明A', url: 'https://example.org/a', status: 'published' })).body.cause;
  const b = (await admPost(c, 'donation-cause-save', { name: '新しい支援先B（テスト）', description: '', url: '', status: 'published' })).body.cause;
  let list = (await mem(m.cookie, 'donation-config')).body.causes;
  assert.deepEqual(list.map((x) => x.name), ['インドプロジェクトへの支援', '新しい支援先A（テスト）', '新しい支援先B（テスト）'], '登録順（表示順）で出る');
  assert.deepEqual([list[1].description, list[1].url], ['説明A', 'https://example.org/a']);
  await admPost(c, 'donation-cause-move', { id: b.id, dir: 'up' });
  list = (await mem(m.cookie, 'donation-config')).body.causes;
  assert.deepEqual(list.map((x) => x.name).slice(1), ['新しい支援先B（テスト）', '新しい支援先A（テスト）'], '表示順を変更できる');
  assert.equal((await admPost(c, 'donation-cause-move', { id: list[0].id, dir: 'up' })).status, 200, '先頭をさらに上へ：何も起きない');
  // 編集
  await admPost(c, 'donation-cause-save', { id: a.id, name: '支援先A（名称変更）', description: '新しい説明', url: '', status: 'published' });
  assert.equal((await mem(m.cookie, 'donation-config')).body.causes.find((x) => x.id === a.id).name, '支援先A（名称変更）');
  // 非公開・受付停止：会員の選択肢から消え、申請もできない
  for (const status of ['unpublished', 'stopped']) {
    await admPost(c, 'donation-cause-save', { id: a.id, name: '支援先A（名称変更）', description: '', url: '', status });
    assert.ok(!(await mem(m.cookie, 'donation-config')).body.causes.some((x) => x.id === a.id), status);
    const r = await create(m, { causeId: a.id });
    assert.deepEqual([r.status, r.body.code], [409, 'cause_unavailable']);
    assert.equal(await bal(m), 1350, '申請できないのでポイントは動かない');
  }
  assert.ok((await adm(c, 'donation-list')).body.causes.some((x) => x.id === a.id && x.status === 'stopped'), '管理画面には残る（削除はできない）');
  await admPost(c, 'donation-cause-save', { id: a.id, name: '支援先A（名称変更）', description: '', url: '', status: 'published' });
  assert.equal((await create(m, { causeId: a.id })).status, 200, '公開に戻すと申請できる');
});

test('支援先の入力検証：名称必須・URLはhttp/httpsのみ・javascript:等は拒否・権限は最高管理者のみ', async () => {
  const c = await adminCookie(); const mod = await adminCookie('community_moderator'); const m = await member();
  const save = (body, cookie = c) => admPost(cookie, 'donation-cause-save', { name: 'X', status: 'published', ...body });
  assert.equal((await save({ name: '' })).status, 400);
  assert.equal((await save({ status: 'deleted' })).status, 400);
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.org', 'http://user:pw@example.org', 'http://localhost', 'not a url', 'https://' + 'a'.repeat(250) + '.com']) assert.equal((await save({ url })).status, 400, url);
  assert.equal((await save({ id: 'nonexistent', name: 'x' })).status, 404);
  assert.equal((await save({ id: 'other', name: 'x' })).status, 404);
  assert.equal((await save({}, mod)).status, 403);
  assert.equal((await admPost(mod, 'donation-cause-move', { id: 'india', dir: 'down' })).status, 403);
  assert.equal((await admPost(m.cookie, 'donation-cause-save', { name: 'x', status: 'published' })).status, 401);
  assert.equal((await save({ name: '<script>alert(1)</script>', url: 'https://example.org/ok' })).status, 200, '文字は保存される（画面側でエスケープ）');
});

test('その他の支援先：入力検証（必須・長さ・URL）。不正なら申請されずポイントも動かない', async () => {
  const m = await member({ points: 3000 });
  for (const bad of [{ name: '' }, { name: '   ' }, { reason: '' }, { url: 'javascript:alert(1)' }, { url: 'ftp://x.example' }]) {
    const r = await createOther(m, bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await create(m, { causeId: 'other' })).status, 400, 'other未指定');
  assert.equal(await bal(m), 3000);
  assert.equal((await mem(m.cookie, 'donation-mine')).body.requests.length, 0);
  const long = await createOther(m, { name: 'あ'.repeat(200), reason: 'い'.repeat(1000) });
  assert.equal(long.status, 200);
  const rec = await D.getRequest(long.body.request.id);
  assert.deepEqual([rec.otherCause.name.length, rec.otherCause.reason.length], [60, 300], '長さは切り詰められる');
  const noUrl = await createOther(m, { url: '' });
  assert.equal((await D.getRequest(noUrl.body.request.id)).otherCause.url, '', 'URLは任意');
});

test('その他の支援先：申請でポイントが確保され、希望しただけでは支援先は登録・公開されない。会員には申請の確認中と出る', async () => {
  const m = await member();
  const before = (await D.listCauses()).length;
  const r = await createOther(m);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.request.causeKind, r.body.request.causeReview, r.body.request.causeName], ['other', 'pending', 'テスト教育基金（架空）']);
  assert.equal(await bal(m), 350);
  assert.equal((await D.listCauses()).length, before, '支援先の一覧には増えない');
  assert.ok(!(await mem(m.cookie, 'donation-config')).body.causes.some((c) => c.name === 'テスト教育基金（架空）'));
  const mine = (await mem(m.cookie, 'donation-mine')).body.requests[0];
  assert.ok(!('otherCause' in mine) && !('reason' in mine), '会員向けの一覧に、管理用の内容は含めない');
  assert.ok(sent.some((x) => /新しい申請/.test(x.subject) && /希望先のURL：https:\/\/example\.org\/fund/.test(x.text) && /支援したい理由：学びの機会/.test(x.text) && /希望先の確認/.test(x.text)));
});

test('希望先の確認：保留 → 承認 → 寄付申請の承認。希望先の承認前は、寄付申請を承認できない', async () => {
  const c = await adminCookie(); const m = await member();
  const id = (await createOther(m)).body.request.id;
  const early = await admPost(c, 'donation-approve', { id });
  assert.deepEqual([early.status, early.body.code], [409, 'cause_review_required']);
  const hold = await admPost(c, 'donation-cause-review', { id, decision: 'hold', note: '団体の確認中' });
  assert.deepEqual([hold.status, hold.body.request.causeReview, hold.body.request.status], [200, 'hold', 'pending']);
  assert.equal(await bal(m), 350, '保留中もポイントは確保されたまま');
  assert.equal((await admPost(c, 'donation-approve', { id })).status, 409, '保留中は承認できない');
  assert.equal((await admPost(c, 'donation-cause-review', { id, decision: 'hold' })).body.duplicate, true);
  const ok = await admPost(c, 'donation-cause-review', { id, decision: 'approve', note: '確認済み' });
  assert.deepEqual([ok.status, ok.body.request.causeReview, ok.body.request.status], [200, 'approved', 'pending']);
  assert.equal((await admPost(c, 'donation-cause-review', { id, decision: 'hold' })).status, 409, '承認後に保留へは戻せない');
  const names = (await D.listCauses()).map((x) => x.name);
  assert.ok(!names.includes('テスト教育基金（架空）'), '希望先を承認しても、自動で支援先の一覧に公開されない');
  const ap = await admPost(c, 'donation-approve', { id });
  assert.deepEqual([ap.status, ap.body.request.status, ap.body.request.holdState], [200, 'approved', 'consumed']);
  await admPost(c, 'donation-transfer', { id, amountYen: 2000, date: '2026-10-31', destination: '（テスト）寄付先' });
  assert.equal((await admPost(c, 'donation-complete', { id })).body.request.status, 'completed');
  assert.equal(await bal(m), 350);
  const log = (await adm(c, 'donation-detail', { query: { id } })).body.log.map((l) => l.type).filter((t) => !t.startsWith('mail'));
  assert.deepEqual(log, ['created', 'cause_hold', 'cause_approved', 'approved', 'transfer_registered', 'completed']);
});

test('希望先を却下：ポイント確保が解除されて戻る。二重に返還されない。承認済みの希望先は、ここでは却下できない', async () => {
  const c = await adminCookie(); const m = await member();
  const id = (await createOther(m)).body.request.id;
  assert.equal((await admPost(c, 'donation-cause-review', { id, decision: 'reject', note: '' })).status, 400, '却下の理由は必須');
  const rj = await admPost(c, 'donation-cause-review', { id, decision: 'reject', note: '内容を確認できないため' });
  assert.deepEqual([rj.status, rj.body.request.status, rj.body.request.causeReview, rj.body.request.holdState], [200, 'rejected', 'rejected', 'released']);
  assert.equal(await bal(m), 1350);
  const again = await admPost(c, 'donation-cause-review', { id, decision: 'reject', note: '再送' });
  assert.deepEqual([again.status, again.body.duplicate, await bal(m)], [200, true, 1350], '二重返還なし');
  assert.equal((await admPost(c, 'donation-reject', { id, reason: 'もう一度' })).body.duplicate, true);
  assert.equal(await bal(m), 1350);
  assert.equal((await admPost(c, 'donation-cause-review', { id, decision: 'approve' })).status, 409, '却下後は承認できない');
  assert.ok(sent.some((x) => x.to[0] === m.email && /について/.test(x.subject)), '却下の通知');
  // 通常の「却下」ボタンでも、希望先の状態が却下になる
  const id2 = (await createOther(m)).body.request.id;
  const r2 = await admPost(c, 'donation-reject', { id: id2, reason: '見送り' });
  assert.deepEqual([r2.body.request.causeReview, await bal(m)], ['rejected', 1350]);
  // 運営が登録した支援先への申請には、希望先の確認は使えない
  const reg = (await create(m)).body.request.id;
  assert.equal((await admPost(c, 'donation-cause-review', { id: reg, decision: 'approve' })).status, 409);
});

test('同時申請・連打でも二重利用されない／希望先の再送は1件（その他の支援先）', async () => {
  const a = await member({ points: 1350 });
  const rs = await Promise.all([createOther(a), createOther(a), createOther(a)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(await bal(a), 350);
  const b = await member({ points: 3000 });
  const body = { causeId: 'other', requestId: rid(), other: { name: '連打テスト基金', reason: '理由' } };
  const out = await Promise.all([1, 2, 3].map(() => mem(b.cookie, 'donation-create', { method: 'POST', body })));
  const ok = out.filter((r) => r.status === 200);
  assert.ok(ok.length >= 1 && new Set(ok.map((r) => r.body.request.id)).size === 1);
  assert.equal(await bal(b), 2000);
  const diff = await mem(b.cookie, 'donation-create', { method: 'POST', body: { ...body, other: { name: '別の基金', reason: '理由' } } });
  assert.equal(diff.status, 409, '同じ操作IDで内容が違う申請は拒否');
  assert.equal(await bal(b), 2000);
});

test('申請中に支援先が非公開・停止になっても、過去の申請を処理できる。名称を変えても、申請時の名称は変わらない', async () => {
  const c = await adminCookie(); const m = await member({ points: 3000 });
  const cause = (await admPost(c, 'donation-cause-save', { name: '一時的な支援先', description: '申請時の説明', url: 'https://example.org/t', status: 'published' })).body.cause;
  const id = (await create(m, { causeId: cause.id })).body.request.id;
  const id2 = (await create(m, { causeId: cause.id })).body.request.id;
  await admPost(c, 'donation-cause-save', { id: cause.id, name: '名称変更後', description: '変更後の説明', url: '', status: 'stopped' });
  const rec = await D.getRequest(id);
  assert.deepEqual([rec.causeName, rec.causeDescription, rec.causeUrl, rec.causeKind], ['一時的な支援先', '申請時の説明', 'https://example.org/t', 'registered'], 'スナップショット');
  assert.equal((await admPost(c, 'donation-approve', { id })).status, 200, '停止中でも承認できる');
  assert.equal((await admPost(c, 'donation-reject', { id: id2, reason: 'テスト' })).status, 200);
  assert.equal(await bal(m), 2000);
  assert.equal((await mem(m.cookie, 'donation-mine')).body.requests.find((x) => x.id === id).causeName, '一時的な支援先');
});

test('権限・閲覧：会員は他人の申請（希望先・理由）を見られない／一般会員は管理APIを操作できない', async () => {
  const a = await member(); const b = await member(); const c = await adminCookie();
  const id = (await createOther(a, { reason: '他人には見せない理由' })).body.request.id;
  assert.ok(!JSON.stringify((await mem(b.cookie, 'donation-mine')).body).includes('他人には見せない理由'));
  for (const act of ['donation-cause-review', 'donation-cause-save', 'donation-cause-move']) {
    assert.equal((await admPost(a.cookie, act, { id, decision: 'approve', name: 'x', status: 'published' })).status, 401, act);
    assert.equal((await admPost('', act, { id, decision: 'approve' })).status, 401, act);
  }
  assert.equal((await adm(c, 'donation-list')).body.requests.find((r) => r.id === id).otherCause.reason, '他人には見せない理由');
  assert.equal((await admPost(c, 'donation-cause-review', { id, decision: 'maybe' })).status, 400);
});

test('管理画面の一覧：種類での絞り込み・希望先で検索・CSVに種類と希望内容（数式は無害化）', async () => {
  const c = await adminCookie(); const m = await member({ points: 3000 });
  const o = (await createOther(m, { name: '=HYPERLINK("x")基金', reason: '検索用の固有の理由キーワードZZQ' })).body.request.id;
  await create(m);
  const all = (await adm(c, 'donation-list', { query: { q: m.email } })).body.requests;
  assert.equal(all.length, 2);
  assert.deepEqual((await adm(c, 'donation-list', { query: { q: m.email, kind: 'other' } })).body.requests.map((r) => r.id), [o]);
  assert.equal((await adm(c, 'donation-list', { query: { q: m.email, kind: 'registered' } })).body.requests.length, 1);
  assert.equal((await adm(c, 'donation-list', { query: { q: 'zzq' } })).body.requests.length, 1, '希望理由でも検索できる');
  assert.equal((await adm(c, 'donation-list', { query: { q: m.email, kind: 'review' } })).body.requests.length, 1, '要確認');
  await admPost(c, 'donation-cause-review', { id: o, decision: 'approve' });
  assert.equal((await adm(c, 'donation-list', { query: { q: m.email, kind: 'review' } })).body.requests.length, 0);
  const csv = String((await adm(c, 'donation-csv', { query: { q: m.email } })).body);
  assert.ok(csv.includes('支援先の種類,希望先のURL,希望の理由,希望先の確認'));
  assert.ok(csv.includes('その他（会員の希望）') && csv.includes('運営が登録') && csv.includes('検索用の固有の理由キーワードZZQ') && csv.includes('承認'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")基金"`) || csv.includes(`'=HYPERLINK`), '数式として実行されない');
});

test('本番では、DONATION_ENABLED=1 になるまで、その他の支援先の申請も受け付けない', async () => {
  const m = await member(); const c = await adminCookie();
  process.env.VERCEL_ENV = 'production';
  try {
    assert.equal((await createOther(m)).status, 403);
    assert.equal((await admPost(c, 'donation-cause-save', { name: 'x', status: 'published' })).status, 403);
    assert.equal(await bal(m), 1350);
  } finally { process.env.VERCEL_ENV = 'preview'; }
});

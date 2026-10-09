/**
 * 教育者のサロン「灯」のAPI（api/salon.js・管理API・認証の調整）のテスト。
 * メモリ上のRedisモックに対して、実際のAPI関数を呼ぶ。本物のRedis・メール・Stripeには接続しない。
 *   node --test "tests-unit/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import * as store from '../api/_lib/store.redis.js';
import * as Salon from '../api/_lib/salon-store.js';
import { hashPassword } from '../api/_lib/security.js';

store.__setRedisForTests(new RedisMock({ host: 'mock-salon', port: 6379 }));
process.env.VERCEL_ENV = 'preview';
// メール送信（Resend）は、テストでは本物に送らない。ダミーの鍵を入れ、Resendへの通信だけ失敗として返す。
process.env.RESEND_API_KEY = 're_test_dummy';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).includes('resend.com') ? new Response(JSON.stringify({ message: 'stubbed in tests' }), { status: 401 }) : realFetch(url, init));
const { default: salon, hooks, playbackFor } = await import('../api/salon.js');
const { default: auth } = await import('../api/community-auth.js');
const { default: admin } = await import('../api/admin.js');

function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.getHeader = (k) => res.headers[k.toLowerCase()];
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.redirect = (c, l) => { res.statusCode = c; res.headers.location = l; return res; };
  return res;
}
let ipSeq = 0;
async function call(handler, cookie, action, { method = 'GET', body = {}, query = {}, headers = {} } = {}) {
  const n = ++ipSeq; const ip = `10.7.${(n >> 8) & 255}.${n & 255}`;
  const res = fakeRes();
  await handler({ method, query: { action, ...query }, body, headers: { cookie: cookie || '', host: 'localhost:3000', 'x-forwarded-for': ip, ...headers }, socket: { remoteAddress: ip } }, res);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}
const S = (cookie, action, query) => call(salon, cookie, action, { query });
const P = (cookie, action, body) => call(salon, cookie, action, { method: 'POST', body });
const A = (cookie, action, opts) => call(admin, cookie, action, opts);
const AP = (cookie, action, body) => call(admin, cookie, action, { method: 'POST', body });

let seq = 0;
async function member(name, { community = 'tomoshibi', status = 'active', staff = null, profile = null, email = null, since = null } = {}) {
  const e = email || `s${++seq}_${Date.now()}@example.com`;
  if (!(await store.getUser(e))) await store.saveUser({ email: e, displayName: name, fullName: `本名${name}`, fullNameKana: 'ほんみょう', passwordHash: 'x:y' });
  await store.createApplication(community, { email: e, fullName: `本名${name}`, fullNameKana: 'ほんみょう', displayName: name });
  await store.resolveApplication(community, e, 'approved', 'test');
  if (status) await store.setMembership(community, e, { status, activatedAt: since || Date.now() });
  if (staff) await Salon.setStaff(e, staff);
  if (profile) await Salon.saveProfile(e, profile);
  return { email: e, name, cookie: `ht_session=${await store.createSession(e)}` };
}
const adminCookie = async (actorId, role = 'staff') => `ht_admin_session=${await store.createAdminSession({ actorId, role })}`;
const OWNER = { role: 'owner', title: '代表', subtitle: '教育学者' };
const SEC = { role: 'secretariat', title: '事務局' };
const rid = () => `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const json = (r) => JSON.stringify(r.body);

/* ═════════ アクセス制御：未ログイン・別サロン・退会・本番 ═════════ */
test('未ログインはAPIが使えない（401）。サロン画面は、元のURLに戻れるログインへ転送される', async () => {
  for (const a of ['bootstrap', 'feed', 'members', 'search', 'me', 'bookmarks']) assert.equal((await S('', a)).status, 401, a);
  for (const a of ['post-create', 'react', 'comment-create', 'event-join', 'profile-update']) assert.equal((await P('', a, {})).status, 401, a);
  const page = await S('', 'page');
  assert.equal(page.status, 302); assert.equal(page.headers.location, '/salon/tomoshibi/login/?next=%2Fsalon%2Ftomoshibi%2F');
});

test('HAKU Communityの会員というだけでは、灯のAPI・画面に入れない（会員資格は灯ごとに確認）', async () => {
  const haku = await member('はく', { community: 'haku' });
  assert.equal((await S(haku.cookie, 'bootstrap')).status, 403);
  assert.equal((await S(haku.cookie, 'bootstrap')).body.code, 'not_member');
  assert.equal((await P(haku.cookie, 'post-create', { channel: 'case', body: 'x' })).status, 403);
  assert.equal((await S(haku.cookie, 'page')).status, 302, '画面もログインへ');
  assert.equal((await S(haku.cookie, 'feed', { ch: 'home' })).status, 403);
});

test('退会済み・未入金（有効でない）の会員は入れない。有効な会員だけが画面を開ける', async () => {
  const gone = await member('たいかい', { status: 'inactive' });
  const none = await member('みにゅう', { status: null });
  const ok = await member('ゆうこう');
  for (const m of [gone, none]) { assert.equal((await S(m.cookie, 'bootstrap')).status, 403); assert.equal((await S(m.cookie, 'page')).status, 302); }
  const page = await S(ok.cookie, 'page');
  assert.equal(page.status, 200); assert.match(String(page.body), /教育者のサロン 灯/); assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow');
});

test('本番（Production）では、サロンのAPI・管理APIは動かない（Previewのみ）', async () => {
  const m = await member('ほんばん');
  process.env.VERCEL_ENV = 'production';
  try {
    assert.equal((await S(m.cookie, 'bootstrap')).status, 403);
    assert.equal((await S(m.cookie, 'page')).status, 403);
    const adm = await adminCookie('x@example.com', 'super_admin');
    assert.equal((await A(adm, 'salon-staff-list')).status, 403);
  } finally { process.env.VERCEL_ENV = 'preview'; }
});

/* ═════════ 投稿：作成・表示・権限 ═════════ */
test('投稿の作成と一覧（新着順・チャンネル別・ホームは全部）', async () => {
  const a = await member('あや');
  const p1 = await P(a.cookie, 'post-create', { channel: 'case', body: '一つ目の相談です。' });
  const p2 = await P(a.cookie, 'post-create', { channel: 'mgmt', body: '二つ目：運営の相談です。' });
  const p3 = await P(a.cookie, 'post-create', { channel: 'case', body: '三つ目の相談です。' });
  assert.equal(p1.status, 200); assert.equal(p1.body.post.isMine, true);
  const home = await S(a.cookie, 'feed', { ch: 'home' });
  assert.deepEqual(home.body.posts.slice(0, 3).map((p) => p.id), [p3.body.post.id, p2.body.post.id, p1.body.post.id], '新着順');
  const cases = await S(a.cookie, 'feed', { ch: 'case' });
  assert.ok(cases.body.posts.every((p) => p.channel === 'case'));
  assert.equal(cases.body.posts.some((p) => p.id === p2.body.post.id), false);
  assert.equal((await S(a.cookie, 'feed', { ch: 'bogus' })).status, 400);
});

test('運営だけが投稿できるチャンネル（実践講義アーカイブ・お知らせ）。一般会員は403', async () => {
  const m = await member('いっぱん'); const st = await member('だいひょう', { staff: OWNER });
  for (const ch of ['archive', 'news']) {
    assert.equal((await P(m.cookie, 'post-create', { channel: ch, body: 'x' })).status, 403, ch);
    const ok = await P(st.cookie, 'post-create', { channel: ch, body: `運営から（${ch}）` });
    assert.equal(ok.status, 200); assert.equal(ok.body.post.author.badge, '代表');
  }
  assert.equal((await P(m.cookie, 'post-create', { channel: 'bogus', body: 'x' })).status, 403);
});

test('入力の検査：空・長すぎ・文字化け・不正な十ヶ条。添付は運営のみ', async () => {
  const m = await member('けんさ');
  assert.equal((await P(m.cookie, 'post-create', { channel: 'case', body: '   ' })).status, 400);
  assert.equal((await P(m.cookie, 'post-create', { channel: 'case', body: 'あ'.repeat(5001) })).status, 400);
  assert.equal((await P(m.cookie, 'post-create', { channel: 'case', body: '文字化け' + String.fromCharCode(0xfffd) })).status, 400);
  assert.equal((await P(m.cookie, 'post-create', { channel: 'creed', body: 'x', creedTag: 11 })).status, 400);
  assert.equal((await P(m.cookie, 'post-create', { channel: 'case', body: 'x', attachment: { type: 'file', title: 't', url: 'https://example.com/a.pdf' } })).status, 403);
});

test('二重投稿の防止：同じ操作ID（requestId）なら、連打しても1件だけ保存される', async () => {
  const m = await member('れんだ'); const id = rid();
  const rs = await Promise.all([1, 2, 3].map(() => P(m.cookie, 'post-create', { channel: 'case', body: '連打テスト', requestId: id })));
  const ids = new Set(rs.filter((r) => r.status === 200).map((r) => r.body.post.id));
  assert.equal(ids.size, 1);
  const feed = await S(m.cookie, 'feed', { ch: 'case' });
  assert.equal(feed.body.posts.filter((p) => p.body === '連打テスト').length, 1);
});

test('自分の投稿だけ編集できる（運営でも他人の投稿は編集できない）。削除は本人か運営', async () => {
  const a = await member('あや'); const b = await member('ぼん'); const st = await member('だいひょう', { staff: OWNER });
  const post = (await P(a.cookie, 'post-create', { channel: 'case', body: '元の本文' })).body.post;
  assert.equal((await P(b.cookie, 'post-update', { id: post.id, body: '乗っ取り' })).status, 403);
  assert.equal((await P(st.cookie, 'post-update', { id: post.id, body: '運営が編集' })).status, 403, '運営も他人の投稿は編集不可');
  const up = await P(a.cookie, 'post-update', { id: post.id, body: '編集した本文' });
  assert.equal(up.status, 200); assert.equal(up.body.post.body, '編集した本文'); assert.equal(up.body.post.edited, true);
  assert.equal((await P(b.cookie, 'post-delete', { id: post.id })).status, 403, '他の会員は削除できない');
  assert.equal((await S(a.cookie, 'feed', { ch: 'case' })).body.posts.some((p) => p.id === post.id), true, '失敗した削除で消えていない');
  assert.equal((await P(st.cookie, 'post-delete', { id: post.id })).status, 200, '運営は削除できる');
  assert.equal((await P(a.cookie, 'post-delete', { id: post.id })).status, 404);
  const log = await store.listAuditLog(50);
  assert.ok(log.some((e) => e.action === 'salon_post_deleted_by_staff' && e.targetId === post.id), '運営の削除は監査ログに残る');
  assert.equal((await P(b.cookie, 'post-pin', { id: post.id, pinned: true })).status, 403, 'ピン留めは運営のみ');
});

test('ピン留め（運営のみ）：先頭に出て、右カラムにも出る。外すと戻る', async () => {
  const a = await member('あや'); const st = await member('だいひょう', { staff: OWNER });
  const p1 = (await P(a.cookie, 'post-create', { channel: 'case', body: '古い投稿' })).body.post;
  await P(a.cookie, 'post-create', { channel: 'case', body: '新しい投稿' });
  assert.equal((await P(st.cookie, 'post-pin', { id: p1.id, pinned: true })).status, 200);
  const feed = await S(a.cookie, 'feed', { ch: 'case' });
  assert.equal(feed.body.posts[0].id, p1.id); assert.equal(feed.body.posts[0].pinned, true);
  assert.equal((await S(a.cookie, 'bootstrap')).body.rail.pinned.id, p1.id);
  await P(st.cookie, 'post-pin', { id: p1.id, pinned: false });
  assert.notEqual((await S(a.cookie, 'feed', { ch: 'case' })).body.posts[0].id, p1.id);
});

/* ═════════ 匿名・教室名を伏せる ═════════ */
test('匿名投稿：一般会員向けのレスポンスに、投稿者を特定できる情報が一切含まれない', async () => {
  const author = await member('ひみつ太郎', { profile: { displayName: 'ひみつ太郎', prefecture: '千葉県', facilityLabel: '学習塾・フリースクール併設', listVisibility: 'public' } });
  const reader = await member('よみて');
  const post = (await P(author.cookie, 'post-create', { channel: 'mgmt', body: '月謝を上げたいのですが…', anonymous: true })).body.post;
  assert.equal(post.author.label, '匿名'); assert.equal(post.author.initial, '?');
  // 投稿者以外が見るすべてのAPI（一覧・単体・検索・ホーム・コメント一覧）
  const outs = [await S(reader.cookie, 'feed', { ch: 'mgmt' }), await S(reader.cookie, 'feed', { ch: 'home' }), await S(reader.cookie, 'post', { id: post.id }), await S(reader.cookie, 'search', { q: '月謝' })];
  for (const r of outs) {
    const t = json(r);
    for (const secret of [author.email, 'ひみつ太郎', '本名ひみつ太郎', '千葉県', '学習塾', author.email.split('@')[0]]) assert.ok(!t.includes(secret), `匿名投稿のレスポンスに漏れている: ${secret}`);
    assert.ok(!/authorEmail|authorId|"email"/.test(t), '作者の識別子のキーが含まれている');
  }
  // 本人には編集・削除の操作が出る（本人にしか分からないフラグ）
  const mine = (await S(author.cookie, 'post', { id: post.id })).body.post;
  assert.equal(mine.isMine, true); assert.equal(mine.canDelete, true);
  assert.equal((await S(reader.cookie, 'post', { id: post.id })).body.post.isMine, false);
  // 匿名投稿のコメント・メンバー一覧からも作者は推定できない
  const mem = json(await S(reader.cookie, 'members'));
  assert.ok(!/authorEmail/.test(mem));
});

test('匿名投稿は、運営向けのAPIでも既定では投稿者を出さない（匿名の範囲は未決定のため安全側）', async () => {
  const author = await member('ひみつ花子', { profile: { displayName: 'ひみつ花子' } });
  const st = await member('だいひょう', { staff: OWNER });
  const post = (await P(author.cookie, 'post-create', { channel: 'case', body: '匿名で相談です。', anonymous: true })).body.post;
  assert.equal((await S(st.cookie, 'post', { id: post.id })).body.post.author.label, '匿名');
  const adm = await adminCookie(st.email, 'staff');
  const list = await A(adm, 'salon-posts', { query: { ch: 'case' } });
  assert.equal(list.status, 200);
  const t = json(list);
  assert.ok(!t.includes('ひみつ花子') && !t.includes(author.email), '管理APIにも匿名の投稿者が出ていない');
  assert.equal(list.body.posts.find((p) => p.id === post.id).author.label, '匿名');
});

test('「教室名を伏せる」は初期ON。OFFにすると所属が表示される。匿名にすると両方とも出ない', async () => {
  const a = await member('さとう', { profile: { displayName: 'さとう', facilityLabel: '音楽教室', listVisibility: 'public' } });
  const def = (await P(a.cookie, 'post-create', { channel: 'case', body: '既定の投稿' })).body.post;          // hideFacility未指定
  const off = (await P(a.cookie, 'post-create', { channel: 'case', body: '所属を見せる投稿', hideFacility: false })).body.post;
  const anon = (await P(a.cookie, 'post-create', { channel: 'case', body: '匿名の投稿', anonymous: true, hideFacility: false })).body.post;
  assert.equal(def.author.label, 'さとう', '初期値ON＝所属は非表示');
  assert.equal(off.author.label, 'さとう（音楽教室）');
  assert.equal(anon.author.label, '匿名');
  assert.ok(!JSON.stringify(anon).includes('音楽教室'));
});

test('退会した会員の投稿は、「退会した会員」と表示され、名前・所属は出ない', async () => {
  const a = await member('たいかいする', { profile: { displayName: 'たいかいする', facilityLabel: '塾' } }); const r = await member('よみて');
  await P(a.cookie, 'post-create', { channel: 'case', body: '退会前の投稿', hideFacility: false });
  await store.setMembership('tomoshibi', a.email, { status: 'inactive' });
  const feed = await S(r.cookie, 'feed', { ch: 'case' });
  const p = feed.body.posts.find((x) => x.body === '退会前の投稿');
  assert.equal(p.author.label, '退会した会員'); assert.ok(!json(feed).includes('たいかいする'));
});

/* ═════════ コメント・ありがとう・あとで読む・検索 ═════════ */
test('コメントは「返信の返信」まで（深さ3）。それ以上と、別の投稿のコメントへの返信は拒否', async () => {
  const a = await member('あや'); const post = (await P(a.cookie, 'post-create', { channel: 'case', body: '相談' })).body.post;
  const post2 = (await P(a.cookie, 'post-create', { channel: 'case', body: '別の相談' })).body.post;
  const c1 = (await P(a.cookie, 'comment-create', { postId: post.id, body: 'コメント' })).body.comment;
  const c2 = (await P(a.cookie, 'comment-create', { postId: post.id, parentId: c1.id, body: '返信' })).body.comment;
  const c3 = (await P(a.cookie, 'comment-create', { postId: post.id, parentId: c2.id, body: '返信の返信' })).body.comment;
  assert.deepEqual([c1.depth, c2.depth, c3.depth], [1, 2, 3]);
  assert.equal((await P(a.cookie, 'comment-create', { postId: post.id, parentId: c3.id, body: 'さらに' })).status, 400, 'これ以上は不可');
  assert.equal((await P(a.cookie, 'comment-create', { postId: post2.id, parentId: c1.id, body: '別の投稿へ' })).status, 404);
  assert.equal((await P(a.cookie, 'comment-create', { postId: post.id, body: '  ' })).status, 400);
  const list = (await S(a.cookie, 'comments', { postId: post.id })).body.comments;
  assert.deepEqual(list.map((c) => c.body), ['コメント', '返信', '返信の返信'], '親→子→孫の順');
  assert.equal((await S(a.cookie, 'feed', { ch: 'case' })).body.posts.find((p) => p.id === post.id).commentCount, 3);
});

test('コメントの削除：本人か運営だけ。返信も一緒に消える。コメントの二重送信は1件', async () => {
  const a = await member('あや'); const b = await member('ぼん'); const st = await member('じむきょく', { staff: SEC });
  const post = (await P(a.cookie, 'post-create', { channel: 'case', body: '相談' })).body.post;
  const id = rid();
  const rs = await Promise.all([1, 2].map(() => P(a.cookie, 'comment-create', { postId: post.id, body: '同じコメント', requestId: id })));
  const first = rs.find((r) => r.status === 200);
  assert.ok(first, '1回は保存される');
  const again = await P(a.cookie, 'comment-create', { postId: post.id, body: '同じコメント', requestId: id });
  assert.equal(again.status, 200); assert.equal(again.body.comment.id, first.body.comment.id, '完了後の再送は、同じコメントを返す（重複しない）');
  assert.equal((await S(a.cookie, 'comments', { postId: post.id })).body.comments.length, 1, '保存は1件だけ');
  const c1 = first.body.comment;
  const c2 = (await P(b.cookie, 'comment-create', { postId: post.id, parentId: c1.id, body: '返信' })).body.comment;
  assert.equal((await P(b.cookie, 'comment-delete', { id: c1.id })).status, 403, '他人のコメントは消せない');
  assert.equal((await P(a.cookie, 'comment-delete', { id: c1.id })).status, 200);
  assert.equal((await S(a.cookie, 'comments', { postId: post.id })).body.comments.length, 0, '返信も消えた');
  const c3 = (await P(b.cookie, 'comment-create', { postId: post.id, body: '運営に消してもらうコメント' })).body.comment;
  assert.equal((await P(st.cookie, 'comment-delete', { id: c3.id })).status, 200);
  void c2;
});

test('運営の返信は、投稿した本人にメールで知らせる（通知OFF・自分への返信・一般会員の返信では送らない）', async () => {
  const sent = []; const orig = hooks.replyMail; hooks.replyMail = async (m) => { sent.push(m); return { ok: true }; };
  try {
    const a = await member('あや'); const quiet = await member('しずか', { profile: { notify: { reply: false } } }); const b = await member('ぼん'); const st = await member('だいひょう', { staff: OWNER });
    const pa = (await P(a.cookie, 'post-create', { channel: 'case', body: '相談A', anonymous: true })).body.post;
    const pq = (await P(quiet.cookie, 'post-create', { channel: 'case', body: '相談Q' })).body.post;
    await P(b.cookie, 'comment-create', { postId: pa.id, body: '一般会員のコメント' });
    assert.equal(sent.length, 0, '一般会員のコメントでは送らない');
    await P(st.cookie, 'comment-create', { postId: pa.id, body: '運営の返信' }, {});
    assert.equal(sent.length, 1); assert.equal(sent[0].email, a.email); assert.match(sent[0].url, /\/salon\/tomoshibi\/#post=/);
    assert.ok(!JSON.stringify(sent[0]).includes('運営の返信'), 'メールに本文を入れない');
    await P(st.cookie, 'comment-create', { postId: pq.id, body: '運営の返信' });
    assert.equal(sent.length, 1, '通知OFFの人には送らない');
    const own = (await P(st.cookie, 'post-create', { channel: 'case', body: '運営の投稿' })).body.post;
    await P(st.cookie, 'comment-create', { postId: own.id, body: '自分に返信' });
    assert.equal(sent.length, 1, '自分への返信では送らない');
  } finally { hooks.replyMail = orig; }
});

test('ありがとう（1種類・何度押しても1回）／あとで読む（自分だけ）', async () => {
  const a = await member('あや'); const b = await member('ぼん');
  const post = (await P(a.cookie, 'post-create', { channel: 'case', body: '相談' })).body.post;
  assert.equal((await P(b.cookie, 'react', { postId: post.id, on: true })).body.count, 1);
  assert.equal((await P(b.cookie, 'react', { postId: post.id, on: true })).body.count, 1, '連打しても増えない');
  assert.equal((await P(a.cookie, 'react', { postId: post.id, on: true })).body.count, 2);
  const view = (await S(b.cookie, 'post', { id: post.id })).body.post;
  assert.equal(view.reactions, 2); assert.equal(view.reacted, true);
  assert.equal((await P(b.cookie, 'react', { postId: post.id, on: false })).body.count, 1);
  assert.equal((await P(b.cookie, 'react', { postId: 'nonexistent1', on: true })).status, 404);
  await P(b.cookie, 'bookmark', { postId: post.id, on: true });
  assert.equal((await S(b.cookie, 'bookmarks')).body.posts.length, 1);
  assert.equal((await S(a.cookie, 'bookmarks')).body.posts.length, 0, '他の会員のあとで読むは見えない');
  assert.equal((await S(a.cookie, 'post', { id: post.id })).body.post.bookmarked, false);
  await P(b.cookie, 'bookmark', { postId: post.id, on: false });
  assert.equal((await S(b.cookie, 'bookmarks')).body.posts.length, 0);
});

test('検索：本文とコメントが対象。十ヶ条のタグでも探せる。匿名の投稿者は検索でも出ない', async () => {
  const a = await member('あや', { profile: { displayName: 'あや' } }); const b = await member('ぼん');
  const p1 = (await P(a.cookie, 'post-create', { channel: 'case', body: '保護者に伝える言葉を探しています。', anonymous: true })).body.post;
  const p2 = (await P(a.cookie, 'post-create', { channel: 'creed', body: '待つことについて', creedTag: 6 })).body.post;
  await P(b.cookie, 'comment-create', { postId: p1.id, body: '月次の記録シートが役に立ちました。' });
  const byBody = (await S(b.cookie, 'search', { q: '保護者' })).body.results;
  assert.equal(byBody.length, 1); assert.equal(byBody[0].post.id, p1.id);
  const byComment = (await S(a.cookie, 'search', { q: '記録シート' })).body.results;
  assert.equal(byComment[0].post.id, p1.id); assert.match(byComment[0].matches[0].snippet, /記録シート/);
  assert.equal((await S(a.cookie, 'search', { q: '第六条' })).body.results[0].post.id, p2.id);
  assert.equal((await S(a.cookie, 'search', { q: 'ＺＺＺ該当なし' })).body.results.length, 0);
  assert.equal((await S(a.cookie, 'search', { q: '' })).status, 400);
  assert.equal((await S(a.cookie, 'search', { q: 'あ'.repeat(61) })).status, 400);
  assert.ok(!json(await S(b.cookie, 'search', { q: '保護者' })).includes(a.email));
});

/* ═════════ メンバー一覧・設定・今月の一条 ═════════ */
test('メンバー一覧：公開してよい項目だけ（メール・本名・非公開情報は返さない）。匿名希望・運営の表示', async () => {
  const pub = await member('さとう', { profile: { displayName: 'さとう', prefecture: '千葉県', facilityLabel: '学習塾', listVisibility: 'public' }, since: Date.now() - 70 * 86400e3 });
  const anon = await member('ナナシノ匿名希望者', { profile: { displayName: 'ナナシノ匿名希望者', prefecture: '東京都', facilityLabel: 'フリースクール', listVisibility: 'anonymous' } });
  const st = await member('おおくぼ', { staff: OWNER, profile: { displayName: '大久保 俊輝' } });
  const r = await S(pub.cookie, 'members'); const t = json(r);
  for (const secret of [pub.email, anon.email, st.email, '本名さとう', '本名ナナシノ匿名希望者', '東京都', 'ナナシノ']) assert.ok(!t.includes(secret), `一覧に漏れている: ${secret}`);
  const rows = r.body.members;
  assert.ok(rows.some((m) => m.name === '大久保 俊輝' && m.sub === '代表 ／ 教育学者' && m.since === '開設より' && m.av === 't')); assert.ok(rows.findIndex((m) => m.since === '開設より') < rows.findIndex((m) => m.name === 'さとう さん'), '運営が先に並ぶ');
  assert.ok(rows.some((m) => m.name === 'さとう さん' && m.sub === '千葉県 ／ 学習塾' && m.since === '2ヶ月'));
  assert.ok(rows.some((m) => m.name === '匿名希望' && m.sub === '非公開 ／ フリースクール'));
  assert.ok(r.body.count >= 3);
});

test('設定：表示名・都道府県・場の種類・一覧への表示・通知の保存と検査（保存先はサロンのプロフィール）', async () => {
  const a = await member('あや');
  assert.equal((await P(a.cookie, 'profile-update', { displayName: '   ' })).status, 400);
  assert.equal((await P(a.cookie, 'profile-update', { prefecture: 'アトランティス' })).status, 400);
  assert.equal((await P(a.cookie, 'profile-update', { listVisibility: 'bogus' })).status, 400);
  assert.equal((await P(a.cookie, 'profile-update', { facilityLabel: 'あ'.repeat(31) })).status, 400);
  const ok = await P(a.cookie, 'profile-update', { displayName: '新しい表示名', prefecture: '大阪府', facilityLabel: '音楽教室', listVisibility: 'anonymous' });
  assert.equal(ok.status, 200); assert.equal(ok.body.profile.displayName, '新しい表示名');
  const me = (await S(a.cookie, 'me')).body;
  assert.equal(me.profile.prefecture, '大阪府'); assert.equal(me.profile.listVisibility, 'anonymous'); assert.equal(me.isStaff, false);
  assert.equal((await store.getUser(a.email)).displayName, 'あや', 'HAKU共通のユーザー名は変わらない（サロンのプロフィールだけ）');
  const n = await P(a.cookie, 'notify-update', { reply: false, reminder: false });
  assert.deepEqual(n.body.profile.notify, { reply: false, reminder: false });
});

test('今月の一条：十ヶ条はWordの正式な文言。運営が設定すると、会員画面・ホームの説明・右カラムに反映される', async () => {
  const { CREEDS, creedFull } = await import('../api/_lib/salon-core.js');
  assert.equal(CREEDS.length, 11);
  assert.equal(CREEDS[6], '時に「ひと呼吸」して待つ'); assert.equal(CREEDS[1], '「不登校・いじめ」に負けない・気にしない技'); assert.equal(CREEDS[10], 'なすべきことはなす誠実さと丁寧さ');
  assert.equal(creedFull(6), '第六条「時に『ひと呼吸』して待つ」');
  const m = await member('あや'); const st = await member('じむきょく', { staff: SEC }); const adm = await adminCookie(st.email, 'staff');
  assert.equal((await AP(adm, 'salon-creed-set', { n: 11 })).status, 400);
  assert.equal((await AP(adm, 'salon-creed-set', { n: 6, reading: '待っている期間に、保護者へ何を伝えるか' })).status, 200);
  const b = (await S(m.cookie, 'bootstrap')).body;
  assert.equal(b.creed.label, '第六条'); assert.equal(b.creed.title, '時に「ひと呼吸」して待つ'); assert.equal(b.creed.reading, '待っている期間に、保護者へ何を伝えるか');
  assert.match(b.descs.home, /テーマ：第六条「時に『ひと呼吸』して待つ」/); assert.match(b.descs.creed, /^第六条「/);
  const p = (await P(m.cookie, 'post-create', { channel: 'creed', body: '待つことについて' })).body.post;
  assert.equal(p.creedTag, 6, '今月の一条のチャンネルは、既定で今月の条のタグが付く'); assert.equal(p.creedLabel, '第六条');
  const generalAdm = await adminCookie('someone@example.com', 'staff');
  assert.equal((await AP(generalAdm, 'salon-creed-set', { n: 2 })).status, 403, '運営ロールのない管理者は変更できない');
});

/* ═════════ イベント・講義 ═════════ */
test('イベント：運営が登録→会員が参加・取消。開催URLは参加予定の会員にだけ返る。定員・終了済みも守る', async () => {
  const m = await member('あや'); const o = await member('ほか'); const st = await member('だいひょう', { staff: OWNER }); const adm = await adminCookie(st.email, 'staff');
  const starts = Date.now() + 5 * 86400e3;
  const created = await AP(adm, 'salon-event-create', { title: '9月の実践講義｜第六条', summary: '待っている期間の報告の仕方', startsAt: starts, endsAt: starts + 5400e3, capacity: 1, url: 'https://meet.google.com/aaa-bbbb-ccc', announce: true, announceBody: '今月の実践講義の日程です。' });
  assert.equal(created.status, 200); const ev = created.body.event;
  assert.equal((await AP(adm, 'salon-event-create', { title: 'x', startsAt: starts, url: 'http://insecure.example.com' })).status, 400, 'httpsのみ');
  const news = (await S(m.cookie, 'feed', { ch: 'news' })).body.posts[0];
  assert.equal(news.attachment.type, 'event'); assert.equal(news.attachment.joined, false); assert.ok(!JSON.stringify(news).includes('meet.google.com'), '一覧にURLは出ない');
  assert.equal((await S(m.cookie, 'event-url', { id: ev.id })).status, 403, '未参加にはURLを返さない');
  assert.equal((await P(m.cookie, 'event-join', { eventId: ev.id })).status, 200);
  assert.equal((await P(m.cookie, 'event-join', { eventId: ev.id })).body.count, 1, '二重参加しない');
  assert.equal((await P(o.cookie, 'event-join', { eventId: ev.id })).status, 409, '定員に達した');
  assert.equal((await S(m.cookie, 'event-url', { id: ev.id })).body.url, 'https://meet.google.com/aaa-bbbb-ccc');
  assert.equal((await S(o.cookie, 'event-url', { id: ev.id })).status, 403);
  assert.equal((await S('', 'event-url', { id: ev.id })).status, 401);
  assert.equal((await P(m.cookie, 'event-leave', { eventId: ev.id })).body.joined, false);
  assert.equal((await S(m.cookie, 'event-url', { id: ev.id })).status, 403, '取消後は取得できない');
  assert.equal((await P(o.cookie, 'event-join', { eventId: ev.id })).status, 200, '空いたら参加できる');
  const rail = (await S(m.cookie, 'bootstrap')).body.rail.events;
  assert.match(rail[0].title, /^\d+\/\d+ 9月の実践講義/);
  const past = (await AP(adm, 'salon-event-create', { title: '終わった会', startsAt: Date.now() - 2 * 86400e3 })).body.event;
  assert.equal((await P(m.cookie, 'event-join', { eventId: past.id })).status, 409);
});

test('講義の前日リマインド：参加予定の会員にメール（通知OFFの人・二重送信なし・CRON_SECRET必須）', async () => {
  const sent = []; const orig = hooks.reminderMail; hooks.reminderMail = async (m) => { sent.push(m); return { ok: true }; };
  process.env.CRON_SECRET = 'test-cron-secret';
  try {
    const a = await member('あや'); const q = await member('しずか', { profile: { notify: { reminder: false } } });
    const dayStart = Date.parse(new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10) + 'T00:00:00+09:00') + 86400e3; // 明日0:00(JST)
    const ev = await Salon.createEvent({ title: '明日の講義', startsAt: dayStart + 20 * 3600e3, endsAt: dayStart + 21.5 * 3600e3 });
    const far = await Salon.createEvent({ title: '来週の講義', startsAt: dayStart + 5 * 86400e3 });
    for (const m of [a, q]) { await Salon.joinEvent(ev.id, m.email, null); await Salon.joinEvent(far.id, m.email, null); }
    assert.equal((await call(salon, '', 'cron-reminders')).status, 401);
    assert.equal((await call(salon, '', 'cron-reminders', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const ok = await call(salon, '', 'cron-reminders', { headers: { authorization: 'Bearer test-cron-secret' } });
    assert.equal(ok.status, 200); assert.equal(ok.body.sent, 1);
    assert.deepEqual(sent.map((s) => s.email), [a.email]); assert.equal(sent[0].eventTitle, '明日の講義');
    const again = await call(salon, '', 'cron-reminders', { headers: { authorization: 'Bearer test-cron-secret' } });
    assert.equal(again.body.sent, 0, '同じ人に2回送らない');
  } finally { hooks.reminderMail = orig; delete process.env.CRON_SECRET; }
});

test('実践講義：運営が登録→会員だけが視聴。動画のURLは一覧に出ず、視聴する会員にだけ返る（未ログイン・他サロン会員は不可）', async () => {
  const m = await member('あや'); const haku = await member('はく', { community: 'haku' }); const st = await member('だいひょう', { staff: OWNER }); const adm = await adminCookie(st.email, 'staff');
  assert.equal((await AP(adm, 'salon-lecture-create', { title: 'x', heldAt: Date.now(), videoUrl: 'http://insecure.example.com/a.mp4' })).status, 400);
  assert.equal((await AP(adm, 'salon-lecture-create', { title: '', heldAt: Date.now(), videoUrl: 'https://example.com/a.mp4' })).status, 400);
  const created = await AP(adm, 'salon-lecture-create', { title: '特性を「直す」のではなく「活かす」見立て方', description: '第五条の回です。', heldAt: '2026-09-06T20:00:00+09:00', minutes: 52, creedTag: 5, note: '記録シートひな形つき', videoUrl: 'https://example.com/lectures/5.mp4' });
  assert.equal(created.status, 200);
  const feed = await S(m.cookie, 'feed', { ch: 'archive' });
  const post = feed.body.posts[0];
  assert.equal(post.attachment.type, 'video'); assert.equal(post.attachment.sub, '52分 ／ 視聴 0名 ／ 記録シートひな形つき'); assert.equal(post.creedLabel, '第五条');
  assert.ok(!json(feed).includes('example.com/lectures'), '一覧に動画のURLが出ない');
  assert.equal((await S('', 'lecture-play', { id: created.body.lecture.id })).status, 401);
  assert.equal((await S(haku.cookie, 'lecture-play', { id: created.body.lecture.id })).status, 403, 'HAKU会員は視聴できない');
  const play = await S(m.cookie, 'lecture-play', { id: created.body.lecture.id });
  assert.equal(play.status, 200); assert.equal(play.body.kind, 'video'); assert.equal(play.body.url, 'https://example.com/lectures/5.mp4');
  assert.equal((await S(m.cookie, 'feed', { ch: 'archive' })).body.posts[0].attachment.sub.includes('視聴 1名'), true, '視聴者数が増える');
  assert.equal((await S(m.cookie, 'lecture-play', { id: 'nonexistent1' })).status, 404);
  assert.equal((await AP(adm, 'salon-lecture-delete', { id: created.body.lecture.id })).status, 200);
  assert.equal((await S(m.cookie, 'feed', { ch: 'archive' })).body.posts.some((p) => p.attachment?.type === 'video'), false, '講義を消すと、その投稿も消える');
});

test('動画の再生方法：YouTube・Vimeoは埋め込み用、mp4は直接再生、その他はリンク', () => {
  assert.deepEqual(playbackFor('https://www.youtube.com/watch?v=abcdEFG1234'), { kind: 'embed', url: 'https://www.youtube-nocookie.com/embed/abcdEFG1234' });
  assert.deepEqual(playbackFor('https://youtu.be/abcdEFG1234'), { kind: 'embed', url: 'https://www.youtube-nocookie.com/embed/abcdEFG1234' });
  assert.equal(playbackFor('https://vimeo.com/123456789/abc123').kind, 'embed');
  assert.equal(playbackFor('https://cdn.example.com/a/b.mp4?token=x').kind, 'video');
  assert.equal(playbackFor('https://drive.google.com/file/d/xyz/view').kind, 'link');
});

/* ═════════ 管理API：運営ロールの二重確認・監査 ═════════ */
test('管理API：管理者ログインだけでは灯の内容を見られない（運営ロールが必要）。ロールの変更は最高管理者のみ', async () => {
  const author = await member('あや'); await P(author.cookie, 'post-create', { channel: 'case', body: '内密の相談です。' });
  const plain = await adminCookie('plain-admin@example.com', 'staff');
  for (const [a, opts] of [['salon-posts', { query: { ch: 'home' } }], ['salon-members', {}], ['salon-overview', {}], ['salon-lecture-list', {}], ['salon-event-list', {}], ['salon-audit', {}]]) {
    const r = await A(plain, a, opts); assert.equal(r.status, 403, a); assert.equal(r.body.code, 'salon_staff_required'); assert.ok(!json(r).includes('内密'));
  }
  assert.equal((await A('', 'salon-posts')).status, 401, '管理者ログインなし');
  assert.equal((await AP(plain, 'salon-staff-set', { email: 'plain-admin@example.com', role: 'owner' })).status, 403, '一般の管理者は自分に付与できない');
  const root = await adminCookie('root@example.com', 'super_admin');
  const set = await AP(root, 'salon-staff-set', { email: 'plain-admin@example.com', role: 'secretariat', title: '事務局' });
  assert.equal(set.status, 200); assert.equal(set.body.staff.find((s) => s.email === 'plain-admin@example.com').role, 'secretariat');
  assert.equal((await A(plain, 'salon-posts', { query: { ch: 'home' } })).status, 200, 'ロール付与後は見られる');
  assert.equal((await AP(root, 'salon-staff-set', { email: 'bad', role: 'owner' })).status, 400);
  assert.equal((await AP(root, 'salon-staff-set', { email: 'plain-admin@example.com', role: 'bogus' })).status, 400);
  await AP(root, 'salon-staff-set', { email: 'plain-admin@example.com', role: 'none' });
  assert.equal((await A(plain, 'salon-posts', { query: { ch: 'home' } })).status, 403, 'ロールを外すと見られない');
  const log = await store.listAuditLog(200);
  assert.ok(log.some((e) => e.action === 'salon_staff_set') && log.some((e) => e.action === 'salon_staff_removed'), 'ロール変更は監査ログに残る');
  assert.equal((await S(author.cookie, 'bootstrap')).body.me.isStaff, false);
  assert.equal((await A(author.cookie, 'salon-posts')).status, 401, '会員のCookieでは管理APIに入れない');
});

test('管理API：投稿・コメントの削除とピン留め、お知らせ、会員の状態（監査ログつき）', async () => {
  const m = await member('あや'); const st = await member('だいひょう', { staff: OWNER }); const adm = await adminCookie(st.email, 'staff');
  const post = (await P(m.cookie, 'post-create', { channel: 'case', body: '管理画面から消される投稿' })).body.post;
  const c = (await P(m.cookie, 'comment-create', { postId: post.id, body: '消えるコメント' })).body.comment;
  const posts = await A(adm, 'salon-posts', { query: { ch: 'case' } });
  assert.ok(posts.body.posts.some((p) => p.id === post.id));
  assert.equal((await AP(adm, 'salon-comment-delete', { id: c.id })).status, 200);
  assert.equal((await AP(adm, 'salon-post-pin', { id: post.id, pinned: true })).status, 200);
  const news = await AP(adm, 'salon-news-create', { body: '運営からのお知らせです。', pinned: false });
  assert.equal(news.status, 200); assert.equal((await S(m.cookie, 'feed', { ch: 'news' })).body.posts[0].body, '運営からのお知らせです。');
  assert.equal((await AP(adm, 'salon-post-delete', { id: post.id })).status, 200);
  assert.equal((await S(m.cookie, 'post', { id: post.id })).status, 404);
  // 会員の状態（決済確認後の有効化・退会）。承認済みの申請がある人だけ
  const none = await member('みしょうにん', { status: null }); await store.resolveApplication('tomoshibi', none.email, 'pending', 'x');
  assert.equal((await AP(adm, 'salon-member-set', { email: none.email, status: 'active' })).status, 409, '承認前は有効化できない');
  const appr = await member('しょうにん', { status: null });
  assert.equal((await AP(adm, 'salon-member-set', { email: appr.email, status: 'active' })).status, 200);
  assert.equal((await S(appr.cookie, 'bootstrap')).status, 200);
  assert.equal((await AP(adm, 'salon-member-set', { email: appr.email, status: 'inactive' })).status, 200);
  assert.equal((await S(appr.cookie, 'bootstrap')).status, 403);
  const audit = (await A(adm, 'salon-audit')).body.entries.map((e) => e.action);
  for (const a of ['salon_comment_deleted_by_staff', 'salon_post_pinned', 'salon_news_created', 'salon_post_deleted_by_staff', 'salon_member_status_set']) assert.ok(audit.includes(a), a);
});

/* ═════════ 認証の調整（灯）：登録・承認・ログイン ═════════ */
test('登録→管理者の承認→ログイン。登録時の都道府県・場の種類・CTAの記録、審査中・見送りの案内', async () => {
  const email = `reg${Date.now()}@example.com`;
  const reg = await call(auth, '', 'register', { method: 'POST', body: { community: 'tomoshibi', fullName: '山田 花子', fullNameKana: 'やまだ はなこ', displayName: 'はなこ', email, password: 'password-1234', password2: 'password-1234', reason: '学びたいです', termsAccepted: true, prefecture: '千葉県', facilityLabel: '音楽教室', source: 'hero' } });
  assert.equal(reg.status, 200);
  const app = await store.getApplication('tomoshibi', email);
  assert.deepEqual([app.prefecture, app.facilityLabel, app.source, app.status], ['千葉県', '音楽教室', 'hero', 'pending']);
  const prof = await Salon.getProfile(email);
  assert.deepEqual([prof.displayName, prof.prefecture, prof.facilityLabel, prof.listVisibility], ['はなこ', '千葉県', '音楽教室', 'public']);
  const bad = await call(auth, '', 'register', { method: 'POST', body: { community: 'tomoshibi', fullName: 'a', fullNameKana: 'あ', displayName: 'a', email: `x${Date.now()}@example.com`, password: 'password-1234', password2: 'password-1234', reason: 'r', termsAccepted: true, prefecture: 'アトランティス' } });
  assert.equal(bad.status, 400);
  const login0 = await call(auth, '', 'login', { method: 'POST', body: { community: 'tomoshibi', email, password: 'password-1234' } });
  assert.equal(login0.status, 403); assert.equal(login0.body.code, 'pending');
  // 管理画面の申請一覧に「灯」の申請として出る → 承認
  const adm = await adminCookie('root@example.com', 'super_admin');
  const list = await A(adm, 'applications', { query: { community: 'tomoshibi', status: 'pending' } });
  assert.ok(list.body.applications.some((a) => a.email === email), '管理画面の灯の申請一覧に反映される');
  assert.equal((await AP(adm, 'approve', { community: 'tomoshibi', email })).status, 200);
  const login = await call(auth, '', 'login', { method: 'POST', body: { community: 'tomoshibi', email, password: 'password-1234' } });
  assert.equal(login.status, 200); assert.equal(login.body.redirect, '/salon/tomoshibi/');
  assert.match(String([].concat(login.headers['set-cookie'] || []).join(';')), /Max-Age=\d+/, '既定はログインしたまま（Max-Ageあり）');
  const cookie = [].concat(login.headers['set-cookie']).map((c) => c.split(';')[0]).join('; ');
  assert.equal((await S(cookie, 'bootstrap')).status, 200, '承認後は、サロンに入れる');
  // 見送り
  const rej = await member('みおくり', { status: null, email: `rej${Date.now()}@example.com` });
  await store.resolveApplication('tomoshibi', rej.email, 'rejected', 'x');
  await store.saveUser({ email: rej.email, passwordHash: await hashPassword('password-1234') });
  const rl = await call(auth, '', 'login', { method: 'POST', body: { community: 'tomoshibi', email: rej.email, password: 'password-1234' } });
  assert.equal(rl.status, 403); assert.equal(rl.body.code, 'rejected');
});

test('決済を求める設計（SALON_REQUIRE_PAYMENT=1）：承認だけでは有効にならず、運営が有効化するまで入れない', async () => {
  process.env.SALON_REQUIRE_PAYMENT = '1';
  try {
    const email = `pay${Date.now()}@example.com`;
    await store.saveUser({ email, displayName: 'ぺい', fullName: 'ぺい', fullNameKana: 'ぺい', passwordHash: await hashPassword('password-1234') });
    await store.createApplication('tomoshibi', { email, fullName: 'ぺい', fullNameKana: 'ぺい', displayName: 'ぺい' });
    const adm = await adminCookie('root@example.com', 'super_admin');
    assert.equal((await AP(adm, 'approve', { community: 'tomoshibi', email })).status, 200);
    assert.equal(await store.getMembership('tomoshibi', email), null, '承認しても有効にならない');
    const l = await call(auth, '', 'login', { method: 'POST', body: { community: 'tomoshibi', email, password: 'password-1234' } });
    assert.equal(l.status, 403); assert.equal(l.body.code, 'reregister', '再登録のご案内（code）');
    await Salon.setStaff('root@example.com', SEC);
    assert.equal((await AP(adm, 'salon-member-set', { email, status: 'active' })).status, 200);
    assert.equal((await call(auth, '', 'login', { method: 'POST', body: { community: 'tomoshibi', email, password: 'password-1234' } })).status, 200);
  } finally { delete process.env.SALON_REQUIRE_PAYMENT; await Salon.setStaff('root@example.com', null); }
});

test('ログイン：連続失敗でロック（5回）。ロック中は正しいパスワードでも入れない。ログインしたまま=OFFは期限つきCookie。HAKUのログインは影響を受けない', async () => {
  const m = await member('ろっく', { email: `lock${Date.now()}@example.com` });
  await store.saveUser({ email: m.email, passwordHash: await hashPassword('correct-password') });
  for (let i = 0; i < 5; i++) assert.equal((await call(auth, '', 'login', { method: 'POST', body: { community: 'tomoshibi', email: m.email, password: 'wrong' + i } })).status, 401);
  const locked = await call(auth, '', 'login', { method: 'POST', body: { community: 'tomoshibi', email: m.email, password: 'correct-password' } });
  assert.equal(locked.status, 429); assert.equal(locked.body.code, 'locked');
  await Salon.clearLoginFailures(m.email);
  const keepOff = await call(auth, '', 'login', { method: 'POST', body: { community: 'tomoshibi', email: m.email, password: 'correct-password', keep: false } });
  assert.equal(keepOff.status, 200);
  assert.ok(!/Max-Age=/.test([].concat(keepOff.headers['set-cookie']).join(';')), '「ログインしたまま」OFFはブラウザを閉じると切れるCookie');
  // 認証失敗の文面は、メールとパスワードのどちらが違うかを示さない
  const wrongUser = await call(auth, '', 'login', { method: 'POST', body: { community: 'tomoshibi', email: 'nobody@example.com', password: 'whatever12' } });
  const wrongPw = await call(auth, '', 'login', { method: 'POST', body: { community: 'tomoshibi', email: m.email, password: 'nope' } });
  assert.equal(wrongUser.body.error, 'メールアドレスまたはパスワードが違います。'); assert.equal(wrongPw.body.error, wrongUser.body.error);
  // HAKUのログインには、灯のロックは影響しない
  assert.equal((await Salon.loginFailureCount(m.email)) >= 0, true);
  const haku = await member('はくログイン', { community: 'haku', email: `hk${Date.now()}@example.com` });
  await store.saveUser({ email: haku.email, passwordHash: await hashPassword('haku-password-1') });
  await store.resolveApplication('haku', haku.email, 'paid', 'x');
  assert.equal((await call(auth, '', 'login', { method: 'POST', body: { community: 'haku', email: haku.email, password: 'haku-password-1' } })).status, 200);
  assert.equal((await call(auth, '', 'login', { method: 'POST', body: { community: 'tomoshibi', email: haku.email, password: 'haku-password-1' } })).status, 403, 'HAKU会員は灯にはログインできない');
});

test('メールのリンクは灯の新しいURL（/salon/tomoshibi/…）。退会の導線（既存のwithdraw）で会員資格が無効になり、入れなくなる', async () => {
  const fs = await import('node:fs');
  const notify = fs.readFileSync(new URL('../api/_lib/notify.js', import.meta.url), 'utf8');
  assert.ok(notify.includes('/salon/tomoshibi/set-password/') && notify.includes('/salon/tomoshibi/login/'));
  assert.ok(!notify.includes('tomoshibi-login.html') && !notify.includes('community-set-password.html'));
  const m = await member('たいかい');
  assert.equal((await S(m.cookie, 'bootstrap')).status, 200);
  const w = await call(auth, m.cookie, 'withdraw', { method: 'POST', body: { community: 'tomoshibi' } });
  assert.equal(w.status, 200);
  assert.equal((await S(m.cookie, 'bootstrap')).status, 403, '退会後は入れない');
  assert.equal((await store.getMembership('haku', m.email)), null, 'HAKUの会員資格には影響しない');
});

test('レスポンスに、他人のメール・本名・パスワードのハッシュが含まれない（画面に返るすべてのAPI）', async () => {
  const a = await member('あや', { profile: { displayName: 'あや', prefecture: '千葉県', facilityLabel: '塾' } }); const b = await member('ぼん');
  const post = (await P(a.cookie, 'post-create', { channel: 'case', body: '相談', hideFacility: false })).body.post;
  await P(b.cookie, 'comment-create', { postId: post.id, body: 'コメント' });
  const outs = [await S(b.cookie, 'bootstrap'), await S(b.cookie, 'feed', { ch: 'home' }), await S(b.cookie, 'members'), await S(b.cookie, 'comments', { postId: post.id }), await S(b.cookie, 'search', { q: '相談' }), await S(b.cookie, 'me')];
  for (const r of outs) { const t = json(r); assert.ok(!t.includes(a.email) && !t.includes('本名あや') && !/passwordHash|ほんみょう/.test(t), JSON.stringify(Object.keys(r.body))); }
  assert.ok(!json(outs[5]).includes(b.email), '自分のメールも返さない（最小限）');
});

/**
 * 教育者のサロン「灯」の決済（Stripe 月額2,980円）のテスト。
 * Stripeは「偽のStripe」に差し替え、メール送信は記録だけ。本物のStripe・Resend・Redisには接続しない。
 * Webhookの署名検証だけは、本物のStripeライブラリの署名（generateTestHeaderString）で確かめる。
 *   node --test "tests-unit/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import RedisMock from 'ioredis-mock';
import Stripe from 'stripe';
import * as store from '../api/_lib/store.redis.js';
import * as Salon from '../api/_lib/salon-store.js';
import { hashPassword } from '../api/_lib/security.js';
import { FakeStripe, stripeEvent as event, completedEvent } from '../tests-e2e-local/fake-stripe.mjs';

store.__setRedisForTests(new RedisMock({ host: 'mock-salon-billing', port: 6379 }));
process.env.VERCEL_ENV = 'preview';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_for_unit_tests';
process.env.STRIPE_PRICE_ID = 'price_haku_test'; // HAKU Communityの料金（灯では使えない）
process.env.SALON_STRIPE_PRICE_ID = 'price_salon_test';
process.env.SALON_STRIPE_WEBHOOK_SECRET = 'whsec_salon_unit';
process.env.HAKU_STRIPE_WEBHOOK_SECRET = 'whsec_haku_unit';
process.env.RESEND_API_KEY = 're_test_dummy';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).includes('resend.com') ? new Response(JSON.stringify({ message: 'stubbed' }), { status: 401 }) : realFetch(url, init));

const billing = await import('../api/_lib/salon-billing.js');
const { mail } = await import('../api/_lib/salon-mail.js');
const { default: salonWebhook } = await import('../api/salon-stripe-webhook.js');
const { default: hakuWebhook } = await import('../api/haku-stripe-webhook.js');
const { default: salon } = await import('../api/salon.js');
const { default: auth } = await import('../api/community-auth.js');
const { default: admin } = await import('../api/admin.js');

// ── メール：送らずに記録する ──
const sent = [];
for (const name of Object.keys(mail)) mail[name] = async (args) => { sent.push({ name, args }); return { ok: true, id: 'mail_stub' }; };
const mails = (name, email) => sent.filter((m) => m.name === name && (!email || m.args.email === email));

// ── 偽のStripe（tests-e2e-local/fake-stripe.mjs と共有） ──
let fake;
function freshStripe() {
  fake = new FakeStripe();
  billing.deps.stripeFactory = () => fake.api;
  billing.resetPriceCache();
}
freshStripe();

// ── 部品 ──
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
  const n = ++ipSeq; const ip = `10.9.${(n >> 8) & 255}.${n & 255}`;
  const res = fakeRes();
  await handler({ method, query: { action, ...query }, body, headers: { cookie: cookie || '', host: 'localhost:3000', 'x-forwarded-for': ip, ...headers }, socket: { remoteAddress: ip } }, res);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}
const S = (cookie, action, query) => call(salon, cookie, action, { query });
const CHECKOUT = (email, password = 'password-1234') => call(salon, '', 'checkout', { method: 'POST', body: { email, password } });
const AP = (cookie, action, body) => call(admin, cookie, action, { method: 'POST', body });
const A = (cookie, action, opts) => call(admin, cookie, action, opts);
const adminCookie = async (actorId, role = 'staff') => `ht_admin_session=${await store.createAdminSession({ actorId, role })}`;

let seq = 0;
async function applicant(name, { status = 'approved', membership = null } = {}) {
  const email = `b${++seq}_${Date.now()}@example.com`;
  await store.saveUser({ email, displayName: name, fullName: `本名${name}`, fullNameKana: 'ほんみょう', passwordHash: await hashPassword('password-1234') });
  await store.createApplication('tomoshibi', { email, fullName: `本名${name}`, fullNameKana: 'ほんみょう', displayName: name, reason: '参加したい' });
  if (status !== 'pending') await store.resolveApplication('tomoshibi', email, status, 'seed');
  if (membership) await store.setMembership('tomoshibi', email, membership);
  return email;
}

// 署名つきのWebhookを、実際のハンドラへ送る
async function deliver(handler, ev, { secret, signature } = {}) {
  const payload = JSON.stringify(ev);
  const header = signature === undefined ? Stripe.webhooks.generateTestHeaderString({ payload, secret }) : signature;
  const req = Readable.from([Buffer.from(payload)]);
  req.method = 'POST'; req.headers = { 'stripe-signature': header, host: 'localhost:3000' };
  const res = fakeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
}
const toSalon = (ev, opts = {}) => deliver(salonWebhook, ev, { secret: 'whsec_salon_unit', ...opts });
const toHaku = (ev, opts = {}) => deliver(hakuWebhook, ev, { secret: 'whsec_haku_unit', ...opts });
const subEvent = (type, sub) => event(type, { ...sub });

/* ═════════ Checkout：承認済みの人だけ。金額・Priceはサーバーが決める ═════════ */
test('Checkout：月額2,980円の灯専用Priceで作る。メタデータ・戻り先は灯のもの。クライアントは金額を指定できない', async () => {
  freshStripe();
  const email = await applicant('ちぇっく');
  const r = await CHECKOUT(email);
  assert.equal(r.status, 200); assert.match(r.body.url, /^https:\/\/checkout\.stripe\.test\/cs_test_/);
  const s = [...fake.sessions.values()][0];
  assert.equal(s.params.mode, 'subscription');
  assert.deepEqual(s.params.line_items, [{ price: 'price_salon_test', quantity: 1 }]);
  assert.deepEqual(s.params.metadata, { product: 'tomoshibi_salon', community: 'tomoshibi', email, applicationId: email, userId: email });
  assert.deepEqual(s.params.subscription_data.metadata, s.params.metadata);
  assert.equal(s.params.customer_email, email);
  assert.match(s.params.success_url, /\/salon\/tomoshibi\/thanks\/\?session_id=\{CHECKOUT_SESSION_ID\}$/);
  assert.match(s.params.cancel_url, /\/salon\/tomoshibi\/cancel\/$/);
  assert.ok(!JSON.stringify(s.params).includes('haku'), 'HAKUの値は入らない');
  // クライアントが priceId / amount を送っても、使われない
  const e2 = await applicant('かいざん');
  const r2 = await call(salon, '', 'checkout', { method: 'POST', body: { email: e2, password: 'password-1234', priceId: 'price_haku_test', amount: 1, price: 'price_evil' } });
  assert.equal(r2.status, 200);
  assert.equal([...fake.sessions.values()].at(-1).params.line_items[0].price, 'price_salon_test');
});

test('Checkout：設定の確認。灯のPrice未設定・HAKUと同じPrice・金額が違うPriceでは、決済を始めさせない', async () => {
  freshStripe(); const email = await applicant('せってい');
  const saved = process.env.SALON_STRIPE_PRICE_ID;
  try {
    delete process.env.SALON_STRIPE_PRICE_ID;
    assert.equal((await CHECKOUT(email)).status, 500); assert.equal(fake.calls.sessionCreate, 0);
    process.env.SALON_STRIPE_PRICE_ID = 'price_haku_test'; // HAKUのPriceの使い回し
    const shared = await CHECKOUT(email); assert.equal(shared.status, 500); assert.equal(shared.body.code, 'config_price_shared');
    process.env.SALON_STRIPE_PRICE_ID = 'price_salon_test';
    fake.prices.price_salon_test.unit_amount = 3300; billing.resetPriceCache();
    const wrong = await CHECKOUT(email); assert.equal(wrong.status, 500); assert.equal(wrong.body.code, 'price_mismatch');
    fake.prices.price_salon_test.unit_amount = 2980; fake.prices.price_salon_test.recurring.interval = 'year'; billing.resetPriceCache();
    assert.equal((await CHECKOUT(email)).body.code, 'price_mismatch', '年額は不可');
    fake.prices.price_salon_test.recurring.interval = 'month'; billing.resetPriceCache();
    assert.equal(fake.calls.sessionCreate, 0);
    assert.equal((await CHECKOUT(email)).status, 200);
  } finally { process.env.SALON_STRIPE_PRICE_ID = saved; }
});

test('Checkout：承認前（審査中・却下・未登録）は決済できない。外向きの理由は同じ（状態を推測されない）', async () => {
  freshStripe();
  const pending = await applicant('しんさ', { status: 'pending' });
  const rejected = await applicant('みおくり', { status: 'rejected' });
  const out = [await CHECKOUT(pending), await CHECKOUT(rejected)];
  for (const r of out) assert.equal(r.status, 403);
  assert.equal(out[0].body.error, out[1].body.error);
  // 未登録のメールは、パスワードの照合でも弾かれる（401）
  assert.equal((await CHECKOUT('nobody@example.com')).status, 401);
  // 正しいメールでもパスワードが違えば401（本人でなければ決済を始められない）
  const ok = await applicant('ほんにん');
  assert.equal((await CHECKOUT(ok, 'wrong-password')).status, 401);
  assert.equal(fake.calls.sessionCreate, 0, 'どのケースでもStripeのSessionは作られない');
});

test('Checkout：パスワードを連続で間違えるとロック（5回）。ロック中は正しいパスワードでも決済を始められない', async () => {
  freshStripe(); const email = await applicant('ろっく');
  for (let i = 0; i < 5; i++) assert.equal((await CHECKOUT(email, 'bad-password')).status, 401);
  const locked = await CHECKOUT(email); assert.equal(locked.status, 429); assert.equal(locked.body.code, 'locked');
  assert.equal(fake.calls.sessionCreate, 0);
});

test('Checkout：すでに会員（有効・解約予約中）・支払い遅れ・無効の人は、新しい決済を始められない（二重決済防止）', async () => {
  freshStripe();
  const a = await applicant('ゆうこう', { membership: { status: 'active', stripeSubscriptionId: 'sub_x' } });
  const c = await applicant('かいやく', { membership: { status: 'canceling', stripeSubscriptionId: 'sub_y' } });
  const p = await applicant('おくれ', { membership: { status: 'past_due', stripeSubscriptionId: 'sub_z' } });
  const i = await applicant('むこう', { membership: { status: 'inactive' } });
  assert.equal((await CHECKOUT(a)).body.alreadyActive, true);
  assert.equal((await CHECKOUT(c)).status, 409);
  assert.equal((await CHECKOUT(p)).body.pastDue, true);
  assert.equal((await CHECKOUT(i)).status, 403, '運営が無効にした人は、支払いで自分を有効にできない');
  assert.equal(fake.calls.sessionCreate, 0);
});

test('Checkout：連打・同時リクエストでも、有効なSessionは1つだけ（同じURLを返す）。期限切れなら作り直す。支払い済みなら確認中', async () => {
  freshStripe(); const email = await applicant('れんだ');
  const rs = await Promise.all([CHECKOUT(email), CHECKOUT(email), CHECKOUT(email)]);
  assert.equal(fake.calls.sessionCreate, 1, '同時に3回でもSessionは1つ');
  const urls = rs.filter((r) => r.status === 200).map((r) => r.body.url);
  assert.ok(urls.length >= 1 && new Set(urls).size === 1);
  assert.ok(rs.every((r) => r.status === 200 || r.body.checkoutInProgress), '残りは「進行中」の案内');
  const again = await CHECKOUT(email); assert.equal(again.status, 200); assert.equal(fake.calls.sessionCreate, 1, '後から押しても同じSession');
  const s = [...fake.sessions.values()][0]; s.status = 'expired';
  const fresh = await CHECKOUT(email); assert.equal(fresh.status, 200); assert.equal(fake.calls.sessionCreate, 2, '期限切れなら新しく作る');
  const s2 = [...fake.sessions.values()][1]; fake.pay(s2);
  const processing = await CHECKOUT(email); assert.equal(processing.status, 409); assert.equal(processing.body.code, 'processing'); assert.equal(fake.calls.sessionCreate, 2);
});

/* ═════════ Webhook：署名・安全装置 ═════════ */
test('Webhook：署名が不正・なし・別のSecret（HAKU用）は400。テスト環境のイベントだけ処理。本番では何もしない', async () => {
  freshStripe(); const email = await applicant('しょめい');
  await CHECKOUT(email); const s = [...fake.sessions.values()][0]; fake.pay(s);
  const ev = completedEvent(s);
  assert.equal((await toSalon(ev, { signature: 'bad' })).status, 400);
  assert.equal((await toSalon(ev, { signature: '' })).status, 400);
  assert.equal((await toSalon(ev, { secret: 'whsec_haku_unit' })).status, 400, 'HAKUの署名Secretでは通らない');
  assert.equal(await store.getMembership('tomoshibi', email), null);
  const live = await toSalon(event('checkout.session.completed', { ...ev.data.object }, { livemode: true }));
  assert.equal(live.status, 200); assert.equal(live.body.skipped, 'livemode'); assert.equal(await store.getMembership('tomoshibi', email), null);
  process.env.VERCEL_ENV = 'production';
  try { const prod = await toSalon(ev); assert.equal(prod.body.skipped, 'production'); assert.equal(await store.getMembership('tomoshibi', email), null); } finally { process.env.VERCEL_ENV = 'preview'; }
  const saved = process.env.SALON_STRIPE_WEBHOOK_SECRET; delete process.env.SALON_STRIPE_WEBHOOK_SECRET;
  try { assert.equal((await toSalon(ev)).status, 500); } finally { process.env.SALON_STRIPE_WEBHOOK_SECRET = saved; }
  assert.equal((await call(salonWebhook, '', 'x', { method: 'GET' })).status, 405);
});

/* ═════════ 決済完了 → 会員有効化 ═════════ */
test('決済完了：Webhookで確認して初めて会員になる。申請は paid・利用開始メール1通・顧客の索引は灯専用（HAKUの索引・会員資格には書かない）', async () => {
  freshStripe(); sent.length = 0;
  const email = await applicant('かんりょう');
  await CHECKOUT(email); const s = [...fake.sessions.values()][0];
  assert.equal(await store.getMembership('tomoshibi', email), null, '決済ページを作っただけでは会員にならない');
  assert.equal((await S(`ht_session=${await store.createSession(email)}`, 'bootstrap')).status, 403);
  const sub = fake.pay(s); // 成功ページに戻っただけ（Webhook前）でも会員にはならない
  assert.equal((await billing.paymentStatus(s.id)).state, 'processing');
  assert.equal(await store.getMembership('tomoshibi', email), null);
  const r = await toSalon(completedEvent(s));
  assert.equal(r.status, 200);
  const m = await store.getMembership('tomoshibi', email);
  assert.deepEqual([m.status, m.stripeSubscriptionId, m.stripeCustomerId, m.source, m.cancelAtPeriodEnd], ['active', sub.id, sub.customer, 'stripe', false]);
  assert.ok(m.currentPeriodEnd > Date.now());
  assert.equal((await store.getApplication('tomoshibi', email)).status, 'paid');
  assert.equal(mails('usageStart', email).length, 1);
  assert.equal(mails('usageStart', email)[0].args.amountLabel, '2,980円');
  assert.equal((await S(`ht_session=${await store.createSession(email)}`, 'bootstrap')).status, 200, '決済後は入れる');
  assert.equal((await billing.paymentStatus(s.id)).state, 'active');
  assert.equal(await Salon.emailByStripeCustomer(sub.customer), email);
  assert.equal(await store.getEmailByStripeCustomer(sub.customer), null, 'HAKUの顧客索引には書かない');
  assert.equal(await store.getMembership('haku', email), null, 'HAKUの会員資格は作られない');
});

test('決済完了：メールアドレスは決済画面で入力された値ではなく、サーバーが入れたmetadataで判断する', async () => {
  freshStripe(); sent.length = 0;
  const email = await applicant('なりすまし'); const victim = await applicant('ひがいしゃ');
  await CHECKOUT(email); const s = [...fake.sessions.values()][0]; fake.pay(s);
  const ev = completedEvent(s); ev.data.object.customer_details = { email: victim, name: 'x' }; ev.data.object.customer_email = victim;
  await toSalon(ev);
  assert.equal((await store.getMembership('tomoshibi', email)).status, 'active');
  assert.equal(await store.getMembership('tomoshibi', victim), null);
});

test('Webhook：同じイベントの重複・同時配信でも、会員の更新とメールは1回だけ。処理に失敗したときは再送で処理し直せる', async () => {
  freshStripe(); sent.length = 0;
  const email = await applicant('じゅうふく');
  await CHECKOUT(email); const s = [...fake.sessions.values()][0]; fake.pay(s);
  const ev = completedEvent(s);
  const rs = await Promise.all([toSalon(ev), toSalon(ev), toSalon(ev)]);
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(mails('usageStart', email).length, 1);
  assert.equal((await toSalon(ev)).body.skipped, 'duplicate_event');
  assert.equal(mails('usageStart', email).length, 1);
  // 失敗→再送：StripeのAPIが一時的に落ちている間は500（処理中の印は外れる）。回復後の再送で処理される
  const e2 = await applicant('さいそう'); await CHECKOUT(e2); const s2 = [...fake.sessions.values()].at(-1); fake.pay(s2);
  const ev2 = completedEvent(s2);
  const orig = fake.subscriptions.retrieve; fake.subscriptions.retrieve = async () => { throw new Error('stripe down'); };
  assert.equal((await toSalon(ev2)).status, 500); assert.equal(await store.getMembership('tomoshibi', e2), null);
  fake.subscriptions.retrieve = orig;
  assert.equal((await toSalon(ev2)).status, 200); assert.equal((await store.getMembership('tomoshibi', e2)).status, 'active');
});

test('Webhook：順不同・遅延。古いイベントが後から届いても、Stripeのいまの状態に揃う（解約済みを有効に戻さない）', async () => {
  freshStripe(); sent.length = 0;
  // ① 更新（有効）が、完了イベントより先に届く → その時点で有効化。後から完了が届いてもメールは重複しない
  const a = await applicant('さきにこうしん'); await CHECKOUT(a); const sa = [...fake.sessions.values()].at(-1); const suba = fake.pay(sa);
  await toSalon(subEvent('customer.subscription.updated', suba));
  assert.equal((await store.getMembership('tomoshibi', a)).status, 'active');
  await toSalon(completedEvent(sa));
  assert.equal(mails('usageStart', a).length, 1, '利用開始メールは1通');
  // ② 支払い後すぐに解約された。完了イベントが遅れて届く → すでに終了しているので、有効にしない
  const b = await applicant('おくれてかんりょう'); await CHECKOUT(b); const sb = [...fake.sessions.values()].at(-1); const subb = fake.pay(sb);
  subb.status = 'canceled';
  await toSalon(completedEvent(sb));
  const mb = await store.getMembership('tomoshibi', b);
  assert.equal(mb.status, 'canceled', '有効に戻らない');
  assert.equal(mails('usageStart', b).length, 0);
  assert.equal((await S(`ht_session=${await store.createSession(b)}`, 'bootstrap')).status, 403);
  // ③ 古い「有効」の更新イベントが、解約後に届く → Stripeのいまの状態（canceled）が優先される
  const stale = subEvent('customer.subscription.updated', { ...subb, status: 'active' });
  await toSalon(stale);
  assert.equal((await store.getMembership('tomoshibi', b)).status, 'canceled');
});

test('支払い失敗：past_due（利用停止）＋メール1通。回復すると有効に戻る。past_dueではログインできない（新規決済も不可）', async () => {
  freshStripe(); sent.length = 0;
  const email = await applicant('しはらいしっぱい'); await CHECKOUT(email); const s = [...fake.sessions.values()].at(-1); const sub = fake.pay(s);
  await toSalon(completedEvent(s));
  sub.status = 'past_due';
  const fail = event('invoice.payment_failed', { id: 'in_1', subscription: sub.id, customer: sub.customer });
  await toSalon(fail); await toSalon(event('invoice.payment_failed', { id: 'in_1', subscription: sub.id, customer: sub.customer }));
  assert.equal((await store.getMembership('tomoshibi', email)).status, 'past_due');
  assert.equal(mails('paymentFailed', email).length, 1, '失敗メールは状態が変わったときの1通だけ');
  const login = await call(auth, '', 'login', { method: 'POST', body: { community: 'tomoshibi', email, password: 'password-1234' } });
  assert.equal(login.status, 403); assert.equal(login.body.code, 'past_due');
  assert.equal((await S(`ht_session=${await store.createSession(email)}`, 'bootstrap')).status, 403);
  assert.equal((await CHECKOUT(email)).body.pastDue, true);
  sub.status = 'active';
  await toSalon(event('invoice.paid', { id: 'in_2', subscription: sub.id, customer: sub.customer }));
  assert.equal((await store.getMembership('tomoshibi', email)).status, 'active');
  assert.equal(mails('usageStart', email).length, 1, '回復で利用開始メールは再送しない');
});

test('退会（解約）：期間の終わりまで利用可。メールは1通。Webhookで終了すると入れなくなる。HAKUの会員資格には影響しない', async () => {
  freshStripe(); sent.length = 0;
  const email = await applicant('たいかい'); await CHECKOUT(email); const s = [...fake.sessions.values()].at(-1); const sub = fake.pay(s);
  await toSalon(completedEvent(s));
  await store.setMembership('haku', email, { status: 'active' }); // 同じメールでHAKUの会員でもある
  const cookie = `ht_session=${await store.createSession(email)}`;
  const w = await call(auth, cookie, 'withdraw', { method: 'POST', body: { community: 'tomoshibi' } });
  assert.equal(w.status, 200); assert.equal(w.body.immediate, false);
  assert.deepEqual(fake.calls.subUpdate, [[sub.id, { cancel_at_period_end: true }]]);
  assert.equal((await store.getMembership('tomoshibi', email)).status, 'canceling');
  assert.equal((await S(cookie, 'bootstrap')).status, 200, '期間の終わりまでは使える');
  assert.equal(mails('cancelScheduled', email).length, 1);
  assert.equal((await call(auth, cookie, 'withdraw', { method: 'POST', body: { community: 'tomoshibi' } })).status, 409, '二重の解約はしない');
  await toSalon(subEvent('customer.subscription.updated', sub)); // Stripeからの同期。解約メールは重複しない
  assert.equal(mails('cancelScheduled', email).length, 1);
  assert.equal((await store.getMembership('tomoshibi', email)).status, 'canceling');
  sub.status = 'canceled';
  await toSalon(subEvent('customer.subscription.deleted', sub));
  assert.equal((await store.getMembership('tomoshibi', email)).status, 'canceled');
  assert.equal(mails('ended', email).length, 0, '解約予約済みの終了では、終了メールを重ねて送らない');
  assert.equal((await S(cookie, 'bootstrap')).status, 403, '終了後は入れない');
  assert.equal((await store.getMembership('haku', email)).status, 'active', 'HAKUの会員資格は変わらない');
});

test('二重決済：すでに有効な契約があるのに2本目のSubscriptionができたら、2本目を自動で解約して運営に知らせる', async () => {
  freshStripe(); sent.length = 0;
  const email = await applicant('にじゅう'); await CHECKOUT(email); const s1 = [...fake.sessions.values()].at(-1); const sub1 = fake.pay(s1);
  await toSalon(completedEvent(s1));
  // 古いリンクで、もう一度支払われた（2本目）
  const s2 = { id: 'cs_test_second1234567', status: 'open', params: s1.params, metadata: s1.metadata, mode: 'subscription' }; fake.sessions.set(s2.id, s2);
  const sub2 = fake.pay(s2);
  await toSalon(completedEvent(s2));
  assert.deepEqual(fake.calls.subCancel, [sub2.id]);
  const m = await store.getMembership('tomoshibi', email);
  assert.equal(m.stripeSubscriptionId, sub1.id, '会員の契約は1本目のまま');
  assert.equal(sent.filter((x) => x.name === 'adminAlert').length, 1);
});

test('承認前の決済・別のPrice・別の商品は、会員にしない（運営へ知らせる／無視する）', async () => {
  freshStripe(); sent.length = 0;
  const pending = await applicant('まえばらい', { status: 'pending' });
  const s = { id: 'cs_test_early12345678', status: 'open', params: { line_items: [{ price: 'price_salon_test' }], subscription_data: { metadata: { product: 'tomoshibi_salon', community: 'tomoshibi', email: pending } } }, metadata: { product: 'tomoshibi_salon', community: 'tomoshibi', email: pending }, mode: 'subscription' };
  fake.sessions.set(s.id, s); fake.pay(s);
  assert.equal((await toSalon(completedEvent(s))).body.skipped, 'application_not_approved');
  assert.equal(await store.getMembership('tomoshibi', pending), null);
  assert.equal(sent.filter((x) => x.name === 'adminAlert').length, 1);
  // 灯の目印はあるが、HAKUのPriceで作られたSubscription
  const e2 = await applicant('ぷらいす'); const s2 = { id: 'cs_test_price12345678', status: 'open', params: { line_items: [{ price: 'price_haku_test' }], subscription_data: { metadata: { product: 'tomoshibi_salon', community: 'tomoshibi', email: e2 } } }, metadata: { product: 'tomoshibi_salon', community: 'tomoshibi', email: e2 }, mode: 'subscription' };
  fake.sessions.set(s2.id, s2); fake.pay(s2);
  assert.equal((await toSalon(completedEvent(s2))).body.skipped, 'price_mismatch');
  assert.equal(await store.getMembership('tomoshibi', e2), null);
  // HAKUの商品の目印
  const e3 = await applicant('はくしょうひん');
  const hakuSession = { id: 'cs_test_haku1234567890', mode: 'subscription', payment_status: 'paid', subscription: 'sub_h', customer: 'cus_h', metadata: { product: 'haku_community', community: 'haku', email: e3 } };
  assert.equal((await toSalon(completedEvent(hakuSession))).body.skipped, 'not_salon');
  assert.equal((await toSalon(event('customer.subscription.updated', { id: 'sub_h', customer: 'cus_h', status: 'active', metadata: { product: 'haku_community', community: 'haku', email: e3 } }))).body.skipped, 'not_salon');
  assert.equal(await store.getMembership('tomoshibi', e3), null);
});

/* ═════════ HAKUと灯の分離 ═════════ */
test('分離：HAKUのWebhookは灯のイベントを無視し、灯のWebhookはHAKUのイベントを無視する。HAKUの会員資格・索引は変わらない', async () => {
  freshStripe(); sent.length = 0;
  const email = await applicant('ぶんり'); await CHECKOUT(email); const s = [...fake.sessions.values()].at(-1); const sub = fake.pay(s);
  await store.setMembership('haku', email, { status: 'active', stripeCustomerId: 'cus_haku_own', stripeSubscriptionId: 'sub_haku_own' });
  await store.createApplication('haku', { email, fullName: 'x', fullNameKana: 'x', displayName: 'x' }); await store.resolveApplication('haku', email, 'paid', 'seed');
  const hakuBefore = JSON.stringify(await store.getMembership('haku', email));
  // 灯の決済イベントを、HAKUのWebhook（HAKUの署名Secret）へ → 無視される
  const h1 = await toHaku(completedEvent(s)); assert.equal(h1.body.skipped, 'not_haku_community');
  const h2 = await toHaku(subEvent('customer.subscription.updated', sub)); assert.equal(h2.body.skipped, 'no_email_index');
  const h3 = await toHaku(event('invoice.payment_failed', { id: 'in_x', customer: sub.customer })); assert.equal(h3.body.skipped, 'no_email_index');
  const h4 = await toHaku(subEvent('customer.subscription.deleted', sub)); assert.equal(h4.body.skipped, 'no_email_index');
  assert.equal(JSON.stringify(await store.getMembership('haku', email)), hakuBefore, 'HAKUの会員資格は変わらない');
  assert.equal(await store.getMembership('tomoshibi', email), null, 'HAKUのWebhookは灯の会員も作らない');
  // 灯のWebhookで処理 → 灯だけが有効になる。HAKUのまま
  await toSalon(completedEvent(s));
  assert.equal((await store.getMembership('tomoshibi', email)).status, 'active');
  assert.equal(JSON.stringify(await store.getMembership('haku', email)), hakuBefore);
  // HAKUの決済イベントを、灯のWebhookへ → 無視される
  const hakuSession = { id: 'cs_test_hakuonly123456', mode: 'subscription', payment_status: 'paid', subscription: 'sub_haku_own', customer: 'cus_haku_own', metadata: { product: 'haku_community', community: 'haku', email } };
  assert.equal((await toSalon(completedEvent(hakuSession))).body.skipped, 'not_salon');
  const hakuSub = { id: 'sub_haku_own', customer: 'cus_haku_own', status: 'canceled', metadata: { product: 'haku_community', community: 'haku', email } };
  assert.equal((await toSalon(subEvent('customer.subscription.deleted', hakuSub))).body.skipped, 'not_salon');
  assert.equal((await store.getMembership('tomoshibi', email)).status, 'active', 'HAKUの解約で灯は変わらない');
});

test('分離：同じevent.idがHAKUとの両方に届いても、灯は灯専用の処理済み記録で処理する（HAKUの記録に巻き込まれない）', async () => {
  freshStripe(); sent.length = 0;
  const email = await applicant('どうじ'); await CHECKOUT(email); const s = [...fake.sessions.values()].at(-1); fake.pay(s);
  const ev = completedEvent(s);
  await store.markEventProcessed(ev.id); // HAKU側の処理済み記録に、同じIDが入っている状態
  const r = await toSalon(ev);
  assert.equal(r.status, 200); assert.equal(r.body.skipped, undefined);
  assert.equal((await store.getMembership('tomoshibi', email)).status, 'active', '灯は処理される');
  assert.equal(await store.isEventProcessed(ev.id), true);
  assert.equal(await store.getEmailByStripeCustomer(s.customer), null);
});

test('分離：同じメールアドレスでも、HAKUの会員資格だけでは灯に入れず、灯の会員資格だけではHAKUに入れない', async () => {
  freshStripe();
  const email = await applicant('りょうほう', { status: 'approved' });
  await store.setMembership('haku', email, { status: 'active' });
  const c = `ht_session=${await store.createSession(email)}`;
  assert.equal((await S(c, 'bootstrap')).status, 403, 'HAKUの会員は灯に入れない');
  const login = await call(auth, '', 'login', { method: 'POST', body: { community: 'tomoshibi', email, password: 'password-1234' } });
  assert.equal(login.body.code, 'payment_required', '灯としては、承認済み・お支払い待ち');
  await store.setMembership('tomoshibi', email, { status: 'active' });
  await store.deleteMembership('haku', email);
  assert.equal((await S(c, 'bootstrap')).status, 200);
  const hakuLogin = await call(auth, '', 'login', { method: 'POST', body: { community: 'haku', email, password: 'password-1234' } });
  assert.equal(hakuLogin.status, 403, '灯の会員はHAKUにログインできない');
});

test('分離：灯に申請していない人（HAKUの会員など）は、灯にログインしても「お支払い待ち」とは案内されない', async () => {
  freshStripe();
  const email = `hakuonly${Date.now()}@example.com`;
  await store.saveUser({ email, displayName: 'はく', fullName: 'はく', fullNameKana: 'はく', passwordHash: await hashPassword('password-1234') });
  await store.setMembership('haku', email, { status: 'active' });
  const login = await call(auth, '', 'login', { method: 'POST', body: { community: 'tomoshibi', email, password: 'password-1234' } });
  assert.equal(login.status, 403); assert.equal(login.body.code, 'reregister');
  assert.equal((await CHECKOUT(email)).status, 403, '灯に申請していない人は決済できない');
});

test('分離：メールアドレスを変更しても、灯の顧客の索引は灯専用のまま。変更後のメールのままWebhookが届く', async () => {
  freshStripe();
  const email = await applicant('へんこう'); await CHECKOUT(email); const s = [...fake.sessions.values()].at(-1); const sub = fake.pay(s);
  await toSalon(completedEvent(s));
  const cookie = `ht_session=${await store.createSession(email)}`;
  const newEmail = `new${Date.now()}@example.com`;
  const r = await call(auth, cookie, 'change-email', { method: 'POST', body: { currentPassword: 'password-1234', newEmail } });
  assert.equal(r.status, 200);
  assert.equal(await store.getEmailByStripeCustomer(sub.customer), null, 'HAKUの索引には書かない');
  assert.equal(await Salon.emailByStripeCustomer(sub.customer), newEmail);
  sub.status = 'past_due';
  await toSalon(event('invoice.payment_failed', { id: 'in_chg', subscription: sub.id, customer: sub.customer }));
  assert.equal((await store.getMembership('tomoshibi', newEmail)).status, 'past_due');
  assert.equal(await store.getMembership('tomoshibi', email), null, '古いメールの会員は作り直されない');
});

test('HAKUのコード・画面は変更していない（HAKUのCheckout・Webhook・メール・ストア・HAKU画面）', () => {
  const base = '85785d8'; // この作業の前のコミット
  const probe = spawnSync('git', ['cat-file', '-t', base], { cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
  if (probe.status !== 0) return; // 履歴が無い環境（浅いクローン等）では確認を省く
  const files = ['api/haku-checkout.js', 'api/haku-stripe-webhook.js', 'api/stripe-webhook.js', 'api/_lib/stripe-checkout.js', 'api/_lib/store.redis.js', 'api/_lib/store.js', 'api/_lib/notify.js', 'api/_lib/http.js', 'api/_lib/security.js', 'api/haku-home.js', 'api/_lib/points.js', 'api/_lib/morning.js', 'haku-community/home', 'haku-community/login', 'haku-community/register', 'haku-community/thanks', 'haku-community/cancel'];
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const diff = spawnSync('git', ['diff', '--stat', base, '--', ...files], { cwd: root, encoding: 'utf8' });
  assert.equal(diff.stdout.trim(), '', `HAKUの既存ファイルに差分があります:\n${diff.stdout}`);
});

test('HAKUの承認・却下・ログインは、これまでどおり（灯の処理は通らない）', async () => {
  freshStripe(); sent.length = 0;
  const email = `haku${Date.now()}@example.com`;
  await store.saveUser({ email, displayName: 'はく', fullName: 'はく', fullNameKana: 'はく', passwordHash: await hashPassword('password-1234') });
  await store.createApplication('haku', { email, fullName: 'はく', fullNameKana: 'はく', displayName: 'はく', referrerName: 'x' });
  const adm = await adminCookie('haku-admin@example.com', 'super_admin'); // 灯の運営ロールは持たない
  const savedKey = process.env.STRIPE_SECRET_KEY; process.env.STRIPE_SECRET_KEY = ''; // HAKUの決済ページ作成は、ここでは本物のStripeへ行かせない
  try {
    assert.equal((await AP(adm, 'approve', { community: 'haku', email })).status, 200, 'HAKUの承認は、灯の運営ロールが無くても通る');
  } finally { process.env.STRIPE_SECRET_KEY = savedKey; }
  assert.equal((await store.getApplication('haku', email)).status, 'approved');
  assert.equal(await store.getMembership('haku', email), null, 'HAKUは承認しても会員にならない（従来どおり）');
  assert.equal(sent.length, 0, '灯のメールは送られない');
  const login = await call(auth, '', 'login', { method: 'POST', body: { community: 'haku', email, password: 'password-1234' } });
  assert.equal(login.status, 403); assert.equal(login.body.canResumeCheckout, true, 'HAKUの決済再開の案内（従来どおり）');
  assert.equal(login.body.code, undefined);
  const e2 = `haku2${Date.now()}@example.com`;
  await store.createApplication('haku', { email: e2, fullName: 'b', fullNameKana: 'b', displayName: 'b', referrerName: 'x' });
  assert.equal((await AP(adm, 'reject', { community: 'haku', email: e2 })).status, 200);
  assert.equal((await store.getApplication('haku', e2)).status, 'rejected');
});

/* ═════════ 決済状況（成功ページ） ═════════ */
test('決済状況：open / processing / active / expired を返す。会員資格は変えない。不正なIDやHAKUのSessionは404・400', async () => {
  freshStripe();
  const email = await applicant('じょうきょう'); await CHECKOUT(email); const s = [...fake.sessions.values()].at(-1);
  const status = (id) => call(salon, '', 'payment-status', { query: { session_id: id } });
  assert.equal((await status(s.id)).body.state, 'open');
  fake.pay(s); assert.equal((await status(s.id)).body.state, 'processing');
  assert.equal(await store.getMembership('tomoshibi', email), null, '状況を見ても会員にはならない');
  await toSalon(completedEvent(s)); assert.equal((await status(s.id)).body.state, 'active');
  s.status = 'expired'; await store.setMembership('tomoshibi', email, { status: 'canceled' });
  assert.equal((await status(s.id)).body.state, 'expired');
  assert.equal((await status('not-a-session')).status, 400);
  fake.sessions.set('cs_test_hakusession1234', { id: 'cs_test_hakusession1234', metadata: { product: 'haku_community' }, status: 'complete' });
  assert.equal((await status('cs_test_hakusession1234')).status, 404);
  assert.ok(!JSON.stringify((await status(s.id)).body).includes(email), '応答にメールアドレスを含めない');
});

/* ═════════ 管理画面：申請・承認・決済の状態 ═════════ */
test('管理：申請一覧→承認→お支払いのご案内メール（Checkoutのリンク）。承認しても会員にはならず、二重承認は1回だけ', async () => {
  freshStripe(); sent.length = 0;
  const email = await applicant('しょうにん', { status: 'pending' });
  const st = await applicant('うんえい', { membership: { status: 'active' } }); await Salon.setStaff(st, { role: 'secretariat', title: '事務局' });
  const adm = await adminCookie(st, 'staff');
  const list = await A(adm, 'salon-applications', { query: { status: 'pending' } });
  const row = list.body.applications.find((a) => a.email === email);
  assert.deepEqual([row.application, row.payment, row.membership], ['pending', 'review', null]);
  assert.ok(!JSON.stringify(list.body).includes('sub_'), 'StripeのIDそのものは返さない');
  // 承認ボタンの二重操作
  const rs = await Promise.all([AP(adm, 'salon-application-approve', { email }), AP(adm, 'salon-application-approve', { email })]);
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(mails('approved', email).length, 1, '承認メールは1通');
  assert.match(mails('approved', email)[0].args.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(fake.calls.sessionCreate, 1, 'Checkoutは1つだけ');
  assert.equal(await store.getMembership('tomoshibi', email), null, '承認しても会員にならない');
  assert.equal((await store.getApplication('tomoshibi', email)).status, 'approved');
  const unpaid = (await A(adm, 'salon-applications', { query: { status: 'approved' } })).body.applications.find((a) => a.email === email);
  assert.equal(unpaid.payment, 'unpaid');
  // 承認後の再承認・却下はできない
  assert.equal((await AP(adm, 'salon-application-approve', { email })).status === 200, false);
  assert.equal((await AP(adm, 'salon-application-reject', { email })).status === 200, false);
  // 決済案内の再送：同じCheckoutを再利用する
  const again = await AP(adm, 'salon-payment-link', { email });
  assert.equal(again.status, 200); assert.equal(fake.calls.sessionCreate, 1, '再送でも新しいCheckoutは作らない');
  assert.equal(mails('approved', email).at(-1).args.checkoutUrl, mails('approved', email)[0].args.checkoutUrl);
  // 決済後は「決済済み」
  fake.pay([...fake.sessions.values()][0]); await toSalon(completedEvent([...fake.sessions.values()][0]));
  const paid = (await A(adm, 'salon-applications', { query: { status: 'approved' } })).body.applications.find((a) => a.email === email);
  assert.deepEqual([paid.payment, paid.membership, paid.hasSubscription], ['paid', 'active', true]);
  assert.equal((await AP(adm, 'salon-payment-link', { email })).status, 409, '決済済みの人には送れない');
  const audit = (await A(adm, 'salon-audit')).body.entries.map((e) => e.action);
  for (const a of ['salon_application_approved', 'salon_checkout_created', 'salon_membership_activated', 'salon_payment_link_sent']) assert.ok(audit.includes(a), a);
});

test('管理：Stripeの設定が未完了でも承認できる（ログイン画面から進むご案内に切り替わる）。却下は1回だけ・却下メールが届く', async () => {
  freshStripe(); sent.length = 0;
  const st = await applicant('うんえい2', { membership: { status: 'active' } }); await Salon.setStaff(st, { role: 'owner', title: '代表' });
  const adm = await adminCookie(st, 'staff');
  const saved = process.env.SALON_STRIPE_PRICE_ID; delete process.env.SALON_STRIPE_PRICE_ID;
  const email = await applicant('せっていまえ', { status: 'pending' });
  try {
    const r = await AP(adm, 'salon-application-approve', { email });
    assert.equal(r.status, 200); assert.equal(r.body.checkout, 'fallback');
    assert.equal(mails('approved', email)[0].args.checkoutUrl, null);
    assert.match(mails('approved', email)[0].args.loginUrl, /\/salon\/tomoshibi\/login\/$/);
  } finally { process.env.SALON_STRIPE_PRICE_ID = saved; }
  // その後、設定が整えば、ログイン画面から決済へ進める
  const go = await CHECKOUT(email); assert.equal(go.status, 200);
  const rej = await applicant('きゃっか', { status: 'pending' });
  const rr = await Promise.all([AP(adm, 'salon-application-reject', { email: rej }), AP(adm, 'salon-application-reject', { email: rej })]);
  assert.equal(rr.filter((x) => x.status === 200).length, 1);
  assert.equal(mails('rejected', rej).length, 1);
  assert.equal((await store.getApplication('tomoshibi', rej)).status, 'rejected');
  assert.equal((await CHECKOUT(rej)).status, 403, '却下された人は決済できない');
});

test('管理：権限はAPI側で確認する。灯の運営ロールがない管理者は、申請・決済・会員の操作がすべて403', async () => {
  freshStripe();
  const email = await applicant('けんげん', { status: 'pending' });
  const outsider = await adminCookie('haku-only-admin@example.com', 'super_admin');
  for (const [a, opts] of [['salon-applications', {}], ['salon-members', {}], ['salon-audit', {}]]) assert.equal((await A(outsider, a, opts)).status, 403, a);
  for (const a of ['salon-application-approve', 'salon-application-reject', 'salon-payment-link', 'salon-member-set']) assert.equal((await AP(outsider, a, { email, status: 'active', reason: 'x' })).status, 403, a);
  assert.equal((await AP(outsider, 'approve', { community: 'tomoshibi', email })).status, 403, '旧「会員申請」タブからの承認も同じ');
  assert.equal((await store.getApplication('tomoshibi', email)).status, 'pending');
  assert.equal((await A('', 'salon-applications')).status, 401, '管理者ログインなしは401');
  process.env.VERCEL_ENV = 'production';
  try { const st = await applicant('ほんばん'); await Salon.setStaff(st, { role: 'owner', title: '代表' }); assert.equal((await A(await adminCookie(st, 'staff'), 'salon-applications')).status, 403, '本番では動かない'); assert.equal((await CHECKOUT(email)).status, 403); } finally { process.env.VERCEL_ENV = 'preview'; }
});

test('管理：Stripeの契約が生きている会員は、手動で有効・無効にできない。決済免除は理由つき', async () => {
  freshStripe();
  const st = await applicant('うんえい3', { membership: { status: 'active' } }); await Salon.setStaff(st, { role: 'owner', title: '代表' });
  const adm = await adminCookie(st, 'staff');
  const payer = await applicant('しはらいちゅう', { membership: { status: 'active', stripeSubscriptionId: 'sub_live', source: 'stripe' } });
  assert.equal((await AP(adm, 'salon-member-set', { email: payer, status: 'inactive', reason: 'x' })).status, 409);
  assert.equal((await store.getMembership('tomoshibi', payer)).status, 'active');
  const guest = await applicant('しょうたい');
  assert.equal((await AP(adm, 'salon-member-set', { email: guest, status: 'active' })).status, 400, '理由なしは不可');
  assert.equal((await AP(adm, 'salon-member-set', { email: guest, status: 'active', reason: '招待のため' })).status, 200);
  const m = await store.getMembership('tomoshibi', guest);
  assert.deepEqual([m.billingExempt, m.exemptReason, m.stripeSubscriptionId], [true, '招待のため', null]);
  const row = (await A(adm, 'salon-applications', { query: { status: 'approved' } })).body.applications.find((a) => a.email === guest);
  assert.equal(row.payment, 'exempt');
  // 決済免除の会員の退会は、その場で無効（Stripeの契約が無い）
  const w = await call(auth, `ht_session=${await store.createSession(guest)}`, 'withdraw', { method: 'POST', body: { community: 'tomoshibi' } });
  assert.equal(w.status, 200); assert.equal(w.body.immediate, true);
  assert.equal((await store.getMembership('tomoshibi', guest)).status, 'inactive');
});

test('登録：灯の申請は灯専用の文面で、運営と本人にメールする。紹介者名は任意。HAKUの登録メールは従来のまま', async () => {
  freshStripe(); sent.length = 0;
  const email = `reg${Date.now()}@example.com`;
  const body = { community: 'tomoshibi', fullName: '山田 花子', fullNameKana: 'やまだ はなこ', displayName: 'はなこ', email, password: 'password-1234', password2: 'password-1234', reason: '学びたいです', termsAccepted: true, referrerName: '佐藤先生' };
  assert.equal((await call(auth, '', 'register', { method: 'POST', body })).status, 200);
  assert.equal(mails('adminNotice').length, 1); assert.equal(mails('adminNotice')[0].args.referrerName, '佐藤先生');
  assert.equal(mails('applicationReceived', email).length, 1);
  assert.equal((await store.getApplication('tomoshibi', email)).referrerName, '佐藤先生');
  const e2 = `reg2${Date.now()}@example.com`;
  assert.equal((await call(auth, '', 'register', { method: 'POST', body: { ...body, email: e2, referrerName: '' } })).status, 200, '紹介者名は空でもよい');
  // HAKUは紹介者名が必須（従来どおり）
  assert.equal((await call(auth, '', 'register', { method: 'POST', body: { ...body, community: 'haku', email: `h${Date.now()}@example.com`, referrerName: '' } })).status, 400);
  // 承認済みで再登録 → ログインからお支払いへ
  await store.resolveApplication('tomoshibi', email, 'approved', 'x');
  const again = await call(auth, '', 'register', { method: 'POST', body });
  assert.equal(again.status, 409); assert.match(again.body.error, /お支払い/);
});

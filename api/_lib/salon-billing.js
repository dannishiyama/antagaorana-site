/**
 * api/_lib/salon-billing.js
 * 教育者のサロン「灯」専用の決済（Stripe 月額サブスクリプション）。HAKU Communityの決済コードには触れず、
 * 同じ考え方（承認済みだけがCheckoutへ進める／二重決済防止／Webhookの署名検証と二重処理防止）を灯専用に実装している。
 *
 * 分離の要点：
 *   - Stripe: 灯専用の Price（SALON_STRIPE_PRICE_ID）と、灯専用の Webhook 署名Secret（SALON_STRIPE_WEBHOOK_SECRET）。
 *     HAKUの STRIPE_PRICE_ID と同じ値は使えない（取り違え防止）。Stripeアカウント・APIキーは同じテスト環境を共有する。
 *   - 目印: Checkout Session / Subscription の metadata.product = 'tomoshibi_salon'。HAKUは 'haku_community'。
 *     灯のWebhookは自分の目印のものだけ、HAKUのWebhookは自分の目印のものだけ処理する。
 *   - Redis: 会員資格は既存の community:'tomoshibi' のキー（HAKUは community:'haku'）。ロック・顧客の索引・処理済みイベントは
 *     灯専用の接頭辞（salon-store.js）。HAKUの索引・処理済み記録には書かない。
 *   - 同じメールアドレスでもHAKUと灯は別々に判定する（Membership・Subscription・Customerが別）。
 *
 * 会員資格は「Checkoutの成功ページ」ではなく、Webhookで受け取ったStripeイベントのあと、StripeのSubscriptionの
 * 「いまの状態」をサーバーが取得し直して決める。イベントが重複・順不同・遅延しても、最後はStripeの状態に揃う。
 */
import { getApplication, getMembership, setMembership, resolveApplication, logAudit } from './store.js';
import * as S from './salon-store.js';
import { mail } from './salon-mail.js';

export const SALON_PRODUCT = 'tomoshibi_salon';
export const SALON_AMOUNT = 2980;
export const SALON_CURRENCY = 'jpy';
const COMMUNITY = 'tomoshibi';
const LOGIN_PATH = '/salon/tomoshibi/login/';

// テストで Stripe を差し替える入口。本番コードは必ず getStripe() 経由で使う
export const deps = { stripeFactory: null };

export class BillingError extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code; this.extra = extra || {}; }
}

const isTestKey = (k) => /^(sk|rk)_test_/.test(k || '');

export function billingConfig() {
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const priceId = process.env.SALON_STRIPE_PRICE_ID || '';
  const webhookSecret = process.env.SALON_STRIPE_WEBHOOK_SECRET || '';
  return { secretKey, priceId, webhookSecret };
}

export async function getStripe() {
  if (deps.stripeFactory) return deps.stripeFactory();
  const { secretKey } = billingConfig();
  // Previewはテストモードのキーだけ。実決済は発生させない
  if (!isTestKey(secretKey)) throw new BillingError(500, '決済設定が完了していません（決済用キー未設定）。', 'config_key');
  const { default: Stripe } = await import('stripe');
  return new Stripe(secretKey, { apiVersion: '2024-06-20' });
}

function requirePriceId() {
  const { priceId } = billingConfig();
  if (!/^price_/.test(priceId)) throw new BillingError(500, '決済設定が完了していません（プラン未設定）。', 'config_price');
  // HAKU Communityの料金（STRIPE_PRICE_ID）を、灯の決済に使い回すことは許さない
  if (priceId === (process.env.STRIPE_PRICE_ID || '')) throw new BillingError(500, '決済設定が正しくありません（HAKU Communityのプランは使えません）。', 'config_price_shared');
  return priceId;
}

// 料金（月額2,980円・円・毎月）をStripe側の実際のPriceで確認する。違えば決済を始めさせない（クライアントは金額を指定できない）。
let priceCache = { id: null, at: 0 };
export function resetPriceCache() { priceCache = { id: null, at: 0 }; }
export async function verifyPrice(stripe, priceId) {
  if (priceCache.id === priceId && Date.now() - priceCache.at < 10 * 60 * 1000) return;
  let price;
  try { price = await stripe.prices.retrieve(priceId); } catch (err) {
    console.error('[salon-billing] price retrieve failed:', err?.code || err?.type || '', err?.message || '');
    throw new BillingError(502, '決済ページを開けませんでした。時間をおいて再度お試しください。', 'price_unavailable');
  }
  const ok = price && price.active === true && price.unit_amount === SALON_AMOUNT && price.currency === SALON_CURRENCY
    && price.type === 'recurring' && price.recurring?.interval === 'month' && (price.recurring?.interval_count || 1) === 1;
  if (!ok) throw new BillingError(500, '決済設定が正しくありません（料金が月額2,980円ではありません）。', 'price_mismatch');
  priceCache = { id: priceId, at: Date.now() };
}

// ── Checkout（承認済みの人だけ） ──
// 申請の状態・会員の状態を毎回サーバーで確認する。外向きの理由は、状態を推測されないよう同じ文言にそろえる（HAKUと同じ方針）。
export async function checkoutEligibility(email) {
  const application = await getApplication(COMMUNITY, email);
  if (!application || (application.status !== 'approved' && application.status !== 'paid')) {
    return { ok: false, status: 403, code: 'not_approved', error: 'お申し込み内容をご確認のうえ、改めてお手続きください。ご不明な点は運営までお問い合わせください。' };
  }
  const m = await getMembership(COMMUNITY, email);
  if (m?.status === 'active' || m?.status === 'canceling') return { ok: false, status: 409, code: 'already_active', error: 'すでにお支払いが完了しています。ログインしてご利用ください。', alreadyActive: true };
  if (m?.status === 'past_due') return { ok: false, status: 409, code: 'past_due', error: 'お支払い方法の確認が必要です。運営までお問い合わせください。新しいお申し込みは不要です。', pastDue: true };
  if (m?.status === 'inactive') return { ok: false, status: 403, code: 'not_approved', error: 'お申し込み内容をご確認のうえ、改めてお手続きください。ご不明な点は運営までお問い合わせください。' };
  return { ok: true, application, membership: m };
}

// Checkout Sessionを作る（または、まだ有効な同じSessionを返す）。同じ人に同時に有効なSessionは1つだけ。
export async function startCheckout({ email, baseUrl }) {
  const e = String(email || '').trim().toLowerCase();
  const elig = await checkoutEligibility(e);
  if (!elig.ok) throw new BillingError(elig.status, elig.error, elig.code, { alreadyActive: elig.alreadyActive, pastDue: elig.pastDue });
  const priceId = requirePriceId();
  const stripe = await getStripe();
  await verifyPrice(stripe, priceId);

  for (let attempt = 0; attempt < 2; attempt++) {
    if (await S.acquireCheckoutLock(e)) {
      try {
        const metadata = { product: SALON_PRODUCT, community: COMMUNITY, email: e, applicationId: e, userId: e };
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          line_items: [{ price: priceId, quantity: 1 }],
          locale: 'ja',
          metadata,
          subscription_data: { metadata },
          customer_email: e,
          success_url: `${baseUrl}/salon/tomoshibi/thanks/?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${baseUrl}/salon/tomoshibi/cancel/`,
        });
        await S.setCheckoutLockSession(e, session.id);
        await logAudit({ actorId: 'system', action: 'salon_checkout_created', targetId: e, metadata: { salon: COMMUNITY, session: session.id } });
        return { url: session.url, sessionId: session.id, reused: false };
      } catch (err) {
        await S.releaseCheckoutLock(e).catch(() => {});
        if (err instanceof BillingError) throw err;
        console.error('[salon-billing] checkout create failed:', err?.type || '', err?.code || '', err?.message || '');
        throw new BillingError(502, '決済ページを開けませんでした。時間をおいて再度お試しください。', 'stripe_error');
      }
    }
    // すでに進行中。有効（open）な同じSessionがあればそのURLを返す（新しいSessionは作らない）
    const held = await S.getCheckoutLock(e);
    if (held && held.startsWith('cs_')) {
      let existing = null;
      try { existing = await stripe.checkout.sessions.retrieve(held); } catch { existing = null; }
      if (existing?.status === 'open' && existing.url) return { url: existing.url, sessionId: existing.id, reused: true };
      if (existing?.status === 'complete') throw new BillingError(409, 'お支払いを確認しています。少し時間をおいてから、ログインをお試しください。', 'processing', { checkoutInProgress: true });
      await S.releaseCheckoutLock(e); // 期限切れ・取得不能：新しく作り直す
      continue;
    }
    throw new BillingError(409, 'すでにお支払い手続きが進行中です。少し時間をおいてから再度お試しください。', 'in_progress', { checkoutInProgress: true });
  }
  throw new BillingError(409, 'すでにお支払い手続きが進行中です。少し時間をおいてから再度お試しください。', 'in_progress', { checkoutInProgress: true });
}

// 成功ページ用：Checkout Sessionの状態を、サーバーがStripeに確認して返す。会員資格は変えない（Webhookだけが変える）。
export async function paymentStatus(sessionId) {
  if (!/^cs_(test|live)_[A-Za-z0-9]{8,200}$/.test(String(sessionId || ''))) throw new BillingError(400, '不正なリンクです。', 'bad_session');
  const stripe = await getStripe();
  let session;
  try { session = await stripe.checkout.sessions.retrieve(sessionId); } catch { throw new BillingError(404, '決済情報が見つかりません。', 'not_found'); }
  if (session?.metadata?.product !== SALON_PRODUCT) throw new BillingError(404, '決済情報が見つかりません。', 'not_found');
  const m = await getMembership(COMMUNITY, String(session.metadata.email || ''));
  if (m?.status === 'active' || m?.status === 'canceling') return { state: 'active' };
  if (session.status === 'expired') return { state: 'expired' };
  if (session.status === 'complete') return { state: 'processing' };
  return { state: 'open' };
}

// ── 状態の対応表（Stripeのsubscription.status → 灯のMembership.status） ──
export function statusFromSubscription(sub) {
  const st = sub?.status;
  if (st === 'active' || st === 'trialing') return sub.cancel_at_period_end ? 'canceling' : 'active';
  if (st === 'past_due') return 'past_due';
  if (st === 'canceled' || st === 'unpaid' || st === 'incomplete_expired') return 'canceled';
  return null; // incomplete / paused など：会員状態は変えない（有効にもしない）
}
const periodEndMs = (sub) => { const v = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end; return v ? v * 1000 : null; };
const priceIdsOf = (sub) => (sub?.items?.data || []).map((i) => i?.price?.id).filter(Boolean);
const jaDate = (ms) => (ms ? new Date(ms).toLocaleDateString('ja-JP') : null);

// ── Subscriptionの「いまの状態」を灯のMembershipへ反映する（Webhookの中核） ──
async function applySubscription(email, sub, ctx) {
  const stripe = ctx.stripe;
  if (sub?.metadata?.product !== SALON_PRODUCT || sub?.metadata?.community !== COMMUNITY) return { status: 'skipped', reason: 'not_salon' };
  const { priceId } = billingConfig();
  // 灯のPrice以外（HAKUのPriceなど）で作られたSubscriptionは扱わない
  if (priceId && !priceIdsOf(sub).includes(priceId)) {
    await logAudit({ actorId: 'stripe-webhook', action: 'salon_price_mismatch', targetId: email, metadata: { salon: COMMUNITY, event: ctx.eventId } });
    return { status: 'skipped', reason: 'price_mismatch' };
  }
  // 顧客と会員メールの対応が、すでに別のメールで記録されていれば、取り違えの疑いとして処理しない
  const mapped = await S.emailByStripeCustomer(sub.customer);
  if (mapped && mapped !== email) {
    await logAudit({ actorId: 'stripe-webhook', action: 'salon_customer_mismatch', targetId: email, metadata: { salon: COMMUNITY, event: ctx.eventId } });
    return { status: 'skipped', reason: 'customer_mismatch' };
  }
  const next = statusFromSubscription(sub);
  if (!next) return { status: 'skipped', reason: `subscription_${sub?.status || 'unknown'}` };

  const application = await getApplication(COMMUNITY, email);
  const before = await getMembership(COMMUNITY, email);
  const live = (s) => s === 'active' || s === 'canceling' || s === 'past_due';

  if (!application || (application.status !== 'approved' && application.status !== 'paid')) {
    // 承認前に決済された（通常は起きない）。会員資格は与えず、運営へ知らせる
    await logAudit({ actorId: 'stripe-webhook', action: 'salon_payment_without_approval', targetId: email, metadata: { salon: COMMUNITY, event: ctx.eventId, applicationStatus: application?.status || 'not_found' } });
    await mail.adminAlert({ subject: '承認前のお支払いを検知しました（要確認）', lines: [`Stripe Event ID: ${ctx.eventId}`, `申請の状態: ${application?.status || '(申請が見つかりません)'}`, '', 'お支払いは完了していますが、承認前のため会員資格は有効にしていません。状況をご確認のうえ、必要ならStripeで返金等の対応をしてください。'] });
    return { status: 'skipped', reason: 'application_not_approved' };
  }

  // すでに別の有効なSubscriptionがある人に、2本目が作られた（二重決済）。新しい方を止めて、運営へ知らせる
  if (before?.stripeSubscriptionId && before.stripeSubscriptionId !== sub.id && live(before.status) && live(next)) {
    try { await stripe.subscriptions.cancel(sub.id); } catch (err) { console.error('[salon-billing] duplicate cancel failed:', err?.message || ''); }
    await logAudit({ actorId: 'stripe-webhook', action: 'salon_duplicate_subscription', targetId: email, metadata: { salon: COMMUNITY, event: ctx.eventId, duplicate: sub.id } });
    await mail.adminAlert({ subject: '二重のお支払いを検知しました（要確認）', lines: [`Stripe Event ID: ${ctx.eventId}`, `重複したSubscription: ${sub.id}`, '', '同じ会員に、2本目のSubscriptionが作られました。2本目は自動で解約しました。Stripeで、2本目の請求（返金の要否）をご確認ください。'] });
    return { status: 'skipped', reason: 'duplicate_subscription' };
  }

  // いまの会員の契約とは別のSubscription（過去に終わった古い契約など）の終了・遅れて届いたイベントでは、状態を変えない
  if (before?.stripeSubscriptionId && before.stripeSubscriptionId !== sub.id && !live(next)) return { status: 'skipped', reason: 'stale_subscription' };

  const record = {
    status: next,
    stripeCustomerId: sub.customer || before?.stripeCustomerId || null,
    stripeSubscriptionId: sub.id,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end) && next !== 'canceled',
    currentPeriodEnd: periodEndMs(sub),
    source: 'stripe',
    stripeSyncedAt: Date.now(),
  };
  if (live(next) && !live(before?.status)) record.activatedAt = Date.now();
  if (next === 'canceled') { record.canceledAt = Date.now(); record.cancelAtPeriodEnd = false; }
  await setMembership(COMMUNITY, email, record);
  await S.setStripeCustomer(sub.customer, email);
  if (application.status === 'approved' && live(next)) await resolveApplication(COMMUNITY, email, 'paid', 'stripe-webhook');
  const action = next === 'active' && !live(before?.status) ? 'salon_membership_activated' : next === 'past_due' ? 'salon_membership_past_due' : next === 'canceled' ? 'salon_membership_canceled' : 'salon_membership_synced';
  await logAudit({ actorId: 'stripe-webhook', action, targetId: email, metadata: { salon: COMMUNITY, event: ctx.eventId, stripeStatus: sub.status, newStatus: next } });

  // メールは「状態が変わったとき」にだけ送る（重複・再送でも二重に送らない）。送信の失敗で状態は戻さない
  const loginUrl = `${ctx.baseUrl}${LOGIN_PATH}`;
  const name = (await ctx.displayName(email)) || undefined;
  if (next === 'active' && !live(before?.status)) await mail.usageStart({ email, displayName: name, loginUrl, amountLabel: ctx.amountLabel });
  else if (next === 'past_due' && before?.status !== 'past_due') await mail.paymentFailed({ email, displayName: name, loginUrl });
  else if (next === 'canceling' && before?.status !== 'canceling') await mail.cancelScheduled({ email, displayName: name, periodEndLabel: jaDate(record.currentPeriodEnd) });
  else if (next === 'canceled' && before?.status !== 'canceled' && !before?.cancelAtPeriodEnd && sub.cancellation_details?.reason !== 'payment_failed') await mail.ended({ email, displayName: name });
  return { status: 'processed', membership: next };
}

// イベントがどの会員のものか。会員がメールアドレスを変更していても追えるよう、顧客の索引（変更時に更新される）を先に見て、なければ決済開始時にサーバーが入れたmetadataのメールを使う
async function memberEmailFor(customerId, metadataEmail) {
  const mapped = await S.emailByStripeCustomer(customerId);
  return String(mapped || metadataEmail || '').trim().toLowerCase();
}

async function retrieveSub(stripe, id, fallback) {
  try { return await stripe.subscriptions.retrieve(id); } catch (err) {
    // 解約済みなどで取得できない場合は、イベントに入っていた内容で判断する
    if (fallback) return fallback;
    throw err;
  }
}

// ── イベントの振り分け。戻り値は { status: 'processed' | 'skipped', reason? }。例外は「再送してほしい失敗」 ──
export async function processSalonEvent(event, { stripe, baseUrl, displayName }) {
  const ctx = { stripe, baseUrl, eventId: event.id, displayName, amountLabel: null };
  const obj = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.metadata?.product !== SALON_PRODUCT) return { status: 'skipped', reason: 'not_salon' };
      if (obj.mode !== 'subscription' || !obj.subscription) return { status: 'skipped', reason: 'not_subscription' };
      if (obj.payment_status !== 'paid') return { status: 'skipped', reason: 'payment_not_paid' };
      const email = await memberEmailFor(obj.customer, obj.metadata?.email); // 決済画面で編集できるメール（customer_details）は使わない
      if (!email) return { status: 'skipped', reason: 'no_email' };
      if (typeof obj.amount_total === 'number') ctx.amountLabel = `${obj.amount_total.toLocaleString('ja-JP')}円`;
      const sub = await retrieveSub(stripe, obj.subscription);
      return applySubscription(email, sub, ctx);
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      if (obj.metadata?.product !== SALON_PRODUCT) return { status: 'skipped', reason: 'not_salon' };
      const email = await memberEmailFor(obj.customer, obj.metadata?.email);
      if (!email) return { status: 'skipped', reason: 'no_email' };
      const sub = await retrieveSub(stripe, obj.id, obj);
      return applySubscription(email, sub, ctx);
    }
    case 'invoice.payment_failed':
    case 'invoice.paid': {
      // 新しいStripe API版では、invoiceのSubscriptionは parent.subscription_details に入る。どちらの形でも読む
      const rawSub = obj.subscription ?? obj.parent?.subscription_details?.subscription;
      const subId = typeof rawSub === 'string' ? rawSub : rawSub?.id;
      if (!subId) return { status: 'skipped', reason: 'no_subscription' };
      const sub = await retrieveSub(stripe, subId);
      if (sub?.metadata?.product !== SALON_PRODUCT) return { status: 'skipped', reason: 'not_salon' };
      const email = await memberEmailFor(sub.customer, sub.metadata?.email);
      if (!email) return { status: 'skipped', reason: 'no_email' };
      return applySubscription(email, sub, ctx);
    }
    default: return { status: 'skipped', reason: event.type };
  }
}

// ── 会員本人の退会（解約）。Stripe側で「期間の終わりに解約」にする。期間の終わりまで利用でき、実際の終了はWebhookが行う（HAKUと同じ方針） ──
export async function cancelSalonMembership(email, { displayName } = {}) {
  const e = String(email || '').trim().toLowerCase();
  const m = await getMembership(COMMUNITY, e);
  if (!m || (m.status !== 'active' && m.status !== 'canceling')) throw new BillingError(404, '有効な会員登録が見つかりません。', 'not_member');
  if (!m.stripeSubscriptionId) {
    // 決済を経ていない会員（運営が招待・免除で有効にした人）は、その場で退会にする
    await setMembership(COMMUNITY, e, { status: 'inactive' });
    await logAudit({ actorId: e, action: 'salon_membership_withdrawn', targetId: e, metadata: { salon: COMMUNITY, billing: 'none' } });
    return { currentPeriodEnd: null, immediate: true };
  }
  if (m.status === 'canceling') throw new BillingError(409, 'すでに退会（解約）の手続き済みです。', 'already_canceling', { currentPeriodEnd: m.currentPeriodEnd || null });
  const stripe = await getStripe();
  let updated;
  try { updated = await stripe.subscriptions.update(m.stripeSubscriptionId, { cancel_at_period_end: true }); } catch (err) {
    console.error('[salon-billing] cancel failed:', err?.message || '');
    throw new BillingError(502, '退会の手続きに失敗しました。時間をおいて再度お試しいただくか、運営までご連絡ください。', 'stripe_error');
  }
  const end = periodEndMs(updated);
  await setMembership(COMMUNITY, e, { status: 'canceling', cancelAtPeriodEnd: true, currentPeriodEnd: end });
  await logAudit({ actorId: e, action: 'salon_cancellation_requested', targetId: e, metadata: { salon: COMMUNITY, currentPeriodEnd: end } });
  await mail.cancelScheduled({ email: e, displayName, periodEndLabel: jaDate(end) });
  return { currentPeriodEnd: end, immediate: false };
}

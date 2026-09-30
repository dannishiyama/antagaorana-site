/**
 * api/haku-checkout.js
 * HAKU Community 申込み → Stripe Checkout Session（月額サブスク）を作成して URL を返す
 *
 * 設計方針:
 *   - PreviewはStripe test鍵、ProductionはStripe live鍵で動く（環境ごとにVercel側で設定）
 *       ・STRIPE_SECRET_KEY が sk_/rk_ の test/live いずれでもない場合のみ 500
 *   - 秘密情報・Price ID はすべて環境変数から取得。フロントには Checkout の URL だけを返す
 *   - ログにメールアドレス等の個人情報は出さない
 *
 * 必要な環境変数（Vercel Dashboard > Settings > Environment Variables）:
 *   STRIPE_SECRET_KEY   Preview: sk_test_.../rk_test_...　Production: sk_live_.../rk_live_...
 *   STRIPE_PRICE_ID     price_...（HAKU Community 月額 2,980円。Preview/Productionで別ID）
 *
 * 前提: 完全紹介制のため、このAPIを呼べるのは
 * Application(community:'haku', status:'approved'（管理者承認済み）) の場合のみ。
 * 新規登録直後（status:'pending'）はまだ呼べない。管理者が承認すると、承認メールの
 * CTAから haku-community-register.html に戻り、再度Application状態を確認したうえで
 * このAPIを呼ぶ（api/community-auth.js の handleRegister が resumed:true を返す）。
 * ここではemailを信用せず、実際に承認済みのApplicationが存在するかを毎回検証する。
 *
 * リクエスト: POST application/json
 *   { email, segment: 'teacher' | 'professional', plan: 'monthly', agree: true }
 * レスポンス: 200 { url } / 4xx・5xx { error }
 */
import { getApplication, getMembership, acquireCheckoutLock, releaseCheckoutLock } from './_lib/store.js';
import { resolveBaseUrl } from './_lib/http.js';

const SEGMENTS = new Set(['teacher', 'professional']);
const PLANS = new Set(['monthly']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 安全装置: 本物のStripe鍵（test/liveいずれか）以外は拒否 ───────────
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const priceId = process.env.STRIPE_PRICE_ID || '';
  if (!/^(sk|rk)_(test|live)_/.test(secretKey)) {
    console.error('[haku-checkout] STRIPE_SECRET_KEY is missing or malformed');
    return res.status(500).json({ error: '決済設定が完了していません（決済用キー未設定）。' });
  }
  if (!/^price_/.test(priceId)) {
    console.error('[haku-checkout] STRIPE_PRICE_ID is missing or malformed');
    return res.status(500).json({ error: '決済設定が完了していません（プラン未設定）。' });
  }

  // ── 入力チェック ────────────────────────────────────────────────
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const { segment, plan, agree } = body;
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: '先に新規登録を完了してください。' });
  if (!SEGMENTS.has(segment)) return res.status(400).json({ error: '区分を選択してください。' });
  if (!PLANS.has(plan)) return res.status(400).json({ error: 'プランを選択してください。' });
  if (agree !== true) return res.status(400).json({ error: '内容へのご同意が必要です。' });

  // emailをクライアントの申告のまま信用せず、実際に「管理者承認済み」のApplicationが
  // 存在するかを必ず確認する。他人のメールアドレスで決済を開始できないようにするだけでなく、
  // 完全紹介制として「承認されるかわからない申込者から先に課金しない」ための最重要ゲート。
  //
  // 情報漏洩対策：このAPIは認証なしでemailを指定できてしまうため、pending/rejected/未登録を
  // それぞれ異なるメッセージで返すと、第三者が任意のメールアドレスを総当たりして
  // 「このメールアドレスは審査中／却下／未登録のどれか」を推測できてしまう
  // （完全紹介制コミュニティとして、これ自体が一種の個人情報・会員状態の漏洩になる）。
  // そのため外部向けの応答は状態によらず同一メッセージ・同一ステータスコードに統一し、
  // 実際の理由はサーバーログにのみ残す（運用調査用）。正規のフロー（承認メール／
  // resumed:trueからの遷移）では、この時点でApplicationは常にapproved/paidのはずであり、
  // このメッセージを実際に見るのは直接APIを叩いた場合のみである。
  const application = await getApplication('haku', email);
  if (!application || (application.status !== 'approved' && application.status !== 'paid')) {
    console.log(`[haku-checkout] checkout blocked: application status=${application?.status || 'not_found'}`);
    return res.status(403).json({ error: 'お申し込み内容をご確認のうえ、改めてお手続きください。ご不明な点は運営までお問い合わせください。' });
  }

  // 二重決済防止：既にStripe Subscriptionが存在する（＝'active'だけでなく、更新決済が
  // 失敗中の'past_due'や、解約予約済みだが期間終了前の'canceling'も含む）なら、
  // 新しいCheckout Sessionを絶対に作らせない。これらの状態は既存のSubscriptionが
  // Stripe側にまだ生きているということであり、ここで新規セッションを許すと同一人物に
  // 対して2本目のSubscriptionが作られ、二重課金につながる（'canceled'のみ、既存
  // Subscriptionが完全終了しているため新規セッション作成を許可してよい）。
  const existingMembership = await getMembership('haku', email);
  if (existingMembership && existingMembership.status !== 'canceled') {
    if (existingMembership.status === 'active' || existingMembership.status === 'canceling') {
      return res.status(409).json({ error: 'すでにお支払いが完了しています。ログインしてご利用ください。', alreadyActive: true });
    }
    if (existingMembership.status === 'past_due') {
      return res.status(409).json({ error: 'お支払い方法の更新が必要です。運営までお問い合わせください。新しいお申し込みは不要です。', pastDue: true });
    }
  }

  const baseUrl = resolveBaseUrl(req);
  if (!baseUrl) return res.status(400).json({ error: 'Invalid host' });

  // 二重決済防止（レースコンディション対策）：上のMembershipチェックは「初回決済が
  // 完了した後」しか効かない。承認直後〜初回決済完了（Webhook処理）までの間は
  // Membershipレコード自体がまだ存在しないため、そのままでは同一Applicationに対して
  // 複数のCheckout Sessionを並行して作成できてしまう（承認メールを2タブで開く、
  // 連打、通信リトライ等）。SET NX EXによる短期排他ロックで、この区間の二重発行を防ぐ。
  // ロックはTTL（10分）で自然に解放されるため、本当に決済を中断した場合の再試行も
  // 一定時間後には可能なままになる。
  const lockAcquired = await acquireCheckoutLock(email, 600);
  if (!lockAcquired) {
    return res.status(409).json({
      error: 'すでにお支払い手続きが進行中です。少し時間をおいてから再度お試しいただくか、開いている決済画面からお手続きください。',
      checkoutInProgress: true,
    });
  }

  // ── Checkout Session 作成 ───────────────────────────────────────
  try {
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(secretKey);
    // applicationId / userId: このシステムではApplication・Userともにemailを一意キーとして
    // 使う設計のため、Stripeダッシュボード上での追跡用にemailをそのまま代用する
    // （api/_lib/stripe-checkout.js の管理者承認メール経由の発行分と揃える）。
    const metadata = { product: 'haku_community', segment, plan, email, community: 'haku', applicationId: email, userId: email };

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      locale: 'ja',
      metadata,
      subscription_data: { metadata },
      customer_email: email,
      custom_fields: [{
        key: 'referralcode', // Stripe の制約: 英数字のみ
        label: { type: 'custom', custom: '紹介コード（お持ちの方のみ）' },
        type: 'text',
        optional: true,
      }],
      success_url: `${baseUrl}/haku-community-thanks?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/haku-community-cancel?for=${segment}`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[haku-checkout] Stripe error:', err?.type || 'unknown', err?.code || '', err?.message || '');
    // Stripe側の一時的な失敗であれば、ロックを保持し続けると正当な再試行までブロック
    // してしまうため、ここでは解放して即座に再試行できるようにする。
    await releaseCheckoutLock(email).catch(() => {});
    return res.status(502).json({ error: '決済ページを開けませんでした。時間をおいて再度お試しください。' });
  }
}

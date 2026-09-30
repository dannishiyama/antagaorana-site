/**
 * api/_lib/stripe-checkout.js
 * HAKU Community用のStripe Checkout Session作成ロジック（共通部分）。
 *
 * api/haku-checkout.js（会員本人がブラウザから呼ぶ経路）は今回一切変更していない
 * （既に正常動作しているフローを壊さないため）。この関数は新たに、
 * api/admin.js の承認処理（承認メールへ直接埋め込むCheckout URLを、承認済み
 * Applicationに対して安全にその場で生成するため）からのみ呼ばれる。
 *
 * 呼び出し元は必ず、Application.status が 'approved'（または 'paid'）であることを
 * 確認済みであること（この関数自体はステータスを再確認しない＝ポリシーを持たない
 * データ層寄りの薄いヘルパーとして設計）。
 *
 * 二重決済防止：api/haku-checkout.js（会員本人がブラウザから呼ぶ経路）と同じ
 * Redis排他ロック（acquireCheckoutLock）をここでも取得する。承認直後、この関数が
 * 承認メール用のCheckout Sessionを作るのとほぼ同時に、会員が新規登録ページの
 * 「resume」導線から/api/haku-checkoutを呼ぶ、という競合が起き得るため、同じ
 * emailに対してどちらか一方しかSession作成を進められないようにする。ロックを
 * 取得できない場合は例外を投げ、呼び出し元（api/admin.js handleApprove）の
 * 既存フォールバック（登録ページへの導線）に委ねる。
 */
import { acquireCheckoutLock, releaseCheckoutLock } from './store.js';

export async function createHakuCheckoutSession({ email, baseUrl, segment = 'professional', plan = 'monthly' }) {
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const priceId = process.env.STRIPE_PRICE_ID || '';
  if (!/^(sk|rk)_test_/.test(secretKey)) throw new Error('STRIPE_SECRET_KEY is missing or not a test-mode key');
  if (!/^price_/.test(priceId)) throw new Error('STRIPE_PRICE_ID is missing or malformed');

  const lockAcquired = await acquireCheckoutLock(email, 600);
  if (!lockAcquired) throw new Error('checkout session creation is already in progress for this email');

  try {
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(secretKey);
    // applicationId / userId: このシステムではApplication・Userともにemailを一意キーとして
    // 使う設計のため、専用の数値・UUID型のIDは存在しない。Stripeダッシュボード上で
    // 「どの申込・どの会員に紐づく決済か」を追跡できるよう、emailをそのまま代用する。
    const metadata = {
      product: 'haku_community', segment, plan, email, community: 'haku',
      applicationId: email, userId: email,
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      locale: 'ja',
      metadata,
      subscription_data: { metadata },
      customer_email: email,
      custom_fields: [{
        key: 'referralcode',
        label: { type: 'custom', custom: '紹介コード（お持ちの方のみ）' },
        type: 'text',
        optional: true,
      }],
      success_url: `${baseUrl}/haku-community-thanks?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/haku-community-cancel?for=${segment}`,
    });
    return session;
  } catch (err) {
    // Stripe側のエラーでSession作成自体に失敗した場合は、ロックを保持し続けると
    // 呼び出し元のフォールバック導線（登録ページ経由の再試行）まで塞いでしまうため解放する。
    await releaseCheckoutLock(email).catch(() => {});
    throw err;
  }
}

/**
 * api/salon-stripe-webhook.js
 * 教育者のサロン「灯」専用の Stripe Webhook。HAKU Community の api/haku-stripe-webhook.js とは別のエンドポイント・別の署名Secret。
 *
 * 安全装置：
 *   1. 本番（VERCEL_ENV=production）では何もしない（灯はPreviewのみ）
 *   2. 署名検証（raw body + SALON_STRIPE_WEBHOOK_SECRET）。不正な署名は400
 *   3. テストモードのイベント（livemode=false）だけ処理する。STRIPE_SECRET_KEY もテストキーのみ
 *   4. 同じevent.idは二重に処理しない（灯専用の処理済み記録。HAKUの記録とは別）
 *   5. 灯の目印（metadata.product='tomoshibi_salon'）が付いたものだけを扱う。HAKUのイベントは無視する
 *   6. 会員資格は、イベントのあとStripeのSubscriptionの「いまの状態」を取得して決める（重複・順不同・遅延に強い）
 *
 * Stripeダッシュボード（テストモード）で、この URL に次のイベントを購読する：
 *   checkout.session.completed / customer.subscription.updated / customer.subscription.deleted / invoice.payment_failed / invoice.paid
 *
 * 環境変数（Vercel の Preview スコープ）: STRIPE_SECRET_KEY（HAKUと共通のテストキー） / SALON_STRIPE_PRICE_ID / SALON_STRIPE_WEBHOOK_SECRET
 */
import Stripe from 'stripe';
import { resolveBaseUrl } from './_lib/http.js';
import { getUser } from './_lib/store.js';
import * as S from './_lib/salon-store.js';
import { getStripe, processSalonEvent, billingConfig } from './_lib/salon-billing.js';
import { salonEnabled, salonKeyAllowed, salonEventModeOk } from './_lib/salon-mode.js';

// Stripeの署名検証にraw bodyが必要
export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }
  // Productionは、灯の本番設定（ライブキー・灯専用Price・署名Secret・有効化スイッチ）が揃うまで、何もしない
  if (!salonEnabled()) return res.status(200).json({ received: true, skipped: 'production' });

  const { secretKey, webhookSecret } = billingConfig();
  if (!salonKeyAllowed(secretKey) || !webhookSecret) {
    console.error('[salon-webhook] Stripe key (mode mismatch) or SALON_STRIPE_WEBHOOK_SECRET is missing');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  let rawBody;
  try { rawBody = await getRawBody(req); } catch { return res.status(400).json({ error: 'Failed to read request body' }); }

  let event;
  try {
    event = new Stripe(secretKey, { apiVersion: '2024-06-20' }).webhooks.constructEvent(rawBody, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    console.error('[salon-webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature error' });
  }

  // 環境とモードが違うイベント（Previewにライブ／Productionにテスト）は処理しない
  if (!salonEventModeOk(event.livemode)) return res.status(200).json({ received: true, skipped: 'livemode' });

  const claim = await S.claimStripeEvent(event.id);
  if (claim.status === 'done') return res.status(200).json({ received: true, skipped: 'duplicate_event' });
  if (claim.status === 'in_flight') return res.status(200).json({ received: true, skipped: 'in_flight' });

  try {
    const stripe = await getStripe();
    const baseUrl = resolveBaseUrl(req) || 'https://antagaorana-haku-tomoshibi-preview.vercel.app';
    const result = await processSalonEvent(event, { stripe, baseUrl, displayName: async (email) => (await getUser(email))?.displayName });
    await S.markStripeEventDone(event.id);
    return res.status(200).json({ received: true, ...(result.status === 'skipped' ? { skipped: result.reason } : {}) });
  } catch (err) {
    // 再送してほしい失敗。処理中の印を外して、Stripeの再送で処理し直せるようにする
    await S.releaseStripeEvent(event.id).catch(() => {});
    console.error(`[salon-webhook] handling failed | type=${event.type} | event=${event.id} |`, err?.message || '');
    return res.status(500).json({ error: 'Processing failed, Stripe will retry' });
  }
}

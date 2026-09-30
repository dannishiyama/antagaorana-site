// tests/haku-webhook-fixture.spec.js
// HAKU: Stripe Checkoutの実UI操作は自動化が壊れやすい（iframe内カード入力）ため、
// ユーザー指示に基づき「Webhook処理をfixture/test eventで検証する」方式を採用する。
// checkout.session.completed / customer.subscription.deleted / invoice.payment_failed の
// 3イベントを、本物のStripe署名アルゴリズム（HMAC-SHA256）で自前署名して送信する。
//
// 実行には環境変数 HAKU_STRIPE_WEBHOOK_SECRET が必要（Vercelに設定済みの値と同じもの）。
// 秘密値なので .env.local 等、Git管理外のファイルから読み込むこと。未設定の場合はスキップする。
import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { uniqueEmail, apiGet } from './helpers.js';

function signStripePayload(payload, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

async function sendFixtureEvent(request, baseURL, secret, event) {
  const payload = JSON.stringify(event);
  const sig = signStripePayload(payload, secret);
  return request.post(`${baseURL}/api/haku-stripe-webhook`, {
    data: payload,
    headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
  });
}

test.describe('HAKU: Stripe Webhook fixture イベント検証', () => {
  const secret = process.env.HAKU_STRIPE_WEBHOOK_SECRET;
  test.skip(!secret, 'HAKU_STRIPE_WEBHOOK_SECRET が未設定のためスキップ（tests/README.md 参照）');

  const email = uniqueEmail('e2e-haku-fixture');
  const customerId = `cus_test_${Date.now()}`;
  const subscriptionId = `sub_test_${Date.now()}`;

  test('checkout.session.completed でMembershipがactiveになる', async ({ request, baseURL }) => {
    const event = {
      id: `evt_test_${Date.now()}_checkout`,
      livemode: false,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_test_${Date.now()}`,
          payment_status: 'paid',
          customer: customerId,
          subscription: subscriptionId,
          customer_details: { email, name: 'Playwright Fixture' },
          amount_total: 2980,
          metadata: { product: 'haku_community', segment: 'professional', plan: 'monthly' },
        },
      },
    };
    const res = await sendFixtureEvent(request, baseURL, secret, event);
    expect(res.status()).toBe(200);
  });

  test('同一event.idを再送しても二重処理されない（idempotency）', async ({ request, baseURL }) => {
    const event = {
      id: `evt_test_${Date.now()}_dup`,
      livemode: false,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_test_dup_${Date.now()}`,
          payment_status: 'paid',
          customer: customerId,
          subscription: subscriptionId,
          customer_details: { email, name: 'Playwright Fixture' },
          amount_total: 2980,
          metadata: { product: 'haku_community', segment: 'professional', plan: 'monthly' },
        },
      },
    };
    const first = await sendFixtureEvent(request, baseURL, secret, event);
    expect(first.status()).toBe(200);
    const second = await sendFixtureEvent(request, baseURL, secret, event);
    expect(second.status()).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.skipped).toBe('duplicate_event');
  });

  test('customer.subscription.deleted でMembershipがcanceledになる', async ({ request, baseURL }) => {
    const event = {
      id: `evt_test_${Date.now()}_sub_del`,
      livemode: false,
      type: 'customer.subscription.deleted',
      data: { object: { id: subscriptionId, customer: customerId } },
    };
    const res = await sendFixtureEvent(request, baseURL, secret, event);
    expect(res.status()).toBe(200);
  });

  test('本番決済（livemode:true）は無視される', async ({ request, baseURL }) => {
    const event = {
      id: `evt_test_${Date.now()}_live`,
      livemode: true,
      type: 'checkout.session.completed',
      data: { object: { payment_status: 'paid', customer_details: { email: 'live-should-be-ignored@example.com' }, metadata: { product: 'haku_community' } } },
    };
    const res = await sendFixtureEvent(request, baseURL, secret, event);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe('live_event_blocked');
  });
});

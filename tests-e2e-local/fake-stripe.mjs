// テスト用の「偽のStripe」。本物のStripeには接続しない。灯の決済（Checkout・Subscription・Price）を、メモリ上で再現する。
// 単体テスト（tests-unit/salon-billing.test.mjs）とローカルE2E（tests-e2e-local/salon.e2e.mjs）で共有する。
let globalSeq = 1000; // IDはテスト全体で通しの連番（テストごとに同じIDを作らない）

export class FakeStripe {
  constructor() {
    this.calls = { sessionCreate: 0, subCancel: [], subUpdate: [] };
    this.sessions = new Map();
    this.subs = new Map();
    const self = this;
    this.prices = { price_salon_test: { id: 'price_salon_test', active: true, unit_amount: 2980, currency: 'jpy', type: 'recurring', recurring: { interval: 'month', interval_count: 1 } } };
    this.prices.price_haku_test = { ...this.prices.price_salon_test, id: 'price_haku_test' };
    this.priceApi = { retrieve: async (id) => { if (!self.prices[id]) throw new Error('no such price'); return self.prices[id]; } };
    this.checkout = { sessions: {
      create: async (params) => {
        self.calls.sessionCreate++;
        const id = `cs_test_${++globalSeq}abcdefghij`;
        const s = { id, status: 'open', url: `https://checkout.stripe.test/${id}`, params, metadata: params.metadata, mode: params.mode, payment_status: 'unpaid', subscription: null, customer: null };
        self.sessions.set(id, s); return s;
      },
      retrieve: async (id) => { const s = self.sessions.get(id); if (!s) throw new Error('no such session'); return s; },
    } };
    this.subscriptions = {
      retrieve: async (id) => { const s = self.subs.get(id); if (!s) throw Object.assign(new Error('no such subscription'), { code: 'resource_missing' }); return s; },
      update: async (id, p) => { self.calls.subUpdate.push([id, p]); const s = self.subs.get(id); Object.assign(s, p); return s; },
      cancel: async (id) => { self.calls.subCancel.push(id); const s = self.subs.get(id); s.status = 'canceled'; return s; },
    };
  }
  // salon-billing.js の deps.stripeFactory に渡す形
  get api() { return { prices: this.priceApi, checkout: this.checkout, subscriptions: this.subscriptions }; }
  // お客様が決済ページで支払い終えた状態にする（SessionとSubscriptionを作る）
  pay(session, { priceId, status = 'active' } = {}) {
    const sub = {
      id: `sub_${++globalSeq}`, status, customer: `cus_${++globalSeq}`, cancel_at_period_end: false,
      metadata: { ...(session.params.subscription_data?.metadata || {}) },
      items: { data: [{ price: { id: priceId || session.params.line_items[0].price }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
    };
    this.subs.set(sub.id, sub);
    Object.assign(session, { status: 'complete', payment_status: 'paid', subscription: sub.id, customer: sub.customer, amount_total: 2980 });
    return sub;
  }
}

let evSeq = 0;
export function stripeEvent(type, object, { id, livemode = false } = {}) {
  return { id: id || `evt_${++evSeq}_${Date.now()}`, object: 'event', type, livemode, created: Math.floor(Date.now() / 1000), data: { object } };
}
export const completedEvent = (session) => stripeEvent('checkout.session.completed', { id: session.id, object: 'checkout.session', mode: 'subscription', metadata: session.metadata, payment_status: session.payment_status, subscription: session.subscription, customer: session.customer, amount_total: session.amount_total });

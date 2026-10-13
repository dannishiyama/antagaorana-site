import test from 'node:test';
import assert from 'node:assert/strict';

const KEYS = ['VERCEL_ENV', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'SALON_STRIPE_PRICE_ID', 'SALON_STRIPE_WEBHOOK_SECRET', 'SALON_PRODUCTION_ENABLED'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const reset = () => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
const setEnv = (o) => { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, o); };
const mode = await import('../api/_lib/salon-mode.js');
const http = await import('../api/_lib/http.js');
const res = () => { const r = { code: 0, status(c) { r.code = c; return r; }, json() { return r; } }; return r; };

const READY = { VERCEL_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_abc123', STRIPE_PRICE_ID: 'price_haku1', SALON_STRIPE_PRICE_ID: 'price_salon1', SALON_STRIPE_WEBHOOK_SECRET: 'whsec_abc', SALON_PRODUCTION_ENABLED: '1' };

test('本番ゲート：Previewは従来どおり（常に有効・テストキーのみ・テストイベントのみ）', () => {
  setEnv({ VERCEL_ENV: 'preview' });
  assert.equal(mode.salonEnabled(), true);
  assert.equal(mode.salonKeyAllowed('sk_test_abc_1'), true);
  assert.equal(mode.salonKeyAllowed('sk_live_abc'), false);
  assert.equal(mode.salonEventModeOk(false), true);
  assert.equal(mode.salonEventModeOk(true), false);
  reset();
});

test('本番ゲート：本番は、4条件が揃わない限り灯は動かない（1つ欠けても止まる）', () => {
  setEnv(READY); assert.equal(mode.salonEnabled(), true);
  for (const drop of ['SALON_PRODUCTION_ENABLED', 'SALON_STRIPE_PRICE_ID', 'SALON_STRIPE_WEBHOOK_SECRET']) {
    const e = { ...READY }; delete e[drop]; setEnv(e);
    assert.equal(mode.salonEnabled(), false, `${drop} が無いのに有効`);
  }
  setEnv({ ...READY, STRIPE_SECRET_KEY: 'sk_test_abc' }); assert.equal(mode.salonEnabled(), false, 'テストキーが本番で有効');
  setEnv({ ...READY, SALON_STRIPE_PRICE_ID: 'price_haku1' }); assert.equal(mode.salonEnabled(), false, 'HAKUのPriceを灯に流用できてしまう');
  setEnv({ ...READY, SALON_PRODUCTION_ENABLED: 'true' }); assert.equal(mode.salonEnabled(), false, 'スイッチは "1" のみ');
  reset();
});

test('本番ゲート：本番はライブキーとライブイベントのみ。テストは拒否', () => {
  setEnv(READY);
  assert.equal(mode.salonKeyAllowed('sk_live_abc'), true);
  assert.equal(mode.salonKeyAllowed('sk_test_abc'), false);
  assert.equal(mode.salonEventModeOk(true), true);
  assert.equal(mode.salonEventModeOk(false), false);
  reset();
});

test('本番ゲート：APIガード。HAKUは従来どおり本番で通り、灯は条件が揃うまで403', () => {
  setEnv({ VERCEL_ENV: 'production' }); // 灯の設定なし
  assert.equal(http.blockProductionForCommunity(res(), 'haku'), false);
  assert.equal(http.blockProductionForCommunity(res(), 'tomoshibi'), true);
  assert.equal(http.blockProductionForCommunity(res(), undefined), true);
  assert.equal(http.blockProduction(res()), true);
  setEnv(READY);
  assert.equal(http.blockProductionForCommunity(res(), 'haku'), false);
  assert.equal(http.blockProductionForCommunity(res(), 'tomoshibi'), false);
  assert.equal(http.blockProductionForCommunity(res(), 'other'), true, '灯以外の新しいcommunityは解放しない');
  assert.equal(http.blockProduction(res()), false);
  reset();
});

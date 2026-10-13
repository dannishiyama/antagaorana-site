/**
 * 灯サロンの「本番で動かしてよいか」と「Stripeのモード」の判定（1か所に集約）。
 *
 * 方針（安全側）
 *  - Preview／ローカル：従来どおり。テストモードのStripeだけ（実課金なし）
 *  - Production：次の条件がすべて揃ったときだけ、灯を動かす。1つでも欠けたら、従来どおり403／何もしない
 *      1. SALON_PRODUCTION_ENABLED=1（運営が、最後に明示的に入れるスイッチ）
 *      2. STRIPE_SECRET_KEY がライブキー（sk_live_ / rk_live_）
 *      3. SALON_STRIPE_PRICE_ID が price_… で、HAKUの STRIPE_PRICE_ID と別
 *      4. SALON_STRIPE_WEBHOOK_SECRET が whsec_…
 *    テスト用のキー・Priceが本番に混ざることは、ここで止める
 */
const isProd = () => process.env.VERCEL_ENV === 'production';

export const isTestKey = (k) => /^(sk|rk)_test_[A-Za-z0-9_]+$/.test(k || '');
export const isLiveKey = (k) => /^(sk|rk)_live_[A-Za-z0-9_]+$/.test(k || '');

// 今の環境で使ってよいStripeキーか（Production=ライブのみ／それ以外=テストのみ）
export const salonKeyAllowed = (k) => (isProd() ? isLiveKey(k) : isTestKey(k));

// Stripeイベントの livemode が、今の環境で処理してよいものか
export const salonEventModeOk = (livemode) => (isProd() ? livemode === true : livemode === false);

export function salonProductionReady(env = process.env) {
  const price = env.SALON_STRIPE_PRICE_ID || '';
  return env.SALON_PRODUCTION_ENABLED === '1'
    && isLiveKey(env.STRIPE_SECRET_KEY || '')
    && /^price_[A-Za-z0-9]+$/.test(price) && price !== (env.STRIPE_PRICE_ID || '')
    && /^whsec_[A-Za-z0-9]+$/.test(env.SALON_STRIPE_WEBHOOK_SECRET || '');
}

// 灯を動かしてよいか（Preview等は常にtrue。Productionは上の条件が揃ったときだけ）
export const salonEnabled = () => !isProd() || salonProductionReady();

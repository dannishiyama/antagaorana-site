#!/usr/bin/env node
/**
 * 教育者のサロン「灯」：Stripe（テストモード）の設定を、1コマンドで行う。
 *
 *   node scripts/salon-stripe-setup.mjs --deploy      設定して、Previewへ再デプロイまで行う
 *   node scripts/salon-stripe-setup.mjs --verify      確認だけ（何も作らない・変えない）
 *   node scripts/salon-stripe-setup.mjs --dry-run     何を作るか表示するだけ
 *
 * やること（すべて、灯専用。HAKU Communityの商品・Price・Webhook・環境変数には触れない）
 *   1. 商品「教育者のサロン 灯」（metadata.product = tomoshibi_salon）を探す。なければ作る
 *   2. その商品に、月額2,980円（JPY・毎月）のPriceを探す。なければ作る
 *   3. Webhookの送信先（Previewの /api/salon-stripe-webhook）を探す。なければ作る。購読は次の5つ
 *        checkout.session.completed / customer.subscription.updated / customer.subscription.deleted / invoice.payment_failed / invoice.paid
 *      送信するAPIバージョンは、アプリの想定（2024-06-20）に固定する
 *   4. Vercelの「Previewスコープ」に、灯専用の環境変数を設定する
 *        SALON_STRIPE_PRICE_ID（Price ID）／ SALON_STRIPE_WEBHOOK_SECRET（署名Secret。Secretとして保存）
 *
 * 安全のための決まり
 *   - Stripeのテストキー（sk_test_… / rk_test_…）だけを受け付ける。ライブキーは拒否する
 *   - キーは、画面に表示されない入力欄で受け取る。ファイル・ログ・Gitには残さない。署名Secretも表示しない
 *   - 既存の商品・Price・Webhookは、変更・削除しない（灯専用の目印がついたものを再利用するだけ。重複は作らない）。
 *     例外：署名Secretは作成時にしか取得できないため、灯のURLのWebhookが「あるのに、VercelにSecretが無い」場合に限り、
 *     そのWebhookだけを作り直す
 *   - Production環境変数・HAKUの変数は変更しない
 *
 * 必要なもの：Stripeダッシュボード（テストモード）の「開発者 → APIキー」のシークレットキー、または制限付きキー
 *   （制限付きキーの場合の権限：Products 書き込み／Prices 書き込み／Webhook Endpoints 書き込み）。Vercel CLIにログイン済みであること。
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(REPO + 'package.json');
const Stripe = require('stripe');

const args = new Set(process.argv.slice(2));
const VERIFY = args.has('--verify');
const DRY = args.has('--dry-run');
const DEPLOY = args.has('--deploy');
const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '--base=https://antagaorana-haku-tomoshibi-preview.vercel.app').slice(7).replace(/\/$/, '');
const WEBHOOK_URL = `${BASE}/api/salon-stripe-webhook`;
const ALIAS_HOST = BASE.replace(/^https:\/\//, '');
const API_VERSION = '2024-06-20';
const EVENTS = ['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed', 'invoice.paid'];
const PRODUCT_MARK = 'tomoshibi_salon';
const AMOUNT = 2980;

const say = (m) => console.log(m);
const ok = (m) => console.log('  ✔ ' + m);
const ng = (m) => console.log('  ✖ ' + m);

// ── 画面に表示されない入力 ──
function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk) => {
      for (const c of chunk) {
        const code = c.charCodeAt(0);
        if (code === 13 || code === 10 || code === 4) { if (stdin.setRawMode) stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); return resolve(buf.trim()); }
        if (code === 3) { process.stdout.write('\n中止しました。\n'); process.exit(1); }
        if (code === 127 || code === 8) buf = buf.slice(0, -1); else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

// ── Vercel CLI（値は標準入力で渡す。出力に値は出ない） ──
function vercel(argv, input) {
  return spawnSync('vercel', argv, { cwd: REPO, input, encoding: 'utf8', shell: process.platform === 'win32' });
}
function vercelPreviewEnvNames() {
  const r = vercel(['env', 'ls', 'preview']);
  if (r.status !== 0) return null;
  return new Set((r.stdout || '').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((n) => /^[A-Z][A-Z0-9_]+$/.test(n)));
}
function vercelSetPreview(name, value, secret) {
  const r = vercel(['env', 'add', name, 'preview', '--force', '--yes', secret ? '--sensitive' : '--no-sensitive'], value + '\n');
  return r.status === 0;
}

async function main() {
  say('教育者のサロン「灯」Stripe設定（テストモード・Preview）' + (VERIFY ? '：確認のみ' : DRY ? '：ドライラン' : ''));
  // テスト用の差し替え口：偽のStripeサーバー（tests-unit/salon-stripe-setup.test.mjs）を指すときだけ、キーを環境変数から受け取る
  const fakePort = process.env.SALON_SETUP_TEST_STRIPE_PORT;
  const key = fakePort ? (process.env.SALON_SETUP_TEST_KEY || '') : await askHidden('Stripeのテストキー（sk_test_… または rk_test_…。入力は表示されません）: ');
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) { ng('テストモードのキーではありません（ライブキーは使えません）。'); process.exit(1); }
  const stripe = new Stripe(key, { apiVersion: API_VERSION, ...(fakePort ? { host: 'localhost', port: Number(fakePort), protocol: 'http' } : {}) });

  const envNames = vercelPreviewEnvNames();
  if (!envNames) { ng('Vercel CLIで、Previewの環境変数を確認できませんでした（vercel login 済みか確認してください）。'); process.exit(1); }

  // 1) 商品
  say('\n[1] 商品');
  let products = (await stripe.products.list({ limit: 100, active: true })).data.filter((p) => p.metadata?.product === PRODUCT_MARK);
  let product = products[0];
  if (products.length > 1) say('  ※ 灯の商品が複数あります。最初のものを使います。');
  if (product) ok(`灯専用の商品は作成済み（${product.id}）。再利用します`);
  else if (VERIFY || DRY) ng('灯専用の商品はまだありません' + (DRY ? '（実行すると作成します）' : ''));
  else { product = await stripe.products.create({ name: '教育者のサロン 灯', description: '教育者のサロン「灯」の月額会員（毎月自動更新）', metadata: { product: PRODUCT_MARK, community: 'tomoshibi' } }); ok(`灯専用の商品を作成しました（${product.id}）`); }

  // 2) Price
  say('\n[2] Price（月額2,980円）');
  let price = null;
  if (product) {
    const prices = (await stripe.prices.list({ product: product.id, active: true, limit: 100 })).data;
    price = prices.find((p) => p.unit_amount === AMOUNT && p.currency === 'jpy' && p.type === 'recurring' && p.recurring?.interval === 'month' && (p.recurring?.interval_count || 1) === 1) || null;
  }
  if (price) ok(`月額2,980円（JPY・毎月）のPriceは作成済み（${price.id}）。再利用します`);
  else if (VERIFY || DRY || !product) ng('月額2,980円のPriceはまだありません' + (DRY ? '（実行すると作成します）' : ''));
  else { price = await stripe.prices.create({ product: product.id, unit_amount: AMOUNT, currency: 'jpy', recurring: { interval: 'month' }, nickname: '灯 月額', metadata: { product: PRODUCT_MARK } }); ok(`Priceを作成しました（${price.id}）`); }

  // 3) Webhook
  say('\n[3] Webhook');
  const endpoints = (await stripe.webhookEndpoints.list({ limit: 100 })).data;
  let endpoint = endpoints.find((e) => e.url === WEBHOOK_URL) || null;
  let webhookSecret = null;
  const secretInVercel = envNames.has('SALON_STRIPE_WEBHOOK_SECRET');
  if (endpoint) {
    ok(`灯のWebhook送信先は登録済み（${endpoint.id}）`);
    const missing = EVENTS.filter((e) => !endpoint.enabled_events.includes(e) && !endpoint.enabled_events.includes('*'));
    if (endpoint.api_version && endpoint.api_version !== API_VERSION) say(`  ※ このWebhookのAPIバージョンは ${endpoint.api_version} です（アプリの想定は ${API_VERSION}）。アプリは両方の形式に対応しています`);
    if (endpoint.livemode) { ng('このWebhookはライブモードです。テストモードのものではありません。'); process.exit(1); }
    if (missing.length) {
      if (VERIFY || DRY) ng(`購読が足りません：${missing.join(', ')}`);
      else { await stripe.webhookEndpoints.update(endpoint.id, { enabled_events: [...new Set([...endpoint.enabled_events, ...EVENTS])] }); ok(`不足していた購読を追加しました：${missing.join(', ')}`); }
    } else ok('購読イベントは、5つすべて揃っています');
    if (endpoint.status !== 'enabled') ng(`状態が有効ではありません（${endpoint.status}）`);
    if (!secretInVercel && !VERIFY && !DRY) {
      // 署名Secretは作成時にしか取得できない。灯のURLのWebhookだけを作り直す
      await stripe.webhookEndpoints.del(endpoint.id);
      const created = await stripe.webhookEndpoints.create({ url: WEBHOOK_URL, enabled_events: EVENTS, api_version: API_VERSION, description: '教育者のサロン 灯（Preview）', metadata: { product: PRODUCT_MARK } });
      endpoint = created; webhookSecret = created.secret;
      ok('VercelにSecretが無かったため、灯のWebhookだけを作り直しました');
    } else if (!secretInVercel) ng('Vercelに SALON_STRIPE_WEBHOOK_SECRET がありません');
  } else if (VERIFY || DRY) ng('灯のWebhook送信先はまだありません' + (DRY ? '（実行すると登録します）' : ''));
  else {
    const created = await stripe.webhookEndpoints.create({ url: WEBHOOK_URL, enabled_events: EVENTS, api_version: API_VERSION, description: '教育者のサロン 灯（Preview）', metadata: { product: PRODUCT_MARK } });
    endpoint = created; webhookSecret = created.secret;
    ok(`灯のWebhook送信先を登録しました（${created.id}）`);
  }

  // 4) Vercel Preview環境変数
  say('\n[4] Vercel（Previewスコープ・灯専用の変数のみ）');
  if (VERIFY || DRY) {
    for (const n of ['SALON_STRIPE_PRICE_ID', 'SALON_STRIPE_WEBHOOK_SECRET']) (envNames.has(n) ? ok : ng)(`${n}：${envNames.has(n) ? '設定済み' : '未設定'}`);
    ok(`STRIPE_SECRET_KEY（HAKUと共通のテストキー）：${envNames.has('STRIPE_SECRET_KEY') ? '設定済み' : '未設定'}`);
  } else {
    if (price) (vercelSetPreview('SALON_STRIPE_PRICE_ID', price.id, false) ? ok : ng)('SALON_STRIPE_PRICE_ID を設定しました');
    if (webhookSecret) (vercelSetPreview('SALON_STRIPE_WEBHOOK_SECRET', webhookSecret, true) ? ok : ng)('SALON_STRIPE_WEBHOOK_SECRET を設定しました（Secret・値は表示しません）');
    else if (secretInVercel) ok('SALON_STRIPE_WEBHOOK_SECRET は設定済み（そのまま使います）');
  }

  // 5) 再デプロイ
  if (DEPLOY && !VERIFY && !DRY) {
    say('\n[5] Previewを再デプロイ（環境変数を反映）');
    const d = vercel(['--yes']);
    const m = /Preview\s+(https:\/\/\S+\.vercel\.app)/.exec((d.stdout || '') + (d.stderr || ''));
    if (d.status !== 0 || !m) { ng('再デプロイに失敗しました。 vercel --yes を手動で実行してください。'); process.exit(1); }
    ok('デプロイしました');
    const a = vercel(['alias', 'set', m[1].replace(/^https:\/\//, ''), ALIAS_HOST]);
    (a.status === 0 ? ok : ng)(`固定のPreview（${ALIAS_HOST}）を更新${a.status === 0 ? 'しました' : 'できませんでした'}`);
  } else if (!VERIFY && !DRY) say('\n環境変数を反映するため、Previewの再デプロイが必要です（--deploy を付けて再実行するか、Claudeに「設定完了」と伝えてください）。');

  say('\n完了。Stripeのキーは、どこにも保存していません。');
}

main().catch((err) => { console.error('\nエラー：', err?.raw?.message || err?.message || err); process.exit(1); });

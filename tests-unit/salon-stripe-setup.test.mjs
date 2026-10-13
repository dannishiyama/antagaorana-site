/**
 * 設定スクリプト（scripts/salon-stripe-setup.mjs）のテスト。
 * 「偽のStripeサーバー」と「偽のvercelコマンド」に向けて実行する。本物のStripe・Vercelには接続しない。
 * 確かめること：灯専用の商品・Price・Webhookを作る／2回目は重複を作らない／HAKUの既存の商品・Price・Webhookに触れない／
 * ライブキーは拒否／Secretは標準出力に出ない・Vercelへは標準入力で渡る／Previewスコープの灯専用変数だけを設定する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'salon-stripe-setup.mjs');
const WEBHOOK_URL = 'https://antagaorana-haku-tomoshibi-preview.vercel.app/api/salon-stripe-webhook';

// ── 偽のStripe（HAKUの商品・Price・Webhookが、最初から入っている） ──
function parseForm(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const parts = k.replace(/\]/g, '').split('[');
    let o = out;
    parts.forEach((p, i) => { if (i === parts.length - 1) o[p] = v; else o = (o[p] ||= {}); });
  }
  const fix = (o) => { if (o && typeof o === 'object') { Object.keys(o).forEach((k) => { o[k] = fix(o[k]); }); if (Object.keys(o).length && Object.keys(o).every((k) => /^\d+$/.test(k))) return Object.values(o); } return o; };
  return fix(out);
}
async function startFakeStripe(live = false) {
  const st = { calls: [], products: [{ id: 'prod_haku', active: true, name: 'HAKU Community', metadata: { product: 'haku_community' } }], prices: [{ id: 'price_haku', active: true, product: 'prod_haku', unit_amount: 2980, currency: 'jpy', type: 'recurring', recurring: { interval: 'month', interval_count: 1 } }], hooks: [{ id: 'we_haku', url: 'https://antagaorana-haku-tomoshibi-preview.vercel.app/api/haku-stripe-webhook', enabled_events: ['checkout.session.completed'], status: 'enabled', livemode: false, api_version: null }], seq: 0 };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'); const body = parseForm(raw); st.calls.push(`${req.method} ${u.pathname}`);
      const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const list = (data) => json({ object: 'list', data, has_more: false });
      if (u.pathname === '/v1/products' && req.method === 'GET') return list(st.products);
      if (u.pathname === '/v1/products' && req.method === 'POST') { const p = { id: `prod_${++st.seq}`, active: true, ...body }; st.products.push(p); return json(p); }
      if (u.pathname === '/v1/prices' && req.method === 'GET') return list(st.prices.filter((p) => p.product === u.searchParams.get('product')));
      if (u.pathname === '/v1/prices' && req.method === 'POST') { const p = { id: `price_${++st.seq}`, active: true, type: 'recurring', unit_amount: Number(body.unit_amount), currency: body.currency, product: body.product, recurring: { interval: body.recurring.interval, interval_count: 1 }, metadata: body.metadata }; st.prices.push(p); return json(p); }
      if (u.pathname === '/v1/webhook_endpoints' && req.method === 'GET') return list(st.hooks);
      if (u.pathname === '/v1/webhook_endpoints' && req.method === 'POST') { const h = { id: `we_${++st.seq}`, url: body.url, enabled_events: body.enabled_events, api_version: body.api_version, status: 'enabled', livemode: live, secret: `whsec_FAKE${st.seq}secretvalue` }; st.hooks.push({ ...h, secret: undefined }); return json(h); }
      const m = /^\/v1\/webhook_endpoints\/(we_\w+)$/.exec(u.pathname);
      if (m && req.method === 'DELETE') { st.hooks = st.hooks.filter((h) => h.id !== m[1]); return json({ id: m[1], deleted: true }); }
      if (m && req.method === 'POST') { const h = st.hooks.find((x) => x.id === m[1]); Object.assign(h, body); return json(h); }
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'not found in fake' } }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  return { st, server, port: server.address().port };
}

// ── 偽のvercelコマンド（PATHの先頭に置く）。環境変数の「名前」と、渡された値・引数を記録する ──
function makeFakeVercel(dir, statePath) {
  const js = path.join(dir, 'fake-vercel.mjs');
  fs.writeFileSync(js, `import fs from 'node:fs';
const st = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
const argv = process.argv.slice(2);
let input = ''; try { input = fs.readFileSync(0, 'utf8'); } catch {}
st.calls.push({ argv, input });
if (argv[0] === 'env' && argv[1] === 'ls') { console.log(' name  value  type  environments'); st.names.forEach((n) => console.log(' ' + n + '  Hidden  Secret  Preview')); }
else if (argv[0] === 'env' && argv[1] === 'add') { if (!st.names.includes(argv[2])) st.names.push(argv[2]); }
else if (argv[0] === '--yes') { console.log('  Preview         https://antagaorana-site-fake123-x.vercel.app'); }
fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(st));
`);
  if (process.platform === 'win32') fs.writeFileSync(path.join(dir, 'vercel.cmd'), `@echo off\r\nnode "%~dp0fake-vercel.mjs" %*\r\n`);
  else { fs.writeFileSync(path.join(dir, 'vercel'), `#!/bin/sh\nexec node "$(dirname "$0")/fake-vercel.mjs" "$@"\n`); fs.chmodSync(path.join(dir, 'vercel'), 0o755); }
}

function runScript({ port, dir, key = 'sk_test_FAKEKEYFORTESTS', flags = [] }) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...flags], { cwd: ROOT, env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, SALON_SETUP_TEST_STRIPE_PORT: String(port), SALON_SETUP_TEST_KEY: key } });
    let out = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { out += c; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('設定スクリプト：灯専用の商品・Price・Webhookを作り、Previewの灯専用変数だけを設定する。HAKUの既存には触れず、Secretは表示しない', async () => {
  const { st, server, port } = await startFakeStripe();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salon-setup-')); const statePath = path.join(dir, 'vercel-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ calls: [], names: ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'HAKU_STRIPE_WEBHOOK_SECRET'] })); makeFakeVercel(dir, statePath);
  try {
    const hakuBefore = JSON.stringify([st.products[0], st.prices[0], st.hooks[0]]);
    const r1 = await runScript({ port, dir, flags: ['--deploy'] });
    assert.equal(r1.code, 0, r1.out);
    // 灯専用の商品・Price・Webhook
    const salonProduct = st.products.find((p) => p.metadata?.product === 'tomoshibi_salon');
    assert.ok(salonProduct && salonProduct.name === '教育者のサロン 灯' && salonProduct.id !== 'prod_haku');
    const salonPrice = st.prices.find((p) => p.product === salonProduct.id);
    assert.deepEqual([salonPrice.unit_amount, salonPrice.currency, salonPrice.recurring.interval], [2980, 'jpy', 'month']);
    const hook = st.hooks.find((h) => h.url === WEBHOOK_URL);
    assert.deepEqual([...hook.enabled_events].sort(), ['checkout.session.completed', 'customer.subscription.deleted', 'customer.subscription.updated', 'invoice.paid', 'invoice.payment_failed']);
    assert.equal(hook.api_version, '2024-06-20', 'アプリの想定のAPIバージョンに固定する');
    // HAKUの既存は不変
    assert.equal(JSON.stringify([st.products[0], st.prices[0], st.hooks[0]]), hakuBefore);
    // Vercel：Previewスコープの灯専用変数だけ。値は標準入力。Secretとして保存
    const vs = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const adds = vs.calls.filter((c) => c.argv[0] === 'env' && c.argv[1] === 'add');
    assert.deepEqual(adds.map((c) => c.argv[2]).sort(), ['SALON_STRIPE_PRICE_ID', 'SALON_STRIPE_WEBHOOK_SECRET']);
    assert.ok(adds.every((c) => c.argv[3] === 'preview' && !c.argv.includes('production') && !c.argv.includes('development')), 'Previewスコープだけ');
    assert.equal(adds.find((c) => c.argv[2] === 'SALON_STRIPE_PRICE_ID').input.trim(), salonPrice.id);
    const sec = adds.find((c) => c.argv[2] === 'SALON_STRIPE_WEBHOOK_SECRET');
    assert.match(sec.input.trim(), /^whsec_FAKE/); assert.ok(sec.argv.includes('--sensitive'), 'Secretとして保存');
    assert.ok(!sec.argv.join(' ').includes('whsec_'), '値は引数に出さない');
    // 出力にSecret・キーは出ない
    assert.ok(!r1.out.includes('whsec_') && !r1.out.includes('sk_test_FAKEKEY'), '出力にSecretが出ている');
    // 再デプロイと固定Previewの更新
    assert.ok(vs.calls.some((c) => c.argv[0] === '--yes') && vs.calls.some((c) => c.argv[0] === 'alias' && c.argv[2] === 'set' || c.argv[1] === 'set'), '再デプロイ＋alias');

    // 2回目：重複を作らない（商品・Price・Webhookは1つのまま。Secretは設定済みなので作り直さない）
    const counts = () => [st.products.length, st.prices.length, st.hooks.length];
    const before = counts(); const callsBefore = st.calls.length;
    const r2 = await runScript({ port, dir });
    assert.equal(r2.code, 0, r2.out);
    assert.deepEqual(counts(), before, '重複して作らない');
    assert.ok(!st.calls.slice(callsBefore).some((c) => c.startsWith('POST /v1/products') || c.startsWith('POST /v1/prices') || c.startsWith('DELETE')), '2回目は作成も削除もしない');
    assert.match(r2.out, /再利用します/);
    // 確認だけ：何も変えない
    const callsV = st.calls.length;
    const rv = await runScript({ port, dir, flags: ['--verify'] });
    assert.equal(rv.code, 0); assert.ok(!st.calls.slice(callsV).some((c) => c.startsWith('POST') || c.startsWith('DELETE')), '--verify は読み取りだけ');
    // Webhookはあるが、VercelにSecretが無いとき：灯のWebhookだけを作り直す（HAKUのWebhookは残る）
    const vs2 = JSON.parse(fs.readFileSync(statePath, 'utf8')); vs2.names = vs2.names.filter((n) => n !== 'SALON_STRIPE_WEBHOOK_SECRET'); fs.writeFileSync(statePath, JSON.stringify(vs2));
    const r3 = await runScript({ port, dir });
    assert.equal(r3.code, 0, r3.out);
    assert.equal(st.hooks.filter((h) => h.url === WEBHOOK_URL).length, 1, '灯のWebhookは1つのまま');
    assert.ok(st.hooks.some((h) => h.id === 'we_haku'), 'HAKUのWebhookは残る');
    assert.equal(JSON.stringify([st.products[0], st.prices[0], st.hooks.find((h) => h.id === 'we_haku')]), hakuBefore);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('設定スクリプト：ライブキーは拒否する（何も作らない）', async () => {
  const { st, server, port } = await startFakeStripe();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salon-setup-')); const statePath = path.join(dir, 'vercel-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ calls: [], names: [] })); makeFakeVercel(dir, statePath);
  try {
    const r = await runScript({ port, dir, key: 'sk_live_FAKEKEYFORTESTS' });
    assert.notEqual(r.code, 0); assert.match(r.out, /テストモードのキーではありません/);
    assert.equal(st.calls.length, 0, 'Stripeには一切アクセスしない');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).calls.length, 0);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

const PROD_URL = 'https://www.antagaorana.com/api/salon-stripe-webhook';
test('本番用スクリプト：ライブキーだけ受け付け、Productionスコープの灯専用2変数だけ設定する。HAKUには触れず、Previewは変更せず、SALON_PRODUCTION_ENABLEDは設定しない', async () => {
  const { st, server, port } = await startFakeStripe(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salon-setup-')); const statePath = path.join(dir, 'vercel-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ calls: [], names: ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'HAKU_STRIPE_WEBHOOK_SECRET'] })); makeFakeVercel(dir, statePath);
  try {
    const hakuBefore = JSON.stringify([st.products[0], st.prices[0], st.hooks[0]]);
    // テストキーは拒否（Stripeにもアクセスしない）
    const bad = await runScript({ port, dir, key: 'sk_test_FAKEKEYFORTESTS', flags: ['--production'] });
    assert.notEqual(bad.code, 0); assert.match(bad.out, /ライブモードのキーではありません/); assert.equal(st.calls.length, 0);
    // --deploy との併用は不可
    const dep = await runScript({ port, dir, key: 'sk_live_FAKEKEYFORTESTS', flags: ['--production', '--deploy'] });
    assert.notEqual(dep.code, 0); assert.equal(st.calls.length, 0);
    // ライブキーで実行
    const r1 = await runScript({ port, dir, key: 'sk_live_FAKEKEYFORTESTS', flags: ['--production'] });
    assert.equal(r1.code, 0, r1.out);
    const salonProduct = st.products.find((p) => p.metadata?.product === 'tomoshibi_salon');
    const salonPrice = st.prices.find((p) => p.product === salonProduct.id);
    assert.deepEqual([salonPrice.unit_amount, salonPrice.currency, salonPrice.recurring.interval], [2980, 'jpy', 'month']);
    const hook = st.hooks.find((h) => h.url === PROD_URL);
    assert.ok(hook, '本番URLのWebhookを登録');
    assert.deepEqual([...hook.enabled_events].sort(), ['checkout.session.completed', 'customer.subscription.deleted', 'customer.subscription.updated', 'invoice.paid', 'invoice.payment_failed']);
    assert.equal(JSON.stringify([st.products[0], st.prices[0], st.hooks[0]]), hakuBefore, 'HAKUの既存は不変');
    const vs = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(vs.calls.filter((c) => c.argv[0] === 'env' && c.argv[1] === 'ls').every((c) => c.argv[2] === 'production'));
    const adds = vs.calls.filter((c) => c.argv[0] === 'env' && c.argv[1] === 'add');
    assert.deepEqual(adds.map((c) => c.argv[2]).sort(), ['SALON_STRIPE_PRICE_ID', 'SALON_STRIPE_WEBHOOK_SECRET'], 'SALON_PRODUCTION_ENABLED や HAKUの変数は触らない');
    assert.ok(adds.every((c) => c.argv[3] === 'production'), 'Productionスコープだけ（Previewは変更しない）');
    assert.ok(adds.find((c) => c.argv[2] === 'SALON_STRIPE_WEBHOOK_SECRET').argv.includes('--sensitive'));
    assert.ok(!vs.calls.some((c) => c.argv[0] === '--yes' || c.argv[0] === 'alias'), '本番デプロイはしない');
    assert.ok(!r1.out.includes('whsec_') && !r1.out.includes('sk_live_FAKEKEY'), '出力にSecretが出ている');
    // 2回目：重複なし・作成も削除もしない
    const before = [st.products.length, st.prices.length, st.hooks.length]; const c0 = st.calls.length;
    const r2 = await runScript({ port, dir, key: 'sk_live_FAKEKEYFORTESTS', flags: ['--production'] });
    assert.equal(r2.code, 0, r2.out);
    assert.deepEqual([st.products.length, st.prices.length, st.hooks.length], before);
    assert.ok(!st.calls.slice(c0).some((c) => c.startsWith('POST /v1/products') || c.startsWith('POST /v1/prices') || c.startsWith('DELETE')));
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

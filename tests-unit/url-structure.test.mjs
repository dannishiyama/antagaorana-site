/**
 * HAKU Community のURL構造（/haku-community/ 配下）のテスト。vercel.json の設定とリポジトリ内の参照を検査する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const cfg = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

const NEW_URLS = {
  top: '/haku-community/', home: '/haku-community/home/', login: '/haku-community/login/', register: '/haku-community/register/',
  thanks: '/haku-community/thanks/', cancel: '/haku-community/cancel/', admin: '/haku-community/admin/',
  setPassword: '/haku-community/set-password/', forgotPassword: '/haku-community/forgot-password/', adminSetPassword: '/haku-community/admin/set-password/',
};
const OLD_TO_NEW = {
  '/haku-community': NEW_URLS.top, '/haku-community.html': NEW_URLS.top,
  '/haku-community-home': NEW_URLS.home, '/haku-community-home.html': NEW_URLS.home,
  '/haku-community-login': NEW_URLS.login, '/haku-community-login.html': NEW_URLS.login,
  '/haku-community-register': NEW_URLS.register, '/haku-community-register.html': NEW_URLS.register,
  '/haku-community-thanks': NEW_URLS.thanks, '/haku-community-thanks.html': NEW_URLS.thanks,
  '/haku-community-cancel': NEW_URLS.cancel, '/haku-community-cancel.html': NEW_URLS.cancel,
  '/admin-community': NEW_URLS.admin, '/admin-community.html': NEW_URLS.admin,
  '/admin-set-password': NEW_URLS.adminSetPassword, '/admin-set-password.html': NEW_URLS.adminSetPassword,
};

test('旧URLはすべて、対応する新URLへ恒久リダイレクトされる', () => {
  const byOld = new Map(cfg.redirects.map((r) => [r.source, r]));
  for (const [oldUrl, newUrl] of Object.entries(OLD_TO_NEW)) {
    const r = byOld.get(oldUrl);
    assert.ok(r, `旧URLのリダイレクトがない: ${oldUrl}`);
    assert.equal(r.destination, newUrl, oldUrl);
    assert.equal(r.permanent, true, oldUrl);
  }
});

test('新URLの末尾スラッシュなしは、スラッシュ付き（正）へ統一される', () => {
  const byOld = new Map(cfg.redirects.map((r) => [r.source, r.destination]));
  for (const url of Object.values(NEW_URLS)) {
    if (url === '/haku-community/') continue;
    assert.equal(byOld.get(url.replace(/\/$/, '')), url, url);
  }
});

test('リダイレクトがループしない（転送先が、別の転送元になっていない）', () => {
  const sources = new Set(cfg.redirects.map((r) => r.source));
  for (const r of cfg.redirects) {
    assert.ok(!sources.has(r.destination), `ループの恐れ: ${r.source} -> ${r.destination}`);
    assert.notEqual(r.source, r.destination);
  }
  // 末尾スラッシュ付きの正URLを、末尾スラッシュなしへ戻す設定がない（Vercelの trailingSlash:false 設定を外していること）
  assert.equal(cfg.trailingSlash, undefined, 'trailingSlash:false が残っていると、スラッシュ付きURLと衝突してループする');
});

test('新URLの実体がある（ディレクトリの index.html、または書き換え先のファイル／関数）', () => {
  for (const key of ['top', 'login', 'register', 'thanks', 'cancel', 'admin', 'adminSetPassword']) {
    const dir = NEW_URLS[key].replace(/^\//, '');
    assert.ok(existsSync(path.join(ROOT, dir, 'index.html')), `${NEW_URLS[key]} の index.html がない`);
  }
  const rewrites = new Map(cfg.rewrites.map((r) => [r.source, r.destination]));
  assert.equal(rewrites.get(NEW_URLS.home), '/api/haku-home');
  assert.ok(existsSync(path.join(ROOT, 'api/haku-home.js')));
  assert.equal(rewrites.get(NEW_URLS.setPassword), '/community-set-password.html');
  assert.equal(rewrites.get(NEW_URLS.forgotPassword), '/forgot-password.html');
  assert.ok(existsSync(path.join(ROOT, 'community-set-password.html')) && existsSync(path.join(ROOT, 'forgot-password.html')));
  // 旧ファイルが残っていない（古いURLが二重に配信されない）
  for (const f of ['haku-community.html', 'haku-community-login.html', 'haku-community-register.html', 'haku-community-thanks.html', 'haku-community-cancel.html', 'admin-community.html', 'admin-set-password.html']) {
    assert.ok(!existsSync(path.join(ROOT, f)), `旧ファイルが残っている: ${f}`);
  }
});

test('Stripe Webhook のURLは変更していない（/api/haku-stripe-webhook のまま）', () => {
  assert.ok(existsSync(path.join(ROOT, 'api/haku-stripe-webhook.js')));
  assert.ok(cfg.functions['api/haku-stripe-webhook.js']);
  assert.ok(!cfg.redirects.some((r) => r.source.includes('webhook') || r.destination.includes('webhook')));
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', '.claude', 'supabase', 'tests-unit', 'tests', 'tests-e2e-local'].includes(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(html|js|mjs|json|xml|txt)$/.test(name)) out.push(p);
  }
  return out;
}

test('コード・HTMLに、旧URL（または相対パスの旧リンク）が残っていない', () => {
  const oldPatterns = [
    /haku-community-(login|register|thanks|cancel)\b/, /haku-community\.html/, /admin-community\b/, /admin-set-password\.html/,
    /(?<!_templates)\/haku-community-home/, /\.\/haku-community/,
  ];
  const hits = [];
  for (const file of walk(ROOT)) {
    if (path.basename(file) === 'vercel.json') continue; // 旧URL→新URLの転送設定そのもの
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (oldPatterns.some((re) => re.test(line))) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('HAKU Communityのページは、画像・CSS・リンクを絶対パスで参照している（階層が変わっても壊れない）', () => {
  const pages = ['haku-community/index.html', 'haku-community/login/index.html', 'haku-community/register/index.html', 'haku-community/thanks/index.html',
    'haku-community/cancel/index.html', 'haku-community/admin/index.html', 'haku-community/admin/set-password/index.html', 'community-set-password.html', 'forgot-password.html', 'api/_templates/haku-community-home.html'];
  for (const f of pages) {
    const html = readFileSync(path.join(ROOT, f), 'utf8');
    const rel = html.match(/(?:src|href)="\.\/[^"]*"/g) || [];
    assert.deepEqual(rel, [], `${f} に相対パスの参照が残っている`);
  }
});

test('canonical・OGのURLも新URL', () => {
  const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
  assert.match(read('haku-community/index.html'), /rel="canonical" href="https:\/\/antagaorana\.com\/haku-community\/"/);
  assert.match(read('haku-community/login/index.html'), /rel="canonical" href="https:\/\/antagaorana\.com\/haku-community\/login\/"/);
  assert.match(read('haku-community/register/index.html'), /rel="canonical" href="https:\/\/antagaorana\.com\/haku-community\/register\/"/);
});

test('メール・決済の戻り先など、サーバーが作るURLは新URL', () => {
  const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
  assert.ok(read('api/haku-checkout.js').includes('/haku-community/thanks/?session_id={CHECKOUT_SESSION_ID}'));
  assert.ok(read('api/haku-checkout.js').includes('/haku-community/cancel/?for='));
  assert.ok(read('api/_lib/stripe-checkout.js').includes('/haku-community/thanks/?session_id={CHECKOUT_SESSION_ID}'));
  assert.ok(read('api/haku-stripe-webhook.js').includes('/haku-community/set-password/?token='));
  const notify = read('api/_lib/notify.js');
  assert.ok(notify.includes('/haku-community/login/') && notify.includes('/haku-community/admin/') && notify.includes('/haku-community/set-password/'));
  assert.ok(notify.includes('/haku-community/admin/set-password/'));
  assert.ok(read('api/admin.js').includes('/haku-community/register/'));
});

test('一般向けの画面にテスト環境・Preview・テストカードの表示がない', () => {
  const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
  for (const f of ['haku-community/index.html', 'haku-community/register/index.html', 'haku-community/thanks/index.html', 'haku-community/login/index.html', 'haku-community/cancel/index.html']) {
    const html = read(f);
    for (const w of [/テスト環境/, /テストカード/, /4242/, /実際の請求は発生/, /Preview確認/, /test-env-notice/, /PRODUCTION_HOSTS/]) assert.ok(!w.test(html), `${f}: ${w}`);
  }
});

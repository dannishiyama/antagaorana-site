// URL体系（/haku-community/ 配下）と、ログイン→会員ホーム→ログアウト、旧URL、認証Cookieの確認（本物のコード × メモリ上のRedis）
// 実行：node tests-e2e-local/url-flow.e2e.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const REPO = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(REPO + 'package.json');
const { chromium } = require('playwright-core');
const { start, seed, MEMBER_PASSWORD } = await import('./e2e-server.mjs');
await seed();
const { server, base } = await start();
const browser = await chromium.launch();
let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log('  ✔', name); } else { fail++; console.log('  ✖', name, JSON.stringify(detail)); } };
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
const pathOf = (page) => new URL(page.url()).pathname;

async function newPage(width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  const bad = [];
  page.on('pageerror', (e) => bad.push('pageerror ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400 && r.status() !== 401 && !/gstatic|fonts/.test(r.url())) bad.push(r.status() + ' ' + new URL(r.url()).pathname); });
  page.on('dialog', (d) => d.accept());
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()); // フォントだけ遮断（Firebase部品などは通常どおり読み込む）
  return { ctx, page, bad };
}

console.log('■ 旧URL → 新URL（ブラウザで開いて、最終的な表示先を確認）');
{
  const { ctx, page, bad } = await newPage();
  const cases = [
    ['/haku-community', '/haku-community/'], ['/haku-community.html', '/haku-community/'],
    ['/haku-community-login.html', '/haku-community/login/'], ['/haku-community-login', '/haku-community/login/'],
    ['/haku-community-register.html', '/haku-community/register/'], ['/haku-community-thanks', '/haku-community/thanks/'],
    ['/haku-community-cancel', '/haku-community/cancel/'], ['/admin-community', '/haku-community/admin/'], ['/admin-community.html', '/haku-community/admin/'],
    ['/admin-set-password.html', '/haku-community/admin/set-password/'],
    ['/haku-community/login', '/haku-community/login/'], ['/haku-community/admin', '/haku-community/admin/'],
    ['/haku-community-home.html', '/haku-community/login/'], ['/haku-community-home', '/haku-community/login/'], ['/haku-community/home/', '/haku-community/login/'],
  ];
  for (const [from, to] of cases) { await page.goto(base + from); eq(`${from} → ${to}`, pathOf(page), to); }
  await page.goto(base + '/haku-community-register.html?segment=general&plan=monthly#top');
  eq('旧URLのクエリ文字列が引き継がれる', new URL(page.url()).search, '?segment=general&plan=monthly');
  eq('転送で404や通信エラーが出ない（未ログインの401を除く）', bad, []);
  await ctx.close();
}

console.log('■ 紹介ページ → ログイン → 会員ホーム（ログイン後も /haku-community/ 配下で認証が維持される）');
{
  const { ctx, page, bad } = await newPage();
  await page.goto(base + '/haku-community/');
  check('紹介ページに「教育支援団体 あんたがおらな」', (await page.innerText('body')).includes('教育支援団体 あんたがおらな'), null);
  eq('紹介ページに、テスト・Preview・テストカードの表示がない', /テスト環境|テストカード|4242|請求は発生|Preview/.test(await page.innerText('body')), false);
  eq('画像が壊れていない', await page.evaluate(() => [...document.images].filter((i) => !i.complete || !i.naturalWidth).length), 0);
  await page.click('a.top-login'); eq('紹介ページのログインボタン → /haku-community/login/', pathOf(page), '/haku-community/login/');
  await page.fill('input[type=email]', 'nishiyama.taro@example.com'); await page.fill('input[type=password]', MEMBER_PASSWORD);
  await page.click('#go');
  await page.waitForURL('**/haku-community/home/**', { timeout: 8000 });
  eq('ログイン後は /haku-community/home/ へ', pathOf(page), '/haku-community/home/');
  await page.waitForSelector('.page.active h1');
  check('会員ホームが表示される（6項目のナビ）', await page.locator('.side .tab').count() === 6, await page.locator('.tab').count());
  const sess = (await ctx.cookies()).find((c) => c.name === 'ht_session');
  check('認証Cookieは Path=/（/haku-community/ 配下でも有効）で HttpOnly', Boolean(sess && sess.path === '/' && sess.httpOnly), sess);
  const heads = {};
  for (const t of ['learn', 'words', 'gather', 'point', 'profile', 'home']) {
    await page.click(`.tab[data-tab="${t}"]`); await page.waitForTimeout(350);
    heads[t] = await page.locator('.page.active h1').innerText();
    check(`${t}: URLは /haku-community/home/ のまま、hash は #${t}`, pathOf(page) === '/haku-community/home/' && new URL(page.url()).hash === '#' + t, page.url());
  }
  eq('各タブの見出し', [heads.learn, heads.words, heads.gather, heads.point, heads.profile], ['学ぶ', 'ことば', '集う', 'HAKUポイント', 'わたしの記録']);
  check('ホームの見出しはあいさつ', /タロウさん/.test(heads.home), heads.home);
  await page.goto(base + '/haku-community/home/#point'); await page.waitForSelector('#pointBody');
  eq('ページを開き直しても認証が維持され、#pointが開く', [pathOf(page), await page.locator('.page.active h1').innerText()], ['/haku-community/home/', 'HAKUポイント']);
  await page.goto(base + '/haku-community-home'); await page.waitForSelector('.side');
  eq('旧URLからも、ログイン済みなら会員ホームへ（ループしない）', pathOf(page), '/haku-community/home/');
  const r = await page.goto(base + '/haku-community/login/');
  eq('ログイン済みで /haku-community/login/ を開いても200', r.status(), 200);
  await page.goto(base + '/haku-community/home/'); await page.click('.tab[data-tab="profile"]');
  await page.click('[data-act="logout"]'); await page.waitForURL('**/haku-community/login/**');
  eq('ログアウト後は /haku-community/login/ へ', pathOf(page), '/haku-community/login/');
  await page.goto(base + '/haku-community/home/');
  eq('ログアウト後に会員ホームを開くと、ログインへ戻される（ループしない）', pathOf(page), '/haku-community/login/');
  eq('ここまでで404・JSエラーなし', bad, []);
  await ctx.close();
}

console.log('■ 各ページの表示（相対パスが壊れていないこと）');
{
  const { ctx, page, bad } = await newPage(390);
  for (const p of ['/haku-community/', '/haku-community/login/', '/haku-community/register/', '/haku-community/thanks/?session_id=cs_x', '/haku-community/cancel/?for=general', '/haku-community/forgot-password/', '/haku-community/set-password/?token=x&community=haku', '/haku-community/admin/', '/haku-community/admin/set-password/?token=x']) {
    const r = await page.goto(base + p);
    const broken = await page.evaluate(() => [...document.images].filter((i) => !i.complete || !i.naturalWidth).map((i) => i.getAttribute('src')));
    const css = await page.evaluate(() => document.styleSheets.length);
    check(`${p.split('?')[0]}: 200・画像/CSS正常`, r.status() === 200 && broken.length === 0 && css > 0, { status: r.status(), broken, css });
  }
  eq('404・JSエラーなし', bad, []);
  await ctx.close();
}
console.log(`\n結果: 成功 ${pass} / 失敗 ${fail}`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);

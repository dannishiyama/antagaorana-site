// 公式サイトに「3つのコミュニティ」への案内を追加したことの検証。
// 最重要：既存の表示が一切減っていないこと。追加した要素（data-community-added）を取り除くと、変更前（基準コミット）とDOMが完全に一致する。
// 実行：node tests-e2e-local/community-links.e2e.mjs
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const REPO_URL = new URL('../', import.meta.url);
const REPO = fileURLToPath(REPO_URL);
const require = createRequire(REPO + 'package.json');
const { chromium } = require('playwright-core');
const { start, seed } = await import('./e2e-server.mjs');
await seed();
const { server, base } = await start();
const OUT = process.env.OUT_DIR || os.tmpdir();
const BASE_COMMIT = '1aaa9b5'; // この改修の直前（公式サイト4ページとメニューが、変更前のまま）
const baseline = (file) => execFileSync('git', ['show', `${BASE_COMMIT}:${file}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
const browser = await chromium.launch();
let pass = 0, fail = 0; const failures = [];
function check(name, ok, detail) { if (ok) { pass++; console.log('  ✔', name); } else { fail++; failures.push(name); console.log('  ✖', name, JSON.stringify(detail)); } }
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(url, { width = 1280, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${url} pageerror ${e.message}`));
  await page.route(/fonts\.(googleapis|gstatic)\.com|calendar\.|google\.com/, (r) => r.abort());
  await page.goto(base + url, { waitUntil: 'domcontentloaded' });
  return { ctx, page };
}
// 基準と、現在のページを、同じ手順で正規化する（追加した要素は取り除く）
const NORMALIZE = `(() => { document.querySelectorAll('[data-community-added]').forEach((e) => e.remove()); const norm = (s) => s.replace(/>\\s+</g, '><').replace(/\\s+/g, ' ').trim(); return { head: norm(document.head.innerHTML), body: norm(document.body.innerHTML) }; })()`;
async function normalizeHtml(html) {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.route('**/*', (r) => r.abort());
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const out = await page.evaluate(NORMALIZE);
  await ctx.close();
  return out;
}

console.log('■ 既存表示が一切減っていない（追加分を除くと、変更前とDOMが完全に一致）');
const PAGES = { 'index.html': '公式トップ', 'etsu.html': '越（etsu・変更なし）', 'haku.html': '拓（HAKU）', 'mei.html': '芽（MEI）', 'shirube.html': '導（SHIRUBE）' };
for (const [file, label] of Object.entries(PAGES)) {
  const before = await normalizeHtml(baseline(file));
  const after = await normalizeHtml(fs.readFileSync(path.join(REPO, file), 'utf8'));
  check(`${label}：<head>（タイトル・メタ・既存のスタイル）が変更前と一致`, before.head === after.head, { b: before.head.length, a: after.head.length });
  check(`${label}：<body>（見出し・文章・画像・ボタン・リンク・メニュー・順序）が変更前と一致`, before.body === after.body, { b: before.body.length, a: after.body.length });
}
// 追加した要素以外に、リンク・画像・見出しが減っていないことも、別の見方で確認する
for (const file of Object.keys(PAGES)) {
  const stats = async (html) => { const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.route('**/*', (r) => r.abort()); await page.setContent(html, { waitUntil: 'domcontentloaded' }); const r = await page.evaluate(() => { document.querySelectorAll('[data-community-added]').forEach((e) => e.remove()); return { links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') + '|' + a.textContent.trim()), imgs: [...document.querySelectorAll('img')].map((i) => i.getAttribute('src')), heads: [...document.querySelectorAll('h1,h2,h3')].map((h) => h.textContent.trim()), btns: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()) }; }); await ctx.close(); return r; };
  const b = await stats(baseline(file)), a = await stats(fs.readFileSync(path.join(REPO, file), 'utf8'));
  eq(`${file}：リンク・画像・見出し・ボタンの一覧が変更前と同じ`, a, b);
}
// 追加の対象外のファイルは、基準から変わっていない
const untouched = ['salon/index.html', 'haku-community/index.html', 'haku-community/login/index.html', 'haku-community/register/index.html', 'salon/tomoshibi/login/index.html', 'salon/tomoshibi/register/index.html', 'api/community-auth.js', 'api/salon.js', 'api/_lib/store.redis.js', 'community.html', 'taku-login.html', 'news.html', 'okubo.html', 'india-project.html'];
const noCr = (t) => t.split(String.fromCharCode(13)).join('');
for (const f of untouched) check(`変更なし：${f}`, noCr(fs.readFileSync(path.join(REPO, f), 'utf8')) === noCr(baseline(f)), null);
const changed = execFileSync('git', ['diff', '--name-only', BASE_COMMIT, '--'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean).filter((f) => !f.startsWith('tests-e2e-local/')).sort();
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter((f) => f && !f.startsWith('.claude/') && f !== '.mcp.json' && !f.startsWith('tests-e2e-local/')).sort();
eq('変更したファイルは、公式トップ・拓・芽・導・ルーティングだけ（新規は縁のページだけ）', [changed, untracked], [['haku.html', 'index.html', 'mei.html', 'shirube.html', 'vercel.json'], ['salon/en/index.html']]);

console.log('■ 追加したメニュー（公式トップ・PC幅）');
{
  const { ctx, page } = await open('/', { width: 1280 });
  const orig = await page.evaluate(() => [...document.querySelectorAll('.nav-links > a')].map((a) => a.textContent.trim()));
  eq('既存のメニュー項目と順番は、そのまま', orig, ['私たちについて', '支援内容', '実際の声', 'お知らせ', 'よくあるご質問']);
  eq('「コミュニティ」は、既存項目の最後に追加される', await page.evaluate(() => [...document.querySelector('.nav-links').children].map((e) => e.textContent.trim().split('\n')[0].trim()).slice(-2)), ['よくあるご質問', 'コミュニティ']);
  const btn = page.locator('#navCommunityBtn'), menu = page.locator('#navCommunityMenu');
  eq('最初は閉じている（aria-expanded=false・非表示）', [await btn.getAttribute('aria-expanded'), await menu.isHidden()], ['false', true]);
  await btn.click();
  eq('クリックで開く（aria-expanded=true）', [await btn.getAttribute('aria-expanded'), await menu.isVisible()], ['true', true]);
  eq('3つのコミュニティが、指定の順・名称・説明で並ぶ', await menu.locator('a').evaluateAll((as) => as.map((a) => [a.getAttribute('href'), a.querySelector('b').textContent, a.querySelector('small').textContent])), [['/haku-community/', 'HAKU Community', '社会人向けコミュニティ'], ['/salon/en/', '親のサロン 縁（えん）', '保護者向けコミュニティ'], ['/salon/', '教育者のサロン 灯（TOMOSHIBI）', '教育者向けコミュニティ']]);
  await page.screenshot({ path: path.join(OUT, 'oc-index-pc-menu.png') }).catch(() => {});
  await page.keyboard.press('Escape');
  eq('Escapeで閉じ、フォーカスはボタンに戻る', [await menu.isHidden(), await page.evaluate(() => document.activeElement && document.activeElement.id)], [true, 'navCommunityBtn']);
  await btn.click(); await page.mouse.click(300, 600);
  eq('外側をクリックすると閉じる', await menu.isHidden(), true);
  await btn.focus(); await page.keyboard.press('Enter');
  eq('キーボード（Enter）で開ける', await menu.isVisible(), true);
  await page.keyboard.press('Tab');
  eq('開いたあと、Tabで最初のリンクにフォーカスが移る（フォーカス表示つき）', await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('href')), '/haku-community/');
  await ctx.close();
  for (const w of [901, 960, 1024, 1440]) {
    const c = await open('/', { width: w }); await c.page.waitForSelector('nav');
    const g = await c.page.evaluate(() => { const nav = document.querySelector('nav').getBoundingClientRect(); const links = document.querySelector('.nav-links').getBoundingClientRect(); const cta = document.querySelector('.nav-cta').getBoundingClientRect(); const logo = document.querySelector('.nav-logo').getBoundingClientRect(); return { navH: Math.round(nav.height), fit: links.right <= cta.left + 1 && links.left >= logo.right - 1, noOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }; });
    eq(`PC ${w}px：ナビの高さは変わらず（78px）、項目が重ならず、横にはみ出さない`, g, { navH: 78, fit: true, noOverflow: true });
    await c.ctx.close();
  }
}
console.log('■ 追加したメニュー（スマホ・既存のハンバーガー）');
{
  const { ctx, page } = await open('/', { width: 390, height: 844 });
  const burger = page.locator('.nav-burger');
  await burger.click();
  eq('既存のハンバーガーが、従来どおり開く', [await burger.getAttribute('aria-expanded'), await page.locator('#navDrawer').isVisible()], ['true', true]);
  const items = await page.evaluate(() => [...document.querySelectorAll('#navDrawer > a, #navDrawer .nav-drawer-parent')].map((e) => e.textContent.trim()));
  eq('既存の項目と順番は、そのまま（MENU・5項目・「コミュニティ」・相談ボタン）', items, ['私たちについて', '支援内容', '実際の声', 'お知らせ', 'よくあるご質問', 'コミュニティ', 'まず、相談してみる']);
  const parent = page.locator('.nav-drawer-parent'), sub = page.locator('#navDrawerCommunity');
  eq('「コミュニティ」は、最初は畳まれている', [await parent.getAttribute('aria-expanded'), await sub.isHidden()], ['false', true]);
  await parent.click();
  eq('タップで展開（aria-expanded=true）', [await parent.getAttribute('aria-expanded'), await sub.isVisible()], ['true', true]);
  eq('3つが指定の順・名称・説明で並ぶ', await sub.locator('a').evaluateAll((as) => as.map((a) => [a.getAttribute('href'), a.querySelector('b').textContent, a.querySelector('small').textContent])), [['/haku-community/', 'HAKU Community', '社会人向けコミュニティ'], ['/salon/en/', '親のサロン 縁（えん）', '保護者向けコミュニティ'], ['/salon/', '教育者のサロン 灯（TOMOSHIBI）', '教育者向けコミュニティ']]);
  check('各リンクのタップ領域は44px以上', (await sub.locator('a').evaluateAll((as) => as.map((a) => a.getBoundingClientRect().height))).every((h) => h >= 44), null);
  check('横はみ出しなし', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), null);
  await page.screenshot({ path: path.join(OUT, 'oc-index-sp-menu.png') }).catch(() => {});
  await parent.click();
  eq('もう一度タップで畳まれる', [await parent.getAttribute('aria-expanded'), await sub.isHidden()], ['false', true]);
  await parent.click(); await page.keyboard.press('Escape');
  eq('Escapeで畳まれ、フォーカスは「コミュニティ」に戻る', [await sub.isHidden(), await page.evaluate(() => document.activeElement.className)], [true, 'nav-drawer-parent']);
  await ctx.close();
}

console.log('■ 各ページへの案内ブロックと遷移');
const goes = [
  ['/haku', 'HAKU Community', 'HAKU Communityを見る', '/haku-community/', '拓'],
  ['/mei', '親のサロン 縁（えん）', '親のサロン 縁について', '/salon/en/', '芽'],
  ['/shirube', '親のサロン 縁（えん）', '親のサロン 縁について', '/salon/en/', '導'],
];
for (const [url, title, label, href, name] of goes) {
  const { ctx, page } = await open(url, { width: 1280 });
  const blk = page.locator('.community-guide');
  eq(`${name}：案内ブロックが1つ追加されている（見出し・ボタン・リンク先）`, [await blk.count(), await blk.locator('h2').innerText(), await blk.locator('a.btn').innerText(), await blk.locator('a.btn').getAttribute('href')], [1, title, label, href]);
  const txt = await blk.innerText();
  if (name === '拓') check('拓：説明・補足・別サービスの注記', /日常の中で、自分を磨き続ける環境。/.test(txt) && /社会人向けコミュニティ/.test(txt) && /コーチングとは、別のサービス/.test(txt), txt);
  else check(`${name}：説明（保護者向けコミュニティ。現在、準備を進めています。）と別サービスの注記`, /保護者向けコミュニティ。現在、準備を進めています。/.test(txt) && new RegExp(`${name === '芽' ? '芽（MEI）' : '導（SHIRUBE）'}とは、別のサービスです。`).test(txt), txt);
  check('ブロックは、既存の最後のセクションの後ろ（既存の並びの後）に置かれる', await page.evaluate(() => { const b = document.querySelector('.community-guide'); const prev = b.previousElementSibling; return Boolean(prev) && !prev.hasAttribute('data-community-added') || prev.tagName === 'STYLE'; }), null);
  await page.screenshot({ path: path.join(OUT, `oc-${name === '拓' ? 'haku' : name === '芽' ? 'mei' : 'shirube'}-pc.png`), fullPage: true }).catch(() => {});
  await blk.locator('a.btn').click(); await page.waitForLoadState('domcontentloaded');
  eq(`${name} → ${href} に遷移する`, new URL(page.url()).pathname, href);
  await ctx.close();
  for (const w of [390, 768]) { const c = await open(url, { width: w, height: 844 }); check(`${name}（${w}px）：横はみ出しなし`, await c.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), null); if (w === 390) await c.page.screenshot({ path: path.join(OUT, `oc-${name === '拓' ? 'haku' : name === '芽' ? 'mei' : 'shirube'}-sp.png`), fullPage: true }).catch(() => {}); await c.ctx.close(); }
}

console.log('■ 親のサロン 縁（準備中ページ）');
{
  const r = await fetch(base + '/salon/en', { redirect: 'manual' });
  eq('/salon/en は /salon/en/ へリダイレクトされる（ループなし）', [r.status, r.headers.get('location')], [308, '/salon/en/']);
  const r2 = await fetch(base + '/salon/en/');
  eq('/salon/en/ は200', r2.status, 200);
  const r3 = await fetch(base + '/salon/', { redirect: 'manual' }); const r4 = await fetch(base + '/haku-community/', { redirect: 'manual' });
  eq('/salon/（灯）と /haku-community/ は、これまでどおり200', [r3.status, r4.status], [200, 200]);
  const { ctx, page } = await open('/salon/en/', { width: 1280 });
  const t = await page.locator('body').innerText();
  check('表示内容：名称・保護者向けコミュニティ・現在、準備を進めています。・理念・公式トップへ戻る', /親のサロン 縁（えん）/.test(t) && /保護者向けコミュニティ/.test(t) && /現在、準備を進めています。/.test(t) && /子どもの人生に味方を。/.test(t) && /比べない/.test(t) && /公式トップへ戻る/.test(t), t);
  check('未確定の料金・募集開始日は書かれていない（円・日付なし）。登録・ログイン・決済のフォームもない', !/[0-9,]+\s*円|¥|年\s*[0-9]+\s*月|[0-9]+月[0-9]+日/.test(t) && (await page.locator('form, input, [href*="login"], [href*="register"], [href*="checkout"]').count()) === 0, null);
  eq('タイトルと canonical', [await page.title(), await page.locator('link[rel=canonical]').getAttribute('href')], ['親のサロン 縁（えん）｜保護者向けコミュニティ｜あんたがおらな', 'https://antagaorana.com/salon/en/']);
  await page.screenshot({ path: path.join(OUT, 'oc-en-pc.png'), fullPage: true }).catch(() => {});
  const back = await page.locator('a.back').getAttribute('href');
  eq('「← 公式トップへ戻る」は /', back, '/');
  await ctx.close();
  for (const w of [390, 768]) { const c = await open('/salon/en/', { width: w, height: 844 }); check(`縁（${w}px）：横はみ出しなし`, await c.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), null); if (w === 390) await c.page.screenshot({ path: path.join(OUT, 'oc-en-sp.png'), fullPage: true }).catch(() => {}); await c.ctx.close(); }
}

console.log('■ 3つのコミュニティの遷移（メニューから）');
for (const [href, expectPath] of [['/haku-community/', '/haku-community/'], ['/salon/en/', '/salon/en/'], ['/salon/', '/salon/']]) {
  const { ctx, page } = await open('/', { width: 1280 });
  await page.locator('#navCommunityBtn').click(); await page.locator(`#navCommunityMenu a[href="${href}"]`).click(); await page.waitForLoadState('domcontentloaded');
  eq(`メニュー → ${href}`, [new URL(page.url()).pathname, (await page.title()).length > 0], [expectPath, true]);
  await ctx.close();
}
eq('JavaScriptエラーなし', errors, []);
await browser.close(); server.close?.();
console.log(`\n結果: 成功 ${pass} / 失敗 ${fail}`);
if (fail) { console.log(failures.join('\n')); process.exit(1); }
process.exit(0);

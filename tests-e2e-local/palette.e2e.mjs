// HAKU Communityの全関連画面の配色が、教育者のサロン「灯」の実際のCSS（カラーコード）と一致しているか、文字が読めるか、スマホで横はみ出しがないか。
// 本物の画面（ローカルサーバー）で、画面に実際に使われている色（計算済みスタイル）を集めて確かめる。
// 実行：node tests-e2e-local/palette.e2e.mjs（README参照）。環境変数 OUT_DIR にスクリーンショットを保存。
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const REPO_URL = new URL('../', import.meta.url);
const REPO = fileURLToPath(REPO_URL);
const require = createRequire(REPO + 'package.json');
const { chromium } = require('playwright-core');
const { start, seed, MEMBER_PASSWORD } = await import('./e2e-server.mjs');
await seed();
const { server, base } = await start();
const OUT = process.env.OUT_DIR || os.tmpdir();
const browser = await chromium.launch();

let pass = 0, fail = 0; const failures = [];
function check(name, ok, detail) { if (ok) { pass++; console.log('  ✔', name); } else { fail++; failures.push(name + ' :: ' + JSON.stringify(detail)); console.log('  ✖', name, JSON.stringify(detail)); } }
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
async function shot(page, file, opts) { try { await page.screenshot({ path: path.join(OUT, file), ...(opts || {}) }); } catch (e) { /* 撮影の失敗は無視 */ } }
const errors = [];
let ipn = 0;

async function open(url, { width = 1280, auth = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ja-JP', extraHTTPHeaders: { 'x-forwarded-for': `10.40.${(++ipn >> 8) & 255}.${ipn & 255}` } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|fonts\./.test(m.text())) errors.push(`[${url}@${width}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${url}@${width}] pageerror ${e.message}`));
  await page.route(/fonts\.(googleapis|gstatic)\.com|googletagmanager|google-analytics|motion/, (r) => r.abort());
  if (auth) {
    await page.goto(base + '/haku-community/login/');
    await page.fill('input[type=email]', 'nishiyama.taro@example.com'); await page.fill('input[type=password]', MEMBER_PASSWORD);
    await page.click('#go', { force: true }); await page.waitForURL('**/haku-community/home/**', { timeout: 8000 }); await page.waitForSelector('.page.active h1');
  }
  if (url) { await page.goto(base + url); await page.waitForLoadState('load'); }
  await new Promise((r) => setTimeout(r, 700));
  return { ctx, page };
}

// ── 画面で実際に使われている色を集める（文字・背景・罫線・グラデーションの色） ──
const COLLECT = `(() => {
  const out = new Map(); const bad = [];
  const norm = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { rgb: p.slice(0, 3).join(','), a: p.length > 3 ? p[3] : 1 }; };
  const add = (c, kind, el) => { const n = norm(c); if (!n || n.a === 0) return; const key = n.rgb; const e = out.get(key) || { n: 0, kinds: new Set(), ex: '' }; e.n++; e.kinds.add(kind); if (!e.ex) e.ex = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''); out.set(key, e); };
  for (const el of document.querySelectorAll('body, body *')) {
    const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0 && el.tagName !== 'BODY') continue;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText) add(cs.color, 'text', el);
    add(cs.backgroundColor, 'bg', el);
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) if (parseFloat(cs['border' + side + 'Width']) > 0 && cs['border' + side + 'Style'] !== 'none') add(cs['border' + side + 'Color'], 'border', el);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') for (const m of cs.backgroundImage.matchAll(/rgba?\\([^)]*\\)/g)) add(m[0], 'gradient', el);
  }
  return [...out.entries()].map(([k, v]) => ({ rgb: k, n: v.n, kinds: [...v.kinds].join('/'), ex: v.ex }));
})()`;

// ── 文字の読みやすさ（文字色と、実際の背景色のコントラスト比） ──
const CONTRAST = `(() => {
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return null; const p = m[1].split(',').map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); let c = parse(cs.backgroundColor); if (cs.backgroundImage && cs.backgroundImage !== 'none') { const g = [...cs.backgroundImage.matchAll(/rgba?\\([^)]*\\)/g)].map((m) => parse(m[0])).filter(Boolean); if (g.length) c = g[Math.floor(g.length / 2)]; } if (c && c.a > 0) stack.push(c); if (c && c.a === 1) break; } let bg = { r: 255, g: 255, b: 255, a: 1 }; for (const c of stack.reverse()) bg = over(c, bg); return bg; };
  const res = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
    const txt = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(''); if (!txt) continue;
    if (el.closest('[hidden], script, style, noscript, option')) continue;
    if (innerWidth < 900 && el.closest('.side-member')) continue; // スマホでは、DOMの外側にある濃い緑の上部バーに重ねて表示される（背景を、別に確認する）
    const bg = bgOf(el); let fg = parse(cs.color); if (!fg) continue; fg = over(fg, bg);
    const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    res.push({ ratio: Math.round(ratio * 100) / 100, large, size, text: txt.slice(0, 24), ex: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') });
  }
  return res;
})()`;

// ── 灯の実CSSから、基準の色を取り出す（実際に描画された値） ──
const base灯 = await (async () => {
  const { ctx, page } = await open('/salon/');
  const v = await page.evaluate(() => { const cs = getComputedStyle(document.documentElement); const o = {}; for (const k of ['green', 'green-dk', 'green-lt', 'cream', 'paper', 'ink', 'mid', 'faint', 'terra', 'gold', 'line', 'line-soft']) o[k] = cs.getPropertyValue('--' + k).trim(); return o; });
  const hero = await page.evaluate(() => getComputedStyle(document.querySelector('.hero')).backgroundColor);
  const btn = await page.evaluate(() => getComputedStyle(document.querySelector('.btn-solid')).backgroundColor);
  const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await ctx.close();
  return { vars: v, hero, btn, body };
})();
const hex2rgb = (h) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h); return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)].join(',') : null; };
const ALLOWED = new Set(Object.values(base灯.vars).map(hex2rgb).filter(Boolean));
// 灯のログイン・登録画面で、濃い背景の上のエラー／成功に使われている色（灯の実ファイルにあることを確認する）
const salonLogin = fs.readFileSync(REPO + 'salon/tomoshibi/login/index.html', 'utf8') + fs.readFileSync(REPO + 'salon/tomoshibi/register/index.html', 'utf8');
for (const c of ['#EDB9A6', '#cfe0c8']) { check(`灯の実ファイルに、状態表示の色 ${c} が使われている`, salonLogin.toLowerCase().includes(c.toLowerCase()), c); ALLOWED.add(hex2rgb(c)); }
['255,255,255', '0,0,0'].forEach((c) => ALLOWED.add(c)); // 白（濃い背景の上の文字・透明度つき）と、ブラウザ既定の黒
console.log('基準（灯の実CSS）:', JSON.stringify(base灯.vars));
eq('基準の取得：灯のヒーロー背景＝灯の --green、ボタン＝--terra、ページ背景＝--cream', [base灯.hero, base灯.btn, base灯.body], [`rgb(${hex2rgb(base灯.vars.green).split(',').join(', ')})`, `rgb(${hex2rgb(base灯.vars.terra).split(',').join(', ')})`, `rgb(${hex2rgb(base灯.vars.cream).split(',').join(', ')})`]);

const PUBLIC = [
  ['/haku-community/', '紹介ページ'], ['/haku-community/register/', '新規会員登録'], ['/haku-community/login/', 'ログイン'],
  ['/haku-community/thanks/', '決済完了'], ['/haku-community/cancel/', '決済中断'], ['/account-settings.html', 'アカウント設定（ゲート）'],
  ['/forgot-password.html', 'パスワード再設定'], ['/community-set-password.html?token=dummy&community=haku', 'パスワード設定'],
];
const HOME = [['home', 'ホーム'], ['learn', '学ぶ'], ['words', 'ことば'], ['gather', '集う'], ['morning', '朝の集まり（カレンダー・参加の記録）'], ['point', 'HAKUポイント'], ['profile', 'マイページ'], ['profile-settings', 'プロフィール設定'], ['email', 'メール変更'], ['password', 'パスワード変更']];

// 本文のコントラスト比の基準：4.5（WCAG AA）。ただし、灯の標準のアクセント色 #B4552F を、ページ背景 #F6F2E9 の上で使う場合は 4.39 になる（灯の画面と同じ）ため、4.3 以上を許容する
const MIN_BODY = 4.3;
const allOff = []; const lowContrast = [];
async function scan(page, label) {
  const colors = await page.evaluate(COLLECT);
  const off = colors.filter((c) => !ALLOWED.has(c.rgb));
  eq(`${label}：使われている色は、すべて灯の色（白・黒を除く）`, off.map((c) => `rgb(${c.rgb}) ${c.kinds} ${c.ex}×${c.n}`), []);
  off.forEach((c) => allOff.push(`${label}: rgb(${c.rgb}) ${c.kinds} ${c.ex}`));
  const ct = await page.evaluate(CONTRAST);
  const low = ct.filter((x) => x.ratio < (x.large ? 3 : MIN_BODY));
  const worst = low.sort((a, b) => a.ratio - b.ratio).slice(0, 6).map((x) => `${x.ratio}:${x.ex}「${x.text}」${x.size}px`);
  check(`${label}：文字のコントラスト（本文4.3以上・大きな文字3以上）`, low.length === 0, { count: low.length, worst });
  low.forEach((x) => lowContrast.push(`${label}: ${x.ratio} ${x.ex}「${x.text}」`));
  eq(`${label}：横はみ出しなし`, await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
}

console.log('■ 公開ページ・認証前の画面（PC 1280px）');
for (const [url, label] of PUBLIC) { const { ctx, page } = await open(url); await scan(page, label); if (url === '/haku-community/') await shot(page, 'palette-01-lp-pc.png', { fullPage: false }); await ctx.close(); }

console.log('■ 会員HOME配下の画面（PC 1280px）');
{
  const { ctx, page } = await open(null, { auth: true });
  for (const [hash, label] of HOME) {
    await page.goto(base + '/haku-community/home/#' + hash); await new Promise((r) => setTimeout(r, 900));
    await scan(page, `会員HOME ${label}`);
    if (hash === 'home') await shot(page, 'palette-02-home-pc.png', { fullPage: false });
    if (hash === 'morning') { try { await page.locator('#p-morning').screenshot({ path: path.join(OUT, 'palette-03-morning-pc.png') }); } catch (e) { /* 無視 */ } }
  }
  // 基準の色の確認：会員HOMEの上部バーの背景＝灯の --green
  const side = await page.evaluate(() => getComputedStyle(document.querySelector('.side')).backgroundColor);
  eq('会員HOME（PC）：左のメニューの背景＝灯の --green', side, `rgb(${hex2rgb(base灯.vars.green).split(',').join(', ')})`);
  await ctx.close();
}

console.log('■ スマホ幅（390px）');
for (const [url, label] of PUBLIC.slice(0, 5)) {
  const { ctx, page } = await open(url, { width: 390 });
  eq(`スマホ ${label}：横はみ出しなし`, await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
  const ct = await page.evaluate(CONTRAST); const low = ct.filter((x) => x.ratio < (x.large ? 3 : MIN_BODY));
  check(`スマホ ${label}：文字のコントラスト`, low.length === 0, low.slice(0, 5).map((x) => `${x.ratio}:${x.ex}「${x.text}」`));
  if (url === '/haku-community/') await shot(page, 'palette-04-lp-mobile.png', { fullPage: false });
  await ctx.close();
}
{
  const { ctx, page } = await open(null, { auth: true, width: 390 });
  for (const [hash, label] of HOME) {
    await page.goto(base + '/haku-community/home/#' + hash); await new Promise((r) => setTimeout(r, 800));
    eq(`スマホ 会員HOME ${label}：横はみ出しなし`, await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
    const ct = await page.evaluate(CONTRAST); const low = ct.filter((x) => x.ratio < (x.large ? 3 : MIN_BODY));
    check(`スマホ 会員HOME ${label}：文字のコントラスト`, low.length === 0, low.slice(0, 5).map((x) => `${x.ratio}:${x.ex}「${x.text}」`));
    if (hash === 'home') { await shot(page, 'palette-05-home-mobile.png', { fullPage: false }); eq('スマホ 会員HOME：上部バーの背景＝灯の --green', await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).backgroundColor), `rgb(${hex2rgb(base灯.vars.green).split(',').join(', ')})`); }
  }
  await ctx.close();
}

// 灯サロン側の見た目は、変更していない（灯のCSSのカラーコードが、そのまま）
const salonRoot = fs.readFileSync(REPO + 'salon/index.html', 'utf8');
check('灯サロンの紹介ページのカラーコードは、そのまま（--green:#1E3A2F など）', ['--green:#1E3A2F', '--terra:#B4552F', '--gold:#C0A05C', '--cream:#F6F2E9', '--paper:#FFFDF8', '--line:#DCD5C5'].every((s) => salonRoot.includes(s)), null);

if (allOff.length) console.log('\n灯の色ではない色:\n' + allOff.join('\n'));
if (lowContrast.length) console.log('\nコントラスト不足:\n' + lowContrast.slice(0, 40).join('\n'));
eq('画面のJavaScriptエラー・予期しないエラーなし', errors, []);
console.log(`\n結果: 成功 ${pass} / 失敗 ${fail}`);
if (fail) console.log('失敗:\n' + failures.join('\n'));
await browser.close(); server.close();
process.exit(fail ? 1 : 0);

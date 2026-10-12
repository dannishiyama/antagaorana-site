// 紹介ページ（/haku-community/ と /salon/）：FAQの初期状態・操作、不自然な改行（孤立行）、横はみ出し、リンクの遷移。
// 本物の画面（ローカルサーバー）。実行：node tests-e2e-local/lp.e2e.mjs（README参照）
import os from 'node:os';
import path from 'node:path';
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
const browser = await chromium.launch();

let pass = 0, fail = 0; const failures = [];
function check(name, ok, detail) { if (ok) { pass++; console.log('  ✔', name); } else { fail++; failures.push(name + ' :: ' + JSON.stringify(detail)); console.log('  ✖', name, JSON.stringify(detail)); } }
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
async function shot(page, file, opts) { try { await page.screenshot({ path: path.join(OUT, file), ...(opts || {}) }); } catch (e) { /* 撮影の失敗は無視 */ } }
const errors = [];

async function open(url, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|fonts\./.test(m.text())) errors.push(`[${url}@${width}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${url}@${width}] pageerror ${e.message}`));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.route(/googletagmanager|google-analytics|motion/, (r) => r.abort());
  await page.goto(base + url); await page.waitForLoadState('load'); await new Promise((r) => setTimeout(r, 700));
  return { ctx, page };
}

// 要素の本文を、実際に描画された「行」に分けて返す（一文字だけの孤立行を見つけるため）
const LINES = `(sel) => [...document.querySelectorAll(sel)].map((el) => {
  const range = document.createRange(); const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const chars = []; let n;
  while ((n = tw.nextNode())) for (let i = 0; i < n.length; i++) { if (!n.data[i].trim()) continue; range.setStart(n, i); range.setEnd(n, i + 1); const r = range.getClientRects()[0]; if (r && r.width > 0) chars.push({ top: Math.round(r.top), ch: n.data[i] }); }
  const lines = []; let cur = null;
  for (const c of chars) { if (!cur || Math.abs(c.top - cur.top) > 6) { cur = { top: c.top, text: '' }; lines.push(cur); } cur.text += c.ch; }
  return { text: el.textContent.replace(/\\s+/g, ''), lines: lines.map((l) => l.text) };
})`;
const TARGETS = '.closing h2, .closing p, h2.lead, .verdict, .lede, .hero h1, .hero p, .att p, .att .mine, .can p, .room .desc, .creed .c .t, .flowline p, .chain p, .map .row .d, .plan li';

for (const [url, label] of [['/haku-community/', 'HAKU Community'], ['/salon/', '灯サロン']]) {
  console.log(`■ ${label}の紹介ページ ${url}`);
  for (const width of [1280, 768, 390]) {
    const { ctx, page } = await open(url, width);
    const tag = `${label} ${width}px`;
    eq(`${tag}：横はみ出しなし`, await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
    // 孤立行：複数行に折り返した文章の最後の行が、一〜二文字だけ、ということがない
    const info = await page.evaluate(`(${LINES})(${JSON.stringify(TARGETS)})`);
    const bad = info.filter((x) => x.lines.length > 1 && x.lines[x.lines.length - 1].length <= 2).map((x) => x.lines);
    eq(`${tag}：見出し・リード・結びの文に、一文字・二文字だけの孤立行がない`, bad, []);
    // 文字が欠けていない（行に分けた文字の合計＝本文）
    check(`${tag}：改行の調整で、文字が消えていない`, info.every((x) => x.lines.join('') === x.text.replace(/[\s]/g, '')), info.filter((x) => x.lines.join('') !== x.text).map((x) => x.text.slice(0, 30)));
    if (width === 1280) {
      if (url.startsWith('/haku')) {
        const cl = info.find((x) => x.text.startsWith('大きな決意はいりません'));
        eq('HAKU 1280px：下部の「大きな決意はいりません。今週の問いを、ひとつ持ち帰るところから。」は1行に収まる', cl.lines.length, 1);
      } else {
        const h = info.find((x) => x.text.startsWith('自分のままで居ていいんだ'));
        eq('灯 1280px：下部の「自分のままで居ていいんだ、と思えた時、」は、1行に収まり、「時、」が次の行に残らない', [h.lines.length, h.lines[0]], [2, '自分のままで居ていいんだ、と思えた時、']);
      }
    }
    if (width === 390) {
      const small = await page.evaluate(() => Math.min(...[...document.querySelectorAll('.closing h2, .closing p, h2.lead')].map((e) => parseFloat(getComputedStyle(e).fontSize))));
      check(`${tag}：文字を極端に小さくしていない（見出し・結びは14px以上）`, small >= 14, small);
    }
    await ctx.close();
  }

  // FAQ：初期状態はすべて閉じている。クリック・キーボードで開閉できる
  const { ctx, page } = await open(url, 1280);
  eq(`${label}：FAQの初期状態は、すべて閉じている`, await page.evaluate(() => [...document.querySelectorAll('#faq details')].map((d) => d.open)).then((a) => ({ n: a.length >= 3, open: a.filter(Boolean).length })), { n: true, open: 0 });
  const first = page.locator('#faq summary').first();
  await first.click();
  eq(`${label}：質問をクリックすると開く`, await page.evaluate(() => [...document.querySelectorAll('#faq details')].map((d) => d.open)).then((a) => a.filter(Boolean).length), 1);
  await first.click();
  eq(`${label}：もう一度クリックすると閉じる`, await page.evaluate(() => [...document.querySelectorAll('#faq details')].filter((d) => d.open).length), 0);
  const second = page.locator('#faq summary').nth(1);
  await second.focus(); await page.keyboard.press('Enter');
  eq(`${label}：キーボード（Tab移動・Enter）でも開ける`, await page.evaluate(() => document.activeElement && document.activeElement.tagName + ':' + document.activeElement.closest('details').open), 'SUMMARY:true');
  await page.keyboard.press('Space');
  eq(`${label}：Spaceキーで閉じる`, await page.evaluate(() => document.activeElement.closest('details').open), false);
  // CTAとリンク：登録・ログイン・ページ内リンクの遷移先
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')));
  const internal = [...new Set(hrefs.filter((h) => h.startsWith('/') && !h.startsWith('//')))];
  const statuses = [];
  for (const h of internal) { const r = await page.request.get(base + h, { maxRedirects: 5 }); statuses.push([h, r.status()]); }
  eq(`${label}：サイト内リンクがすべて開く（404・エラーなし）`, statuses.filter(([, s]) => s >= 400), []);
  check(`${label}：参加・ログインのCTAが、既存のとおり登録・ログインへ`, hrefs.some((h) => /register|#h-apply/.test(h)) && hrefs.some((h) => /login/.test(h)), hrefs.filter((h) => /register|login|h-apply/.test(h)));
  const anchors = hrefs.filter((h) => h.startsWith('#') && h.length > 1);
  const missing = await page.evaluate((a) => a.filter((h) => !document.querySelector(h)), anchors);
  eq(`${label}：ページ内リンク（#…）の移動先がすべてある`, missing, []);
  await shot(page, `lp-${url.includes('haku') ? 'haku' : 'salon'}-pc.png`, { fullPage: true });
  await ctx.close();
}

// HAKUのデザイン改善：見出しの下の金線・柱・週の流れが描画されている（CSSが効いている）
{
  const { ctx, page } = await open('/haku-community/', 1280);
  const cs = await page.evaluate(() => ({
    pillars: [...document.querySelectorAll('#h-pillars .can > div')].map((d) => getComputedStyle(d).borderTopWidth),
    gold: getComputedStyle(document.querySelector('.sec-label'), '::before').height,
    flow: getComputedStyle(document.querySelector('.week .flowline div'), '::before').width,
    why: getComputedStyle(document.querySelector('.why .chain .n')).borderRadius,
    tane: getComputedStyle(document.querySelector('.tane .can > div')).borderLeftWidth,
  }));
  eq('HAKU：4つの柱が、同じ重さのまとまりとして並ぶ（上辺3px）', cs.pillars, ['3px', '3px', '3px', '3px']);
  eq('HAKU：見出しラベルの上に細い金線、週の流れに時間の点、WHYの段階に丸い印、TANEの説明に左の金線', [cs.gold, cs.flow, cs.why !== '0px', cs.tane], ['2px', '13px', true, '3px']);
  await shot(page, 'lp-haku-sections-pc.png', { fullPage: false });
  await ctx.close();
}

eq('画面のJavaScriptエラー・予期しないエラーなし', errors, []);
console.log(`\n結果: 成功 ${pass} / 失敗 ${fail}`);
if (fail) console.log('失敗:\n' + failures.join('\n'));
await browser.close(); server.close();
process.exit(fail ? 1 : 0);

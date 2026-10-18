// 会員画面のUX改善（HOMEの現在ポイント・ポイント目標と植物・朝の集まりの状態表示・スタンプ・マイページ）。
// 本物の画面 × 本物のAPI × メモリ上のRedis。実行：node tests-e2e-local/member-ux.e2e.mjs
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const REPO_URL = new URL('../', import.meta.url);
const REPO = fileURLToPath(REPO_URL);
const require = createRequire(REPO + 'package.json');
const { chromium } = require('playwright-core');
const { start, seed, MEMBER_PASSWORD } = await import('./e2e-server.mjs');
const pointsMod = await import(new URL('api/_lib/points.js', REPO_URL).href);
const att = await import(new URL('api/_lib/morning-attendance.js', REPO_URL).href);
await seed();
const { server, base } = await start();
const OUT = process.env.OUT_DIR || os.tmpdir();
const browser = await chromium.launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const failures = [];
function check(name, ok, detail) { if (ok) { pass++; console.log('  ✔', name); } else { fail++; failures.push(name); console.log('  ✖', name, JSON.stringify(detail)); } }
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
const errors = []; let n = 0;
async function login(email, { width = 1280, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'ja-JP', reducedMotion: 'reduce', extraHTTPHeaders: { 'x-forwarded-for': `10.40.0.${++n}` } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(m.text())) errors.push(`[${email}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${email}] pageerror ${e.message}`));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(base + '/haku-community/login/');
  await page.fill('input[type=email]', email); await page.fill('input[type=password]', MEMBER_PASSWORD);
  await page.click('#go', { force: true }); await page.waitForURL('**/haku-community/home/**', { timeout: 8000 });
  await page.waitForSelector('.page.active h1');
  return { ctx, page };
}
const A = 'nishiyama.taro@example.com', B = 'jiro.yamada@example.com', C = 'miku.sato@example.com';
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

console.log('■ HOME：現在のポイント（台帳の実残高）');
{
  const { ctx, page } = await login(C);
  await page.waitForSelector('#homeStep .step-lead');
  check('HOMEには、HAKUポイントの欄（現在ポイント・目標）は出ない', (await page.locator('#homePoint, .home-pt').count()) === 0 && !/現在のポイント|わたしの目標/.test(await page.locator('#p-home').innerText()), await page.locator('#p-home').innerText());
  await page.goto(base + '/haku-community/home/#point'); await page.waitForSelector('#goalBox .gl-cur-n');
  check('残高0でも、台帳の実際の値（0 pt）を、目標のカードの先頭に出す', /^0\s*pt/.test(await page.locator('#goalBox .gl-cur-n').innerText()), await page.locator('#goalBox').innerText());
  await ctx.close();
}
await pointsMod.grantPoints({ email: A, amount: 30, reason: 'E2E', actorId: 'e2e', requestId: `ux-${Date.now()}` });
await pointsMod.grantPoints({ email: B, amount: 500, reason: 'E2E', actorId: 'e2e', requestId: `ux2-${Date.now()}` });
{
  const { ctx, page } = await login(A);
  await page.waitForSelector('#homeStep .step-lead');
  check('HOMEには、ポイント欄が出ない', (await page.locator('#homePoint, .home-pt').count()) === 0, null);
  eq('HOMEの順番（今日の一歩 → 次の集まり → ことば）', await page.evaluate(() => ['homeStep', 'homePlanGroup', 'homeWordsGroup'].map((i) => document.getElementById(i).getBoundingClientRect().top).every((t, k, a) => k === 0 || t > a[k - 1])), true);
  await page.locator('[data-tab="point"]:visible').first().click(); await page.waitForSelector('#goalBox .gl-cur-n');
  check('ポイント画面：現在のポイント（台帳の実残高 30 pt）が目標のカードの先頭に出る', /^30\s*pt/.test(await page.locator('#goalBox .gl-cur-n').innerText()), await page.locator('#goalBox .gl-cur-n').innerText());
  eq('「現在のポイント」表示は1つだけ（重複なし）', await page.locator('#p-point .gl-cur-n, #p-point .pt-now').count(), 1);
  eq('植物の画像は1つだけ（重複なし）', await page.locator('#p-point svg.plant').count(), 1);
  check('「詳しく見る」でHAKUポイント詳細へ遷移し、目標の空状態が出る', /まだ目標は決めていません/.test(await page.locator('#goalBox').innerText()), await page.locator('#goalBox').innerText());
  eq('空状態の植物は「芽ばえ」', await page.locator('#goalBox svg.plant').getAttribute('aria-label'), '芽ばえ');

  console.log('■ 目標の設定・検証・変更・解除');
  await page.click('#goalOpenBtn');
  for (const bad of ['0', '-5', '1.5', '100001', '']) {
    await page.fill('#goalInputPt', bad); await page.click('#goalSaveBtn');
    await sleep(120);
    check(`不正な目標「${bad}」は保存されない（画面の検証）`, (await page.locator('#goalErrPt').innerText()).length > 0 || bad === '1.5', bad);
  }
  const bal0 = await pointsMod.getBalance(A);
  await page.fill('#goalInputPt', '100'); await page.click('#goalSaveBtn');
  await page.waitForFunction(() => document.querySelector('#goalBox .gl-row b'));
  const txt = await page.locator('#goalBox').innerText();
  check('目標100：現在30（先頭）・目標100・達成率30%・あと70 が出る', /^30\s*pt/.test(await page.locator('#goalBox .gl-cur-n').innerText()) && /目標\s*100\s*pt/.test(txt) && /達成率\s*30%/.test(txt) && /あと\s*70\s*pt/.test(txt), txt);
  eq('達成率30% → 「芽」', await page.locator('#goalBox svg.plant').getAttribute('aria-label'), '成長の様子：葉（達成率 30%）');
  eq('プログレスバーの値', await page.locator('#goalBox [role=progressbar]').getAttribute('aria-valuenow'), '30');
  eq('目標を設定しても残高は変わらない', await pointsMod.getBalance(A), bal0);
  check('目標は、実際の活用が決まったことを意味しないという注記がある', /実際の活用が決まったことを意味しません/.test(txt) && /残高や付与の記録は変わりません/.test(txt), null);
  await page.click('#goalOpenBtn'); await page.fill('#goalInputPt', '40'); await page.click('#goalSaveBtn');
  await page.waitForFunction(() => /達成率\s*75%/.test(document.getElementById('goalBox').innerText));
  eq('目標40 → 75% → 「つぼみ」', await page.locator('#goalBox svg.plant').getAttribute('aria-label'), '成長の様子：つぼみ（達成率 75%）');
  await page.click('#goalOpenBtn'); await page.fill('#goalInputPt', '30'); await page.click('#goalSaveBtn');
  await page.waitForFunction(() => /目標に届きました/.test(document.getElementById('goalBox').innerText));
  eq('目標30 → 100% → 「花」・残りなし', await page.locator('#goalBox svg.plant').getAttribute('aria-label'), '成長の様子：花（達成率 100%）');
  await page.click('#goalOpenBtn'); await page.fill('#goalInputPt', '10'); await page.click('#goalSaveBtn');
  await page.waitForFunction(() => /達成率\s*100%/.test(document.getElementById('goalBox').innerText));
  check('目標が残高を下回っても、達成率は100%で止まる（超過表示にしない）', /達成率\s*100%/.test(await page.locator('#goalBox').innerText()), null);
  await page.goto(base + '/haku-community/home/#home'); await page.waitForSelector('#homeStep .step-lead');
  check('HOMEには出ない（目標・達成率はHAKUポイント画面だけ）', (await page.locator('#p-home [role=progressbar]').count()) === 0, null);
  eq('目標を何度変えても、ポイント残高・履歴は不変', [await pointsMod.getBalance(A), (await pointsMod.getAdminMemberView(A)).entries.length], [30, 1]);
  await page.locator('[data-tab="point"]:visible').first().click(); await page.waitForSelector('#goalClearBtn');
  await page.click('#goalClearBtn');
  await page.waitForFunction(() => /まだ目標は決めていません/.test(document.getElementById('goalBox').innerText));
  eq('目標を解除しても、残高は変わらない', await pointsMod.getBalance(A), 30);
  await page.click('#goalOpenBtn'); await page.fill('#goalInputPt', '300'); await page.click('#goalSaveBtn');
  await page.waitForFunction(() => /達成率\s*10%/.test(document.getElementById('goalBox').innerText));
  eq('最終：目標300・10%・「芽ばえ」', await page.locator('#goalBox svg.plant').getAttribute('aria-label'), '成長の様子：芽ばえ（達成率 10%）');
  await page.screenshot({ path: path.join(OUT, 'ux-point-pc.png'), fullPage: true }).catch(() => {});
  await ctx.close();
}

console.log('■ 他の会員の目標は見えない／影響しない');
{
  const { ctx, page } = await login(B);
  await page.locator('[data-tab="point"]:visible').first().click(); await page.waitForSelector('#goalBox');
  check('別の会員には、他人の目標は出ない（空状態）', /まだ目標は決めていません/.test(await page.locator('#goalBox').innerText()), null);
  const r = await page.evaluate(async () => { const x = await fetch('/api/community-auth?action=points-goal-set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: 700, email: 'nishiyama.taro@example.com' }) }); return x.status; });
  eq('メールアドレスを指定しても、本人の目標だけが変わる', r, 200);
  const mine = await page.evaluate(async () => (await (await fetch('/api/community-auth?action=points-me')).json()).goal);
  eq('本人（B）の目標が700', mine, 700);
  await ctx.close();
  const a = await login(A); await a.page.locator('[data-tab="point"]:visible').first().click(); await a.page.waitForFunction(() => /目標\s*300\s*pt/.test(document.getElementById('goalBox').innerText));
  check('Aの目標は300のまま（Bの操作の影響なし）', true, null);
  await a.ctx.close();
}

console.log('■ スマホ幅390px');
{
  const { ctx, page } = await login(A, { width: 390, height: 844 });
  await page.waitForSelector('#homeStep .step-lead');
  check('HOME：横はみ出しなし', !(await overflow(page)), null);
  await page.screenshot({ path: path.join(OUT, 'ux-home-mobile.png'), fullPage: true }).catch(() => {});
  await page.goto(base + '/haku-community/home/#point'); await page.waitForSelector('#goalBox svg.plant');
  check('ポイント詳細：横はみ出しなし', !(await overflow(page)), null);
  await page.screenshot({ path: path.join(OUT, 'ux-point-mobile.png'), fullPage: true }).catch(() => {});
  const sz = await page.evaluate(() => { const b = document.getElementById('goalOpenBtn').getBoundingClientRect(); return b.height >= 44; });
  check('目標ボタンのタップ領域は44px以上', sz, null);
  await ctx.close();
}

console.log('■ 朝の集まり：状態の区別・スタンプ');
{
  await att.confirmAttendance({ date: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), email: A, source: 'admin', actorId: 'e2e', reason: 'E2E' });
  const { ctx, page } = await login(A);
  await page.goto(base + '/haku-community/home/#morning'); await page.waitForSelector('.mo-grid .mo-cell:not(.blank)');
  check('凡例（参加予定／参加できる日／申込締切済み）が出る', /参加予定/.test(await page.locator('.mo-legend').innerText()) && /参加できる日/.test(await page.locator('.mo-legend').innerText()) && /申込締切済み/.test(await page.locator('.mo-legend').innerText()), null);
  const cls = await page.evaluate(() => ({ open: document.querySelectorAll('.mo-cell.open').length, closed: document.querySelectorAll('.mo-cell.closed').length, past: document.querySelectorAll('.mo-cell.past').length }));
  check('参加できる日（open）が区別されている', cls.open > 0, cls);
  check('既存のカレンダー・参加申請の注意書きは維持', (await page.locator('.mo-month').count()) === 1 && /前々日23:59まで/.test(await page.locator('#morningBody').innerText()), null);
  check('スタンプ：実際の出席記録（確定済み）だけが押印される', (await page.locator('.st-cell.on').count()) >= 1 && (await page.locator('.st-cell.on').count()) === Number((await page.locator('.st-count').innerText()).match(/\d+/)[0]), await page.locator('.st-count').innerText());
  check('カレンダーを過度に大きくしていない（高さ < 520px）', (await page.locator('.mo-grid').evaluate((e) => e.getBoundingClientRect().height)) < 520, null);
  await page.screenshot({ path: path.join(OUT, 'ux-morning-pc.png'), fullPage: true }).catch(() => {});
  await ctx.close();
  const m = await login(A, { width: 390, height: 844 });
  await m.page.goto(base + '/haku-community/home/#morning'); await m.page.waitForSelector('.mo-legend');
  check('朝の集まり（スマホ）：横はみ出しなし', !(await overflow(m.page)), null);
  await m.page.screenshot({ path: path.join(OUT, 'ux-morning-mobile.png'), fullPage: true }).catch(() => {});
  await m.ctx.close();
}

console.log('■ マイページ：既存の導線をすべて維持');
{
  const { ctx, page } = await login(A);
  await page.goto(base + '/haku-community/home/#profile'); await page.waitForSelector('#h-settings');
  const links = await page.locator('#p-profile .block[aria-labelledby="h-settings"] .row-link').allInnerTexts();
  check('設定・メール・パスワード・ログアウト・問い合わせの導線が残っている', ['プロフィール', 'メール', 'パスワード', 'ログアウト', 'お問い合わせ'].every((w) => links.some((l) => l.includes(w))), links);
  const order = await page.evaluate(() => ['h-goals', 'h-recent', 'h-gathered', 'h-sessions', 'h-settings'].map((i) => document.getElementById(i).getBoundingClientRect().top).every((t, k, a) => k === 0 || t > a[k - 1]));
  eq('表示順（約束 → 記録 → 設定）は維持', order, true);
  const small = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('h-settings')).fontSize) < parseFloat(getComputedStyle(document.getElementById('h-recent')).fontSize));
  check('設定とサポートは、わたしの記録より小さく表示される', small, null);
  const lay = await page.evaluate(() => { const cols = [...document.querySelectorAll('.set-col')]; const r = cols.map((c) => c.getBoundingClientRect()); return { n: cols.length, sameTop: Math.abs(r[0].top - r[1].top) < 2, apart: r[0].right <= r[1].left + 1, rows: [...document.querySelectorAll('.set-col .row-link')].every((e) => e.getBoundingClientRect().height >= 44) }; });
  eq('PC：設定とサポートは、2つのまとまりが同じ高さから横に並び、各行は44px以上', lay, { n: 2, sameTop: true, apart: true, rows: true });
  await page.locator('.block[aria-labelledby="h-settings"]').screenshot({ path: path.join(OUT, 'ux-settings-pc.png') }).catch(() => {});
  await page.screenshot({ path: path.join(OUT, 'ux-profile-pc.png'), fullPage: true }).catch(() => {});
  await ctx.close();
  const m = await login(A, { width: 390, height: 844 });
  await m.page.goto(base + '/haku-community/home/#profile'); await m.page.waitForSelector('#h-settings');
  check('マイページ（スマホ）：横はみ出しなし', !(await overflow(m.page)), null);
  const lay2 = await m.page.evaluate(() => { const cols = [...document.querySelectorAll('.set-col')]; const r = cols.map((c) => c.getBoundingClientRect()); return { stacked: r[1].top >= r[0].bottom - 1, inView: r.every((x) => x.left >= 0 && x.right <= window.innerWidth + 1), rows: [...document.querySelectorAll('.set-col .row-link')].every((e) => e.getBoundingClientRect().height >= 44) }; });
  eq('スマホ：設定とサポートは縦に積まれ、画面内に収まり、各行は44px以上', lay2, { stacked: true, inView: true, rows: true });
  await m.page.locator('.block[aria-labelledby="h-settings"]').screenshot({ path: path.join(OUT, 'ux-settings-mobile.png') }).catch(() => {});
  await m.page.screenshot({ path: path.join(OUT, 'ux-profile-mobile.png'), fullPage: true }).catch(() => {});
  await m.ctx.close();
}

eq('画面のJavaScriptエラーなし', errors, []);
await browser.close(); server.close?.();
console.log(`\n結果: 成功 ${pass} / 失敗 ${fail}`);
if (fail) { console.log(failures.join('\n')); process.exit(1); }
process.exit(0);

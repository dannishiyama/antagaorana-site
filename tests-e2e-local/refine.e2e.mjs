// 総仕上げのE2E：植物の5段階（芽ばえ→葉→葉が茂る→つぼみ→花）・残高と積み重ねの分離・集う（次の一歩・スタンプ）・ことばの区別・記録帳（歩み）・HOMEの主役。
// 本物の画面 × 本物のAPI × メモリ上のRedis。実行：node tests-e2e-local/refine.e2e.mjs
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const REPO_URL = new URL('../', import.meta.url);
const REPO = fileURLToPath(REPO_URL);
const require = createRequire(REPO + 'package.json');
const { chromium } = require('playwright-core');
const { start, seed, store, MEMBER_PASSWORD } = await import('./e2e-server.mjs');
const P = await import(new URL('api/_lib/points.js', REPO_URL).href);
const att = await import(new URL('api/_lib/morning-attendance.js', REPO_URL).href);
const { deps: mailDeps } = await import(new URL('api/_lib/donation-mail.js', REPO_URL).href);
mailDeps.send = async () => ({ data: { id: 'e2e' } });
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
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'ja-JP', reducedMotion: 'reduce', extraHTTPHeaders: { 'x-forwarded-for': `10.80.0.${++n}` } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|status of/.test(m.text())) errors.push(`[${email}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${email}] pageerror ${e.message}`));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(base + '/haku-community/login/');
  await page.fill('input[type=email]', email); await page.fill('input[type=password]', MEMBER_PASSWORD);
  await page.click('#go', { force: true }); await page.waitForURL('**/haku-community/home/**', { timeout: 8000 });
  await page.waitForSelector('.page.active h1');
  return { ctx, page };
}
const A = 'nishiyama.taro@example.com', B = 'jiro.yamada@example.com';
let g = 0; const grant = (email, amount) => P.grantPoints({ email, amount, reason: 'E2E', actorId: 'e2e', requestId: `rf-e2e-${Date.now()}-${++g}` });
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
const month = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
await store.createHakuNote({ type: 'weekly_question', title: '今週の問い', body: '最近、誰かの美点を見つけましたか。', category: '人間関係', createdBy: 'e2e' });
await grant(A, 1500);
await att.confirmAttendance({ date: `${month}-01`, email: A, source: 'admin', actorId: 'e2e', reason: 'E2E' });

console.log('■ 植物の5段階（葉が増え、つぼみがつき、花が咲く）');
const a = await login(A);
await a.page.goto(base + '/haku-community/home/#point'); await a.page.waitForSelector('#goalBox svg.plant');
const plantFn = "(() => { const src = [...document.scripts].map((x) => x.textContent).join(String.fromCharCode(10)); const i = src.indexOf('function plantSvg('), j = src.indexOf('function plantLabel('); return new Function('esc', src.slice(i, j) + '; return plantSvg;')(String); })()";
const strip = await a.page.evaluate((fnSrc) => { const plantSvg = eval(fnSrc); return [0, 1, 2, 3, 4].map((i) => { const d = document.createElement('div'); d.innerHTML = plantSvg(i, 132, 'x'); return { leaves: d.querySelectorAll('.p-leaf').length, buds: d.querySelectorAll('.p-bud').length, petals: d.querySelectorAll('.p-petal').length, seed: d.querySelectorAll('.p-seed').length }; }); }, plantFn);
check('葉は段階とともに増える', strip[0].leaves < strip[1].leaves && strip[1].leaves < strip[2].leaves, strip);
check('つぼみは「つぼみ」の段階でつき、花びらは「花」の段階で咲く。種の描画はない', strip[2].buds === 0 && strip[3].buds >= 2 && strip[3].petals === 0 && strip[4].petals >= 6 && strip.every((x) => x.seed === 0), strip);
await a.page.evaluate((fnSrc) => { const plantSvg = eval(fnSrc); const names = ['芽ばえ', '葉', '葉が茂る', 'つぼみ', '花']; const w = document.createElement('div'); w.id = 'plantStrip'; w.style.cssText = 'display:flex;gap:8px;padding:16px;background:#FFFDF8;position:fixed;left:0;top:0;z-index:9999'; w.innerHTML = names.map((n, i) => '<div style="text-align:center;font-size:12px">' + plantSvg(i, 150, 'x') + '<div>' + n + '</div></div>').join(''); document.body.appendChild(w); }, plantFn);
await a.page.locator('#plantStrip').screenshot({ path: path.join(OUT, 'rf-plants.png') }).catch(() => {});
await a.page.evaluate(() => document.getElementById('plantStrip').remove());

console.log('■ 残高と積み重ねは別（社会貢献に使っても、成長は減らない）');
await a.page.locator('#goalOpenBtn').click(); await a.page.fill('#goalInputPt', '1500'); await a.page.click('#goalSaveBtn');
await a.page.waitForFunction(() => /達成率\s*100%/.test(document.getElementById('goalBox').innerText));
eq('積み重ね1,500 / 目標1,500 → 100% →「花」', await a.page.locator('#goalBox svg.plant').getAttribute('aria-label'), '成長の様子：花（達成率 100%）');
const r = await a.page.evaluate(async () => { const x = await fetch('/api/community-auth?action=donation-create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ causeId: 'india', requestId: 'rf-e2e-req-0001' }) }); return x.status; });
eq('社会貢献の申請（1,000pt）', [r, await P.getBalance(A)], [200, 510]);
await a.page.reload(); await a.page.waitForSelector('#goalBox svg.plant');
const gb = await a.page.locator('#goalBox').innerText();
check('現在のポイント（残高）は510 ptに減るが、積み重ね（1,510 pt）・達成率・「花」は減らない', /^510\s*pt/.test(await a.page.locator('#goalBox .gl-cur-n').innerText()) && /これまでの積み重ね\s*1,510\s*pt/.test(gb) && /達成率\s*100%/.test(gb) && (await a.page.locator('#goalBox svg.plant').getAttribute('aria-label')) === '成長の様子：花（達成率 100%）', gb);
check('残高と積み重ねの説明（使うと減る／使っても減らない）が出る', /社会貢献の申請に使うと、その分は減ります/.test(gb) && /誰かのために使っても、積み重ねの記録は減りません/.test(gb), null);
eq('段階の目安（芽ばえ・葉・葉が茂る・つぼみ・花）が並び、今の段階が示される', [await a.page.locator('.gl-steps li').allInnerTexts(), await a.page.locator('.gl-steps li.on').innerText()], [['芽ばえ', '葉', '葉が茂る', 'つぼみ', '花'], '花']);
check('恩送り（社会貢献）は、ポイント履歴より前にある（流れ：学び→ポイント→支援）', await a.page.evaluate(() => document.getElementById('donationBox').getBoundingClientRect().top < document.getElementById('pointBody').querySelector('.block:last-of-type').getBoundingClientRect().top + 1), null);
await a.page.locator('#goalBox').screenshot({ path: path.join(OUT, 'rf-goal-card.png') }).catch(() => {});

console.log('■ HOME：今週の問いが主役');
await a.page.goto(base + '/haku-community/home/#home'); await a.page.waitForSelector('#homeNote .q-text');
check('今週の問い → 今日の一歩 → 次の集まり → ことば の順。問いは大きな明朝', await a.page.evaluate(() => ['h-question', 'homeStep', 'h-next', 'h-words'].map((i) => document.getElementById(i).getBoundingClientRect().top).every((t, k, x) => k === 0 || t > x[k - 1])) && parseFloat(await a.page.locator('#homeNote .q-text').evaluate((e) => getComputedStyle(e).fontSize)) >= 21, null);
await sleep(600);
await a.page.screenshot({ path: path.join(OUT, 'rf-home-pc.png'), fullPage: true }).catch(() => {});

console.log('■ 集う：次の一歩・出席確認の印');
await a.page.goto(base + '/haku-community/home/#morning'); await a.page.waitForSelector('#moNext');
await a.page.waitForFunction(() => document.getElementById('moNext') && document.getElementById('moNext').textContent.length > 5);
check('「次に何をすればよいか」が、カレンダーの上に出る', /参加したい日を、カレンダーから選んでください|次の/.test(await a.page.locator('#moNext').innerText()), await a.page.locator('#moNext').innerText());
await a.page.waitForFunction(() => document.querySelectorAll('.mo-cell.att').length >= 1);
check('出席確認済みの印（カレンダー）と、直近の出席確認（スタンプ）', (await a.page.locator('.mo-cell.att').count()) >= 1 && /直近の出席確認/.test(await a.page.locator('#moStamps').innerText()), null);
await a.page.locator('#morningBody').screenshot({ path: path.join(OUT, 'rf-morning-pc.png') }).catch(() => {});
const b = await login(B);
await b.page.goto(base + '/haku-community/home/#morning'); await b.page.waitForSelector('#moStamps .st-grid');
check('出席が無い会員には、スタンプの空状態の説明（参加の表明だけでは印は付かない）', /出席が確認されると、ここに印が押されます。参加の表明だけでは、印は付きません。/.test(await b.page.locator('#moStamps').innerText()), null);
await b.ctx.close();

console.log('■ ことば：運営からと、メンバーからの区別');
await a.page.goto(base + '/haku-community/home/#words'); await a.page.waitForSelector('#p-words .words-official');
await sleep(500);
const zones = await a.page.evaluate(() => { const o = getComputedStyle(document.querySelector('.words-official')), m = getComputedStyle(document.querySelector('.words-members')); return { oBorderTop: o.borderTopWidth, oBg: o.backgroundColor, mBg: m.backgroundColor, mBorder: m.borderTopWidth }; });
check('HAKUからのことばは枠のある読み物（金の線）、みんなのことばは枠なしの静かな一覧', zones.oBorderTop === '3px' && zones.mBorder === '0px' && zones.oBg !== zones.mBg, zones);
check('導入文（運営から／メンバーが静かに残す場所。評価や順位はない）', /運営から、日々のなかで受け取ってほしいことばを届けます。/.test(await a.page.locator('.words-official').innerText()) && /評価や順位はありません/.test(await a.page.locator('.words-members').innerText()), null);
await a.page.screenshot({ path: path.join(OUT, 'rf-words-pc.png'), fullPage: true }).catch(() => {});

console.log('■ マイページ：成長の記録帳');
await a.page.goto(base + '/haku-community/home/#profile'); await a.page.waitForSelector('#walkBox:not([hidden])');
const walk = await a.page.locator('#walkBox').innerText();
check('導入文と「これまでの歩み」（朝の集まり（出席を確認）・参加した集まり・書いたことば・月ごとの振り返り）', /記録帳です/.test(await a.page.locator('.me-lead').innerText()) && /朝の集まり（出席を確認）\s*1回/.test(walk.replace(/\n/g, ' ')) && /数を競うものではなく/.test(walk), walk);
await a.page.locator('#p-profile').screenshot({ path: path.join(OUT, 'rf-profile-pc.png') }).catch(() => {});
await a.ctx.close();

console.log('■ スマホ幅390px');
{
  const m = await login(A, { width: 390, height: 844 });
  for (const [hash, sel] of [['home', '.home-q'], ['point', '#goalBox .gl-steps'], ['morning', '#moNext'], ['words', '.words-official'], ['profile', '#walkBox']]) {
    await m.page.goto(base + '/haku-community/home/#' + hash); await m.page.waitForSelector(sel, { state: 'attached' }); await sleep(600);
    check(`${hash}：横はみ出しなし`, !(await overflow(m.page)), null);
  }
  await m.page.goto(base + '/haku-community/home/#point'); await m.page.waitForSelector('#goalBox .gl-steps'); await sleep(400);
  await m.page.locator('#goalBox').screenshot({ path: path.join(OUT, 'rf-goal-mobile.png') }).catch(() => {});
  await m.ctx.close();
}
eq('画面のJavaScriptエラーなし', errors, []);
await browser.close(); server.close?.();
console.log(`\n結果: 成功 ${pass} / 失敗 ${fail}`);
if (fail) { console.log(failures.join('\n')); process.exit(1); }
process.exit(0);

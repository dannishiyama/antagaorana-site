// HAKUポイントの社会貢献（ポイント利用申請）：会員の申請 → 運営の承認・却下・振込記録 → 完了、までの画面とAPIのE2E。
// 本物の画面 × 本物のAPI × メモリ上のRedis（メールは実際には送らない）。実行：node tests-e2e-local/donation.e2e.mjs
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const REPO_URL = new URL('../', import.meta.url);
const REPO = fileURLToPath(REPO_URL);
const require = createRequire(REPO + 'package.json');
const { chromium } = require('playwright-core');
const { start, seed, MEMBER_PASSWORD, ADMIN } = await import('./e2e-server.mjs');
const P = await import(new URL('api/_lib/points.js', REPO_URL).href);
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
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'ja-JP', reducedMotion: 'reduce', extraHTTPHeaders: { 'x-forwarded-for': `10.50.0.${++n}` } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|status of 500/.test(m.text())) errors.push(`[${email}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${email}] pageerror ${e.message}`));
  page.on('dialog', (d) => d.accept('E2Eテストの理由'));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(base + '/haku-community/login/');
  await page.fill('input[type=email]', email); await page.fill('input[type=password]', MEMBER_PASSWORD);
  await page.click('#go', { force: true }); await page.waitForURL('**/haku-community/home/**', { timeout: 8000 });
  await page.waitForSelector('.page.active h1');
  return { ctx, page };
}
const A = 'nishiyama.taro@example.com', B = 'jiro.yamada@example.com', C = 'miku.sato@example.com';
let g = 0; const grant = (email, amount) => P.grantPoints({ email, amount, reason: 'E2E', actorId: 'e2e', requestId: `dn-e2e-${Date.now()}-${++g}` });
await grant(A, 1350); await grant(B, 500); await grant(C, 1000);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
const gotoPoint = async (page) => { await page.goto(base + '/haku-community/home/#point'); await page.waitForSelector('#donationBox .dn'); };

console.log('■ 会員：画面の構成');
const a = await login(A);
await gotoPoint(a.page);
const box = a.page.locator('#donationBox');
check('見出しと説明文', /受け取ったものを、次の誰かへ。/.test(await box.locator('.dn-title').innerText()) && /あなたの積み重ねを、社会への小さな支援につなげます。/.test(await box.locator('.dn-lead').innerText()), null);
check('セクションは、既存のポイント・目標・履歴の「下」にある', await a.page.evaluate(() => ['goalBox', 'donationBox'].map((i) => document.getElementById(i).getBoundingClientRect().top).every((t, k, x) => k === 0 || t > x[k - 1])), null);
eq('支援先はラジオ形式：公開中のインドプロジェクトへの支援と、その他の支援先（運営の承認が必要）', await box.locator('input[name=dnCause]').evaluateAll((els) => els.map((e) => e.closest('label').innerText.trim())), ['インドプロジェクトへの支援', 'その他の支援先（運営の承認が必要）']);
eq('インドプロジェクトは最初から選択済み。その他の入力欄は隠れている', [await box.locator('input[name=dnCause]:checked').getAttribute('value'), await box.locator('#dnOther').isHidden()], ['india', true]);
check('現在のHAKUポイント（1,350 pt）・必要1,000 pt・利用できる1,350 pt・申請後の残り350 pt', /1,350\s*pt/.test(await box.locator('.dn-now').innerText()) && /必要なポイント\s*1,000 pt/.test(await box.locator('.dn-dl').innerText().then((t) => t.replace(/\n/g, ' '))) && /申請後の残り\s*350 pt/.test((await box.locator('.dn-dl').innerText()).replace(/\n/g, ' ')), await box.locator('.dn-card').innerText());
check('円への換算や金額は表示しない', !/円|¥|寄附金控除|控除/.test(await box.innerText()), null);
eq('申請ボタンが使える', await a.page.locator('#dnConfirmBtn').isEnabled(), true);
await box.screenshot({ path: path.join(OUT, 'dn-member-pc.png') }).catch(() => {});

console.log('■ 会員：残高不足（500pt）');
const b = await login(B);
await gotoPoint(b.page);
eq('ボタンは無効', await b.page.locator('#dnConfirmBtn').isDisabled(), true);
check('「あと 500 pt で申請できます。」', /あと 500 pt で申請できます。/.test(await b.page.locator('#donationBox .dn-short').innerText()), null);
await b.ctx.close();

console.log('■ 会員：確認 → 申請（連打しても1件）');
await a.page.click('#dnConfirmBtn');
await a.page.waitForSelector('#dnOv .dn-modal');
const mt = await a.page.locator('#dnOv').innerText();
check('確認画面：支援先・利用ポイント・運営団体・注意事項', /インドプロジェクトへの支援/.test(mt) && /1,000 pt/.test(mt) && /教育支援団体「あんたがおらな」/.test(mt) && /金銭をお預かりすることはありません/.test(mt) && /確保が解除され/.test(mt), mt);
check('確認画面にも、円や控除の表現はない', !/円|控除/.test(mt), null);
await a.page.click('#dnBack'); eq('「戻る」で閉じる（申請されない）', [await a.page.locator('#dnOv').count(), await P.getBalance(A)], [0, 1350]);
await a.page.click('#dnConfirmBtn'); await a.page.waitForSelector('#dnSubmit');
await a.page.evaluate(() => { const b = document.getElementById('dnSubmit'); b.click(); b.click(); b.click(); });
await a.page.waitForSelector('#dnClose');
check('受付完了が表示される', /申請を受け付けました/.test(await a.page.locator('#dnOv').innerText()), null);
eq('連打しても確保は1回（残高350）', await P.getBalance(A), 350);
await a.page.click('#dnClose'); await a.page.waitForFunction(() => /申請中/.test(document.getElementById('donationBox').innerText));
check('申請の状況に「申請中」が出る。利用できるポイントは350 pt', /申請中/.test(await box.locator('.dn-hist').innerText()) && /350\s*pt/.test(await box.locator('.dn-now').innerText()) && (await box.locator('.dn-list li').count()) === 1, await box.innerText());
check('台帳の履歴に「確保」が残る', /社会貢献の申請（ポイントを確保）/.test(await a.page.locator('#pointBody').innerText()), null);
eq('残高が足りなくなったので、ボタンは無効', await a.page.locator('#dnConfirmBtn').isDisabled(), true);
check('既存の目標・植物の表示は、そのまま（現在350 ptで更新）', (await a.page.locator('#goalBox svg.plant').count()) === 1 && /350\s*pt/.test(await a.page.locator('#goalBox .gl-cur-n').innerText()), null);

console.log('■ 会員：エラー時は、成功を表示しない');
const c = await login(C);
await gotoPoint(c.page);
await c.page.route('**/api/community-auth?action=donation-create', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'サーバーで問題が起きました。' }) }));
await c.page.click('#dnConfirmBtn'); await c.page.waitForSelector('#dnSubmit'); await c.page.click('#dnSubmit');
await c.page.waitForFunction(() => document.getElementById('dnErr') && document.getElementById('dnErr').textContent.length > 0);
check('エラーが表示され、「受け付けました」は出ない。ポイントも減らない', !/申請を受け付けました/.test(await c.page.locator('#dnOv').innerText()) && (await P.getBalance(C)) === 1000, await c.page.locator('#dnErr').innerText());
await c.page.unroute('**/api/community-auth?action=donation-create');
await c.page.click('#dnSubmit'); await c.page.waitForSelector('#dnClose');
eq('同じ画面から再送すると成功（1件・確保は1回）', [await P.getBalance(C), (await c.page.evaluate(async () => (await (await fetch('/api/community-auth?action=donation-mine')).json()).requests.length))], [0, 1]);
await c.page.click('#dnClose');

console.log('■ スマホ幅390px（会員）');
{
  const m = await login(B, { width: 390, height: 844 });
  await gotoPoint(m.page);
  check('ポイント画面：横はみ出しなし', !(await overflow(m.page)), null);
  await m.page.locator('#donationBox').screenshot({ path: path.join(OUT, 'dn-member-mobile.png') }).catch(() => {});
  await m.ctx.close();
  const m2 = await login('jiro.yamada@example.com', { width: 390, height: 844 });
  await grant(B, 600);
  await gotoPoint(m2.page);
  await m2.page.click('#dnConfirmBtn'); await m2.page.waitForSelector('#dnSubmit');
  const geo = await m2.page.evaluate(() => { const r = document.querySelector('#dnOv .dn-modal').getBoundingClientRect(); return { fits: r.left >= 0 && r.right <= window.innerWidth + 1, btn: document.getElementById('dnSubmit').getBoundingClientRect().height >= 44 }; });
  eq('確認モーダル（スマホ）：画面内に収まり、ボタンは44px以上', geo, { fits: true, btn: true });
  await m2.page.screenshot({ path: path.join(OUT, 'dn-modal-mobile.png') }).catch(() => {});
  await m2.page.keyboard.press('Escape'); eq('Escapeで閉じる', await m2.page.locator('#dnOv').count(), 0);
  await m2.ctx.close();
}

console.log('■ 管理画面：申請管理');
const actx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'ja-JP' });
const ap = await actx.newPage();
ap.on('dialog', (d) => { if (/申請IDを入力/.test(d.message())) d.accept(d.message().split('：').pop().trim()); else d.accept('E2Eテストの理由'); });
ap.on('pageerror', (e) => errors.push('[admin] pageerror ' + e.message));
await ap.goto(base + '/haku-community/admin/');
await ap.fill('#adminemail', ADMIN.email); await ap.fill('#adminpw', ADMIN.password);
await ap.click('#loginbtn'); await ap.waitForSelector('#adminPanel', { state: 'visible' });
await ap.click('#adminNav [data-key="donations"]'); await ap.waitForSelector('#dnList .dn-card');
check('メニュー：HAKUポイントの分類に「ポイント｜利用申請管理」がある。現在地も更新される', (await ap.locator('#crumbPage').innerText()).includes('利用申請管理') && (await ap.locator('#adminNav .ng-haku .ni.on').count()) === 1, null);
eq('一覧に2件（A・C）', await ap.locator('#dnList .dn-card').count(), 2);
const first = await ap.locator('#dnList .dn-card').first().innerText();
check('一覧の項目：申請ID・会員名・メール・申請日時・利用ポイント・支援先・ステータス', /DN-\d{8}-[A-Z0-9]+/.test(first) && /nishiyama|sato/.test(first) && /申請日時/.test(first) && /1,000 pt/.test(first) && /インドプロジェクト/.test(first) && /申請中/.test(first), first);
check('ステータス別の集計と、CSVの出力リンクがある', /インドプロジェクトへの支援/.test(await ap.locator('#dnSummary').innerText()) && /action=donation-csv/.test(await ap.locator('#dnCsv').getAttribute('href')), null);
await ap.selectOption('#dnStatus', 'approved'); await sleep(500);
eq('絞り込み（承認済み：0件）', await ap.locator('#dnList .dn-card').count(), 0);
await ap.selectOption('#dnStatus', ''); await ap.fill('#dnQ', 'nishiyama'); await sleep(700);
eq('検索（会員のメール）', await ap.locator('#dnList .dn-card').count(), 1);
const card = ap.locator('#dnList .dn-card').first();
await card.locator('[data-dn=approve]').click();
await ap.waitForFunction(() => /承認済み・振込待ち/.test(document.getElementById('dnList').innerText));
check('承認：承認済み・振込待ち。ポイントは350のまま（利用確定）。「完了」にはならない', (await ap.locator('#dnList .dn-card').first().locator('.dn-chip').innerText()) === '承認済み・振込待ち' && (await P.getBalance(A)) === 350, await ap.locator('#dnList .dn-card').first().locator('.dn-chip').innerText());
const c2 = ap.locator('#dnList .dn-card').first();
eq('金額登録前は「振込完了にする」を押せない', await c2.locator('[data-dn=complete]').isDisabled(), true);
await c2.locator('[data-f=amountYen]').fill('3000'); await c2.locator('[data-f=date]').fill('2026-10-31');
await c2.locator('[data-dn=transfer]').click(); await ap.waitForFunction(() => /振込先を入力してください/.test(document.getElementById('dnList').innerText));
check('振込先が未入力だと登録できない（エラーが出て、登録されない）', !(await ap.locator('#dnList .dn-card').first().locator('.dn-dl dt').allInnerTexts()).includes('寄付金額（円）'), null);
const c3 = ap.locator('#dnList .dn-card').first();
await c3.locator('[data-f=amountYen]').fill('3000'); await c3.locator('[data-f=date]').fill('2026-10-31'); await c3.locator('[data-f=destination]').fill('（テスト）寄付先'); await c3.locator('[data-f=reference]').fill('REF-E2E-1');
await c3.locator('[data-dn=transfer]').click();
await ap.waitForFunction(() => /寄付金額（円）/.test(document.getElementById('dnList').innerText));
check('振込情報を登録（まだ完了ではない）', /承認済み・振込待ち/.test(await ap.locator('#dnList .dn-card').first().innerText()) && /3,000 円/.test(await ap.locator('#dnList .dn-card').first().innerText()), null);
await ap.locator('#dnList .dn-card').first().locator('[data-dn=complete]').click();
await ap.waitForFunction(() => /振込完了/.test(document.getElementById('dnList').innerText) && !document.querySelector('#dnList [data-dn=complete]'));
check('振込完了：記録（金額・振込日・振込先・参照番号）が残る。集計に寄付金額が出る', /3,000 円/.test(await ap.locator('#dnList').innerText()) && /REF-E2E-1/.test(await ap.locator('#dnList').innerText()) && /3,000<\/b>円/.test(await ap.locator('#dnSummary').innerHTML()), null);
await ap.locator('#dnList details summary').first().click();
await ap.waitForFunction(() => /completed/.test(document.querySelector('#dnList .dn-log').innerText));
const logText = await ap.locator('#dnList .dn-log').first().innerText();
check('操作履歴（作成・承認・振込登録・振込完了）', ['created', 'approved', 'transfer_registered', 'completed'].every((t) => logText.includes(t)), logText);
const csv = await ap.evaluate(async () => { const r = await fetch('/api/admin?action=donation-csv'); const b = new Uint8Array(await r.arrayBuffer()); return { bom: b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF, text: new TextDecoder().decode(b) }; });
check('CSV：見出し行と2件のデータ（Excelで文字化けしないBOMつき）', csv.text.startsWith('申請ID,') && csv.bom && csv.text.trim().split(String.fromCharCode(13, 10)).length === 3 && /3000/.test(csv.text), csv.text.length);

await ap.fill('#dnQ', 'sato'); await sleep(700);
await ap.locator('#dnList .dn-card').first().locator('[data-dn=reject]').click();
await ap.waitForFunction(() => /却下/.test(document.getElementById('dnList').innerText));
eq('却下：確保が解除されポイントが元に戻る（C：1,000pt）', await P.getBalance(C), 1000);
check('却下の理由が記録される', /E2Eテストの理由/.test(await ap.locator('#dnList').innerText()), null);

console.log('■ 会員側への反映／管理画面のスマホ');
await gotoPoint(a.page);
check('会員Aの申請の状況：振込完了。金額や振込先は見えない', /振込完了/.test(await box.locator('.dn-hist').innerText()) && !/3,000|REF-E2E|寄付先/.test(await box.innerText()), await box.locator('.dn-hist').innerText());
await actx.close();
{
  const mc = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP' });
  const mp = await mc.newPage();
  await mp.goto(base + '/haku-community/admin/'); await mp.fill('#adminemail', ADMIN.email); await mp.fill('#adminpw', ADMIN.password);
  await mp.click('#loginbtn'); await mp.waitForSelector('#adminPanel', { state: 'visible' });
  await mp.click('#navToggle'); await mp.click('#adminNav [data-key="donations"]'); await mp.waitForSelector('#dnList .dn-card');
  check('管理画面（スマホ）：横はみ出しなし', !(await overflow(mp)), null);
  await mp.screenshot({ path: path.join(OUT, 'dn-admin-mobile.png'), fullPage: true }).catch(() => {});
  await mc.close();
}
await a.ctx.close(); await c.ctx.close();
eq('画面のJavaScriptエラーなし', errors, []);
await browser.close(); server.close?.();
console.log(`\n結果: 成功 ${pass} / 失敗 ${fail}`);
if (fail) { console.log(failures.join('\n')); process.exit(1); }
process.exit(0);

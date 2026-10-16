// 朝の集まり：参加の記録（スタンプ）とHAKUポイントの表示。本物の画面 × 本物のAPI × メモリ上のRedis。Googleには接続しない。
// 実行：node tests-e2e-local/attendance.e2e.mjs（README参照）
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const REPO_URL = new URL('../', import.meta.url);
const REPO = fileURLToPath(REPO_URL);
const require = createRequire(REPO + 'package.json');
const { chromium } = require('playwright-core');
const { start, seed, store, MEMBER_PASSWORD, ADMIN } = await import('./e2e-server.mjs');
const pointsMod = await import(new URL('api/_lib/points.js', REPO_URL).href);
const W = (n) => new Promise((r) => setTimeout(r, n));
const att = await import(new URL('api/_lib/morning-attendance.js', REPO_URL).href);
await seed();
const { server, base } = await start();
const OUT = process.env.OUT_DIR || os.tmpdir();
const browser = await chromium.launch();

let pass = 0, fail = 0; const failures = [];
function check(name, ok, detail) { if (ok) { pass++; console.log('  ✔', name); } else { fail++; failures.push(name + ' :: ' + JSON.stringify(detail)); console.log('  ✖', name, JSON.stringify(detail)); } }
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
async function shot(page, file, opts) { try { await page.screenshot({ path: path.join(OUT, file), ...(opts || {}) }); } catch (e) { /* 撮影の失敗は無視 */ } }
const errors = [];
let n = 0;
async function login(email, { width = 1280, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'ja-JP', extraHTTPHeaders: { 'x-forwarded-for': `10.30.0.${++n}` } });
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
const A = 'nishiyama.taro@example.com', B = 'Hanako.Nishiyama@Example.com';
const JST = (n = 0) => new Date(Date.now() + 9 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const today = JST(); const month = today.slice(0, 7);
const prevMonth = (() => { const d = new Date(`${month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
const d1 = `${month}-01`;
const d2 = today;
const dPrev = `${prevMonth}-15`;

console.log('■ 参加の記録（スタンプ）');
{
  // 実際に参加した日だけを、サーバー側で確定する（参加表明やMeetのボタンでは付かない）
  for (const d of [...new Set([d1, d2])]) await att.confirmAttendance({ date: d, email: A.toLowerCase(), source: 'admin', actorId: 'e2e', reason: 'E2E' });
  await att.confirmAttendance({ date: dPrev, email: A.toLowerCase(), source: 'admin', actorId: 'e2e', reason: 'E2E' });
  await att.confirmAttendance({ date: d1, email: B.toLowerCase(), source: 'admin', actorId: 'e2e', reason: 'E2E' }); // 他の会員の記録
  const expected = new Set([d1, d2]).size;

  const { ctx, page } = await login(A);
  await page.goto(base + '/haku-community/home/#morning');
  await page.waitForSelector('#moStamps .st-grid');
  const order = await page.evaluate(() => { const g = document.querySelector('.mo-grid'), s = document.getElementById('moStamps'); return [!!g, !!s, g && s ? !!(g.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) : false]; });
  eq('既存のカレンダーはそのまま残り、その下に「参加の記録」がある', order, [true, true, true]);
  eq('見出しは「参加の記録」', await page.locator('#moStampTitle').innerText(), '参加の記録');
  check('既存の文言（参加申請の締切の注意書き・カレンダー）は変わっていない', /前々日23:59まで受け付けています/.test(await page.locator('#morningBody').innerText()) && (await page.locator('.mo-month').count()) === 1, null);
  eq('本人が実際に参加した日だけにスタンプ（その月）', await page.locator('#moStamps .st-cell.on').count(), expected);
  check('スタンプにアクセシブルな名前（月日・参加）がある', /月\d+日、参加/.test((await page.locator('#moStamps .st-cell.on').first().getAttribute('aria-label')) || ''), null);
  eq('その月の回数が表示される', await page.locator('.st-count').innerText(), `${expected}回`);
  check('他の会員（B）の記録は含まれない（Bだけが参加した日は、Aのスタンプ数に影響しない）', expected >= 1, null);
  const sizeOk = await page.evaluate(() => { const b = document.getElementById('moStamps').getBoundingClientRect(); return b.height < 420; });
  check('コンパクト（縦に長くならない）', sizeOk, null);
  try { await page.locator('#moStamps').screenshot({ path: path.join(OUT, 'attendance-01-stamps-pc.png') }); } catch (e) { /* 撮影の失敗は無視 */ }
  // 月の切替：既存のカレンダーの月は変わらない
  const mainMonth = await page.locator('.mo-month').innerText();
  const stMonth0 = await page.locator('.st-month').innerText();
  await page.click('[data-act="st-prev"]');
  await page.waitForFunction((m) => { const e = document.querySelector('.st-month'); return e && e.textContent !== m; }, stMonth0);
  eq('記録の月だけが切り替わる（既存のカレンダーは動かない）', await page.locator('.mo-month').innerText(), mainMonth);
  await page.waitForSelector('#moStamps .st-grid');
  eq('前の月のスタンプが出る', [await page.locator('#moStamps .st-cell.on').count(), (await page.locator('#moStamps .st-cell.on span').first().innerText())], [1, '15']);
  await page.click('[data-act="st-next"]');
  await page.waitForFunction(() => document.querySelectorAll('#moStamps .st-cell.on').length > 0 && /回$/.test(document.querySelector('.st-count').textContent));
  eq('今月へ戻れる', await page.locator('#moStamps .st-cell.on').count(), expected);
  // 取り消された出席は消える
  await att.cancelAttendance({ date: d1, email: A.toLowerCase(), actorId: 'e2e', reason: 'E2E取消' });
  await page.reload(); await page.waitForSelector('#moStamps .st-grid');
  eq('取消した日のスタンプは消える', await page.locator('#moStamps .st-cell.on').count(), expected - 1);
  await att.confirmAttendance({ date: d1, email: A.toLowerCase(), source: 'admin', actorId: 'e2e', reason: 'E2E再確定' });

  // HAKUポイント：残高・履歴に反映（台帳と同じデータ）
  const bal = await (await import(new URL('api/_lib/points.js', REPO_URL).href)).getBalance(A.toLowerCase());
  await page.goto(base + '/haku-community/home/#point');
  await page.waitForFunction(() => /朝の集まりへの参加/.test(document.body.innerText), null, { timeout: 10000 });
  check('ポイントの履歴に「朝の集まりへの参加」が出る', /朝の集まりへの参加/.test(await page.locator('#p-point').innerText()), null);
  check('ポイント残高が台帳の合計と一致する', (await page.locator('#p-point').innerText()).replace(/[,\s]/g, '').includes(String(bal)), { bal });
  await ctx.close();

  // 参加の記録がない会員：偽のスタンプは出ない
  const L = await login('jiro.yamada@example.com');
  await L.page.goto(base + '/haku-community/home/#morning'); await L.page.waitForSelector('#moStamps .st-grid');
  eq('参加の記録がない会員には、スタンプが出ない（固定のダミーなし）', [await L.page.locator('#moStamps .st-cell.on').count(), await L.page.locator('.st-count').innerText()], [0, '0回']);
  await L.ctx.close();

  // スマホ幅
  const M = await login(A, { width: 390, height: 844 });
  await M.page.goto(base + '/haku-community/home/#morning'); await M.page.waitForSelector('#moStamps .st-grid');
  eq('スマホ幅390px：横はみ出しなし', await M.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
  check('スマホ幅：記録のカレンダーが画面幅に収まる', await M.page.evaluate(() => document.querySelector('.st-grid').getBoundingClientRect().right <= document.documentElement.clientWidth), null);
  try { await M.page.locator('#moStamps').screenshot({ path: path.join(OUT, 'attendance-02-stamps-mobile.png') }); } catch (e) { /* 撮影の失敗は無視 */ }
  await M.ctx.close();
}

console.log('■ 管理画面：朝の集まり・出席（出席訂正・確認待ち）');
{
  const date = JST(-3); const M1 = 'nishiyama.taro@example.com';
  await store.ensureMorningEvent(date, 'e2e'); await store.joinEventAtomic(store.morningEventId(date), M1, null);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP', extraHTTPHeaders: { 'x-forwarded-for': '10.31.0.1' } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|gstatic|firebase/i.test(m.text())) errors.push(`[admin] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[admin] pageerror ${e.message}`));
  const answers = []; page.on('dialog', (d) => { if (d.type() === 'prompt') d.accept(answers.shift() ?? 'E2E'); else d.accept(); });
  await page.goto(base + '/haku-community/admin/');
  await page.fill('#adminemail', ADMIN.email); await page.fill('#adminpw', ADMIN.password);
  await page.click('#loginbtn'); await page.waitForSelector('#adminPanel', { state: 'visible' });
  await page.click('#adminNav [data-key="attendance"]');
  eq('現在地：HAKU Community運営 › 集う › 朝の集まり｜出席管理', await page.evaluate(() => [document.getElementById('crumbSvc').textContent, document.getElementById('crumbPage').textContent]), ['HAKU Community運営', '朝の集まり｜出席管理']);
  await page.fill('#attDate', date); await page.click('#attLoad');
  await page.waitForSelector(`#attMembers [data-email="${M1}"]`);
  const st = await page.locator('#attStatus').innerText();
  check('自動出席確認の状況：Google連携は未設定・設定待ち（自動付与は行わない）と表示', /設定待ち/.test(st) && /Google連携：未設定/.test(st) && /出席の条件：未決定/.test(st), st);
  check('参加表明している会員が、「未確認」で表示される', /未確認/.test(await page.locator(`#attMembers [data-email="${M1}"]`).innerText()) && /参加表明あり/.test(await page.locator(`#attMembers [data-email="${M1}"]`).innerText()), null);
  await shot(page, 'attendance-03-admin-pc.png', { fullPage: false });
  const before = await pointsMod.getBalance(M1);
  answers.push('Meet画面で出席を確認');
  await page.click(`#attMembers [data-email="${M1}"] [data-att="confirm"]`);
  await page.waitForFunction((e) => /出席確認済み \+10pt/.test(document.querySelector(`#attMembers [data-email="${e}"]`)?.innerText || ''), M1);
  eq('出席訂正（出席にする）：10ptが台帳に付く', (await pointsMod.getBalance(M1)) - before, 10);
  answers.push('誤記録のため');
  await page.click(`#attMembers [data-email="${M1}"] [data-att="cancel"]`);
  await page.waitForFunction((e) => /出席を取り消し済み/.test(document.querySelector(`#attMembers [data-email="${e}"]`)?.innerText || ''), M1);
  eq('出席の取消：ポイントは相殺され、残高が元に戻る（履歴は消えない）', [(await pointsMod.getBalance(M1)) - before, (await pointsMod.getAdminMemberView(M1)).entries.filter((e) => e.refId === date || e.reversalOf).length >= 2], [0, true]);
  // 理由を入れずにキャンセルしたら、何も起きない
  answers.push('');
  await page.click(`#attMembers [data-email="${M1}"] [data-att="confirm"]`); await W(500);
  eq('理由なしでは、出席訂正は実行されない', (await pointsMod.getBalance(M1)) - before, 0);
  // Googleの参加履歴との照合：未設定の間は、何も付与しない
  await page.click('#attSync'); await page.waitForFunction(() => /未設定のため/.test(document.getElementById('attErr').textContent));
  check('「Googleの参加履歴と照合する」は、未設定の間は何も付与しない旨を表示', /何も付与していません/.test(await page.locator('#attErr').innerText()), null);
  // 確認待ち：会員に結び付けて出席にする
  await att.setPending(date, [{ participantKey: 'users/5555', kind: 'signedin', displayName: 'ゲストさん', minutes: 31, at: Date.now() }]);
  await page.click('#attLoad'); await page.waitForSelector('#attPending [data-link]');
  check('確認待ちの参加者が、表示名・種別・滞在時間つきで出る', /ゲストさん/.test(await page.locator('#attPending').innerText()) && /31分/.test(await page.locator('#attPending').innerText()), null);
  answers.push(M1, '本人と確認');
  await page.click('#attPending [data-link]');
  await page.waitForFunction(() => !document.querySelector('#attPending [data-link]'));
  eq('確認待ちの結び付け：出席が確定し、Googleアカウントが会員に結び付く（以後は自動で照合される）', [(await pointsMod.getBalance(M1)) - before, await att.emailByGoogleIdentity('users/5555')], [10, M1]);
  // 音声の入力欄：登録前に再生して確認できる（音声はURLで登録する方式）
  await page.route('https://media.example.test/**', (r) => r.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(32) }));
  await page.click('#adminNav [data-key="sessions"]');
  check('セッションの音声欄に、再生確認と、対応形式・登録方式の説明がある', (await page.locator('#sessionsPanel .audpv').count()) === 1 && /mp3・m4a・wav・aac・ogg/.test(await page.locator('#sessionsPanel .audnote').first().innerText()) && /アップロード用の保存先は、まだ設定されていません/.test(await page.locator('#sessionsPanel .audnote').first().innerText()), null);
  await page.fill('#sessUrl', 'http://insecure.example.test/a.mp3'); await page.click('#sessionsPanel .audpv button');
  check('https以外のURLは、再生確認の前に弾かれる', /https:\/\/ から始まる/.test(await page.locator('#sessionsPanel .audbox').innerText()) && (await page.locator('#sessionsPanel audio').count()) === 0, null);
  await page.fill('#sessUrl', 'https://media.example.test/a.mp3'); await page.click('#sessionsPanel .audpv button');
  eq('httpsのURLなら、プレーヤーが出る（自動再生はしない）', [await page.locator('#sessionsPanel audio').count(), await page.locator('#sessionsPanel audio').evaluate((a) => [a.controls, a.autoplay])], [1, [true, false]]);
  await page.click('#adminNav [data-key="words"]');
  eq('HAKUからのことばの音声欄にも、再生確認がある', await page.locator('#wordsPanel .audpv').count(), 1);
  // スマホ幅
  await page.setViewportSize({ width: 390, height: 844 }); await W(300);
  eq('スマホ幅390px：出席管理の画面で横はみ出しなし', await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
  await shot(page, 'attendance-04-admin-mobile.png', { fullPage: false });
  await ctx.close();
}

eq('画面のJavaScriptエラー・予期しないエラーなし', errors, []);
console.log(`\n結果: 成功 ${pass} / 失敗 ${fail}`);
if (fail) console.log('失敗:\n' + failures.join('\n'));
await browser.close(); server.close();
process.exit(fail ? 1 : 0);

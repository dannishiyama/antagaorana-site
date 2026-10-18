// 11月運用開始に向けた改善のE2E：今週の問い→振り返り、月ごとの振り返り、1か月前のあなたから、ことば・学ぶ・集う・ポイントの表示。
// 本物の画面 × 本物のAPI × メモリ上のRedis。実行：node tests-e2e-local/november.e2e.mjs
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const REPO_URL = new URL('../', import.meta.url);
const REPO = fileURLToPath(REPO_URL);
const require = createRequire(REPO + 'package.json');
const { chromium } = require('playwright-core');
const { start, seed, store, MEMBER_PASSWORD } = await import('./e2e-server.mjs');
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
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'ja-JP', reducedMotion: 'reduce', extraHTTPHeaders: { 'x-forwarded-for': `10.70.0.${++n}` } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|status of/.test(m.text())) errors.push(`[${email}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${email}] pageerror ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(base + '/haku-community/login/');
  await page.fill('input[type=email]', email); await page.fill('input[type=password]', MEMBER_PASSWORD);
  await page.click('#go', { force: true }); await page.waitForURL('**/haku-community/home/**', { timeout: 8000 });
  await page.waitForSelector('.page.active h1');
  return { ctx, page };
}
const A = 'nishiyama.taro@example.com', B = 'jiro.yamada@example.com';
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
const XSS = '<img src=x onerror="window.__xss=1">気づき';
// 準備：今週の問い・過去の学び（音声）・約30日前の公開投稿
await store.createHakuNote({ type: 'weekly_question', title: '今週の問い', body: '今週、誰かに感謝を伝えるなら、誰に何を伝えますか。', category: '人生', createdBy: 'e2e' });
await store.createHakuNote({ type: 'audio', title: '過去の音声の学び', body: '音声の内容です。', category: '仕事', publishFrom: Date.now() - 20 * 86400e3, createdBy: 'e2e' });
const old = await store.createPost('haku', { authorEmail: A, title: '1か月前の題名', body: '1か月前の私は、朝の散歩を始めようとしていた。', category: 'today_did' });
{ const key = `ht:post:${old.id}`; const raw = JSON.parse(await store.getRedis().get(key)); const at = Date.now() - 30 * 86400e3; await store.getRedis().set(key, JSON.stringify({ ...raw, createdAt: at, updatedAt: at })); await store.getRedis().zadd('ht:posts:haku:by-user:' + A, at, old.id).catch(() => {}); }
const month = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
await att.confirmAttendance({ date: `${month}-01`, email: A, source: 'admin', actorId: 'e2e', reason: 'E2E' });

console.log('■ HOME・学ぶ：今週の問いが主役／振り返りへの導線');
const a = await login(A);
await a.page.waitForSelector('#homeNote .q-text');
check('HOME：今週の問いが、大きな文字と金の線で表示される', parseFloat(await a.page.locator('#homeNote .q-text').evaluate((e) => getComputedStyle(e).fontSize)) >= 20 && /誰かに感謝を伝えるなら/.test(await a.page.locator('#homeNote').innerText()), null);
eq('HOME：今週の問い（主役）→ 今日の一歩 → 次の集まり → ことば の順', await a.page.evaluate(() => ['h-question', 'homeStep', 'h-next', 'h-words'].map((i) => document.getElementById(i).getBoundingClientRect().top).every((t, k, x) => k === 0 || t > x[k - 1])), true);
await a.page.locator('#homeNote [data-act="to-reflect"]').click();
await a.page.waitForSelector('#reflectBody .rf-form');
check('「この問いを、振り返りに書く」で、マイページの振り返りの入力欄が開く', (await a.page.evaluate(() => document.activeElement && document.activeElement.id)) === 'rf-noticed', await a.page.evaluate(() => document.activeElement && document.activeElement.id));
await a.page.locator('.tab[data-tab="learn"]:visible, [data-tab="learn"]:visible').first().click();
await a.page.waitForSelector('#learnArchive .arc');
check('学ぶ：今週の問い（大きな表示）・過去の学びに種類（音声）が出る', /音声/.test(await a.page.locator('#learnArchive').innerText()) && (await a.page.locator('#learnCurrent [data-act="to-reflect"]').count()) === 1, null);

console.log('■ マイページ：月ごとの振り返り（任意・保存・編集・削除）');
await a.page.goto(base + '/haku-community/home/#profile'); await a.page.waitForSelector('#reflectBody .rf-card');
check('見出し・説明（任意・毎日書く必要はない）・非公開の説明', /月ごとの振り返り/.test(await a.page.locator('#h-reflect').innerText()) && /毎日書く必要はありません/.test(await a.page.locator('#h-reflect + .block-supp').innerText()) && /あなただけに表示されます/.test(await a.page.locator('#reflectBody').innerText()), null);
check('最初は空状態（今月の振り返りは、まだありません）。過去も空', /今月の振り返りは、まだありません/.test(await a.page.locator('#reflectBody').innerText()) && /これまでの振り返りは、まだありません/.test(await a.page.locator('#reflectBody').innerText()), null);
await a.page.locator('[data-rf="edit"]').first().click();
await a.page.click('#rfSave');
check('空のままでは保存できない（エラー表示）', /どれか1つ、書いてから保存してください/.test(await a.page.locator('#rfErr').innerText()) && (await a.page.evaluate(async () => (await (await fetch('/api/community-auth?action=reflect-list')).json()).reflections.length)) === 0, null);
await a.page.fill('#rf-noticed', XSS); await a.page.fill('#rf-nextMonth', '朝の散歩を続ける');
await a.page.evaluate(() => { const b = document.getElementById('rfSave'); b.click(); b.click(); });
await a.page.waitForFunction(() => /朝の散歩を続ける/.test(document.getElementById('reflectBody').innerText) && !document.querySelector('#reflectBody .rf-form'));
eq('二重クリックでも保存は1件。入力はHTMLとして解釈されない（XSSなし）', [await a.page.evaluate(async () => (await (await fetch('/api/community-auth?action=reflect-list')).json()).reflections.length), await a.page.locator('#reflectBody img').count(), await a.page.evaluate(() => window.__xss === undefined)], [1, 0, true]);
check('保存した内容を閲覧できる（気づいたこと・来月大切にしたいこと）', /今月気づいたこと/.test(await a.page.locator('#reflectBody').innerText()) && /来月大切にしたいこと/.test(await a.page.locator('#reflectBody').innerText()), null);
await a.page.locator('[data-rf="edit"]').first().click(); await a.page.fill('#rf-practiced', '10分の散歩'); await a.page.click('#rfSave');
await a.page.waitForFunction(() => /10分の散歩/.test(document.getElementById('reflectBody').innerText));
await a.page.reload(); await a.page.waitForSelector('#reflectBody .rf-card');
check('リロードしても残っている（後から閲覧・編集できる）', /10分の散歩/.test(await a.page.locator('#reflectBody').innerText()), null);
// 保存失敗時：成功を表示しない
await a.page.route('**/api/community-auth?action=reflect-save', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'サーバーで問題が起きました。' }) }));
await a.page.locator('[data-rf="edit"]').first().click(); await a.page.fill('#rf-changed', '失敗する保存'); await a.page.click('#rfSave');
await a.page.waitForFunction(() => document.getElementById('rfErr') && document.getElementById('rfErr').textContent.length > 0);
check('保存に失敗したら、エラーを表示し、保存済みとは表示しない（入力は残る）', (await a.page.locator('#rf-changed').inputValue()) === '失敗する保存' && !/失敗する保存/.test(await a.page.evaluate(async () => JSON.stringify(await (await fetch('/api/community-auth?action=reflect-list')).json()))), null);
await a.page.unroute('**/api/community-auth?action=reflect-save'); await a.page.click('[data-rf="cancel"]');
await a.page.locator('[data-rf="edit"]').first().click(); await a.page.locator('[data-rf="delete"]').click();
await a.page.waitForFunction(() => /今月の振り返りは、まだありません/.test(document.getElementById('reflectBody').innerText));
eq('削除できる', await a.page.evaluate(async () => (await (await fetch('/api/community-auth?action=reflect-list')).json()).reflections.length), 0);
await a.page.locator('[data-rf="edit"]').first().click(); await a.page.fill('#rf-noticed', '先に書いた内容（非公開）'); await a.page.click('#rfSave');
await a.page.waitForFunction(() => /先に書いた内容（非公開）/.test(document.getElementById('reflectBody').innerText));
await a.page.screenshot({ path: path.join(OUT, 'nov-profile-pc.png'), fullPage: true }).catch(() => {});

console.log('■ 1か月前のあなたから');
await a.page.reload(); await a.page.waitForSelector('#echoBlock:not([hidden]) .echo-card');
const echo = await a.page.locator('#echoBlock').innerText();
check('約30日前の公開投稿を、本人にだけ表示（題名・本文・日付・種類・非公開の説明）', /1か月前のあなたから/.test(echo) && /朝の散歩を始めようとしていた/.test(echo) && /公開したことば/.test(echo) && /他の会員には表示されません/.test(echo), echo);
await a.page.fill('#echoInput', 'いま振り返ると、続けられていて嬉しい。'); await a.page.click('#echoSave');
await a.page.waitForFunction(() => /いまの気持ちを保存しました/.test(document.querySelector('.toast') ? document.querySelector('.toast').textContent : '') || true);
await sleep(400);
await a.page.reload(); await a.page.waitForSelector('#echoInput');
eq('いまの気持ち（任意）が保存され、再表示される', await a.page.locator('#echoInput').inputValue(), 'いま振り返ると、続けられていて嬉しい。');
await a.page.screenshot({ path: path.join(OUT, 'nov-echo-pc.png'), fullPage: true }).catch(() => {});
console.log('■ 他の会員には見えない');
const b = await login(B);
await b.page.goto(base + '/haku-community/home/#profile'); await b.page.waitForSelector('#reflectBody .rf-card');
await sleep(500);
const bt = await b.page.locator('#p-profile').innerText();
check('Bの画面に、Aの振り返り・1か月前の記録・いまの気持ちは出ない（空状態）', !/先に書いた内容|朝の散歩|続けられていて/.test(bt) && (await b.page.locator('#echoBlock').isHidden()) && /今月の振り返りは、まだありません/.test(bt), null);
await b.ctx.close();

console.log('■ ことば・集う・ポイント');
await a.page.goto(base + '/haku-community/home/#point'); await a.page.waitForSelector('#goalBox');
check('ポイント：学び・実践・参加・貢献 → HAKUポイント → 自分の学びや、誰かへの支援。成長表現の注記', (await a.page.locator('.pt-flow .pf-step').allInnerTexts()).join('|') === '学び・実践・参加・貢献|HAKUポイント|自分の学びや、誰かへの支援' && /人の成長を点数にしたものではありません/.test(await a.page.locator('.pt-flow-note').innerText()), null);
await a.page.goto(base + '/haku-community/home/#morning'); await a.page.waitForSelector('.mo-grid .mo-cell:not(.blank)');
await a.page.waitForFunction(() => document.querySelectorAll('.mo-cell.att').length >= 1);
check('集う：出席確認済みの日（サーバーが確定した出席）に印が付く。凡例は5種類', (await a.page.locator('.mo-legend span').count()) === 5 && /出席確認済み/.test(await a.page.locator('.mo-legend').innerText()) && /参加した日（出席は確認待ち）/.test(await a.page.locator('.mo-legend').innerText()), await a.page.locator('.mo-legend').innerText());
check('既存：申請締切の注意書き・月間カレンダー・参加履歴スタンプは維持', /前々日23:59まで/.test(await a.page.locator('#morningBody').innerText()) && (await a.page.locator('.st-grid').count()) >= 1, null);
await a.page.goto(base + '/haku-community/home/#words'); await a.page.waitForSelector('#p-words.active');
await sleep(500);
check('ことば：HAKUからのことばは、みんなのことばと区別される（金の線・枠・明朝の本文）。空状態も自然', /HAKUからのことば|まもなく|まだ/.test(await a.page.locator('#p-words').innerText()), null);
await a.ctx.close();

console.log('■ スマホ幅390px');
{
  const m = await login(A, { width: 390, height: 844 });
  for (const [hash, sel] of [['home', '#homeStep'], ['learn', '#learnCurrent'], ['words', '#p-words'], ['morning', '.mo-legend'], ['point', '#goalBox'], ['profile', '#reflectBody']]) {
    await m.page.goto(base + '/haku-community/home/#' + hash); await m.page.waitForSelector(sel, { state: 'attached' }); await sleep(500);
    check(`${hash}：横はみ出しなし`, !(await overflow(m.page)), null);
  }
  await m.page.locator('[data-rf="edit"]').first().click();
  check('マイページ（振り返りの入力中）：横はみ出しなし／入力欄のタップ領域', !(await overflow(m.page)) && (await m.page.locator('#rf-noticed').evaluate((e) => e.getBoundingClientRect().height)) >= 44, null);
  await m.page.screenshot({ path: path.join(OUT, 'nov-profile-mobile.png'), fullPage: false }).catch(() => {});
  await m.ctx.close();
}
eq('画面のJavaScriptエラーなし', errors, []);
await browser.close(); server.close?.();
console.log(`\n結果: 成功 ${pass} / 失敗 ${fail}`);
if (fail) { console.log(failures.join('\n')); process.exit(1); }
process.exit(0);

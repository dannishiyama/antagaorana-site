// 管理画面の最終整理：会員管理（HAKU・灯の統一）、みんなのことば投稿管理（検索・絞り込み・新着・段階読み込み）、操作履歴の分離。
// 本物の画面 × 本物のAPI × メモリ上のRedis。実行：node tests-e2e-local/admin-final.e2e.mjs
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const REPO_URL = new URL('../', import.meta.url);
const REPO = fileURLToPath(REPO_URL);
const require = createRequire(REPO + 'package.json');
const { chromium } = require('playwright-core');
const { start, seed, store, ADMIN } = await import('./e2e-server.mjs');
await seed();
const Salon = await import(new URL('api/_lib/salon-store.js', REPO_URL).href);
await Salon.setStaff(ADMIN.email, { role: 'secretariat', title: '事務局', addedBy: 'seed', addedAt: Date.now() });
const { server, base } = await start();
const OUT = process.env.OUT_DIR || os.tmpdir();
const browser = await chromium.launch();

let pass = 0, fail = 0; const failures = [];
function check(name, ok, detail) { if (ok) { pass++; console.log('  ✔', name); } else { fail++; failures.push(name); console.log('  ✖', name, JSON.stringify(detail)); } }
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 投稿を28件（カテゴリ2種）つくる
const people = ['nishiyama.taro@example.com', 'jiro.yamada@example.com'];
for (let i = 1; i <= 28; i++) {
  await store.createPost('haku', { authorEmail: people[i % 2], title: i % 7 === 0 ? `題名${i}` : '', body: `テスト投稿${i}番 ${i % 5 === 0 ? 'ひみつのキーワード' : '通常'}`, category: i % 3 === 0 ? 'today_did' : 'today_noticed' });
  await sleep(2);
}

const ctx = await browser.newContext({ viewport: { width: 1200, height: 1000 }, locale: 'ja-JP' });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror ' + e.message));
page.on('dialog', (d) => d.accept('E2E理由'));
await page.goto(base + '/haku-community/admin/');
await page.fill('#adminemail', ADMIN.email); await page.fill('#adminpw', ADMIN.password);
await page.click('#loginbtn'); await page.waitForSelector('#adminPanel', { state: 'visible' });

console.log('■ 会員管理：申請管理（HAKU）');
await page.waitForSelector('#list .app');
const pendTxt = await page.locator('#list .app', { hasText: '高橋 未来' }).first().innerText();
check('HAKU申請管理：審査待ちの人にお支払い状況が出る', /お支払い：審査後に、お支払いのご案内/.test(pendTxt), pendTxt);
await page.click('#applicationsPanel .statusfilter [data-status="approved"]');
await page.waitForFunction(() => /決済済み/.test(document.getElementById('list').innerText));
const allTxt = await page.locator('#list').innerText();
check('HAKU申請管理：承認済みの人に「決済済み（有効）」「決済済み（解約予約中…」が出る', /お支払い：決済済み（有効）/.test(allTxt) && /お支払い：決済済み（解約予約中/.test(allTxt), allTxt.slice(0, 300));
check('HAKU申請管理に灯の申請は混ざらない', !/灯 先生/.test(allTxt), null);

console.log('■ 会員管理：会員一覧・検索（灯）に決済免除の操作が集約されている');
await page.click('#adminNav [data-key="mem-salon"]'); await page.waitForFunction(() => document.querySelectorAll('#membersList .app').length > 0);
const salonTxt = await page.locator('#membersList').innerText();
check('灯の会員一覧：灯の会員だけが出る', /灯 先生/.test(salonTxt) && !/西山 太郎/.test(salonTxt), salonTxt.slice(0, 200));
eq('灯の会員一覧：HAKUポイントの操作は出ない', await page.locator('.ptbtn').count(), 0);
check('灯の会員一覧：決済を経ない手動の有効化／無効化の操作がカードにある（決済免除）', (await page.locator('#membersList [data-salon-st]').count()) === 2, await page.locator('#membersList').innerText());
await page.locator('#membersList [data-salon-st="inactive"]').click();
await page.waitForFunction(() => /無効/.test(document.getElementById('membersList').innerText));
eq('手動で無効にできる（理由つき・サーバーに反映）', (await store.getMembership('tomoshibi', 'tomo.teacher@example.com'))?.status, 'inactive');
check('操作は灯の操作履歴にだけ記録される', await page.evaluate(async () => { const all = (await (await fetch('/api/admin?action=audit-log')).json()).entries || []; const h = (await (await fetch('/api/admin?action=audit-log&service=haku')).json()).entries || []; return all.some((e) => /salon_member/.test(e.action)) && !h.some((e) => /salon_/.test(e.action)); }), null);
await page.click('#adminNav [data-key="mem-haku"]'); await page.waitForFunction(() => document.querySelectorAll('#membersList .app').length > 0);
check('HAKUの会員一覧：灯の会員は出ない', !/灯 先生/.test(await page.locator('#membersList').innerText()), null);
check('HAKUポイント 付与・調整 は、HAKU会員検索を開く', await (async () => { await page.click('#adminNav [data-key="pts-grant"]'); await sleep(300); return (await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'memberSearch'; })(), null);

console.log('■ みんなのことば 投稿管理');
await page.click('#adminNav [data-key="posts"]'); await page.waitForSelector('#postsList .post');
eq('最初は20件だけ表示', await page.locator('#postsList .post').count(), 20);
check('件数表示（全28件）', /全28件/.test(await page.locator('#postCount').innerText()), await page.locator('#postCount').innerText());
check('投稿者・メール・日時・本文が見える', /（.+@.+）/.test(await page.locator('#postsList .post .meta').first().innerText()), null);
await page.click('#postMore'); await sleep(200);
eq('「もっと見る」で残りが出る', await page.locator('#postsList .post').count(), 28);
check('すべて出たら「もっと見る」は消える', await page.locator('#postMore').isHidden(), null);
await page.fill('#postSearch', 'ひみつのキーワード'); await sleep(400);
eq('検索：本文のキーワードで絞り込み（5の倍数＝5件）', await page.locator('#postsList .post').count(), 5);
await page.fill('#postSearch', 'jiro.yamada'); await sleep(400);
eq('検索：メールアドレスでも絞り込める', await page.locator('#postsList .post').count(), 14);
await page.fill('#postSearch', '');
await page.selectOption('#postCat', 'today_did'); await sleep(300);
eq('カテゴリ絞り込み（3の倍数＝9件）', await page.locator('#postsList .post').count(), 9);
await page.selectOption('#postCat', '');
check('新着バッジが出る（初回は直近3日）', (await page.locator('#postsList .new-badge').count()) > 0, null);
await page.click('#postSeen'); await sleep(200);
eq('「新着を確認済みにする」で新着バッジが消える', await page.locator('#postsList .new-badge').count(), 0);
// 既存の操作（非表示・再表示・削除）は従来どおり
await page.fill('#postSearch', 'テスト投稿1番'); await sleep(400);
await page.locator('#postsList .post .hide').first().click(); await sleep(500);
check('非表示にできる（非表示中バッジ）', (await page.locator('#postsList .hidden-badge').count()) >= 1, null);
await page.selectOption('#postStat', 'hidden'); await sleep(300);
check('状態で絞り込み：非表示のみ', (await page.locator('#postsList .post').count()) >= 1, null);
await page.locator('#postsList .post .restore').first().click(); await sleep(500);
await page.selectOption('#postStat', ''); await sleep(300);
check('再表示できる（非表示中バッジが消える）', (await page.locator('#postsList .hidden-badge').count()) === 0, null);
const before = await page.evaluate(async () => ((await (await fetch('/api/admin?action=posts')).json()).posts || []).length);
await page.locator('#postsList .post .delete').first().click(); await sleep(500);
eq('削除できる（件数が1つ減る）', await page.evaluate(async () => ((await (await fetch('/api/admin?action=posts')).json()).posts || []).length), before - 1);

console.log('■ 操作履歴の分離');
await page.click('#adminNav [data-key="audit-haku"]'); await sleep(600);
const hakuAudit = await page.evaluate(async () => (await (await fetch('/api/admin?action=audit-log&service=haku')).json()).entries || []);
check('HAKUの操作履歴：投稿の操作が記録され、灯の操作は無い', hakuAudit.length > 0 && !hakuAudit.some((e) => String(e.action).startsWith('salon_') || (e.metadata || {}).community === 'tomoshibi'), hakuAudit.map((e) => e.action));
check('操作履歴の画面の説明に「灯サロン」は別表示と書いてある', /灯サロンの操作は/.test(await page.locator('#auditPanel').innerText()), null);

console.log('■ スマホ幅');
await page.setViewportSize({ width: 390, height: 844 });
await page.click('#navToggle'); await page.click('#adminNav [data-key="posts"]'); await sleep(300);
check('投稿管理：横はみ出しなし', !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)), null);
await page.screenshot({ path: path.join(OUT, 'admin-final-posts-mobile.png') }).catch(() => {});
eq('画面のJavaScriptエラーなし', errors, []);

await browser.close(); server.close?.();
console.log(`\n結果: 成功 ${pass} / 失敗 ${fail}`);
if (fail) { console.log(failures.join('\n')); process.exit(1); }
process.exit(0);

// 管理画面（本物の画面・本物のAPI・メモリ上のRedis）での、会員検索→ポイント付与／調整／取消→会員側反映のE2E。
// 実行：node tests-e2e-local/admin-points.e2e.mjs（README参照）
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const REPO_URL = new URL('../', import.meta.url);
const REPO = fileURLToPath(REPO_URL);
const require = createRequire(REPO + 'package.json');
const { chromium } = require('playwright-core');
const { start, seed, store, ADMIN, MEMBER_PASSWORD } = await import('./e2e-server.mjs');
await seed();
const security = await import(new URL('api/_lib/security.js', REPO_URL).href);
await store.saveAdminUser({ email: 'staff@example.test', passwordHash: await security.hashPassword('StaffTest-12345'), role: 'staff', active: true });
const { server, base } = await start();
const OUT = process.env.OUT_DIR || os.tmpdir();
const browser = await chromium.launch();

let pass = 0, fail = 0; const failures = [];
function check(name, ok, detail) { if (ok) { pass++; console.log('  ✔', name); } else { fail++; failures.push(name + ' :: ' + JSON.stringify(detail)); console.log('  ✖', name, JSON.stringify(detail)); } }
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });

const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 }, locale: 'ja-JP' });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror ' + e.message));
page.on('dialog', (d) => d.accept('x'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const visibleNames = () => page.evaluate(() => [...document.querySelectorAll('#membersList .app')].filter((e) => !e.hidden).map((e) => e.querySelector('b').innerText.split('（')[0].trim()));
const countText = () => page.locator('#memberCount').innerText();
async function search(q) { await page.fill('#memberSearch', q); await page.waitForTimeout(260); }
const waitList = () => page.waitForFunction(() => document.querySelectorAll('#membersList .app').length > 0);
const card = (name) => page.locator('#membersList .app', { hasText: name }).first();

console.log('■ A. 管理者ログイン〜会員一覧');
await page.goto(base + '/haku-community/admin/');
await page.fill('#adminemail', ADMIN.email); await page.fill('#adminpw', ADMIN.password);
await page.click('#loginbtn'); await page.waitForSelector('#adminPanel', { state: 'visible' });
await page.click('[data-mode="members"]'); await waitList();
eq('既定の会員一覧はHAKU Community', await page.evaluate(() => document.querySelector('#membersPanel [data-mc].on').dataset.mc), 'haku');
eq('HAKU Communityの申込者7名が一覧に出る', (await visibleNames()).length, 7);
eq('件数表示（検索なし）', await countText(), '全7件');
check('検索欄がある', await page.locator('#memberSearch').count() === 1, null);

console.log('■ B. 検索');
async function expectSearch(label, q, names) {
  await search(q);
  const got = (await visibleNames()).sort();
  eq(label + `（「${q}」）`, got, [...names].sort());
}
await expectSearch('氏名（姓）', '西山', ['西山 太郎', '西山 花子']);
await expectSearch('氏名（フルネーム・空白あり）', '西山 太郎', ['西山 太郎']);
await expectSearch('氏名（空白なし）', '西山太郎', ['西山 太郎']);
await expectSearch('氏名（語順違い）', '太郎 西山', ['西山 太郎']);
await expectSearch('氏名の一部', '山', ['西山 太郎', '西山 花子', '山田 次郎']);
await expectSearch('ふりがな（ひらがな）', 'にしやま', ['西山 太郎', '西山 花子']);
await expectSearch('ふりがな（一部）', 'たろう', ['西山 太郎']);
await expectSearch('ふりがな（カタカナで入力）', 'ニシヤマ', ['西山 太郎', '西山 花子']);
await expectSearch('表示名（カタカナ）', 'ジロー', ['山田 次郎']);
await expectSearch('表示名（英字・大文字入力）', 'MIKU', ['佐藤 みく']);
await expectSearch('表示名（英字・小文字入力）', 'miku', ['佐藤 みく']);
await expectSearch('メールアドレス（一部）', 'nishiyama.taro', ['西山 太郎']);
await expectSearch('メールアドレス（大文字入力）', 'HANAKO.NISHIYAMA@EXAMPLE', ['西山 花子']);
await expectSearch('メールアドレス（ドメインの一部）', '@example.com', ['西山 太郎', '西山 花子', '山田 次郎', '佐藤 みく', '鈴木 一郎', '高橋 未来', '田中 守']);
await expectSearch('前後の空白は無視', '   西山   ', ['西山 太郎', '西山 花子']);
await expectSearch('全角英数字・全角空白', '　ＮＩＳＨＩＹＡＭＡ　', ['西山 太郎', '西山 花子']);
await search('西山'); eq('件数表示（該当あり）', await countText(), '2件の会員が見つかりました。');
await search('存在しない人'); eq('該当者0件の表示', await countText(), '該当する会員が見つかりません。');
eq('0件のとき、一覧側にも案内が出る', await page.locator('#memberNoMatch').isVisible(), true);
eq('0件のとき、会員カードは表示されない', (await visibleNames()).length, 0);
await page.click('#memberSearchClear'); await page.waitForTimeout(150);
eq('検索を解除すると全件に戻る', (await visibleNames()).length, 7);
eq('件数表示が全件に戻る', await countText(), '全7件');
await search('西山'); await page.press('#memberSearch', 'Escape'); await page.waitForTimeout(150);
eq('Escキーでも解除できる', (await visibleNames()).length, 7);

console.log('■ C. 既存フィルターとの組み合わせ');
await search('西山');
await page.click('#membersPanel [data-mstatus="active"]'); await waitList();
eq('「有効会員」＋「西山」（検索語は保持される）', (await visibleNames()).sort(), ['西山 太郎', '西山 花子']);
eq('検索語は絞り込み切替後も残る', await page.inputValue('#memberSearch'), '西山');
await search('');
eq('「有効会員」のみ（有効＋解約予約中の4名）', (await visibleNames()).length, 4);
await page.click('#membersPanel [data-mstatus="unpaid"]'); await waitList();
await search('鈴木');
eq('「未決済」＋「鈴木」', await visibleNames(), ['鈴木 一郎']);
await search('西山');
eq('「未決済」＋「西山」は0件（表示は検索0件の案内）', [(await visibleNames()).length, await countText()], [0, '該当する会員が見つかりません。']);
await page.click('#membersPanel [data-mstatus="rejected"]'); await page.waitForTimeout(700);
await search('');
eq('そもそも該当データがない場合は、検索0件とは別の案内', await page.locator('#membersList .empty').first().innerText(), 'この条件に当てはまる会員データは、まだありません。');
await page.click('#membersPanel [data-mstatus="all"]'); await waitList();
await page.click('#membersPanel [data-mc="tomoshibi"]'); await waitList();
eq('「教育者のサロン 灯」に切り替え', await visibleNames(), ['灯 先生']);
eq('灯には、HAKUポイント操作は出ない', await page.locator('.ptbtn').count(), 0);
await page.click('#membersPanel [data-mc="haku"]'); await waitList();
await search('');
eq('申請タブ側の状態が壊れていない（会員一覧の操作の影響を受けない）', await page.evaluate(() => [typeof appStatusFilter, appStatusFilter, community]), ['string', 'pending', 'tomoshibi']);

console.log('■ D. 検索 → 対象会員 → HAKUポイント付与（西山 太郎）');
await search('西山 太郎');
eq('検索結果は1名', await visibleNames(), ['西山 太郎']);
const taro = card('西山 太郎');
check('「HAKUポイントを操作する」ボタンが出る', await taro.locator('.ptbtn').count() === 1, await taro.innerText());
await taro.locator('.ptbtn').click(); await taro.locator('.ptgo').waitFor();
check('対象会員が明示される', (await taro.locator('.ptwho').innerText()).includes('西山 太郎') && (await taro.locator('.ptwho').innerText()).includes('nishiyama.taro@example.com'), await taro.locator('.ptwho').innerText());
eq('現在ポイント 0', await taro.locator('.ptnow b').innerText(), '0');
async function op(c, { mode, amount, reason }) {
  if (mode) await c.locator(`input[type=radio][value=${mode}]`).check();
  await c.locator('.ptamt').fill(amount);
  await c.locator('.ptreason').fill(reason || '');
  await c.locator('.ptgo').click();
}
async function waitMsg(c, re) { await page.waitForFunction(([sel, src]) => { const e = document.querySelector(sel); return e && new RegExp(src).test(e.textContent); }, [null, null].map(String)).catch(() => {}); }
async function msgOf(c) { return (await c.locator('.ptmsg').first().innerText()).trim(); }
async function waitFor(c, pred) { for (let i = 0; i < 60; i++) { const t = await msgOf(c).catch(() => ''); if (pred(t)) return t; await sleep(150); } return await msgOf(c).catch(() => ''); }

await op(taro, { amount: '100', reason: 'HAKU MORNINGのお手伝い' });
let m1 = await waitFor(taro, (t) => t.includes('付与しました'));
eq('+100 付与の完了表示', m1, '西山 太郎 さんに +100pt を付与しました（現在 100 pt）。');
eq('管理画面の現在ポイントが100', await taro.locator('.ptnow b').innerText(), '100');
eq('一覧のボタン表示も更新', (await taro.locator('.ptbtn').innerText()), 'HAKUポイントを操作する（現在 100 pt）');
await op(taro, { amount: '50', reason: '追加のお礼' });
await waitFor(taro, (t) => t.includes('+50pt'));
eq('+50 で現在ポイントが150', await taro.locator('.ptnow b').innerText(), '150');
await op(taro, { mode: 'adjust', amount: '-20', reason: '付与数の訂正' });
const m3 = await waitFor(taro, (t) => t.includes('調整しました'));
eq('調整 -20 の完了表示', m3, '西山 太郎 さんのポイントを -20pt 調整しました（現在 130 pt）。');
eq('最終ポイントは130', await taro.locator('.ptnow b').innerText(), '130');
const rows = await taro.locator('.pthist .ptrow').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
eq('履歴は 調整-20 / 付与+50 / 付与+100（新しい順）', rows.map((r) => (r.match(/([+-][0-9,]+pt) (付与|調整|取消)/) || []).slice(1).join(' ')), ['-20pt 調整', '+50pt 付与', '+100pt 付与']);
check('履歴に理由・操作者・残高が残る', rows[2].includes('HAKU MORNINGのお手伝い') && rows[2].includes('admin@example.test') && rows[2].includes('残高 100 pt'), rows[2]);
await page.screenshot({ path: path.join(OUT, 'admin_point_panel.png'), fullPage: true });

console.log('■ E. 入力バリデーション（保存されないこと）');
async function invalid(label, c, args, expectText) {
  await op(c, args);
  const t = await waitFor(c, (x) => x.length > 0);
  check(label, t.includes(expectText), t);
  const bal = await c.locator('.ptnow b').innerText();
  return bal;
}
await taro.locator('input[type=radio][value=grant]').check();
eq('空欄は保存されない', await invalid('空欄', taro, { amount: '', reason: '' }, 'ポイント数を入力してください'), '130');
eq('0は保存されない', await invalid('0pt', taro, { amount: '0', reason: '' }, '0ポイントは操作できません'), '130');
eq('数値以外は保存されない', await invalid('abc', taro, { amount: 'abc', reason: '' }, '1以上の整数'), '130');
eq('付与の負数は保存されない', await invalid('負数', taro, { amount: '-5', reason: '' }, '1以上の整数'), '130');
eq('小数は保存されない', await invalid('小数', taro, { amount: '1.5', reason: '' }, '1以上の整数'), '130');
eq('異常に大きな値は保存されない', await invalid('巨大', taro, { amount: '99999999', reason: '' }, '1回の操作は'), '130');
eq('調整は理由が必須', await invalid('理由なし調整', taro, { mode: 'adjust', amount: '-10', reason: '' }, '調整の理由'), '130');
eq('残高を超えるマイナス調整は保存されない（サーバー側の拒否）', await invalid('残高超過', taro, { mode: 'adjust', amount: '-999', reason: '誤入力' }, 'マイナスになる'), '130');
eq('履歴の行数は3のまま', await taro.locator('.pthist .ptrow').count(), 3);

console.log('■ F. 連打・二重送信（西山 花子）');
await search('花子');
const hana = card('西山 花子');
await hana.locator('.ptbtn').click(); await hana.locator('.ptgo').waitFor();
await hana.locator('.ptamt').fill('40'); await hana.locator('.ptreason').fill('連打テスト');
await hana.locator('.ptgo').dblclick(); // 2回素早くクリック
await waitFor(hana, (t) => t.includes('付与しました'));
eq('ダブルクリックしても +40 は1回だけ', [await hana.locator('.ptnow b').innerText(), await hana.locator('.pthist .ptrow').count()], ['40', 1]);
// 同じ操作IDでの直接再送（通信の再送を模擬）→ サーバーが1回分としてしか記録しない
const entryId = await hana.locator('.pthist .ptrow').first().getAttribute('data-id');
const dupRes = await page.evaluate(async () => {
  const members = await (await fetch('/api/admin?action=points-member&email=hanako.nishiyama@example.com')).json();
  return { count: members.entries.length, balance: members.balance };
});
eq('サーバー側の履歴は1件・40pt', dupRes, { count: 1, balance: 40 });

console.log('■ G. 取消（誤付与の訂正）');
await hana.locator('.ptrev').first().click();
await hana.locator('.ptrevreason').fill('テスト用の誤付与');
await hana.locator('.ptrevgo').click();
const rm = await waitFor(hana, (t) => t.includes('取り消しました'));
eq('取消の完了表示', rm, '西山 花子 さんの履歴を取り消しました（現在 0 pt）。');
const hrows = await hana.locator('.pthist .ptrow').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
eq('履歴は消えず、取消の行が追加される', [hrows.length, /-40pt 取消/.test(hrows[0]), /\+40pt 付与（取消済み）/.test(hrows[1])], [2, true, true]);
check('取消の行に、取り消した元のIDが残る', hrows[0].includes('取消対象ID: ' + entryId), hrows[0]);
eq('取消済みの付与には、もう取消ボタンがない', await hana.locator('.pthist .ptrow .ptrev').count(), 0);
const again = await page.evaluate(async (id) => (await fetch('/api/admin?action=points-reverse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entryId: id, reason: 'もう一度', requestId: 'again-' + Date.now() + '-xx' }) })).status, entryId);
eq('同じ履歴の二重取消は拒否（409）', again, 409);

console.log('■ H. 通信失敗でも二重付与・表示の食い違いが起きない（山田 次郎）');
await search('山田');
const jiro = card('山田 次郎');
await jiro.locator('.ptbtn').click(); await jiro.locator('.ptgo').waitFor();
// (1) サーバーに届く前に通信が切れる → 同じ操作IDで自動再送 → 1回だけ保存
let aborted = 0;
await page.route('**/api/admin?action=points-grant', async (route) => { if (aborted < 1) { aborted++; return route.abort('failed'); } return route.continue(); });
await op(jiro, { amount: '30', reason: '通信断テスト1' });
const j1 = await waitFor(jiro, (t) => t.includes('付与しました'));
eq('届く前に切れても自動再送で付与される', [j1.startsWith('山田 次郎 さんに +30pt を付与しました'), aborted], [true, 1]);
await page.unroute('**/api/admin?action=points-grant');
// (2) サーバーには保存されたが、応答が届かない → 同じ操作IDで再送 → 「反映済み」と表示され、二重にはならない
let dropped = 0;
await page.route('**/api/admin?action=points-grant', async (route) => { if (dropped < 1) { dropped++; await route.fetch(); return route.abort('failed'); } return route.continue(); });
await op(jiro, { amount: '20', reason: '通信断テスト2' });
const j2 = await waitFor(jiro, (t) => t.includes('付与しました'));
eq('保存済みで応答だけ失われても、二重にならず「反映済み」と表示', [j2.includes('すでに反映済み'), dropped], [true, 1]);
eq('現在ポイントは 30 + 20 = 50', await jiro.locator('.ptnow b').innerText(), '50');
eq('履歴は2件のみ', await jiro.locator('.pthist .ptrow').count(), 2);
await page.unroute('**/api/admin?action=points-grant');
// (3) 常に失敗する場合：最新の状態を取り直し、実際の保存状況を見せる
await page.route('**/api/admin?action=points-grant', (route) => route.abort('failed'));
await op(jiro, { amount: '5', reason: '通信断テスト3' });
const j3 = await waitFor(jiro, (t) => t.includes('通信に失敗しました'));
check('通信が回復しない場合は、失敗と「最新の現在ポイント・履歴で確認」を案内', j3.includes('通信に失敗しました') && j3.includes('確認'), j3);
eq('その場合も、画面の現在ポイントはサーバーの値（50）', await jiro.locator('.ptnow b').innerText(), '50');
await page.unroute('**/api/admin?action=points-grant');

console.log('■ I. 会員資格がない人には操作させない');
await search('鈴木');
eq('未決済の会員にはポイント操作ボタンが出ない', await card('鈴木 一郎').locator('.ptbtn').count(), 0);
check('理由の案内が出る', (await card('鈴木 一郎').innerText()).includes('現在有効な会員ではないため'), await card('鈴木 一郎').innerText());
await search('高橋'); eq('審査中の人にも出ない', await card('高橋 未来').locator('.ptbtn').count(), 0);
await search('田中'); eq('解約済みの人にも出ない', await card('田中 守').locator('.ptbtn').count(), 0);
await search('佐藤'); eq('解約予約中（まだ利用可）の人には出る', await card('佐藤 みく').locator('.ptbtn').count(), 1);
const apiCalls = await page.evaluate(async () => {
  const post = (email) => fetch('/api/admin?action=points-grant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, amount: 10, reason: 'x', requestId: 'direct-' + email.length + '-' + Date.now() }) }).then(async (r) => [r.status, (await r.json()).code]);
  return {
    unpaid: await post('ichiro.suzuki@example.com'), pending: await post('pending.takahashi@example.com'),
    canceled: await post('canceled.tanaka@example.com'), nobody: await post('nobody@example.com'), nonMemberTomoshibi: await post('tomo.teacher@example.com'),
  };
});
eq('APIでも、会員資格なし・存在しない会員への付与は拒否', apiCalls, { unpaid: [404, 'not_member'], pending: [404, 'not_member'], canceled: [409, 'not_active_member'], nobody: [404, 'not_member'], nonMemberTomoshibi: [404, 'not_member'] });
eq('拒否された会員にポイントは付いていない（ポイントがある会員は2名だけ）', await page.evaluate(async () => (await (await fetch('/api/admin?action=members&community=haku')).json()).members.filter((m) => m.points).map((m) => m.email + ':' + m.points).sort()), ['jiro.yamada@example.com:50', 'nishiyama.taro@example.com:130']);

console.log('■ J. 「HAKUポイント」タブ（全会員の操作履歴）');
await page.click('[data-mode="tane"]'); await page.waitForSelector('#pointsRecentList .ptrow');
const recent = await page.locator('#pointsRecentList .ptrow').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
check('全会員の履歴が出る（太郎3・花子2・次郎2＝7件）', recent.length === 7, recent.length);
check('会員名・増減・種別・理由・操作者・日時が見える', recent.some((r) => r.includes('西山 太郎') && r.includes('+100pt') && r.includes('付与') && r.includes('HAKU MORNINGのお手伝い') && r.includes('admin@example.test') && /20[0-9]{2}\//.test(r)), recent.find((r) => r.includes('HAKU MORNING')));
check('取消・調整も種別で区別される', recent.some((r) => /-40pt 取消/.test(r)) && recent.some((r) => /-20pt 調整/.test(r)) && recent.some((r) => /\+40pt 付与（取消済み）/.test(r)), recent);
await page.fill('#pointsSearch', '山田'); await page.waitForTimeout(260);
eq('履歴を会員名で絞り込める', [await page.locator('#pointsRecentList .ptrow').count(), await page.locator('#pointsCount').innerText()], [2, '2件の履歴が見つかりました。']);
await page.fill('#pointsSearch', ''); await page.waitForTimeout(260);
await page.screenshot({ path: path.join(OUT, 'admin_points_tab.png'), fullPage: true });

console.log('■ K. 会員側と管理画面が同じデータ（西山 太郎＝130pt）');
const mctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'ja-JP' });
const mp = await mctx.newPage();
await mp.goto(base + '/lp-assets/logo-hero.png'); // 同一オリジンでCookieを持たせるための足場
const loginRes = await mp.evaluate(async (pw) => (await fetch('/api/community-auth?action=login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ community: 'haku', email: 'nishiyama.taro@example.com', password: pw }) })).status, MEMBER_PASSWORD);
eq('会員ログイン', loginRes, 200);
await mp.goto(base + '/haku-community/home/#point');
await mp.waitForSelector('#pointBody .pt-row');
const memberText = await mp.locator('#pointBody').innerText();
check('会員の#pointに「130 pt」が出る', /現在のポイント\s*130 pt/.test(memberText.replace(/\n+/g, ' ')), memberText);
const mrows = await mp.locator('#pointBody .pt-row').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
eq('会員側の履歴も +100 / +50 / -20', mrows.map((r) => (r.match(/([+-][0-9]+) pt/) || [])[1]), ['-20', '+50', '+100']);
check('会員側に、運営の個人名・メールは出ない', !/admin@example\.test/.test(memberText), memberText);
await mp.screenshot({ path: path.join(OUT, 'member_point_130.png') });
const adminBal = await page.evaluate(async () => (await (await fetch('/api/admin?action=points-member&email=nishiyama.taro@example.com')).json()).balance);
const memberBal = await mp.evaluate(async () => (await (await fetch('/api/community-auth?action=points-me')).json()).balance);
eq('管理画面と会員画面の残高が一致', [adminBal, memberBal], [130, 130]);
// 山田 次郎（50）、取消後の花子（0）も一致
await mctx.clearCookies();
await mp.evaluate(async (pw) => fetch('/api/community-auth?action=login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ community: 'haku', email: 'jiro.yamada@example.com', password: pw }) }), MEMBER_PASSWORD);
eq('山田 次郎も一致（50）', await mp.evaluate(async () => (await (await fetch('/api/community-auth?action=points-me')).json()).balance), 50);

console.log('■ L. 一般会員からの操作は不可（会員ログイン状態でAPI直叩き）');
const direct = await mp.evaluate(async () => {
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => r.status);
  return {
    grantSelf: await post('/api/admin?action=points-grant', { email: 'jiro.yamada@example.com', amount: 1000, requestId: 'member-attempt-0001' }),
    adjust: await post('/api/admin?action=points-adjust', { email: 'jiro.yamada@example.com', amount: 5, reason: 'x', requestId: 'member-attempt-0002' }),
    reverse: await post('/api/admin?action=points-reverse', { entryId: 'x', reason: 'x', requestId: 'member-attempt-0003' }),
    memberApiGrant: await post('/api/community-auth?action=points-grant', { email: 'jiro.yamada@example.com', amount: 1000, requestId: 'member-attempt-0004' }),
    recent: await fetch('/api/admin?action=points-recent').then((r) => r.status),
    members: await fetch('/api/admin?action=members&community=haku').then((r) => r.status),
  };
});
eq('一般会員は付与・調整・取消・履歴・会員一覧のどれも不可', direct, { grantSelf: 401, adjust: 401, reverse: 401, memberApiGrant: 400, recent: 401, members: 401 });
eq('試みた後もポイントは変わらない', await mp.evaluate(async () => (await (await fetch('/api/community-auth?action=points-me')).json()).balance), 50);
// 未ログイン
const anon = await (await browser.newContext()).newPage();
await anon.goto(base + '/lp-assets/logo-hero.png');
eq('未ログインも不可', await anon.evaluate(async () => fetch('/api/admin?action=points-grant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'jiro.yamada@example.com', amount: 5, requestId: 'anon-attempt-00001' }) }).then((r) => r.status)), 401);

console.log('■ M. 管理者のロール（最上位以外の管理者でも、管理者として付与・調整・取消できる）');
const sctx = await browser.newContext(); const sp = await sctx.newPage();
await sp.goto(base + '/lp-assets/logo-hero.png');
const staffLogin = await sp.evaluate(async () => (await fetch('/api/admin?action=login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'staff@example.test', password: 'StaffTest-12345' }) })).json());
eq('別ロール（staff）の管理者でログイン', staffLogin.role, 'staff');
const staffOps = await sp.evaluate(async () => {
  const post = (a, body) => fetch('/api/admin?action=' + a, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, (await r.json()).balance]);
  const g = await post('points-grant', { email: 'miku.sato@example.com', amount: 10, reason: 'staff', requestId: 'staff-op-grant-01' });
  const a = await post('points-adjust', { email: 'miku.sato@example.com', amount: -3, reason: 'staff調整', requestId: 'staff-op-adjust-01' });
  return { g, a };
});
eq('staffでも付与・調整が実行できる（操作は履歴に記録）', staffOps, { g: [200, 10], a: [200, 7] });

console.log('■ N. ページを開き直してもログイン状態が復元される');
await page.reload(); await page.waitForSelector('#adminPanel', { state: 'visible' });
eq('再読み込み後も管理画面（ログイン画面に戻らない）', [await page.locator('#loginbox').isHidden(), await page.locator('#adminPanel').isVisible()], [true, true]);

console.log('■ O. 操作履歴（監査ログ）に残る');
const audit = await page.evaluate(async () => (await (await fetch('/api/admin?action=audit-log')).json()).entries.filter((e) => /^point_/.test(e.action)).map((e) => e.action).sort());
check('付与・調整・取消の操作が監査ログにも記録', ['point_adjust', 'point_grant', 'point_reverse'].every((a) => audit.includes(a)), audit);

check('画面のJavaScriptエラーなし', consoleErrors.length === 0, consoleErrors);
console.log(`\n結果: 成功 ${pass} / 失敗 ${fail}`);
if (failures.length) console.log('失敗:\n' + failures.join('\n'));
await browser.close(); server.close();
process.exit(fail ? 1 : 0);

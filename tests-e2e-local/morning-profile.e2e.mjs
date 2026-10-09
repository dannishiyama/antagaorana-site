// 朝の集まり（カレンダー・参加／取消・他の会員への共有）とプロフィール画像（保存・各所への反映・削除）の、
// 本物の画面 × 本物のAPI × メモリ上のRedis によるE2E。本物のRedis・Stripeには接続しない。
// 実行：node tests-e2e-local/morning-profile.e2e.mjs（README参照）
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const REPO_URL = new URL('../', import.meta.url);
const REPO = fileURLToPath(REPO_URL);
const require = createRequire(REPO + 'package.json');
const { chromium } = require('playwright-core');
const { start, seed, store, MEMBER_PASSWORD } = await import('./e2e-server.mjs');
await seed();
const { server, base } = await start();
const OUT = process.env.OUT_DIR || os.tmpdir();
const browser = await chromium.launch();

let pass = 0, fail = 0; const failures = [];
function check(name, ok, detail) { if (ok) { pass++; console.log('  ✔', name); } else { fail++; failures.push(name + ' :: ' + JSON.stringify(detail)); console.log('  ✖', name, JSON.stringify(detail)); } }
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });

// テスト用の画像（横長のPNG・テキストを画像に偽装したもの・テキスト）
function crc32(buf) { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
function widePng(w, h) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(w * 3 + 1); for (let x = 0; x < w; x++) { row[1 + x * 3] = x * 255 / w; row[2 + x * 3] = 120; row[3 + x * 3] = 60; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-av-'));
const FILES = { wide: path.join(tmp, 'wide.png'), fake: path.join(tmp, 'fake.png'), txt: path.join(tmp, 'note.txt'), logo: path.join(REPO, 'lp-assets/haku-community-logo.png') };
fs.writeFileSync(FILES.wide, widePng(600, 200)); fs.writeFileSync(FILES.fake, '<script>alert(1)</script>'); fs.writeFileSync(FILES.txt, 'hello');

const errors = [];
async function login(email, { width = 1280, height = 900, name } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(m.text())) errors.push(`[${name || email}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name || email}] pageerror ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(base + '/haku-community/login/');
  await page.fill('input[type=email]', email); await page.fill('input[type=password]', MEMBER_PASSWORD);
  await page.click('#go'); await page.waitForURL('**/haku-community/home/**', { timeout: 8000 });
  await page.waitForSelector('.page.active h1');
  return { ctx, page };
}
const A = 'nishiyama.taro@example.com', B = 'Hanako.Nishiyama@Example.com';
const JST = (n = 0) => new Date(Date.now() + 9 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const today = JST(0), tomorrow = JST(1), yesterday = JST(-1);
const cell = (page, date) => page.locator(`.mo-cell[data-date="${date}"]`);
const detail = (page) => page.locator('#moDetail').innerText();
async function openMorning(page) { await page.goto(base + '/haku-community/home/#morning'); await page.waitForSelector('.mo-grid'); }
async function pick(page, date) { await cell(page, date).click(); await page.waitForFunction((d) => document.querySelector(`.mo-cell[data-date="${d}"]`).getAttribute('aria-pressed') === 'true', date); }

console.log('■ A. ナビ名・ホームの朝の集まり（誰も参加していない状態）');
const a = await login(A, { name: 'タロウ' });
{
  const p = a.page;
  eq('ナビは6項目・最後は「マイページ」', await p.locator('.side .tab .tab-lbl').allInnerTexts().then((t) => t.map((s) => s.replace(/\s+/g, ''))), ['ホーム', '学ぶ', 'ことば', '集う', 'HAKUポイント', 'マイページ']);
  eq('マイページのaria-label', await p.locator('.tab[data-tab="profile"]').getAttribute('aria-label') ?? await p.locator('.side-member button').getAttribute('aria-label'), await p.locator('.tab[data-tab="profile"]').getAttribute('aria-label') ?? 'マイページを開く');
  eq('PCアイコンのaria-label', await p.locator('#avatarBtn').getAttribute('aria-label'), 'マイページを開く');
  await p.waitForFunction(() => document.querySelector('#homeNextMorning') && !document.querySelector('#homeNextMorning .pulse'));
  const homeText = await p.locator('#homeNextMorning').innerText();
  check('誰も参加していない：開催予定の朝の集まりなし＋「朝の集まりを見る」', /開催予定の朝の集まりはありません/.test(homeText) && /朝の集まりを見る/.test(homeText), homeText);
  const body = await p.innerText('body');
  check('HOMEに「555チャレンジ」「HAKU MORNING」が出ない', !/555|チャレンジ|HAKU MORNING|Google Meet/.test(body), null);
  eq('ホームにカレンダーを置かない', await p.locator('#p-home .mo-grid').count(), 0);
  await p.screenshot({ path: path.join(OUT, 'morning-01-home-empty.png') });
  await p.click('#homeNextMorning [data-go="morning"]'); await p.waitForSelector('.mo-grid');
  eq('「朝の集まりを見る」で専用ページへ（hash）', new URL(p.url()).hash, '#morning');
  eq('専用ページの見出し', await p.locator('#p-morning h1').innerText(), '朝の集まり');
  check('集うタブが選択されたまま', (await p.locator('.tab[aria-current="page"]').getAttribute('data-tab')) === 'gather', null);
}

console.log('■ B. カレンダー：参加表明（Aが明日に参加）');
{
  const p = a.page;
  const month = await p.locator('.mo-month').innerText();
  check('月間表示（年月）', /^\d{4}年\d{1,2}月$/.test(month), month);
  eq('曜日の見出し7つ', await p.locator('.mo-wd').allInnerTexts(), ['日', '月', '火', '水', '木', '金', '土']);
  check('今日のセルが選ばれている（開催予定なし）', /開催予定なし/.test(await detail(p)), await detail(p));
  await pick(p, tomorrow);
  const before = await detail(p);
  check('参加者0人の日：「開催予定なし」＋参加ボタン', /開催予定なし/.test(before) && (await p.locator('#moDetail [data-act="mo-join"]').count()) === 1, before);
  await p.click('#moDetail [data-act="mo-join"]');
  await p.waitForFunction(() => /開催予定/.test(document.querySelector('#moDetail').innerText) && !/開催予定なし/.test(document.querySelector('#moDetail').innerText));
  const after = await detail(p);
  check('参加すると「開催予定」「参加予定 1人」「タロウ（あなた）」', /開催予定/.test(after) && /参加予定 1人/.test(after) && /タロウ/.test(after) && /あなた/.test(after), after);
  check('取消ボタンに変わる', (await p.locator('#moDetail [data-act="mo-leave"]').count()) === 1 && (await p.locator('#moDetail [data-act="mo-join"]').count()) === 0, null);
  const c = cell(p, tomorrow);
  check('セル：1人・自分が参加予定（mine）', /1人/.test(await c.innerText()) && (await c.getAttribute('class')).includes('mine') && /あなたは参加予定/.test(await c.getAttribute('aria-label')), await c.getAttribute('class'));
  await p.screenshot({ path: path.join(OUT, 'morning-02-calendar-A.png'), fullPage: false });
}

console.log('■ C. Bから見える（共有）／Bも参加／取消の反映');
const b = await login(B, { name: 'ハナ' });
{
  const p = b.page;
  await p.waitForFunction(() => document.querySelector('#homeNextMorning') && !document.querySelector('#homeNextMorning .pulse'));
  const home = await p.locator('#homeNextMorning').innerText();
  check('Bのホーム：「あしたの朝の集まり」参加予定1人・タロウさん', /あしたの朝の集まり/.test(home) && /参加予定 1人/.test(home) && /タロウさん/.test(home), home);
  await p.screenshot({ path: path.join(OUT, 'morning-03-home-B.png') });
  await p.click('#homeNextMorning [data-go="morning"]'); await p.waitForSelector('.mo-grid');
  await pick(p, tomorrow);
  const d = await detail(p);
  check('Bから見て、Aが参加予定／Bは未参加', /参加予定 1人/.test(d) && /タロウ/.test(d) && !/あなた/.test(d) && (await p.locator('#moDetail [data-act="mo-join"]').count()) === 1, d);
  check('参加者に氏名（西山）・メールが出ない', !/西山|@example/.test(await p.innerText('#morningBody')), null);
  await p.click('#moDetail [data-act="mo-join"]');
  await p.waitForFunction(() => /参加予定 2人/.test(document.querySelector('#moDetail').innerText));
  const d2 = await detail(p);
  check('Bも参加：2人、ハナ（あなた）とタロウ', /参加予定 2人/.test(d2) && /ハナ/.test(d2) && /タロウ/.test(d2), d2);
  // Aの画面を開き直す → Bが見える
  await openMorning(a.page); await pick(a.page, tomorrow);
  const da = await detail(a.page);
  check('Aから見てBが参加予定（再取得で反映）', /参加予定 2人/.test(da) && /ハナ/.test(da), da);
  // Aが取消 → Bに反映
  await a.page.click('#moDetail [data-act="mo-leave"]');
  await a.page.waitForFunction(() => /参加予定 1人/.test(document.querySelector('#moDetail').innerText));
  check('Aが取消：A側は未参加に', (await a.page.locator('#moDetail [data-act="mo-join"]').count()) === 1, await detail(a.page));
  await openMorning(p); await pick(p, tomorrow);
  const db = await detail(p);
  check('Aの取消がB側にも反映（1人・ハナのみ）', /参加予定 1人/.test(db) && /ハナ/.test(db) && !/タロウ/.test(db), db);
  await p.screenshot({ path: path.join(OUT, 'morning-04-calendar-B.png') });
  // Bも取消 → 開催予定なしに戻る
  await p.click('#moDetail [data-act="mo-leave"]');
  await p.waitForFunction(() => /開催予定なし/.test(document.querySelector('#moDetail').innerText));
  check('全員が取消すると「開催予定なし」に戻る', /開催予定なし/.test(await detail(p)), null);
  await openMorning(b.page);
}

console.log('■ D. 二重参加・過去日');
{
  const p = a.page;
  await openMorning(p); await pick(p, tomorrow);
  await Promise.all([p.locator('#moDetail [data-act="mo-join"]').click({ noWaitAfter: true }), p.locator('#moDetail [data-act="mo-join"]').click({ noWaitAfter: true, timeout: 800 }).catch(() => {})]);
  await p.waitForFunction(() => /参加予定 1人/.test(document.querySelector('#moDetail').innerText));
  await p.waitForTimeout(500);
  eq('連打しても1人分（サーバー上も1人）', await store.countEventParticipants('morning-' + tomorrow), 1);
  const r = await p.evaluate(async (t) => (await fetch('/api/community-auth?action=morning-join', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: t }) })).json(), tomorrow);
  check('すでに参加済みでもう一度参加を送っても、二重にならない', r.ok === true && r.alreadyJoined === true && r.day.count === 1, r);
  await p.click('#moDetail [data-act="mo-leave"]'); await p.waitForFunction(() => /開催予定なし/.test(document.querySelector('#moDetail').innerText));
  // 過去日：今日が月初なら前の月へ
  const today1 = today.slice(8) === '01';
  if (today1) { await p.click('[data-act="mo-prev"]'); await p.waitForSelector('.mo-grid'); }
  const pastDate = today1 ? JST(-1) : yesterday;
  await pick(p, pastDate);
  const pd = await detail(p);
  check('過去日：参加・取消ボタンがない（「過ぎた日です」）', /過ぎた日です/.test(pd) && (await p.locator('#moDetail [data-act]').count()) === 0, pd);
  const api = await p.evaluate(async (d) => (await fetch('/api/community-auth?action=morning-join', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: d }) })).status, pastDate);
  eq('過去日へのAPI直接の参加も拒否（409）', api, 409);
  // 月の移動
  await openMorning(p);
  const m0 = await p.locator('.mo-month').innerText();
  await p.click('[data-act="mo-next"]'); await p.waitForSelector('.mo-grid');
  check('次の月へ移動できる', (await p.locator('.mo-month').innerText()) !== m0, null);
  await p.click('[data-act="mo-prev"]'); await p.waitForSelector('.mo-grid');
  eq('前の月に戻れる', await p.locator('.mo-month').innerText(), m0);
}

console.log('■ E. マイページ → 設定とサポート → プロフィール設定');
{
  const p = a.page;
  await p.goto(base + '/haku-community/home/#profile'); await p.waitForSelector('#p-profile.active');
  eq('マイページの見出しは「わたしの記録」（世界観を残す）', await p.locator('#p-profile h1').innerText(), 'わたしの記録');
  const groups = await p.locator('#p-profile .sub-title').allInnerTexts();
  eq('設定とサポートのグループ', groups, ['プロフィール', 'アカウント', 'サポート']);
  const rows = await p.locator('#p-profile #h-settings ~ ul .row-link span:first-child, #p-profile #cancelArea .row-link span:first-child').allInnerTexts();
  check('既存の項目が残っている（メール・パスワード・ログアウト・解約・お問い合わせ）', ['メールアドレスを変更', 'パスワードを変更', 'ログアウト', 'HAKU Communityを解約する', '運営へのお問い合わせ'].every((t) => rows.includes(t)), rows);
  await p.screenshot({ path: path.join(OUT, 'profile-01-mypage.png'), fullPage: true });
  await p.click('[data-go="profile-settings"]'); await p.waitForSelector('#p-profile-settings.active');
  eq('プロフィール設定の見出し', await p.locator('#p-profile-settings h1').innerText(), 'プロフィール設定');
  eq('表示名の現在値', await p.inputValue('#pfNameInput'), 'タロウ');
  check('画像未設定：頭文字（タ）が表示される', (await p.locator('#pfNow .av').innerText()).trim() === 'タ' && (await p.locator('#pfNow img').count()) === 0, null);
  check('「画像を選ぶ」がある', (await p.locator('[data-act="avatar-pick"]').innerText()) === '画像を選ぶ', null);
  check('「設定とサポート」から来ているのでマイページのタブが選択', (await p.locator('.tab[aria-current="page"]').getAttribute('data-tab')) === 'profile', null);
}

console.log('■ F. 画像アップロード（検証）');
{
  const p = a.page;
  const err = () => p.locator('#pfImgErr').innerText();
  await p.setInputFiles('#avatarFile', FILES.txt);
  check('テキストファイルは拒否', /JPEG・PNG・WebP/.test(await err()), await err());
  await p.setInputFiles('#avatarFile', FILES.fake);
  await p.waitForFunction(() => document.querySelector('#pfImgErr').innerText.length > 0);
  check('画像に偽装した文字ファイルは拒否（読み込めない）', /読み込めません/.test(await err()), await err());
  eq('どちらも保存されていない', (await store.getUser(A)).avatarId ?? null, null);
  await p.setInputFiles('#avatarFile', FILES.wide);
  await p.waitForSelector('[data-act="avatar-save"]');
  const prev = await p.evaluate(() => { const i = document.querySelector('#pfImage img'); return i && { w: i.naturalWidth, h: i.naturalHeight, src: i.src.slice(0, 22) }; });
  eq('プレビューは正方形に整えられている（256×256 JPEG）', prev, { w: 256, h: 256, src: 'data:image/jpeg;base64' });
  await p.screenshot({ path: path.join(OUT, 'profile-02-preview.png') });
  await p.click('[data-act="avatar-cancel"]');
  check('「やめる」で保存せず戻る', (await p.locator('[data-act="avatar-save"]').count()) === 0 && (await store.getUser(A)).avatarId == null, null);
}

console.log('■ G. 画像の保存・各所への反映・再読み込み');
{
  const p = a.page;
  await p.setInputFiles('#avatarFile', FILES.logo);
  await p.waitForSelector('[data-act="avatar-save"]');
  await p.click('[data-act="avatar-save"]');
  await p.waitForSelector('#pfNow img');
  const id = (await store.getUser(A)).avatarId;
  check('保存された（User.avatarIdが入る・16桁）', /^[a-f0-9]{16}$/.test(id), id);
  const imgOk = (sel) => imgOk0(p, sel);
  check('プロフィール設定のプレビューに画像', await imgOk('#pfNow img'), null);
  check('PC左下のアイコン（サイドナビ周辺）に画像', await imgOk('#avatarBtn img'), null);
  await p.click('[data-go="profile"]'); await p.waitForSelector('#p-profile.active');
  check('マイページのアイコンに画像', await imgOk('#meAv img'), null);
  await p.screenshot({ path: path.join(OUT, 'profile-03-mypage-with-image.png') });
  // 再読み込み後も維持
  await p.reload(); await p.waitForSelector('.page.active h1');
  check('再読み込み後も、PC左下のアイコンに画像が出る', await imgOk('#avatarBtn img'), null);
  const srcs = await p.evaluate(() => [document.querySelector('#avatarBtn img').getAttribute('src')]);
  check('画像のURLは avatarId だけ（メールアドレスを含まない）', srcs[0].endsWith(id) && !/@|%40/.test(srcs[0]), srcs);
  // 朝の集まりの参加者アイコン
  await openMorning(p); await pick(p, tomorrow);
  await p.click('#moDetail [data-act="mo-join"]'); await p.waitForFunction(() => /参加予定 1人/.test(document.querySelector('#moDetail').innerText));
  check('朝の集まり：自分の参加者アイコンに画像', await imgOk('#moDetail .mo-person img'), null);
  check('カレンダーのセル（ミニアイコン）にも画像', await imgOk(`.mo-cell[data-date="${tomorrow}"] img`), null);
  // Bから見ても同じ画像
  await openMorning(b.page); await pick(b.page, tomorrow);
  await b.page.waitForSelector('#moDetail .mo-person img');
  check('Bから見たAの参加者アイコンも画像', await imgOk0(b.page, '#moDetail .mo-person img'), null);
  eq('同じ会員は、どの場所でも同じ画像（avatarIdが同一）', await b.page.evaluate(() => document.querySelector('#moDetail .mo-person img').getAttribute('src').split('id=')[1]), id);
  await b.page.screenshot({ path: path.join(OUT, 'morning-05-participants-with-image-B.png') });
  await b.page.goto(base + '/haku-community/home/#home'); await b.page.waitForSelector('#homeNextMorning .mo-stack');
  check('ホームの朝の集まりカードにもアイコン画像', await imgOk0(b.page, '#homeNextMorning .mo-stack img'), null);
  await b.page.screenshot({ path: path.join(OUT, 'morning-06-home-B-with-avatar.png') });
  await p.click('#moDetail [data-act="mo-leave"]'); await p.waitForFunction(() => /開催予定なし/.test(document.querySelector('#moDetail').innerText));
}
async function imgOk0(page, sel) { // 画像の読み込みが終わるのを少し待ってから判定する
  return page.waitForFunction((s) => { const i = document.querySelector(s); return Boolean(i && i.complete && i.naturalWidth > 0); }, sel, { timeout: 4000 }).then(() => true, () => false);
}

console.log('■ H. 画像の削除（イニシャルに戻る）・表示名の変更');
{
  const p = a.page;
  await p.goto(base + '/haku-community/home/#profile-settings'); await p.waitForSelector('[data-act="avatar-remove"]');
  await p.click('[data-act="avatar-remove"]');
  await p.waitForFunction(() => !document.querySelector('#pfNow img'));
  eq('削除：User.avatarIdが空に', (await store.getUser(A)).avatarId ?? null, null);
  eq('設定画面は頭文字（タ）に戻る', (await p.locator('#pfNow .av').innerText()).trim(), 'タ');
  eq('PC左下のアイコンも頭文字', (await p.locator('#avatarBtn').innerText()).trim(), 'タ');
  await p.click('[data-go="profile"]'); await p.waitForSelector('#p-profile.active');
  eq('マイページのアイコンも頭文字', (await p.locator('#meAv .av').innerText()).trim(), 'タ');
  // 表示名
  await p.click('[data-go="profile-settings"]'); await p.waitForSelector('#pfNameInput');
  await p.fill('#pfNameInput', 'たろう'); await p.click('#pfNameBtn');
  await p.waitForFunction(() => document.querySelector('.topbar-name').textContent === 'たろう');
  eq('表示名を変更すると、サイド・マイページ・アイコンの頭文字が変わる', [await p.locator('.topbar-name').innerText(), (await p.locator('#avatarBtn').innerText()).trim(), (await p.locator('#meName').innerText())], ['たろう', 'た', 'たろう']);
  eq('保存されている', (await store.getUser(A)).displayName, 'たろう');
  await p.fill('#pfNameInput', 'タロウ'); await p.click('#pfNameBtn');
  await p.waitForFunction(() => document.querySelector('.topbar-name').textContent === 'タロウ');
}
// 画像が読めないときは頭文字に戻る
{
  const p = a.page;
  await store.saveUser({ ...(await store.getUser(A)), avatarId: 'abababababababab' }); // 実体のない画像ID
  await p.goto(base + '/haku-community/home/#home'); await p.waitForSelector('.page.active h1');
  await p.waitForFunction(() => !document.querySelector('#avatarBtn img'));
  eq('画像が読み込めなくても、頭文字に戻る（壊れた画像は出ない）', (await p.locator('#avatarBtn').innerText()).trim(), 'タ');
  await store.saveUser({ ...(await store.getUser(A)), avatarId: null });
}

console.log('■ I. スマホ幅（390px）：ホーム／朝の集まり／プロフィール設定');
{
  const m = await login(A, { width: 390, height: 844, name: 'タロウ(スマホ)' });
  const p = m.page;
  const overflow = () => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || document.querySelector('.content').scrollWidth > document.querySelector('.content').clientWidth + 1);
  await p.waitForFunction(() => !document.querySelector('#homeNextMorning .pulse'));
  eq('ホーム：横スクロールなし', await overflow(), false);
  check('ホーム：下部メニュー6項目・最後は「マイページ」', (await p.locator('.tabbar .tab').count()) === 6 && /マイページ/.test(await p.locator('.tabbar .tab').last().innerText()), null);
  await p.screenshot({ path: path.join(OUT, 'm-01-home.png') });
  await openMorning(p); await pick(p, tomorrow);
  await p.click('#moDetail [data-act="mo-join"]'); await p.waitForFunction(() => /参加予定 1人/.test(document.querySelector('#moDetail').innerText));
  eq('朝の集まり：横スクロールなし', await overflow(), false);
  const cw = await p.evaluate(() => Math.round(document.querySelector('.mo-cell:not(.blank)').getBoundingClientRect().width));
  check(`セルの幅が十分（${cw}px）・押しやすい高さ`, cw >= 40 && (await p.evaluate(() => document.querySelector('.mo-cell:not(.blank)').getBoundingClientRect().height)) >= 56, cw);
  await p.screenshot({ path: path.join(OUT, 'm-02-morning.png'), fullPage: true });
  await p.click('#moDetail [data-act="mo-leave"]'); await p.waitForFunction(() => /開催予定なし/.test(document.querySelector('#moDetail').innerText));
  await p.goto(base + '/haku-community/home/#profile-settings'); await p.waitForSelector('#p-profile-settings.active');
  eq('プロフィール設定：横スクロールなし', await overflow(), false);
  await p.screenshot({ path: path.join(OUT, 'm-03-profile-settings.png'), fullPage: true });
  await p.goto(base + '/haku-community/home/#profile'); await p.waitForSelector('#p-profile.active');
  eq('マイページ：横スクロールなし', await overflow(), false);
  await p.screenshot({ path: path.join(OUT, 'm-04-mypage.png'), fullPage: true });
  await m.ctx.close();
}

console.log('■ J. 既存の「集う」（通常イベントの予約・取消）に影響がない');
{
  const ev = await store.createEvent('haku', { type: 'meet', title: '秋の交流会', startsAt: new Date(Date.now() + 6 * 86400e3).toISOString(), capacity: 5, location: 'オンライン' });
  const p = a.page;
  await p.goto(base + '/haku-community/home/#gather'); await p.reload(); await p.waitForSelector('#gatherBody .item');
  check('集う：朝の集まりへの入口（カレンダーへ）がある', (await p.locator('#gatherBody [data-go="morning"]').count()) === 1, null);
  check('集う：通常のイベントが出る（日ごとの朝の集まりは混ざらない）', /秋の交流会/.test(await p.locator('#gatherBody').innerText()) && !/morning-/.test(await p.locator('#gatherBody').innerHTML()), null);
  await p.click(`[data-act="join"][data-id="${ev.id}"]`); await p.waitForSelector(`[data-act="leave"][data-id="${ev.id}"]`);
  eq('通常イベントに参加できる', await store.isEventParticipant(ev.id, A), true);
  await p.click(`[data-act="leave"][data-id="${ev.id}"]`); await p.waitForSelector(`[data-act="join"][data-id="${ev.id}"]`);
  eq('通常イベントを取り消せる', await store.isEventParticipant(ev.id, A), false);
}

eq('画面のJavaScriptエラー・予期しないエラーなし', errors, []);
console.log(`\n結果: 成功 ${pass} / 失敗 ${fail}`);
if (fail) console.log('失敗:\n' + failures.join('\n'));
await browser.close(); server.close();
process.exit(fail ? 1 : 0);

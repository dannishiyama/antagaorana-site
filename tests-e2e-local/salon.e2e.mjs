// 教育者のサロン「灯」のE2E：本物の画面 × 本物のAPI × メモリ上のRedis。本物のRedis・メール・Stripe・Googleには接続しない。
// 実行：node tests-e2e-local/salon.e2e.mjs（README参照）
// 画面の忠実さは、依頼主が確認済みのモックアップ原本（SALON_MOCK_DIR）と、同じ要素の「実際の見た目（計算済みスタイル）」を比べて確かめる。
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const REPO_URL = new URL('../', import.meta.url);
const REPO = fileURLToPath(REPO_URL);
const require = createRequire(REPO + 'package.json');
const { chromium } = require('playwright-core');
process.env.RESEND_API_KEY = 're_test_dummy';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).includes('resend.com') ? new Response(JSON.stringify({ message: 'stubbed' }), { status: 401 }) : realFetch(url, init));
const { start, seed, store, ADMIN, MEMBER_PASSWORD } = await import('./e2e-server.mjs');
const Salon = await import(new URL('api/_lib/salon-store.js', REPO_URL).href);
const security = await import(new URL('api/_lib/security.js', REPO_URL).href);
const { hooks } = await import(new URL('api/salon.js', REPO_URL).href);
await seed();
const { server, base } = await start();
const OUT = process.env.OUT_DIR || os.tmpdir();
const MOCK_DIR = process.env.SALON_MOCK_DIR || '';
const browser = await chromium.launch();

let pass = 0, fail = 0; const failures = [];
function check(name, ok, detail) { if (ok) { pass++; console.log('  ✔', name); } else { fail++; failures.push(name + ' :: ' + JSON.stringify(detail)); console.log('  ✖', name, JSON.stringify(detail)); } }
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
async function shot(page, file, opts) { try { await page.screenshot({ path: path.join(OUT, file), ...(opts || {}) }); } catch (e) { /* 撮影の失敗は無視 */ } }

// ── テストデータ（Previewのテスト用。本番のデータではない） ──
const hash = await security.hashPassword(MEMBER_PASSWORD);
async function addMember(email, name, { staff = null, profile = null, since = Date.now() } = {}) {
  await store.saveUser({ email, displayName: name, fullName: `本名${name}`, fullNameKana: 'ほんみょう', passwordHash: hash });
  await store.createApplication('tomoshibi', { email, fullName: `本名${name}`, fullNameKana: 'ほんみょう', displayName: name });
  await store.resolveApplication('tomoshibi', email, 'approved', 'seed');
  await store.setMembership('tomoshibi', email, { status: 'active', activatedAt: since, source: 'admin' });
  if (staff) await Salon.setStaff(email, staff);
  await Salon.saveProfile(email, { displayName: name, ...(profile || {}) });
}
const OWNER = 'owner@example.test', SECR = 'office@example.test', SASAKI = 'sasaki@example.test', NAKAMURA = 'nakamura@example.test', HIMITSU = 'himitsu@example.test';
await addMember(OWNER, '大久保 俊輝', { staff: { role: 'owner', title: '代表', subtitle: '教育学者' } });
await addMember(SECR, '事務局', { staff: { role: 'secretariat', title: '事務局' } });
await addMember(SASAKI, '佐々木', { profile: { prefecture: '千葉県', facilityLabel: '学習塾・フリースクール併設', listVisibility: 'public' }, since: Date.now() - 70 * 86400e3 });
await addMember(NAKAMURA, '中村', { profile: { prefecture: '大阪府', facilityLabel: '音楽教室', listVisibility: 'public' }, since: Date.now() - 150 * 86400e3 });
await addMember(HIMITSU, 'ひみつ希望', { profile: { prefecture: '福島県', facilityLabel: '公立中学校 教諭', listVisibility: 'anonymous' } });
await Salon.setStaff(ADMIN.email, { role: 'secretariat', title: '事務局', addedBy: 'seed', addedAt: Date.now() }); // 管理画面のテスト用

const errors = [];
async function newCtx({ width = 1280, height = 900, name = 'x' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'ja-JP' });
  await ctx.route('https://meet.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>meet</title>fake meet' }));
  await ctx.route('https://media.example.test/**', (r) => r.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.alloc(16) }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  ctx.setDefaultTimeout(12000);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|ERR_ABORTED|media/.test(m.text())) errors.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror ${e.message}`));
  page.on('dialog', (d) => d.accept());
  return { ctx, page };
}
async function login(page, email, { next = null } = {}) {
  await page.goto(base + '/salon/tomoshibi/login/' + (next ? '?next=' + encodeURIComponent(next) : ''));
  await page.fill('#uid', email); await page.fill('#pw', MEMBER_PASSWORD);
  await page.click('#go', { force: true });
  await page.waitForURL('**/salon/tomoshibi/**', { timeout: 10000 });
  await page.waitForSelector('#meName:not(:empty)', { timeout: 10000 });
}
const adminCookie = async () => { const r = await realFetch(base + '/api/admin?action=login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }) }); return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '); };
const aCall = async (cookie, action, body, query) => { const r = await realFetch(`${base}/api/admin?action=${action}${query || ''}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const W = (n) => new Promise((r) => setTimeout(r, n));

/* ═════════ 1. 紹介ページ（LP） ═════════ */
console.log('■ 1. 紹介ページ /salon/');
{
  const { ctx, page } = await newCtx({ name: 'lp' });
  const res = await page.goto(base + '/salon/');
  eq('/salon/ が開く（200）', res.status(), 200);
  const html = await page.content();
  check('noindex・OGP・canonical', /name="robots" content="noindex/.test(html) && /property="og:title"/.test(html) && /rel="canonical" href="https:\/\/antagaorana.com\/salon\/"/.test(html), null);
  eq('ヒーローの見出し（Word指定の文言）', (await page.locator('.hero h1').innerText()).replace(/\s+/g, ''), '居場所は、つくれた。そのあとが、わからない。');
  eq('セクション：ヘッダー・ヒーロー・WHY・CURRICULUM・TOMOSHIBI(TWO SALONS)・FAQ・フッター', await page.evaluate(() => [!!document.querySelector('.top'), !!document.querySelector('#hero'), [...document.querySelectorAll('.sec-label')].map((e) => e.textContent.trim())].flat().join(',')), 'true,true,WHY,CURRICULUM,ATTITUDE,TOMOSHIBI,CONTENTS,POSITION,A MONTH HERE,PRICE,FAQ');
  eq('心得十ヶ条が10項目並ぶ（Wordの正式な文言）', await page.locator('#curriculum').innerText().then((t) => ['時に「ひと呼吸」して待つ', '「責任は我にあり」と受け止める', 'なすべきことはなす誠実さと丁寧さ'].every((s) => t.includes(s))), true);
  check('縁は「準備中」で、リンクではない', (await page.locator('#en').innerText()).includes('準備') && (await page.locator('#en a').count()) === 0, null);
  check('料金（PRICE）は既定で非表示。ナビの「料金」も出ない', !(await page.locator('#price').isVisible()) && !(await page.locator('#nav-price').isVisible()), null);
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('[data-cta]')].map((a) => a.getAttribute('data-cta') + '→' + a.getAttribute('href')));
  check('CTA：参加は登録へ（どのCTAか分かる ?cta=）、ログインはログインへ。data-ctaで計測できる', hrefs.includes('hero-join→/salon/tomoshibi/register/?cta=hero') && hrefs.includes('closing-join→/salon/tomoshibi/register/?cta=closing') && hrefs.includes('header-login→/salon/tomoshibi/login/'), hrefs);
  await page.evaluate(() => { document.querySelector('[data-cta="hero-join"]').addEventListener('click', (e) => e.preventDefault()); });
  await page.click('[data-cta="hero-join"]');
  eq('CTAクリックが dataLayer に積まれる', await page.evaluate(() => (window.dataLayer || []).map((x) => x.cta)), ['hero-join']);
  check('FAQは折りたたみ（1問目のみ開いている）', await page.evaluate(() => { const d = [...document.querySelectorAll('#faq details')]; return d.length >= 3 && d[0].open && d.slice(1).every((x) => !x.open); }), null);
  check('テスト・Preview表記が出ない／別サイトのHAKUのリンクが無い', !/テスト環境|Preview|プレビュー|haku-community/i.test(html), null);
  eq('旧URL /tomoshibi → /salon/', await page.goto(base + '/tomoshibi').then(() => new URL(page.url()).pathname), '/salon/');
  eq('旧URL /tomoshibi-login → ログイン', await page.goto(base + '/tomoshibi-login.html').then(() => new URL(page.url()).pathname), '/salon/tomoshibi/login/');
  eq('旧URL /tomoshibi-register → 登録', await page.goto(base + '/tomoshibi-register').then(() => new URL(page.url()).pathname), '/salon/tomoshibi/register/');
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(base + '/salon/');
  eq('スマホ幅：横スクロールなし', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
  await shot(page, 'salon-01-lp-m.png', { fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(base + '/salon/'); await W(900);
  await shot(page, 'salon-01-lp-pc.png', { fullPage: false });
  await ctx.close();
}

/* ═════════ 2. 新規登録 → 管理画面に反映 → 承認 → ログイン ═════════ */
console.log('■ 2. 新規登録→申請一覧→承認→ログイン→サロン');
const NEWB = `newbie${Date.now()}@example.test`;
{
  const { ctx, page } = await newCtx({ name: 'reg' });
  await page.goto(base + '/salon/tomoshibi/register/?cta=hero');
  eq('登録ページ：都道府県・場の種類の任意項目がある', [await page.locator('#prefecture option').count() > 40, await page.locator('#facility').count()], [true, 1]);
  check('登録ページ：テスト環境の表示がない', !/テスト環境|Preview/.test(await page.innerText('body')), null);
  await page.click('#go', { force: true });
  eq('未入力は検査される', (await page.locator('#err').innerText()).length > 0, true);
  await page.fill('#fullname', '新人 太郎'); await page.fill('#fullnamekana', 'しんじん たろう'); await page.fill('#nickname', 'しんじん'); await page.selectOption('#prefecture', '千葉県'); await page.fill('#facility', '音楽教室');
  await page.fill('#email', NEWB); await page.fill('#password', MEMBER_PASSWORD); await page.fill('#password2', MEMBER_PASSWORD); await page.fill('#reason', '現場で学びたいです。'); await page.check('#terms');
  await page.click('#go', { force: true });
  await page.waitForSelector('#okmsg.show', { timeout: 10000 });
  check('申し込み完了のメッセージ', /お申し込みありがとうございます/.test(await page.locator('#okmsg').innerText()), null);
  const app = await store.getApplication('tomoshibi', NEWB);
  eq('申請が保存（審査中・都道府県・場の種類・CTA）', [app.status, app.prefecture, app.facilityLabel, app.source], ['pending', '千葉県', '音楽教室', 'hero']);
  // 承認前はログインできない
  await page.goto(base + '/salon/tomoshibi/login/');
  await page.fill('#uid', NEWB); await page.fill('#pw', MEMBER_PASSWORD); await page.click('#go', { force: true });
  await page.waitForFunction(() => document.getElementById('err').textContent.length > 0);
  check('審査中は「確認中です」と案内される', /確認中/.test(await page.locator('#err').innerText()), await page.locator('#err').innerText());
  // 管理画面（既存の申請管理）に灯の申請として反映 → 承認
  const ac = await adminCookie();
  const list = await aCall(ac, 'applications', null, '&community=tomoshibi&status=pending');
  check('既存の管理画面の「灯」申請一覧に反映される', list.body.applications.some((a) => a.email === NEWB), list.status);
  eq('承認できる', (await aCall(ac, 'approve', { community: 'tomoshibi', email: NEWB })).status, 200);
  await login(page, NEWB, { next: '/salon/tomoshibi/' });
  eq('承認後、ログインしてサロン画面に入れる', new URL(page.url()).pathname, '/salon/tomoshibi/');
  await ctx.close();
}

/* ═════════ 3. ログイン画面：モックアップの文言・エラー・元のURLへ戻る・ログアウト ═════════ */
console.log('■ 3. ログイン');
{
  const { ctx, page } = await newCtx({ name: 'login' });
  await page.goto(base + '/salon/tomoshibi/');
  eq('未ログインでサロンのURLを開くと、ログインへ転送される（元のURLを保持）', [new URL(page.url()).pathname, new URL(page.url()).searchParams.get('next')], ['/salon/tomoshibi/login/', '/salon/tomoshibi/']);
  eq('ログインのタイトル', await page.title(), 'ログイン｜教育者のサロン 灯｜あんたがおらな');
  check('「ログインしたままにする」は初期ON', await page.isChecked('#keep'), null);
  await page.click('#go', { force: true });
  eq('未入力：文言はモックアップのまま', await page.locator('#err').innerText(), 'メールアドレスとパスワードをご入力ください。');
  await page.fill('#uid', 'not-an-email'); await page.fill('#pw', 'x'); await page.click('#go', { force: true });
  eq('形式不正：文言はモックアップのまま', await page.locator('#err').innerText(), 'メールアドレスの形式をご確認ください。');
  await page.fill('#uid', SASAKI); await page.fill('#pw', 'wrong-password'); await page.click('#go', { force: true });
  await page.waitForFunction(() => document.getElementById('err').textContent.startsWith('メールアドレスまたは'));
  eq('認証失敗：どちらが違うかを示さない', await page.locator('#err').innerText(), 'メールアドレスまたはパスワードが違います。');
  check('「入力チェックだけでは通らない」：誤ったパスワードではサロンに入れない', new URL(page.url()).pathname === '/salon/tomoshibi/login/', page.url());
  const cs = (await ctx.cookies()).find((c) => c.name === 'ht_session');
  eq('失敗時にセッションCookieは作られない', cs, undefined);
  await page.goto(base + '/salon/tomoshibi/login/?next=https://evil.example/');
  await page.fill('#uid', SASAKI); await page.fill('#pw', MEMBER_PASSWORD); await page.click('#go', { force: true });
  await page.waitForURL('**/salon/tomoshibi/', { timeout: 10000 });
  eq('外部サイトへの next は無視され、サロンに入る', new URL(page.url()).origin + new URL(page.url()).pathname, base + '/salon/tomoshibi/');
  const ss = (await ctx.cookies()).find((c) => c.name === 'ht_session');
  check('Cookie：HttpOnly・Secure・SameSite=Lax・Path=/', Boolean(ss && ss.httpOnly && ss.secure && ss.sameSite === 'Lax' && ss.path === '/'), ss);
  await page.waitForSelector('#meName:not(:empty)');
  eq('ログイン中の表示名', await page.locator('#meName').innerText(), '佐々木 さん');
  await page.click('#logoutBtn'); await page.waitForURL('**/login/**');
  await page.goto(base + '/salon/tomoshibi/');
  eq('ログアウト後は、サロンに入れずログインへ', new URL(page.url()).pathname, '/salon/tomoshibi/login/');
  eq('ログアウト後はAPIも401', await page.evaluate(() => fetch('/api/salon?action=bootstrap', { credentials: 'same-origin' }).then((r) => r.status)), 401);
  // HAKU会員（灯の会員ではない）
  const haku = 'hakuonly@example.test';
  await store.saveUser({ email: haku, displayName: 'はく', fullName: 'はく', fullNameKana: 'はく', passwordHash: hash });
  await store.createApplication('haku', { email: haku, fullName: 'はく', fullNameKana: 'はく', displayName: 'はく', referrerName: 'x' }); await store.resolveApplication('haku', haku, 'paid', 'x'); await store.setMembership('haku', haku, { status: 'active' });
  await page.goto(base + '/salon/tomoshibi/login/'); await page.fill('#uid', haku); await page.fill('#pw', MEMBER_PASSWORD); await page.click('#go', { force: true });
  await page.waitForFunction(() => document.getElementById('err').textContent.length > 0);
  check('HAKU Communityの会員は、灯にログインできない（再登録のご案内）', /灯|有効化/.test(await page.locator('#err').innerText()) && (await page.locator('#err a').count()) === 1, await page.locator('#err').innerText());
  eq('同じCookieでもサロンのAPIは403', await page.evaluate(() => fetch('/api/salon?action=bootstrap', { credentials: 'same-origin' }).then((r) => r.status)), 401);
  await ctx.close();
}

/* ═════════ 4. 画面の忠実さ：モックアップ原本との見た目の比較 ═════════ */
console.log('■ 4. モックアップとの見た目の比較（同じ要素の実際のスタイル）');
let mockPage = null;
if (MOCK_DIR && fs.existsSync(path.join(MOCK_DIR, 'salon.html'))) {
  const ctxM = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' });
  await ctxM.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  mockPage = await ctxM.newPage();
  await mockPage.goto('file:///' + path.join(MOCK_DIR, 'salon.html').replace(/\\/g, '/'));
}
const PROPS = ['display', 'position', 'backgroundColor', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopColor', 'borderBottomColor', 'borderRadius', 'boxShadow', 'width', 'height', 'gap'];
const styleOf = (page, sel) => page.evaluate(([s, props]) => { const e = document.querySelector(s); if (!e) return null; const cs = getComputedStyle(e); const o = {}; props.forEach((p) => { o[p] = cs[p]; }); return o; }, [sel, PROPS]);
async function compareStyles(appPage, pairs, label) {
  for (const [mockSel, appSel, skip] of pairs) {
    const [m, a] = [await styleOf(mockPage, mockSel), await styleOf(appPage, appSel)];
    if (!m || !a) { check(`${label}: ${appSel} が存在する`, false, { mock: !!m, app: !!a }); continue; }
    const diffs = PROPS.filter((p) => !(skip || []).includes(p) && m[p] !== a[p]).map((p) => `${p}: モック=${m[p]} / 実装=${a[p]}`);
    check(`${label}: ${appSel} の見た目がモックアップと同じ`, diffs.length === 0, diffs);
  }
}

/* ═════════ 5. サロン画面：一般会員の操作 ═════════ */
console.log('■ 5. サロン画面（一般会員 佐々木・中村）');
const A = await newCtx({ name: 'sasaki' }); const B = await newCtx({ name: 'nakamura' });
await login(A.page, SASAKI); await login(B.page, NAKAMURA);
{
  const p = A.page;
  eq('チャンネルは7つ・並びと文言はモックアップのまま', await p.locator('.side a.ch').evaluateAll((els) => els.map((e) => e.firstChild.textContent.trim())), ['ホーム', '今月の一条', 'ケース検討', '運営の相談', '実践講義アーカイブ', 'お知らせ', 'メンバー一覧']);
  eq('上部バー：サロン名・検索・お知らせ・ユーザー名・ログアウト', [(await p.locator('.top .logo').innerText()).replace(/\s+/g, ''), await p.locator('#searchInput').getAttribute('placeholder'), (await p.locator('#bell').innerText()).trim(), await p.locator('#meName').innerText(), await p.locator('#logoutBtn').innerText()], ['教育者のサロン灯TOMOSHIBI', 'サロン内を検索', 'お知らせ', '佐々木 さん', 'ログアウト']);
  eq('投稿欄（閉じた状態）の文言はモックアップのまま', await p.locator('#composer .fake').innerText(), '現場で起きたことを書く（教室名は伏せられます）');
  check('空のチャンネル：「まだ投稿がありません」', /まだ投稿がありません/.test(await p.locator('#empty').innerText()), await p.locator('#empty').innerText());
  await p.click('#composerShut');
  check('入力欄が開く：匿名はOFF・教室名を伏せるは初期ON', !(await p.isChecked('#anon')) && (await p.isChecked('#hide')), null);
  eq('投稿先の選択肢は ケース検討・運営の相談・今月の一条（一般会員）', await p.locator('#pch option').allInnerTexts(), ['ケース検討', '運営の相談', '今月の一条']);
  eq('入力欄の注意書き（プレースホルダー）はモックアップのまま', await p.getAttribute('#ptext', 'placeholder'), 'いま関わっている子のこと、迷っていること、うまくいったこと。\n教室名・学校名・お子さんの名前は書かないでください。');
  // XSSの試験文字列と、普通の投稿
  await p.fill('#ptext', '<img src=x onerror="window.__xss=1"><script>window.__xss2=1</script> 開いて8ヶ月です。\n保護者から「何が変わりましたか」と聞かれました。');
  await p.selectOption('#pch', 'case'); await p.click('#composerSubmit');
  await p.waitForSelector('.post');
  eq('投稿が一覧の先頭に出る（本人の表示名・所属は伏せる）', (await p.locator('.post .who b').first().innerText()), '佐々木');
  check('XSS：投稿内の<img>・<script>は文字として表示され、実行されない', (await p.evaluate(() => window.__xss === undefined && window.__xss2 === undefined && !document.querySelector('.post .body img') && !document.querySelector('.post .body script'))) && /<img src=x/.test(await p.locator('.post .body').first().innerText()), null);
  await p.reload(); await p.waitForSelector('.post');
  eq('再読み込み後も投稿が残る（データベースに保存されている）', await p.locator('.post').count(), 1);
  // 匿名＋所属を見せる投稿
  await p.click('#composerShut'); await p.check('#anon'); await p.uncheck('#hide'); await p.selectOption('#pch', 'mgmt');
  await p.fill('#ptext', '月謝を上げたいのですが、言い出せません。'); await p.click('#composerSubmit');
  await p.waitForFunction(() => document.querySelectorAll('.post').length === 2);
  eq('匿名投稿の表示：名前「匿名」・アイコン「?」', [await p.locator('.post').first().locator('.who b').innerText(), await p.locator('.post').first().locator('.av').innerText()], ['匿名', '?']);
  // 別の会員（中村）から見える
  const q = B.page; await q.reload(); await q.waitForSelector('.post');
  const bHtml = await q.content();
  eq('他の会員からも2件が見える', await q.locator('.post').count(), 2);
  const anonHtml = await q.locator('#posts .post').first().innerHTML();
  check('匿名投稿：他の会員に返ったHTMLに、投稿者の名前・メール・所属が含まれない', !/佐々木|sasaki|学習塾|千葉県|本名/.test(anonHtml) && !bHtml.includes(SASAKI), anonHtml.slice(0, 200));
  const feedObj = await q.evaluate(() => fetch('/api/salon?action=feed&ch=home', { credentials: 'same-origin' }).then((r) => r.json()));
  const anonPost = feedObj.posts.find((x) => x.body.startsWith('月謝を上げたい'));
  check('APIレスポンス：匿名の投稿には、投稿者を特定できる情報（名前・所属・メール・ID・色分け）がない', JSON.stringify(anonPost.author) === JSON.stringify({ label: '匿名', initial: '?', av: 'p', badge: null }) && !/佐々木|sasaki|学習塾|authorEmail|"email"/.test(JSON.stringify(anonPost)), anonPost.author);
  // ありがとう／あとで読む／コメント／返信の返信
  await q.click('.post:nth-child(2) [data-act="react"]'); await q.waitForFunction(() => document.querySelectorAll('[data-act="react"].on').length === 1);
  eq('ありがとう：1になる（本人が押した状態）', await q.locator('.post:nth-child(2) [data-act="react"]').innerText(), 'ありがとう 1');
  await q.click('.post:nth-child(2) [data-act="save"]'); await q.waitForFunction(() => document.querySelector('.post:nth-child(2) [data-act="save"]').textContent === '保存しました');
  await q.click('.post:nth-child(2) [data-act="comments"]');
  await q.fill('.post:nth-child(2) .cmtbox input', '「様子を見ましょう」を使わないと決めてから、面談が変わりました。'); await q.press('.post:nth-child(2) .cmtbox input', 'Enter');
  await q.waitForSelector('.post:nth-child(2) .cmt');
  eq('コメントが表示される', await q.locator('.post:nth-child(2) .cmt .txt').first().innerText().then((t) => t.includes('様子を見ましょう')), true);
  await A.page.reload(); await A.page.waitForSelector('.post');
  eq('投稿者側にも、コメントとありがとうの数が反映される', [await A.page.locator('.post:nth-child(2) [data-act="react"]').innerText(), (await A.page.locator('.post:nth-child(2) [data-act="comments"]').innerText())], ['ありがとう 1', 'コメント 1']);
  await A.page.click('.post:nth-child(2) [data-act="comments"]'); await A.page.waitForSelector('.post:nth-child(2) .cmt');
  await A.page.click('.post:nth-child(2) .cmt [data-act="reply"]');
  await A.page.fill('.post:nth-child(2) .cmtbox input', 'ありがとうございます。使ってみます。'); await A.page.press('.post:nth-child(2) .cmtbox input', 'Enter');
  await A.page.waitForFunction(() => document.querySelectorAll('.post:nth-child(2) .cmt').length === 2);
  await A.page.click('.post:nth-child(2) .cmt.reply [data-act="reply"]');
  await A.page.fill('.post:nth-child(2) .cmtbox input', '返信への返信も書けます。'); await A.page.press('.post:nth-child(2) .cmtbox input', 'Enter');
  await A.page.waitForFunction(() => document.querySelectorAll('.post:nth-child(2) .cmt').length === 3);
  eq('返信の返信（深さ3）まで書ける。これ以上の返信ボタンは出ない', [await A.page.locator('.post:nth-child(2) .cmt.reply.d3').count(), await A.page.locator('.post:nth-child(2) .cmt.reply.d3 [data-act="reply"]').count()], [1, 0]);
  // 編集・削除（自分の投稿だけ）
  eq('自分の投稿には「編集」「削除」が出る。他人の投稿には出ない', [await A.page.locator('.post:nth-child(2) [data-act="edit"]').count(), await q.locator('.post:nth-child(2) [data-act="edit"]').count(), await q.locator('.post:nth-child(2) [data-act="delete"]').count()], [1, 0, 0]);
  await A.page.click('.post:nth-child(1) [data-act="edit"]'); await A.page.fill('.post:nth-child(1) .editbox textarea', '月謝を上げたいのですが、言い出せません。（編集しました）'); await A.page.click('.post:nth-child(1) [data-act="editsave"]');
  await A.page.waitForFunction(() => /編集しました/.test(document.querySelector('.post:nth-child(1) .body').textContent));
  check('編集：本文が更新され「編集済み」と出る', /編集済み/.test(await A.page.locator('.post:nth-child(1) .meta').innerText()), null);
  // 他の会員のAPI操作（IDOR）
  const idor = await q.evaluate(async () => { const f = await fetch('/api/salon?action=feed&ch=home', { credentials: 'same-origin' }).then((r) => r.json()); const id = f.posts[0].id; const del = await fetch('/api/salon?action=post-delete', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); const upd = await fetch('/api/salon?action=post-update', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, body: 'x' }) }); return [del.status, upd.status]; });
  eq('他人の投稿は、APIを直接叩いても削除・編集できない（403）', idor, [403, 403]);
  await shot(A.page, 'salon-05-home-sasaki.png');
}

/* ═════════ 6. 見た目の比較（実際の描画） ═════════ */
if (mockPage) {
  const p = B.page; await p.goto(base + '/salon/tomoshibi/#home'); await p.waitForSelector('.post');
  const skip = ['width', 'height'];
  await compareStyles(p, [
    ['.top', '.top', ['width']], ['.top .logo', '.top .logo'], ['.top .logo span', '.top .logo span'], ['.top .search input', '.top .search input'], ['.top .me', '.top .me', ['width']],
    ['.side', '.side', skip], ['.side .sname', '.side .sname', skip], ['.side .sname b', '.side .sname b'], ['.side .grp', '.side .grp', skip], ['.side a.ch', '.side a.ch', skip], ['.side a.ch.on', '.side a.ch.on', skip],
    ['.feed', '.feed', skip], ['.feedhead', '.feedhead', skip], ['.feedhead h2', '.feedhead h2', skip], ['.feedhead p', '.feedhead p', skip],
    ['.composer', '.composer', skip], ['.composer .shut .fake', '.composer .shut .fake', skip],
    ['.post', '.post', skip], ['.post .top-row .av', '.post .top-row .av', ['backgroundColor']], ['.who b', '.who b'], ['.who .badge', '.who .badge'], ['.who .meta', '.who .meta', ['width']],
    ['.post .body', '.post .body', skip], ['.post .body p', '.post .body p', skip], ['.acts', '.acts', skip], ['.acts button', '.acts button', ['width']],
    ['.rail', '.rail', skip], ['.rail h4', '.rail h4', skip], ['.rail .pin', '.rail .pin', skip], ['.rail .card', '.rail .card', skip],
  ], 'PC');
  eq('3カラム：左228px・右268px（モックアップと同じ）', await p.evaluate(() => [Math.round(document.querySelector('.side').getBoundingClientRect().width), Math.round(document.querySelector('.rail').getBoundingClientRect().width)]), await mockPage.evaluate(() => [Math.round(document.querySelector('.side').getBoundingClientRect().width), Math.round(document.querySelector('.rail').getBoundingClientRect().width)]));
  check('Wordのルール：影なし・角丸なし（円形のアイコンを除く）・グラデーションなし', await p.evaluate(() => { const bad = []; document.querySelectorAll('body *').forEach((e) => { const cs = getComputedStyle(e); const isCircle = cs.borderRadius === '50%' || e.classList.contains('dot') || e.tagName === 'I'; if (cs.boxShadow !== 'none' && !(e.matches('.side a.ch.on'))) bad.push(['shadow', e.className]); if (!isCircle && parseFloat(cs.borderTopLeftRadius) > 0) bad.push(['radius', e.className]); if (/gradient/.test(cs.backgroundImage)) bad.push(['gradient', e.className]); }); return bad.length === 0 ? true : bad.slice(0, 5); }), null);
  await mockPage.screenshot({ path: path.join(OUT, 'salon-mock-pc.png') }).catch(() => {});
  await shot(p, 'salon-06-app-pc.png');
}

/* ═════════ 7. 運営（代表・事務局）の操作 ═════════ */
console.log('■ 7. 運営の操作');
const O = await newCtx({ name: 'owner' });
await login(O.page, OWNER);
{
  const p = O.page;
  eq('運営の表示：代表のバッジ', await p.locator('#meName').innerText(), '大久保 俊輝 さん');
  await p.goto(base + '/salon/tomoshibi/#archive'); await p.waitForSelector('#composer:not([hidden])');
  const memberSeesComposer = await (async () => { await A.page.goto(base + '/salon/tomoshibi/#archive'); await W(500); return await A.page.locator('#composer').isVisible(); })();
  eq('一般会員（佐々木）には、アーカイブの投稿欄が出ない', memberSeesComposer, false);
  eq('運営の投稿先に、アーカイブ・お知らせが加わる', await p.locator('#pch option').allInnerTexts().then((t) => t.includes('実践講義アーカイブ') && t.includes('お知らせ')), true);
  await p.goto(base + '/salon/tomoshibi/#news'); await p.waitForSelector('#composer:not([hidden])');
  await p.click('#composerShut'); await p.selectOption('#pch', 'news'); await p.fill('#ptext', '今月の実践講義の日程です。カメラオフ・発言なしでの参加を歓迎します。'); await p.click('#composerSubmit');
  await p.waitForSelector('.post');
  eq('運営の投稿：名前の横に「代表」バッジ', await p.locator('.post .who .badge').first().innerText(), '代表');
  // 運営の返信 → 投稿者にメール
  const sent = []; const orig = hooks.replyMail; hooks.replyMail = async (m) => { sent.push(m); return { ok: true }; };
  await p.goto(base + '/salon/tomoshibi/#case'); await p.waitForSelector('.post');
  await p.click('.post [data-act="comments"]'); await p.fill('.post .cmtbox input', '学習を入れるかどうかの前に、記録を始めてください。'); await p.press('.post .cmtbox input', 'Enter');
  await p.waitForSelector('.post .cmt .badge');
  hooks.replyMail = orig;
  eq('運営の返信：投稿者（佐々木）にメール通知の処理が呼ばれ、本文は含まれない', [sent.length, sent[0] && sent[0].email, JSON.stringify(sent).includes('記録を始めて')], [1, SASAKI, false]);
  // ピン留め・他人の投稿の削除
  await p.click('.post [data-act="pin"]'); await p.waitForFunction(() => /ピン留めを外す/.test((document.querySelector('.post [data-act="pin"]') || {}).textContent));
  await p.reload();
  try { await p.waitForSelector('.post'); } catch (e) { console.log('DEBUG url=', p.url(), '| body=', (await p.innerText('body')).slice(0, 400).split(String.fromCharCode(10)).join(' / ')); throw e; }
  eq('ピン留めされた投稿に「ピン留め」の表示。右カラムにも出る', [await p.locator('.post .badge.pin').count(), (await p.locator('#railPin').innerText()).includes('運営からのご案内')], [1, true]);
  eq('運営には、他人の投稿の削除ボタンが出る', await p.locator('.post [data-act="delete"]').count() >= 1, true);
  await p.goto(base + '/salon/tomoshibi/#mgmt'); await p.waitForSelector('.post');
  const before = await p.locator('.post').count();
  await p.click('.post [data-act="delete"]'); await p.waitForFunction((n) => document.querySelectorAll('.post').length === n - 1 || !document.querySelector('.post'), before);
  check('運営が他人の投稿を削除できる（監査ログに残る）', (await store.listAuditLog(30)).some((e) => e.action === 'salon_post_deleted_by_staff'), null);
}

/* ═════════ 8. 講義・イベント・今月の一条（運営が登録→会員が操作） ═════════ */
console.log('■ 8. 実践講義・イベント・今月の一条');
{
  const ac = await adminCookie();
  const creed = await aCall(ac, 'salon-creed-set', { n: 6, reading: '待っている期間に、保護者へ何を伝えるか' });
  eq('管理画面：今月の一条を設定', creed.status, 200);
  const starts = Date.now() + 6 * 86400e3;
  const ev = (await aCall(ac, 'salon-event-create', { title: '実践講義｜第六条', summary: '待っている期間の報告の仕方', startsAt: starts, endsAt: starts + 5400e3, url: 'https://meet.google.com/aaa-bbbb-ccc', announce: true, announceBody: '今月の実践講義の日程です。' })).body.event;
  const lec = await aCall(ac, 'salon-lecture-create', { title: '特性を「直す」のではなく「活かす」見立て方', description: '先月（第五条・決めつけない）のアーカイブを公開しました。', heldAt: Date.now() - 30 * 86400e3, minutes: 52, creedTag: 5, note: '記録シートひな形つき', videoUrl: 'https://media.example.test/lectures/5.mp4' });
  eq('管理画面：イベントと講義動画を登録', [ev.id.length > 5, lec.status], [true, 200]);
  const p = A.page; await p.goto(base + '/salon/tomoshibi/#home'); await p.reload(); await p.waitForSelector('.post');
  eq('右カラム：今月の一条', [await p.locator('#railCreed small').first().innerText(), await p.locator('#railCreed b').innerText()], ['第六条', '時に「ひと呼吸」して待つ']);
  check('ホームの説明：メンバー数と今月のテーマ', /^メンバー \d+名 ／ \d+月のテーマ：第六条「時に『ひと呼吸』して待つ」$/.test(await p.locator('#chDesc').innerText()), await p.locator('#chDesc').innerText());
  check('右カラム：今月の予定にイベント', (await p.locator('#railEvents').innerText()).includes('実践講義｜第六条'), null);
  await p.goto(base + '/salon/tomoshibi/#news'); await p.waitForSelector('.attach');
  eq('お知らせのイベント添付：日付・題名・参加するボタン（モックアップのまま）', [await p.locator('.attach .ic').first().innerText() !== '', await p.locator('.attach b').first().innerText(), await p.locator('.attach .go').first().innerText()], [true, '実践講義｜第六条', '参加する']);
  check('一覧に開催URLが出ていない', !(await p.content()).includes('aaa-bbbb-ccc'), null);
  await p.click('.attach [data-act="eventjoin"]'); await p.waitForSelector('.attach [data-act="eventurl"]');
  eq('参加すると「開催URLを開く」「取り消す」になる', [await p.locator('.attach [data-act="eventurl"]').innerText(), await p.locator('.attach [data-act="eventleave"]').innerText()], ['開催URLを開く', '取り消す']);
  const [pop] = await Promise.all([A.ctx.waitForEvent('page'), p.click('.attach [data-act="eventurl"]')]);
  await pop.waitForURL(/meet\.google\.com/, { timeout: 8000 }).catch(() => {});
  check('開催URLは参加予定の会員だけが開ける（Meetへ移動）', /meet\.google\.com\/aaa-bbbb-ccc/.test(pop.url()), pop.url()); await pop.close();
  const urlForOther = await B.page.evaluate((id) => fetch('/api/salon?action=event-url&id=' + id, { credentials: 'same-origin' }).then((r) => r.status), ev.id);
  eq('未参加の会員は開催URLを取得できない（403）', urlForOther, 403);
  await p.click('.attach [data-act="eventleave"]'); await p.waitForSelector('.attach [data-act="eventjoin"]');
  eq('取り消すと「参加する」に戻る', await p.locator('.attach [data-act="eventjoin"]').count(), 1);
  // アーカイブ
  await p.goto(base + '/salon/tomoshibi/#archive'); await p.waitForSelector('.attach');
  eq('講義アーカイブ：動画の添付（題名・分・視聴・メモ・視聴するボタン）', [await p.locator('.attach .ic').innerText(), await p.locator('.attach b').innerText(), await p.locator('.attach small').innerText(), await p.locator('.attach .go').innerText()], ['動画', '特性を「直す」のではなく「活かす」見立て方', '52分 ／ 視聴 0名 ／ 記録シートひな形つき', '視聴する']);
  check('一覧のHTMLに動画のURLが含まれない', !(await p.content()).includes('media.example.test'), null);
  await p.evaluate(() => { new MutationObserver(() => { const v = document.querySelector('#vBody video'); if (v) window.__vsrc = v.getAttribute('src'); }).observe(document.getElementById('vBody'), { childList: true, subtree: true }); }); // テスト用の動画は中身が空なので、再生エラーで消える前にURLを記録する
  await p.click('.attach [data-act="play"]'); await p.waitForFunction(() => window.__vsrc);
  eq('「視聴する」で動画プレーヤーが開く（会員だけがURLを受け取る）', await p.evaluate(() => window.__vsrc), 'https://media.example.test/lectures/5.mp4');
  await p.click('#vClose'); eq('閉じると動画が止まり、消える', await p.locator('#vBody video').count(), 0);
  const anonPlay = await (await newCtx({ name: 'anon' })).page.goto(base + '/api/salon?action=lecture-play&id=' + lec.body.lecture.id).then((r) => r.status());
  eq('未ログインは動画のURLを取得できない（401）', anonPlay, 401);
  await shot(p, 'salon-08-archive.png');
}

/* ═════════ 9. メンバー一覧・検索・設定・ご利用ガイド・退会 ═════════ */
console.log('■ 9. メンバー一覧・検索・設定・ガイド・退会');
{
  const p = A.page; await p.goto(base + '/salon/tomoshibi/#members'); await p.waitForSelector('.mrow');
  const rows = await p.locator('.mrow').evaluateAll((els) => els.map((e) => [e.querySelector('b').textContent, e.querySelector('small').textContent, e.querySelector('.since').textContent]));
  check('メンバー一覧：運営・一般・匿名希望の表示（モックアップの形式）', rows.some((r) => r[0] === '大久保 俊輝' && r[1] === '代表 ／ 教育学者' && r[2] === '開設より') && rows.some((r) => r[0] === '佐々木 さん' && r[1] === '千葉県 ／ 学習塾・フリースクール併設' && r[2] === '2ヶ月') && rows.some((r) => r[0] === '匿名希望' && r[1] === '非公開 ／ 公立中学校 教諭'), rows);
  const html = await p.content();
  check('一覧にメールアドレス・本名・匿名希望の本名が出ない', !/@example\.test|本名|ひみつ希望/.test(await p.locator('#membersPanel').innerHTML()), null);
  eq('説明文：公開は都道府県と場の種類のみ', /公開しています/.test(await p.locator('#membersPanel p').first().innerText()), true);
  // 検索
  await p.fill('#searchInput', '記録'); await p.press('#searchInput', 'Enter');
  await p.waitForSelector('.post');
  check('検索：本文・コメントに一致する投稿が出る（コメントの一致も表示）', (await p.locator('#chTitle').innerText()) === '検索結果' && await p.locator('.post').count() >= 1, null);
  await p.fill('#searchInput', '存在しない言葉ＺＺＺ'); await p.press('#searchInput', 'Enter');
  await p.waitForFunction(() => /見つかりませんでした/.test(document.getElementById('empty').textContent));
  check('検索：該当なしの表示', true, null);
  // 設定
  await p.goto(base + '/salon/tomoshibi/#settings'); await p.waitForSelector('#profileForm');
  await p.fill('#pfName', '佐々木先生'); await p.selectOption('#pfPref', '東京都'); await p.fill('#pfFac', '学習塾'); await p.check('input[name="pfVis"][value="anonymous"]'); await p.click('#profileForm button[type="submit"]');
  await p.waitForFunction(() => document.getElementById('pfSaved').textContent === '保存しました');
  eq('設定：プロフィール保存。上部バーの表示名が変わる', await p.locator('#meName').innerText(), '佐々木先生 さん');
  await p.uncheck('#ntReply'); await W(400);
  eq('設定：通知（返信メール）をOFFにできる', (await Salon.getProfile(SASAKI)).notify.reply, false);
  await p.fill('#pwCur', 'wrong'); await p.fill('#pwNew', 'new-password-123'); await p.fill('#pwNew2', 'new-password-123'); await p.click('#pwForm button[type="submit"]');
  await p.waitForFunction(() => document.getElementById('pwErr').textContent.length > 0);
  eq('設定：現在のパスワードが違うと変更できない', await p.locator('#pwErr').innerText(), '現在のパスワードが違います。');
  await p.fill('#pwCur', MEMBER_PASSWORD); await p.click('#pwForm button[type="submit"]'); await p.waitForFunction(() => document.getElementById('pwSaved').textContent === '変更しました');
  eq('設定：パスワードを変更できる', await p.locator('#pwSaved').innerText(), '変更しました');
  await p.click('[data-act="loadbm"]'); await p.waitForFunction(() => document.getElementById('bmBox').textContent.length > 0);
  check('設定：所属サロンと会員の状態の表示', /教育者のサロン 灯/.test(await p.locator('.kv').innerText()) && /有効/.test(await p.locator('.kv').innerText()), null);
  // ご利用ガイド・退会について
  await p.goto(base + '/salon/tomoshibi/#guide'); await p.waitForSelector('#guidePanel h3');
  const g = await p.locator('#guidePanel').innerText();
  check('ご利用ガイド：投稿方法・匿名/教室名・コメント/リアクション・アーカイブ・問い合わせ・基本ルール', ['投稿のしかた', '匿名で投稿する／教室名を伏せる', 'コメント・ありがとう', '実践講義アーカイブの見方', '運営への問い合わせ', '会員として守っていただきたいこと'].every((t) => g.includes(t)), null);
  check('ご利用ガイド：匿名性を保証する表現がない（匿名の範囲は未決定と明記）', /保証するものではありません/.test(g) && !/完全に匿名|絶対に|必ず匿名/.test(g), null);
  await p.goto(base + '/salon/tomoshibi/#withdraw'); await p.waitForSelector('#withdrawBtn');
  check('退会について：未確定の規定を確定事項として書かない（案内と退会ボタン）', /正式に決まり次第/.test(await p.locator('#withdrawPanel').innerText()), null);
  eq('お知らせ（ベル）→ お知らせのチャンネルへ', await p.click('#bell').then(() => W(300)).then(() => new URL(p.url()).hash), '#news');
  await shot(p, 'salon-09-settings.png');
  // 退会する会員（別の会員）
  const gone = 'leaver@example.test'; await addMember(gone, 'やめる人');
  const L = await newCtx({ name: 'leaver' }); await login(L.page, gone);
  await L.page.goto(base + '/salon/tomoshibi/#withdraw'); await L.page.waitForSelector('#withdrawBtn'); await L.page.click('#withdrawBtn');
  await L.page.waitForURL('**/salon/', { timeout: 10000 });
  eq('退会：会員資格が無効になり、紹介ページへ', [new URL(L.page.url()).pathname, (await store.getMembership('tomoshibi', gone)).status], ['/salon/', 'inactive']);
  eq('退会後はサロンの画面・APIに入れない', [await L.page.goto(base + '/salon/tomoshibi/').then(() => new URL(L.page.url()).pathname), await L.page.evaluate(() => fetch('/api/salon?action=bootstrap', { credentials: 'same-origin' }).then((r) => r.status))], ['/salon/tomoshibi/login/', 401]);
  await L.ctx.close();
}

/* ═════════ 10. スマホ幅（390px） ═════════ */
console.log('■ 10. スマホ幅 390px');
{
  const M = await newCtx({ width: 390, height: 844, name: 'mobile' }); await login(M.page, NAKAMURA);
  const p = M.page; await p.waitForSelector('.post');
  const overflow = () => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  eq('ホーム：横スクロールなし（1カラムに縦積み）', await overflow(), false);
  check('チャンネルは横スクロールの1行（モックアップのスマホ表示）', await p.evaluate(() => { const n = document.querySelector('.side .nav'); const cs = getComputedStyle(n); return cs.display === 'flex' && cs.overflowX !== 'visible' && document.querySelector('.app').getBoundingClientRect().width <= 391; }), null);
  check('検索欄はスマホでは隠れる（モックアップのまま）', !(await p.locator('.top .search').isVisible()), null);
  await shot(p, 'salon-10-mobile-home.png', { fullPage: true });
  for (const h of ['members', 'settings', 'guide', 'withdraw', 'archive', 'news']) { await p.goto(base + '/salon/tomoshibi/#' + h); await W(500); eq(`#${h}：横スクロールなし`, await overflow(), false); }
  await p.goto(base + '/salon/tomoshibi/#settings'); await W(500); await shot(p, 'salon-10-mobile-settings.png', { fullPage: true });
  await M.ctx.close();
}

/* ═════════ 11. 管理画面の「灯 サロン運営」タブ ═════════ */
console.log('■ 11. 管理画面（灯 サロン運営）');
{
  const A = await newCtx({ name: 'admin-ui' }); const p = A.page;
  await p.goto(base + '/haku-community/admin/');
  await p.fill('#adminemail', ADMIN.email); await p.fill('#adminpw', ADMIN.password);
  await p.click('#loginbtn'); await p.waitForSelector('#adminPanel', { state: 'visible' });
  await p.click('[data-mode="salon"]'); await p.waitForSelector('#salonBody .app, #salonBody .empty');
  check('運営ロール：登録済みの代表・事務局が一覧に出る', (await p.locator('#salonBody').innerText()).includes(OWNER) && (await p.locator('#salonBody').innerText()).includes(SECR), null);
  check('運営ロール：最高管理者には登録フォームが出る', await p.locator('#stGo').count() === 1, null);
  await p.fill('#stEmail', 'newstaff@example.test'); await p.selectOption('#stRole', 'secretariat'); await p.click('#stGo');
  await p.waitForFunction(() => document.getElementById('salonBody').innerText.includes('newstaff@example.test'));
  eq('運営ロール：UIから登録でき、サーバーに保存される', (await Salon.getStaff('newstaff@example.test'))?.role, 'secretariat');

  await p.click('#salonSub [data-sub="creed"]'); await p.waitForSelector('#crGo');
  await p.selectOption('#crN', '7'); await p.fill('#crR', '後継を自分以上に育てる読み方'); await p.click('#crGo');
  await p.waitForFunction(() => document.getElementById('salonBody').innerText.includes('第七条'));
  eq('今月の一条：UIから設定できる', (await Salon.getCreed())?.n, 7);

  await p.click('#salonSub [data-sub="events"]'); await p.waitForSelector('#nwGo');
  await p.fill('#nwB', '管理画面からのお知らせです。'); await p.click('#nwGo');
  await p.waitForFunction(() => document.getElementById('salonMsg').innerText.includes('投稿しました'));
  await p.fill('#evT2', '管理画面のテスト会'); await p.fill('#evS2', '2099-01-15T20:00'); await p.fill('#evC2', '5'); await p.click('#evGo2');
  await p.waitForFunction(() => document.getElementById('salonBody').innerText.includes('管理画面のテスト会'));
  eq('お知らせ・イベント：UIから作成できる', (await Salon.listEvents({ limit: 50 })).some((e) => e.title === '管理画面のテスト会'), true);

  await p.click('#salonSub [data-sub="lectures"]'); await p.waitForSelector('#lcGo');
  await p.fill('#lcT', '管理画面の講義'); await p.fill('#lcD', '2099-01-10'); await p.fill('#lcU', 'https://media.example.test/lec.mp4'); await p.click('#lcGo');
  await p.waitForFunction(() => document.getElementById('salonBody').innerText.includes('管理画面の講義'));
  check('講義：UIから登録でき、動画URLは管理一覧の画面に出ない', !(await p.locator('#salonBody').innerText()).includes('lec.mp4'), null);
  await p.fill('#lcT', 'ng'); await p.fill('#lcU', 'http://insecure.example.test/x.mp4'); await p.fill('#lcD', '2099-01-11'); await p.click('#lcGo');
  await p.waitForFunction(() => document.getElementById('salonMsg').innerText.includes('https://'));
  check('講義：https以外のURLはエラーで登録されない', !(await Salon.listLectures()).some((l) => l.title === 'ng'), null);

  await p.click('#salonSub [data-sub="posts"]'); await p.waitForSelector('#slPosts');
  await p.click('#salonBody [data-ch="news"]'); await p.waitForSelector('#slPosts .post');
  const n0 = await p.locator('#slPosts .post').count();
  await p.locator('#slPosts .post [data-del]').first().click();
  await p.waitForFunction((n) => document.querySelectorAll('#slPosts .post').length < n || document.querySelector('#slPosts .empty'), n0);
  check('投稿・コメント：UIから削除できる', (await p.locator('#slPosts .post').count()) < n0, null);

  await p.click('#salonBody [data-ch="mgmt"]'); await p.waitForSelector('#slPosts');
  const anon = (await p.locator('#slPosts').innerText());
  check('投稿管理でも、匿名投稿の投稿者名・メールは出ない', !anon.includes(NAKAMURA) && !anon.includes('中村'), anon.slice(0, 200));

  await p.click('#salonSub [data-sub="members"]'); await p.waitForSelector('#salonBody .app');
  check('会員：申請状況の一覧が出る', (await p.locator('#salonBody').innerText()).includes(SASAKI), null);
  await p.click('#salonSub [data-sub="audit"]'); await p.waitForFunction(() => document.querySelectorAll('#salonBody .audit').length > 0);
  check('操作履歴：灯の操作が記録されている', (await p.locator('#salonBody .audit').count()) > 0, null);
  await shot(p, 'salon-11-admin.png', { fullPage: true });
  await A.ctx.close();

  // 灯の運営ロールがない管理者は、管理画面から灯の内容を見られない（サーバー側で拒否）
  await Salon.setStaff(ADMIN.email, null);
  const ac2 = await adminCookie();
  eq('運営ロールのない管理者は、灯の投稿一覧をAPIで取得できない（403）', (await aCall(ac2, 'salon-posts', undefined, '&ch=home')).status, 403);
  await Salon.setStaff(ADMIN.email, { role: 'secretariat', title: '事務局', addedBy: 'seed', addedAt: Date.now() });
}

eq('画面のJavaScriptエラー・予期しないエラーなし', errors, []);
console.log(`\n結果: 成功 ${pass} / 失敗 ${fail}`);
if (fail) console.log('失敗:\n' + failures.join('\n'));
await browser.close(); server.close();
process.exit(fail ? 1 : 0);

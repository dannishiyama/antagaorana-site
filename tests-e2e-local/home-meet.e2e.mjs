// HOMEの並び（ことば → 予定）／カレンダーの参加者アイコン／Google Meet（偽のGoogleで）／マイページの記録／HAKUポイントの活用イメージ
// 本物の画面 × 本物のAPI × メモリ上のRedis。Googleへの通信は偽物（本物のGoogleには接続しない）。
// 実行：node tests-e2e-local/home-meet.e2e.mjs（README参照）
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const REPO_URL = new URL('../', import.meta.url);
const REPO = fileURLToPath(REPO_URL);
const require = createRequire(REPO + 'package.json');
const { chromium } = require('playwright-core');
const { start, seed, store, MEMBER_PASSWORD } = await import('./e2e-server.mjs');
const { __setFetchForTests } = await import(new URL('api/_lib/google-meet.js', REPO_URL).href);
const { legacyMeetUrl } = await import(new URL('api/_lib/morning-meet.js', REPO_URL).href);
await seed();
const { server, base } = await start();
const OUT = process.env.OUT_DIR || os.tmpdir();
const browser = await chromium.launch();

let pass = 0, fail = 0; const failures = [];
function check(name, ok, detail) { if (ok) { pass++; console.log('  ✔', name); } else { fail++; failures.push(name + ' :: ' + JSON.stringify(detail)); console.log('  ✖', name, JSON.stringify(detail)); } }
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });

// ── 偽のGoogle ──
const google = { spaces: 0, fail: false };
__setFetchForTests(async (url) => {
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  if (String(url).includes('oauth2.googleapis.com')) return json(200, { access_token: 'fake' });
  if (String(url) === 'https://meet.googleapis.com/v2/spaces') {
    google.spaces++;
    if (google.fail) return json(503, {});
    const code = `abc${google.spaces}-defg-hij`;
    return json(200, { name: `spaces/${google.spaces}`, meetingUri: `https://meet.google.com/${code}`, meetingCode: code });
  }
  return json(404, {});
});
function googleOn(on) { for (const k of ['GOOGLE_MEET_CLIENT_ID', 'GOOGLE_MEET_CLIENT_SECRET', 'GOOGLE_MEET_REFRESH_TOKEN']) { if (on) process.env[k] = 'x'; else delete process.env[k]; } }

// 画像の保存だけが目的の処理。PCのメモリが足りないときに撮影に失敗しても、検証そのものは止めない。
async function shot(page, opts) { try { await page.screenshot(opts); } catch (e) { /* 撮影の失敗は無視 */ } }
const errors = [];
async function login(email, { width = 1280, height = 900, name } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'ja-JP' });
  await ctx.route('https://meet.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>meet</title>fake meet' }));
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(m.text())) errors.push(`[${name || email}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name || email}] pageerror ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(base + '/haku-community/login/');
  await page.fill('input[type=email]', email); await page.fill('input[type=password]', MEMBER_PASSWORD);
  await page.click('#go', { force: true }); await page.waitForURL('**/haku-community/home/**', { timeout: 8000 });
  await page.waitForSelector('.page.active h1');
  return { ctx, page };
}
const A = 'nishiyama.taro@example.com', B = 'Hanako.Nishiyama@Example.com';
const JST = (n = 0) => new Date(Date.now() + 9 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const D1 = JST(3), D2 = JST(4), D3 = JST(5); // 参加申請の締切（前々日23:59:59.999まで）に間に合う日
const cell = (page, date) => page.locator(`.mo-cell[data-date="${date}"]`);

// 参加申請の締切（開催日の前々日23:59:59.999まで）があるので、テストで参加する日は「今日の3日後〜」を使う。月をまたぐ日は、カレンダーを次の月へ送って選ぶ。
async function gotoMonth(page, date) {
  for (let i = 0; i < 4; i++) {
    const label = await page.locator('.mo-month').innerText();
    const [y, m] = date.split('-');
    if (label === `${Number(y)}年${Number(m)}月`) return;
    await page.click('[data-act="mo-next"]');
    await page.waitForFunction((l) => document.querySelector('.mo-month') && document.querySelector('.mo-month').textContent !== l, label);
    await page.waitForSelector('.mo-grid');
  }
}
async function openMorning(page, date = D1) { await page.goto(base + '/haku-community/home/#morning'); await page.reload(); await page.waitForSelector('.mo-grid'); await gotoMonth(page, date); }
async function pick(page, date) { await gotoMonth(page, date); await cell(page, date).click(); await page.waitForFunction((d) => document.querySelector(`.mo-cell[data-date="${d}"]`).getAttribute('aria-pressed') === 'true', date); }
const detail = (page) => page.locator('#moDetail').innerText();
async function clickPopup(page, sel) { // クリックの前から「新しいタブが開く」のを待つ
  const [popup] = await Promise.all([page.context().waitForEvent('page', { timeout: 8000 }), page.locator(sel).first().click()]);
  await popup.waitForURL(/meet\.google\.com/, { timeout: 8000 }).catch(() => {}); // APIの返事のあとにMeetへ移動する
  return popup;
}
const q_get = (page, d) => page.evaluate(async (date) => { const r = await fetch('/api/community-auth?action=morning-meet&date=' + date, { credentials: 'same-origin' }); return { status: r.status, body: await r.json() }; }, d);
const box = (page, sel) => page.locator(sel).first().boundingBox();

console.log('■ A. HOME：冒頭 → ことば → 予定（朝の集まり・直近の予定）。PC');
const a = await login(A, { name: 'タロウ' });
{
  const p = a.page;
  await p.waitForFunction(() => !document.querySelector('#p-home .pulse'));
  const order = await p.evaluate(() => ['#greetTxt', '#homeStep', '#homeWordsGroup', '#h-words', '#h-question', '#homePlanGroup', '#h-next'].map((s) => document.querySelector(s).getBoundingClientRect().top));
  check('表示の順：挨拶 → 今日の一歩 → ことば → 今週の問い → 予定', order.every((v, i) => i === 0 || v >= order[i - 1]), order);
  eq('冒頭の挨拶・今日の一歩は維持', [await p.locator('#homeStep .step-kicker').innerText(), /さん/.test(await p.locator('#greetTxt').innerText())], ['今日の一歩', true]);
  eq('「ことば」ブロックの中身（HAKUからのことば・会員のことば・もっと読む）が維持', await p.locator('#homeWordsGroup .sub-title').allInnerTexts(), ['HAKUからのことば', '会員のことば']);
  check('「ことば」のグループに「今週の問い」も含まれる（既存の見出しのまま）', /今週の問い/.test(await p.locator('#homeWordsGroup').innerText()), null);
  eq('予定のまとまり：朝の集まり → 次回の集まり が同じ1つのグループに隣接', await p.locator('#homePlanGroup .sub-title').allInnerTexts(), ['朝の集まり', '次回の集まり']);
  eq('予定のグループの見出し「直近の予定」', await p.locator('#homePlanGroup .block-title').innerText(), '直近の予定');
  check('2つのグループは背景・枠のあるカード（淡白にしていない）', await p.evaluate(() => ['#homeWordsGroup', '#homePlanGroup'].every((s) => { const st = getComputedStyle(document.querySelector(s)); return st.borderTopWidth === '1px' && st.backgroundColor !== 'rgba(0, 0, 0, 0)' && parseFloat(st.borderTopLeftRadius) >= 10; })), null);
  const w = await box(p, '#homeWordsGroup'), pl = await box(p, '#homePlanGroup');
  check('ことばのグループが、予定のグループより上（PC）', w.y + w.height <= pl.y + 1, { w, pl });
  await shot(p, { path: path.join(OUT, 'r3-01-home-pc.png'), fullPage: true });
}

console.log('■ B. カレンダー：人数テキストなし・参加者アイコンが日付枠内に増える・多いときは「＋n」');
const b = await login(B, { name: 'ハナ' });
{
  // 追加の会員（アイコン数の確認用）。JiroとMikuと、さらに3名を朝の集まりに入れる
  const extra = [];
  for (let i = 1; i <= 3; i++) { const email = `extra${i}@example.com`; await store.saveUser({ email, displayName: `追加${i}`, fullName: `追加${i}`, fullNameKana: 'ついか', passwordHash: 'x:y' }); await store.createApplication('haku', { email, fullName: `追加${i}`, fullNameKana: 'ついか', displayName: `追加${i}` }); await store.resolveApplication('haku', email, 'approved', 't'); await store.setMembership('haku', email, { status: 'active' }); extra.push(email); }
  await openMorning(a.page); await pick(a.page, D1);
  await a.page.click('#moDetail [data-act="mo-join"]'); await a.page.waitForSelector('#moDetail [data-act="mo-meet"]');
  const c1 = cell(a.page, D1);
  eq('1人参加 → アイコン1個・「人」の文字なし', [await c1.locator('.mo-avs .av').count(), /人/.test(await c1.innerText())], [1, false]);
  await openMorning(b.page); await pick(b.page, D1);
  await b.page.click('#moDetail [data-act="mo-join"]'); await b.page.waitForSelector('#moDetail [data-act="mo-meet"]');
  eq('2人参加 → アイコン2個', await cell(b.page, D1).locator('.mo-avs .av').count(), 2);
  await store.ensureMorningEvent(D1, 'x'); await store.joinEventAtomic(`morning-${D1}`, 'jiro.yamada@example.com', null);
  await openMorning(b.page);
  eq('3人参加 → アイコン3個（他会員の参加も共有される）', await cell(b.page, D1).locator('.mo-avs .av').count(), 3);
  const moreOf = () => cell(b.page, D1).locator('.mo-more').allInnerTexts();
  eq('3人までは「＋」なし', await moreOf(), []);
  await store.joinEventAtomic(`morning-${D1}`, 'MIKU.sato@example.com'.toLowerCase(), null);
  await openMorning(b.page);
  eq('4人 → アイコン4個（省略なし）', [await cell(b.page, D1).locator('.mo-avs .av').count(), await moreOf()], [4, []]);
  for (const e of extra) await store.joinEventAtomic(`morning-${D1}`, e, null);
  await openMorning(b.page);
  eq('7人 → アイコン3個＋「＋4」で省略', [await cell(b.page, D1).locator('.mo-avs .av').count(), await moreOf()], [3, ['＋4']]);
  check('「○人」のテキストがどの日付枠にもない', !(await b.page.locator('.mo-grid').innerText()).includes('人'), null);
  const geo = await b.page.evaluate((d) => { const c = document.querySelector(`.mo-cell[data-date="${d}"]`).getBoundingClientRect(); const items = [...document.querySelectorAll(`.mo-cell[data-date="${d}"] .mo-avs > *`)].map((e) => e.getBoundingClientRect()); return items.every((r) => r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.bottom <= c.bottom + 0.5); }, D1);
  check('アイコンは日付枠からはみ出さない（PC）', geo, null);
  await pick(b.page, D1);
  const dt = await detail(b.page);
  check('日付を選ぶと、参加者の一覧（表示名とアイコン）と「参加予定 7人」が出る', /参加予定 7人/.test(dt) && /ハナ/.test(dt) && /タロウ/.test(dt) && /ジロー/.test(dt) && /Miku/.test(dt) && (await b.page.locator('#moDetail .mo-person .av').count()) === 7, dt);
  await shot(b.page, { path: path.join(OUT, 'r3-02-calendar-pc.png') });
  // 取消でアイコンが減る
  await b.page.click('#moDetail [data-act="mo-leave"]'); await b.page.waitForSelector('#moDetail [data-act="mo-join"]');
  eq('Bが取消 → アイコン6個→「3個＋＋3」に更新', [await cell(b.page, D1).locator('.mo-avs .av').count(), await cell(b.page, D1).locator('.mo-more').allInnerTexts()], [3, ['＋3']]);
  await b.page.click('#moDetail [data-act="mo-join"]'); await b.page.waitForSelector('#moDetail [data-act="mo-meet"]');
  // 後続のMeet確認のため、追加メンバーを抜けておく
  for (const e of [...extra, 'jiro.yamada@example.com', 'miku.sato@example.com']) await store.leaveEvent(`morning-${D1}`, e);
}

console.log('■ C. Google Meet：未設定のとき（準備中・再試行。架空のURLは出さない）');
{
  googleOn(false); process.env.HAKU_LEGACY_MEET_URL = ''; // 暫定の共通Meetも無効にして「準備中」表示を確認する
  const p = a.page;
  await openMorning(p); await pick(p, D1);
  await p.click('#moDetail [data-act="mo-meet"]');
  await p.waitForFunction(() => document.querySelector('#moMeetMsg').innerText.length > 0);
  const msg = await p.locator('#moMeetMsg').innerText();
  check('未設定：「準備ができ次第こちらに表示します」＋もう一度試す。技術的な説明は出ない', /準備ができ次第/.test(msg) && /もう一度試す/.test(msg) && !/Google|API|環境変数|token|OAuth/i.test(msg), msg);
  eq('Googleへ作成要求をしていない', google.spaces, 0);
  eq('URLは保存されていない', await store.getMorningMeet(D1), null);
  check('ボタンは押せる状態に戻っている', await p.locator('#moDetail [data-act="mo-meet"]').first().isEnabled(), null);
  // 暫定：Google未設定のまま共通Meetを有効にすると、参加済みの会員は従来の共通Meetへ移動できる（別のURLは作らない）
  delete process.env.HAKU_LEGACY_MEET_URL;
  const legacyPopup = await clickPopup(p, '#moDetail [data-act="mo-meet"]');
  check('暫定：Google未設定の間は、共通Meetへ移動できる（Googleへは通信せず、新しい会議も作らない）', legacyPopup.url() === legacyMeetUrl() && google.spaces === 0, { spaces: google.spaces });
  await legacyPopup.close();
  const nbLegacy = await q_get(b.page, D2); // BはD2に参加していない
  check('暫定：参加していないBには共通Meetも返らない（403）', nbLegacy.status === 403 && !JSON.stringify(nbLegacy.body).includes('meet.google.com'), { status: nbLegacy.status });
}

console.log('■ D. Google Meet：設定済み（偽のGoogle）。開催日ごとに別URL・同日は同じURL・参加者だけ');
{
  googleOn(true); google.spaces = 0;
  const p = a.page, q = b.page;
  const popupA = await clickPopup(p, '#moDetail [data-act="mo-meet"]');
  const urlA = popupA.url();
  check('「朝の集まりに参加する」でMeetが新しいタブで開く', /^https:\/\/meet\.google\.com\/abc1-defg-hij$/.test(urlA), urlA);
  eq('Googleでの作成は1回', google.spaces, 1);
  await popupA.close();
  await openMorning(q); await pick(q, D1);
  const popupB = await clickPopup(q, '#moDetail [data-act="mo-meet"]');
  eq('同じ日のBも同じURL（作成は増えない）', [popupB.url(), google.spaces], [urlA, 1]);
  await popupB.close();
  // 別の日
  await openMorning(p); await pick(p, D2);
  check('未参加の日には「朝の集まりに参加する」が出ない（参加表明ボタンのみ）', (await p.locator('#moDetail [data-act="mo-meet"]').count()) === 0 && (await p.locator('#moDetail [data-act="mo-join"]').count()) === 1, null);
  await p.click('#moDetail [data-act="mo-join"]'); await p.waitForSelector('#moDetail [data-act="mo-meet"]');
  const popup2 = await clickPopup(p, '#moDetail [data-act="mo-meet"]');
  check('別の日は別のURL', popup2.url() !== urlA && /^https:\/\/meet\.google\.com\/abc2-/.test(popup2.url()), popup2.url());
  await popup2.close();
  // 保護（API）
  const get = (page, d) => page.evaluate(async (date) => { const r = await fetch('/api/community-auth?action=morning-meet&date=' + date, { credentials: 'same-origin' }); return { status: r.status, body: await r.json() }; }, d);
  const nb = await get(q, D2);
  check('Bは D2 に未参加 → APIから取得できない（403・URLなし）', nb.status === 403 && !JSON.stringify(nb.body).includes('meet.google.com'), nb);
  const anon = await browser.newContext(); const ap = await anon.newPage(); await ap.goto(base + '/haku-community/login/');
  const an = await get(ap, D1);
  check('未ログインは取得できない（401）', an.status === 401 && !JSON.stringify(an.body).includes('meet.google.com'), an);
  await anon.close();
  const html = await p.content();
  check('画面のHTML・データにMeetのURLが埋め込まれていない（ボタンを押すまで取得しない）', !html.includes('meet.google.com/abc'), null);
  // 取消した人は取れない
  await openMorning(q); await pick(q, D1); await q.click('#moDetail [data-act="mo-leave"]'); await q.waitForSelector('#moDetail [data-act="mo-join"]');
  const afterLeave = await get(q, D1);
  eq('参加を取り消したら、その日のURLは取得できない', afterLeave.status, 403);
  await shot(p, { path: path.join(OUT, 'r3-03-meet-detail.png') });
}

console.log('■ E. Google Meet：Google側の一時的な失敗（エラー表示と再試行）／過去・中止');
{
  googleOn(true); google.fail = true;
  const p = a.page;
  await openMorning(p); await pick(p, D3);
  await p.click('#moDetail [data-act="mo-join"]'); await p.waitForSelector('#moDetail [data-act="mo-meet"]');
  eq('Meetが作れなくても、参加表明は成功している', (await store.countEventParticipants(`morning-${D3}`)), 1);
  await p.locator('#moDetail [data-act="mo-meet"]').first().click();
  await p.waitForFunction(() => /準備ができませんでした/.test(document.querySelector('#moMeetMsg').innerText));
  check('エラー：「ミーティングの準備ができませんでした。」＋もう一度試す', /もう一度試す/.test(await p.locator('#moMeetMsg').innerText()), null);
  google.fail = false;
  const popup = await clickPopup(p, '#moMeetMsg [data-act="mo-meet"]');
  check('再試行で成功するとMeetが開く', /^https:\/\/meet\.google\.com\//.test(popup.url()), popup.url());
  await popup.close();
  // 中止
  await store.updateEvent(`morning-${D3}`, { registration: 'cancelled' });
  await openMorning(p); await pick(p, D3);
  check('中止の日：Meet参加ボタンも参加ボタンも出ない', (await p.locator('#moDetail [data-act]').count()) === 0 && /中止/.test(await detail(p)), await detail(p));
  await store.updateEvent(`morning-${D3}`, { registration: 'open' });
  // 過去日
  const y = JST(-1); const m0 = (await p.locator('.mo-month').innerText());
  if (JST(0).slice(8) === '01') { await p.click('[data-act="mo-prev"]'); await p.waitForSelector('.mo-grid'); }
  await pick(p, y);
  check('過去日：参加・Meetともボタンなし', (await p.locator('#moDetail [data-act]').count()) === 0, null);
  void m0;
  await p.click('[data-go="gather"]'); await p.waitForSelector('#p-gather.active');
  check('集う：朝の集まりへの導線・イベント分類は維持', (await p.locator('#gatherBody [data-go="morning"]').count()) === 1 && /参加予定|予約できる集まり|これまでの集まり/.test(await p.locator('#gatherBody').innerText()), null);
  await store.leaveEvent(`morning-${D3}`, A);
}

console.log('■ F. マイページ：活動の記録（最近書いたことば・これまでの集まり・セッションの記録）を1つのまとまりに');
{
  const p = a.page;
  await p.goto(base + '/haku-community/home/#profile'); await p.reload(); await p.waitForSelector('#p-profile.active');
  await p.waitForFunction(() => !document.querySelector('#p-profile .rec-group .pulse'));
  eq('3項目が同じ親（.rec-group）に入り、見出し文言は従来のまま', await p.locator('#p-profile .rec-group .block-title').allInnerTexts(), ['最近、書いたことば', 'これまでの集まり', 'セッションの記録']);
  check('3項目それぞれに小さなアイコン・区切り線がある', (await p.locator('#p-profile .rec-group .rec-ic').count()) === 3 && await p.evaluate(() => [...document.querySelectorAll('#p-profile .rec-group > .block')].slice(1).every((e) => getComputedStyle(e).borderTopWidth === '1px')), null);
  check('3項目は1つのカードにまとまり、独立カードが乱立していない', (await p.locator('#p-profile .rec-group').count()) === 1 && (await p.locator('#p-profile .rec-group .rec-group, #p-profile .rec-group .home-group').count()) === 0, null);
  check('既存の内容・遷移先（ことばを書く／ことばの一覧／音声）を維持', (await p.locator('#recentBody').innerText()).length > 0 && (await p.locator('#sessionsBody').innerText()).length > 0 && (await p.locator('#gatheredBody').innerText()).length > 0, null);
  eq('今月の約束・設定とサポートはそのまま', [await p.locator('#h-goals').innerText(), await p.locator('#h-settings').innerText()], ['今月の約束', '設定とサポート']);
  const order = await p.evaluate(() => ['#h-goals', '.rec-group', '#h-settings'].map((s) => document.querySelector(s).getBoundingClientRect().top));
  check('並び：今月の約束 → 記録のまとまり → 設定とサポート', order[0] < order[1] && order[1] < order[2], order);
  await shot(p, { path: path.join(OUT, 'r3-04-mypage-pc.png'), fullPage: true });
}

console.log('■ G. HAKUポイント：活用イメージ（構想の紹介だけ）');
{
  const p = a.page;
  await p.goto(base + '/haku-community/home/#point'); await p.reload(); await p.waitForSelector('#h-usage');
  const t = await p.locator('#pointBody').innerText();
  check('「ポイントの活用イメージ」に2つの構想が出る', /ポイントの活用イメージ/.test(t) && /インドプロジェクトへの支援/.test(t) && /自分の学びや挑戦への活用/.test(t), t);
  check('構想の段階だと分かる短い一文がある', /構想の段階です/.test(t), null);
  check('未確定の換算率・ルールを断定していない（1pt＝1円・円・有効期限・上限などの語がない）', !/1\s*pt|1ポイント|＝|=|円|有効期限|上限|換算|交換できます|寄付できます/.test(await p.locator('section.block[aria-labelledby="h-usage"]').innerText()), null);
  eq('交換・寄付・申請のボタンやリンクを追加していない', await p.locator('section.block[aria-labelledby="h-usage"]').locator('button, a, input').count(), 0);
  check('既存のポイント表示（理念・準備中／残高・履歴）が維持', /受け取ったものを、次の誰かへ/.test(t), null);
  await shot(p, { path: path.join(OUT, 'r3-05-point.png'), fullPage: true });
}

console.log('■ H. スマホ幅（390px）：HOME／カレンダー（アイコン）／マイページ／ポイント');
{
  const m = await login(A, { width: 390, height: 844, name: 'タロウ(スマホ)' });
  const p = m.page;
  const overflow = () => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || document.querySelector('.content').scrollWidth > document.querySelector('.content').clientWidth + 1);
  await p.waitForFunction(() => !document.querySelector('#p-home .pulse'));
  const w = await box(p, '#homeWordsGroup'), pl = await box(p, '#homePlanGroup');
  check('スマホでも、ことばが予定より上（縦に ことば → 予定）', w.y + w.height <= pl.y + 1, { w, pl });
  eq('HOME：横スクロールなし', await overflow(), false);
  await shot(p, { path: path.join(OUT, 'r3-06-home-m.png'), fullPage: true });
  await store.ensureMorningEvent(D1, 'x');
  for (const e of ['nishiyama.taro@example.com', 'hanako.nishiyama@example.com', 'jiro.yamada@example.com', 'extra1@example.com', 'extra2@example.com', 'extra3@example.com']) await store.joinEventAtomic(`morning-${D1}`, e, null);
  await openMorning(p); await pick(p, D1);
  const geo = await p.evaluate((d) => { const c = document.querySelector(`.mo-cell[data-date="${d}"]`).getBoundingClientRect(); const items = [...document.querySelectorAll(`.mo-cell[data-date="${d}"] .mo-avs > *`)].map((e) => e.getBoundingClientRect()); const next = document.querySelector(`.mo-cell[data-date="${d}"]`).nextElementSibling; return { n: items.length, inside: items.every((r) => r.left >= c.left - 0.5 && r.right <= c.right + 0.5), h: Math.round(c.height), w: Math.round(c.width) }; }, D1);
  check(`6人参加でも日付枠に収まる（スマホ：アイコン${geo.n}個・枠 ${geo.w}×${geo.h}px）`, geo.inside && geo.n === 4, geo);
  eq('カレンダー：横スクロールなし', await overflow(), false);
  await shot(p, { path: path.join(OUT, 'r3-07-calendar-m.png'), fullPage: true });
  await p.goto(base + '/haku-community/home/#profile'); await p.reload(); await p.waitForSelector('#p-profile.active .rec-group');
  eq('マイページ：横スクロールなし', await overflow(), false);
  await shot(p, { path: path.join(OUT, 'r3-08-mypage-m.png'), fullPage: true });
  await p.goto(base + '/haku-community/home/#point'); await p.reload(); await p.waitForSelector('#h-usage');
  eq('ポイント：横スクロールなし', await overflow(), false);
  await shot(p, { path: path.join(OUT, 'r3-09-point-m.png'), fullPage: true });
  await m.ctx.close();
}

console.log('■ I. 参加申請の締切（開催日の前々日23:59まで）の表示と、締切後の挙動');
{
  googleOn(true);
  const p = a.page, q = b.page;
  const closedDay = JST(1);                          // 明日の開催：すでに締切後（前々日＝今日の0:00〜は不可）
  const openDay = JST(2);                            // 明後日の開催：今日の23:59:59.999まで申請できる
  await openMorning(p, openDay);
  eq('注意書き（カレンダー上部の小さな一文）', await p.locator('.mo-note').innerText(), '朝の集まりへの参加申請は、開催日の前々日23:59まで受け付けています。');
  const noteBox = await box(p, '.mo-note'), headBox = await box(p, '.mo-head');
  check('注意書きはカレンダーの月表示の上にあり、大きな警告カードではない（背景・枠なし）', noteBox.y < headBox.y && noteBox.height < 60 && await p.evaluate(() => { const s = getComputedStyle(document.querySelector('.mo-note')); return s.backgroundColor === 'rgba(0, 0, 0, 0)' && s.borderTopWidth === '0px'; }), { noteBox, headBox });
  // 2日後の開催は、まだ参加できる
  await pick(p, openDay);
  check('明後日の開催：参加ボタンがある（締切前）', (await p.locator('#moDetail [data-act="mo-join"]').count()) === 1 && !/受付は終了/.test(await detail(p)), await detail(p));
  // 明日の開催（締切後）。他の会員Bが締切前に参加していた、という状況を作る
  await store.ensureMorningEvent(closedDay, 'x'); await store.joinEventAtomic(`morning-${closedDay}`, B.toLowerCase(), null);
  await openMorning(p, closedDay); await pick(p, closedDay);
  const d1 = await detail(p);
  check('締切後・未参加：「参加受付は終了しました」と出て、参加ボタンは出ない。参加者一覧は維持', /参加受付は終了しました/.test(d1) && (await p.locator('#moDetail [data-act="mo-join"]').count()) === 0 && /参加予定 1人/.test(d1) && /ハナ/.test(d1) && (await p.locator('#moDetail .mo-person .av').count()) === 1, d1);
  check('カレンダーのアイコンも維持', (await cell(p, closedDay).locator('.mo-avs .av').count()) === 1, null);
  const api = await p.evaluate(async (d) => { const r = await fetch('/api/community-auth?action=morning-join', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: d }) }); return { status: r.status, body: await r.json() }; }, closedDay);
  check('APIを直接呼んでも締切は回避できない（409 deadline・人数は増えない）', api.status === 409 && api.body.code === 'deadline' && (await store.countEventParticipants(`morning-${closedDay}`)) === 1, api);
  // 締切後も、参加済みの会員（B）は状態維持・Meet導線・取消ができる
  await openMorning(q, closedDay); await pick(q, closedDay);
  check('締切後・参加済み：参加状態を維持し、「朝の集まりに参加する」と取消が使える（締切で無効化されない）', (await q.locator('#moDetail [data-act="mo-meet"]').count()) === 1 && (await q.locator('#moDetail [data-act="mo-leave"]').count()) === 1 && await q.locator('#moDetail [data-act="mo-meet"]').first().isEnabled() && !/受付は終了/.test(await detail(q)), await detail(q));
  const popup = await clickPopup(q, '#moDetail [data-act="mo-meet"]');
  check('締切後でもMeetへ移動できる', /^https:\/\/meet\.google\.com\/abc\d+-/.test(popup.url()), popup.url());
  await popup.close();
  await q.click('#moDetail [data-act="mo-leave"]'); await q.waitForFunction(() => /開催予定なし/.test(document.querySelector('#moDetail').innerText));
  const d2 = await detail(q);
  check('締切後に取り消すと開催予定なしに。再び参加はできない（受付終了の表示）', /開催予定なし/.test(d2) && /参加受付は終了しました/.test(d2) && (await q.locator('#moDetail [data-act="mo-join"]').count()) === 0, d2);
  check('ホームの「今日の一歩」は、締切後の日へ「参加してみませんか」と誘わない', !/朝の集まりが開催予定です。参加してみませんか/.test(await (async () => { await p.goto(base + '/haku-community/home/#home'); await p.reload(); await p.waitForFunction(() => !document.querySelector('#homeStep .pulse')); return p.locator('#homeStep').innerText(); })()), null);
  await shot(p, { path: path.join(OUT, 'r4-01-home.png') });
  await openMorning(q, closedDay); await pick(q, closedDay);
  await shot(q, { path: path.join(OUT, 'r4-02-closed-day.png'), fullPage: false });
  await openMorning(p, openDay); await pick(p, openDay);
  await shot(p, { path: path.join(OUT, 'r4-03-calendar-note.png'), fullPage: false });
  await store.leaveEvent(`morning-${closedDay}`, B.toLowerCase());
}

googleOn(false);
eq('画面のJavaScriptエラー・予期しないエラーなし', errors, []);
console.log(`\n結果: 成功 ${pass} / 失敗 ${fail}`);
if (fail) console.log('失敗:\n' + failures.join('\n'));
await browser.close(); server.close();
process.exit(fail ? 1 : 0);

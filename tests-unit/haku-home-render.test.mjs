/**
 * 会員ホームの「画面の組み立て」のテスト。実際のRedis・ネットワークには一切つながない。
 *   node --test "tests-unit/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { renderHakuHome, safeJson } from '../api/_lib/haku-home-render.js';
import { UI } from '../api/_lib/haku-ui-strings.js';
import { cleanUserText, hasInvalidChars, isDisplayablePost, normalizeRequestId } from '../api/_lib/text-safety.js';
import { computeEventState, joinBlockReason, isEventPast } from '../api/_lib/event-state.js';

const TEMPLATE = readFileSync(new URL('../api/_templates/haku-community-home.html', import.meta.url), 'utf8');
const render = (opts = {}) => renderHakuHome(TEMPLATE, { displayName: '山田太郎', isAdmin: false, ...opts });

function walk(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? walk(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
}
const get = (path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), UI);

test('テンプレートの {{t.…}} と UI.… の参照は、すべて文言ファイルに存在する', () => {
  const htmlRefs = [...TEMPLATE.matchAll(/\{\{t\.([A-Za-z0-9_.]+)\}\}/g)].map((m) => m[1]);
  assert.ok(htmlRefs.length > 40, '文言の参照が少なすぎる（置換が機能していない可能性）');
  for (const ref of htmlRefs) assert.equal(typeof get(ref), 'string', `HTML側の参照がない: ${ref}`);
  const jsRefs = [...TEMPLATE.matchAll(/\bUI\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)/g)].map((m) => m[1]);
  assert.ok(jsRefs.length > 80);
  for (const ref of new Set(jsRefs)) assert.equal(typeof get(ref), 'string', `JS側の参照がない: ${ref}`);
});

test('描画後に未置換のプレースホルダーが残らない・画面のスクリプトは文法的に正しい', () => {
  const html = render();
  assert.ok(!/\{\{[^}]*\}\}/.test(html));
  const script = html.split('<script>')[1].split('</script>')[0];
  assert.doesNotThrow(() => new Function(script)); // 構文チェックのみ（実行はしない）
});

test('表示名はHTML・JSONの両方で安全に埋め込まれる（スクリプトが実行されない）', () => {
  const evil = '</script><script>alert(1)</script>"><img src=x onerror=alert(2)>';
  const html = render({ displayName: evil });
  assert.ok(!html.includes('<img src=x onerror'), 'HTMLに生のタグが入っている');
  assert.ok(!html.includes('<script>alert(1)'), 'スクリプトタグが入っている');
  const scripts = html.split('<script>').length - 1;
  assert.equal(scripts, 1, 'script要素が増えている');
  const member = html.match(/const MEMBER = (\{.*\});/)[1];
  assert.equal(JSON.parse(member).name, evil, 'JSONを戻すと元の名前に戻る');
});

test('safeJson は < > & と行区切り文字を無効化し、読み戻すと同じ値になる', () => {
  const src = { a: '</script><b>&amp;', c: String.fromCharCode(0x2028) + 'x' };
  const out = safeJson(src);
  assert.ok(!out.includes('<') && !out.includes('>') && !out.includes('&'));
  assert.ok(!out.includes(String.fromCharCode(0x2028)));
  assert.deepEqual(JSON.parse(out), src);
});

test('運営の管理画面へのリンク・URLは、運営権限がない会員のHTMLには一切含まれない', () => {
  const member = render({ isAdmin: false });
  assert.ok(!member.includes('/haku-community/admin'));
  assert.ok(!member.includes(UI.me.admin));
  const admin = render({ isAdmin: true });
  assert.ok(admin.includes('/haku-community/admin/'));
  assert.ok(admin.includes(UI.me.admin));
});

test('会員の画面に、Preview表記・テスト用の言葉・旧名称・英語の大文字見出しが出ない', () => {
  const html = render();
  const banned = [/PREVIEW/i, /Preview/, /統合/, /完成形/, /フィクスチャ/, /fixture/i, /テスト環境/, /検証用/, /\bTANE\b/, /MY HAKU/, /TODAY/, /NEXT HAKU/, /\bOPEN\b/, /種（TANE）/];
  for (const re of banned) assert.ok(!re.test(html), `禁止語が残っている: ${re}`);
  // ナビは6項目・指定の順序・日本語ラベル
  const nav = [...html.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(nav, ['home', 'learn', 'words', 'gather', 'point', 'profile']);
  assert.deepEqual([UI.nav.home, UI.nav.learn, UI.nav.words, UI.nav.gather, UI.nav.pointFull, UI.nav.me], ['ホーム', '学ぶ', 'ことば', '集う', 'HAKUポイント', 'マイページ']);
});

test('操作はすべてdata属性で受け、HTMLにonclick等のインライン操作がない／見出しは各画面に1つ', () => {
  const html = render();
  assert.ok(!/\sonclick=/i.test(html));
  const body = html.split('<script>')[0];
  assert.equal((body.match(/<h1\b/g) || []).length, 10, '各画面（10）にh1が1つずつ');
  // 入力欄にはラベルが結び付いている
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of body.matchAll(/<label[^>]*\sfor="([^"]+)"/g)) assert.ok(ids.has(m[1]), `ラベルの対象がない: ${m[1]}`);
});

test('文言ファイルのすべての文言は文字列で、空でなく、置換文字（文字化け）を含まない', () => {
  for (const path of walk(UI)) {
    const v = get(path);
    assert.equal(typeof v, 'string', path);
    assert.ok(v.length > 0, `空の文言: ${path}`);
    assert.ok(!hasInvalidChars(v), `文字化け: ${path}`);
  }
});

test('ロゴはHAKU Community専用（lp-assets/haku-community-logo.png）で、総合トップのヘッダー画像とは別。右側の団体名はそのまま残る', () => {
  const html = render();
  assert.ok(html.includes('/lp-assets/haku-community-logo.png?v='));
  assert.ok(!html.includes('src="/lp-assets/logo-hero.png'), '総合トップのロゴ画像を、会員ホームのヘッダーで使っている');
  assert.ok(existsSync(new URL('../lp-assets/haku-community-logo.png', import.meta.url)), 'ロゴ画像ファイルがない');
  assert.ok(html.includes('教育支援団体') && html.includes('あんたがおらな'));
  assert.ok(!html.includes('hero-logo-antagaorana'), '旧・文字ロゴを参照している');
});

/* ─── 文章の安全化 ─── */
test('cleanUserText: 制御文字・双方向制御文字を除き、改行を整える', () => {
  assert.equal(cleanUserText('a\r\nb\n\n\n\nc\u0007d‮e  '), 'a\nb\n\ncd' + 'e');
  assert.equal(cleanUserText(null), '');
});

test('置換文字（文字化け）を検知し、そのような既存投稿は表示対象から外す', () => {
  const bad = 'テスト' + String.fromCharCode(0xFFFD);
  assert.equal(hasInvalidChars(bad), true);
  assert.equal(hasInvalidChars('通常の文章'), false);
  assert.equal(isDisplayablePost({ title: '', body: bad }), false);
  assert.equal(isDisplayablePost({ title: bad, body: 'ok' }), false);
  assert.equal(isDisplayablePost({ title: '', body: '<script>alert(1)</script>' }), true, '記号は文字として通す（表示時にエスケープ）');
});

test('normalizeRequestId: 形式が正しいIDだけ受け付ける', () => {
  assert.equal(normalizeRequestId('abcdef12'), 'abcdef12');
  assert.equal(normalizeRequestId('550e8400-e29b-41d4-a716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(normalizeRequestId('short'), null);
  assert.equal(normalizeRequestId('has space here'), null);
  assert.equal(normalizeRequestId('a'.repeat(65)), null);
});

/* ─── 集まりの状態判定 ─── */
const NOW = Date.parse('2026-10-10T00:00:00Z');
const future = '2026-10-15T07:00:00+09:00';
const past = '2026-10-01T07:00:00+09:00';
test('computeEventState: 中止 > 開催済み > 参加予定 > 受付終了 > 満席 > 受付中', () => {
  const st = (event, extra = {}) => computeEventState({ event, participantCount: 0, joined: false, nowMs: NOW, ...extra }).state;
  assert.equal(st({ startsAt: future }), 'open');
  assert.equal(st({ startsAt: future, capacity: 2 }, { participantCount: 2 }), 'full');
  assert.equal(st({ startsAt: future, capacity: 2 }, { participantCount: 2, joined: true }), 'joined', '参加済みの人は満席でも「参加予定」');
  assert.equal(st({ startsAt: future, registration: 'closed' }), 'closed');
  assert.equal(st({ startsAt: future, registration: 'closed' }, { joined: true }), 'joined');
  assert.equal(st({ startsAt: past }), 'ended');
  assert.equal(st({ startsAt: past }, { joined: true }), 'ended');
  assert.equal(st({ startsAt: future, registration: 'cancelled' }, { joined: true }), 'cancelled');
  assert.equal(st({ startsAt: past, registration: 'cancelled' }), 'cancelled');
  assert.equal(st({ startsAt: null }), 'open', '日程調整中は開催済みにならない');
});

test('joinBlockReason / isEventPast', () => {
  assert.equal(joinBlockReason({ startsAt: future }, NOW), null);
  assert.equal(joinBlockReason({ startsAt: future, registration: 'closed' }, NOW), 'closed');
  assert.equal(joinBlockReason({ startsAt: future, registration: 'cancelled' }, NOW), 'cancelled');
  assert.equal(joinBlockReason({ startsAt: past }, NOW), 'ended');
  assert.equal(isEventPast({ startsAt: 'not-a-date' }, NOW), false);
});

/* ─── 追加改修：サイドバー／丸いロゴ／運営元の表記／旧名称「種・TANE」 ─── */
test('PCは左サイドバー、スマホは下部メニュー：ヘッダー・メニュー・会員名が1つの入れ物にあり、本文より前にある（Tab順＝見た目の順）', () => {
  const html = render();
  const body = html.split('<script>')[0];
  const side = body.indexOf('<div class="side">');
  const header = body.indexOf('<header class="topbar">');
  const nav = body.indexOf('<nav class="tabbar"');
  const member = body.indexOf('<div class="side-member">');
  const main = body.indexOf('<main class="content"');
  assert.ok(side > 0 && side < header && header < nav && nav < member && member < main);
  // 900px以上でサイドバー（縦並び）、それ未満は下部固定のメニューのまま
  assert.match(html, /@media \(min-width:900px\)\{[\s\S]*\.tabbar\{position:static;display:flex;flex-direction:column/);
  assert.match(html, /\.tabbar\{position:fixed;left:0;right:0;bottom:0/);
  // 6項目の順序
  assert.deepEqual([...body.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]), ['home', 'learn', 'words', 'gather', 'point', 'profile']);
});

test('ロゴ：丸いバッジ（44px）のまま、HAKU Community専用ロゴを切り抜かず置く', () => {
  const html = render();
  assert.match(html, /\.brand-mark\{[^}]*width:44px;height:44px;border-radius:50%/);
  assert.ok(!/\.brand-mark\{[^}]*border-radius:9px/.test(html), '旧・角丸四角の台座が残っている');
  assert.ok(html.includes('src="/lp-assets/haku-community-logo.png?v='));
  assert.match(html.match(/\.brand-mark img\{[^}]*\}/)[0], /width:44px;height:44px/);
  // 画像は加工せず（filter・clip-path・object-fit での切り抜きなし）
  const css = html.match(/\.brand-mark img\{[^}]*\}/)[0];
  assert.ok(!/filter|clip-path|object-fit|mask/.test(css), css);
});

test('会員ホームの表示に「株式会社」「種」「TANE」「HAKU POINT」が出ない', () => {
  const html = render();
  assert.ok(!html.includes('株式会社'));
  assert.ok(!/TANE|HAKU POINT/.test(html));
  // 画面に出る部分（スクリプトのコード・コメントを除く本文）と、全文言データに「種」がない
  const visible = html.split('<script>')[0];
  assert.ok(!visible.includes('種'), '旧名称「種」が残っている');
  assert.ok(!JSON.stringify(UI).includes('種'), '文言データに旧名称「種」が残っている');
  assert.ok(html.includes(UI.nav.pointFull) && html.includes(UI.point.title));
  // 未確定の仕様（換算率・有効期限・交換先・付与条件）を会員向け文言に出さない
  const all = JSON.stringify(UI.point); // HAKUポイント画面の文言（ログイン切れ等の別機能の文言は対象外）
  for (const w of ['換算', '有効期限', '交換', '還元', '1pt', '付与される']) assert.ok(!all.includes(w), `未確定の仕様を示す語: ${w}`);
});

test('運営元の表記：HAKU Communityの通常ページは「教育支援団体」。正式法人名が必要なページは維持', () => {
  const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  for (const f of ['haku-community/login/index.html', 'haku-community/register/index.html', 'haku-community/index.html']) {
    assert.ok(!read(f).includes('株式会社あんたがおらな'), `${f} に運営元の肩書きとして残っている`);
    assert.ok(read(f).includes('教育支援団体 あんたがおらな'), f);
  }
  // 法的に正式法人名が必要なページは変更しない
  assert.ok(read('commercial-transactions.html').includes('株式会社あんたがおらな'));
  assert.ok(read('benkyokai-terms.html').includes('株式会社あんたがおらな'));
  assert.ok(read('index.html').includes('株式会社あんたがおらな'));
});

test('旧コミュニティ（community.html）のHAKUタブ：会員に見える名称は「HAKUポイント」。未確定ルールの文は出さない', () => {
  const html = readFileSync(new URL('../community.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('<span class="tab-lbl">種</span>'));
  assert.ok(html.includes('<span class="tab-lbl">HAKUポイント</span>'));
  const fn = html.slice(html.indexOf('function hakuRenderTane()'), html.indexOf('// ── マイページ拡張'));
  assert.ok(!/TANE|換算率|有効期限/.test(fn), '会員向け描画に旧名称・未確定ルールが残っている');
  assert.ok(fn.includes('受け取ったものを、次の誰かへ。') && fn.includes('ただいま準備中です'));
  assert.ok(!html.includes('累計TANE'));
});

test('管理画面の表示名は「HAKUポイント」に統一（内部名 tane は維持）', () => {
  const html = readFileSync(new URL('../haku-community/admin/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('<button data-mode="tane">HAKUポイント</button>'));
  assert.ok(!/<button[^>]*>[^<]*HAKU POINT/.test(html));
});

test('名称の統一：会員の画面は「朝の集まり」。HAKU MORNING／555チャレンジは出ない（説明文での補足のみ）', () => {
  const html = render();
  assert.ok(!/555|チャレンジ|5時55分|meet\.google\.com/.test(html), '555チャレンジ関連が残っている');
  const withBrand = Object.entries(Object.fromEntries([...walk(UI)].map((p) => [p, get(p)]))).filter(([, v]) => /HAKU MORNING/.test(v)).map(([k]) => k);
  assert.deepEqual(withBrand, ['morning.lead'], '「HAKU MORNING」は、朝の集まりの説明文だけ');
  assert.equal(UI.gather.typeMorning, '朝の集まり');
  assert.ok(UI.morning.lead.startsWith('朝の集まり（HAKU MORNING）'));
});

test('「わたし」→「マイページ」：ナビ（PC・スマホ共通）とaria-label。画面内の見出し「わたしの記録」は残す', () => {
  const html = render();
  const nav = html.match(/<nav class="tabbar"[\s\S]*?<\/nav>/)[0];
  assert.ok(nav.includes('マイページ') && !nav.includes('わたし'), 'ナビにマイページ以外の名称が残っている');
  assert.ok(html.includes('aria-label="マイページを開く"'));
  assert.equal(UI.me.title, 'わたしの記録');
});

test('設定とサポート：プロフィール設定／アカウント／サポートに整理され、既存の機能は残っている', () => {
  const html = render({ isAdmin: true });
  const block = html.match(/<section class="block" aria-labelledby="h-settings">[\s\S]*?<\/section>/)[0];
  const order = [UI.me.groupProfile, UI.me.groupAccount, UI.me.groupSupport].map((t) => block.indexOf('class="sub-title">' + t));
  assert.ok(order.every((n) => n > 0) && order[0] < order[1] && order[1] < order[2], 'グループの順序');
  assert.ok(block.includes('data-go="profile-settings"') && block.includes(UI.me.profileSettings));
  for (const keep of ['data-go="email"', 'data-go="password"', 'data-act="logout"', 'id="cancelArea"', UI.contact.mailto.replace(/&/g, '&amp;')]) assert.ok(block.includes(keep), `既存機能が消えている: ${keep}`);
  assert.ok(block.includes('/haku-community/admin/'), '運営の方のリンクは維持');
});

test('プロフィール設定：画像（選ぶ・プレビュー・保存・戻す）と表示名がマイページから開ける', () => {
  const html = render();
  assert.ok(html.includes('id="p-profile-settings"') && html.includes('id="avatarFile"') && html.includes('accept="image/jpeg,image/png,image/webp"'));
  assert.ok(html.includes('id="nameForm"'));
  for (const act of ['avatar-pick', 'avatar-save', 'avatar-cancel', 'avatar-remove']) assert.ok(html.includes(`actions['${act}']`), act);
  assert.ok(html.includes('id="p-morning"') && html.includes('data-act') && html.includes("actions['mo-join']") && html.includes("actions['mo-leave']"));
  // アイコンを出す3か所（サイド/ヘッダー・マイページ・朝の集まりの参加者）は、同じ関数（avatarInner / avatarHtml）で描く
  assert.ok(html.includes('function paintAvatars()') && html.includes("$('avatarBtn').innerHTML = avatarInner(me)") && html.includes("$('meAv').innerHTML = avatarHtml(me, 64)"));
  assert.ok((html.match(/avatarHtml\(p(?:, \d+)?\)|avatarHtml\(q, \d+\)|avatarHtml\(p, \d+\)/g) || []).length >= 3, '参加者アイコンも同じ関数');
});

test('ホーム：朝の集まりは月間カレンダーではなく、直近1件のカード＋「朝の集まりを見る」。ことば→予定の順', () => {
  const html = render();
  const body = html.split('<script>')[0];
  const order = ['id="homeStep"', 'id="h-words"', 'id="h-question"', 'id="h-next"'].map((k) => body.indexOf(k));
  assert.ok(order.every((n) => n > 0) && order.every((n, i) => i === 0 || n > order[i - 1]), '冒頭（挨拶・今日の一歩）→ことば→今週の問い→予定（朝の集まり・直近の予定） の順');
  const homeSection = body.match(/<section class="page active" id="p-home"[\s\S]*?<!-- 学ぶ -->/)[0];
  assert.ok(!homeSection.includes('mo-grid') && !homeSection.includes('morningBody'), 'ホームにカレンダーを置かない');
  assert.ok(html.includes('data-go="morning"'));
  assert.ok(html.includes('function renderMorningHome()'));
});

test('HOME：ことば → 予定（朝の集まり・直近の予定）の順に、それぞれ1つのまとまりとして並ぶ。既存の見出し文言は変えない', () => {
  const html = render();
  const body = html.split('<script>')[0];
  const words = body.indexOf('id="homeWordsGroup"'), plan = body.indexOf('id="homePlanGroup"');
  assert.ok(words > 0 && plan > words, 'ことばのまとまり → 予定のまとまり');
  const g1 = body.slice(words, plan), g2 = body.slice(plan, body.indexOf('<!-- 学ぶ -->'));
  assert.ok(g1.includes('id="h-words"') && g1.includes('id="h-question"') && !g1.includes('id="h-next"'));
  assert.ok(g2.includes('id="h-next"') && g2.includes('id="homeNextMorning"') && g2.includes('id="homeNextMeet"'), '朝の集まりと直近の予定は同じグループ');
  assert.deepEqual([UI.home.wordsTitle, UI.home.noteTitle, UI.home.nextTitle, UI.home.nextMorning, UI.home.nextMeet, UI.home.wordLatest, UI.home.membersWords], ['ことば', '今週の問い', '直近の予定', '朝の集まり', '次回の集まり', 'HAKUからのことば', '会員のことば']);
});

test('カレンダーの日付枠：「○人」の文字を出さず、参加者のアイコン（多いときは＋n）を出す。詳細には人数と一覧を残す', () => {
  const html = render();
  const script = html.split('<script>')[1];
  const cell = script.slice(script.indexOf('function moCellHtml'), script.indexOf('function moDetailHtml'));
  assert.ok(!/人</.test(cell) && !/\.count\s*\+\s*'人/.test(cell), '日付枠に人数テキストがある');
  assert.ok(cell.includes('moAvatars(day.participants)') && script.includes('mo-more'));
  const detail = script.slice(script.indexOf('function moDetailHtml'), script.indexOf('function drawMorning'));
  assert.ok(detail.includes('UI.morning.people') && detail.includes('mo-person'), '詳細には参加予定の人数と一覧（表示名・アイコン）');
  assert.equal(UI.morning.more, '＋{n}');
});

test('Meet：参加登録済みの日にだけ「朝の集まりに参加する」。URLはHTMLにも文言にも含まれず、ボタンを押したときにAPIから受け取る', () => {
  const html = render();
  assert.ok(!/meet\.google\.com\/[a-z0-9]/i.test(html.replace(/\^https:\\\/\\\/meet\\\.google\\\.com\\\//g, '')), 'MeetのURLが埋め込まれている');
  assert.equal(UI.morning.meetJoin, '朝の集まりに参加する');
  const script = html.split('<script>')[1];
  const detail = script.slice(script.indexOf('function moDetailHtml'), script.indexOf('function drawMorning'));
  assert.ok(/day\.joined\s*\n?\s*\? '<button[^]*mo-meet[^]*mo-leave[^]*: '<button[^]*mo-join/.test(detail), '参加済み＝Meet＋取消、未参加＝参加表明');
  assert.ok(script.includes("action=morning-meet&date="));
  for (const k of ['meetPreparing', 'meetError', 'meetUnavailable', 'meetRetry']) assert.ok(UI.morning[k], k);
  assert.ok(!/Google|API|OAuth|トークン|環境変数/.test(UI.morning.meetError + UI.morning.meetUnavailable + UI.morning.meetPreparing), '会員に技術的な説明を出さない');
});

test('マイページ：最近書いたことば・これまでの集まり・セッションの記録は1つのまとまり（見出し文言は従来のまま）', () => {
  const html = render();
  const group = html.match(/<div class="rec-group">[\s\S]*?<section class="block" aria-labelledby="h-settings">/)[0];
  for (const id of ['h-recent', 'h-gathered', 'h-sessions']) assert.ok(group.includes(`id="${id}"`), id);
  assert.ok(!group.includes('id="h-goals"') && !group.includes('id="h-settings"'));
  assert.deepEqual([UI.me.recentTitle, UI.me.gatheredTitle, UI.me.sessionsTitle], ['最近、書いたことば', 'これまでの集まり', 'セッションの記録']);
});

test('HAKUポイント：活用イメージは構想の紹介だけ。換算率・円・期限などを断定せず、交換や寄付の操作を持たない', () => {
  const u = UI.point.usage;
  assert.deepEqual([u.title, u.item1Title, u.item2Title], ['ポイントの活用イメージ', 'インドプロジェクトへの支援', '自分の学びや挑戦への活用']);
  const text = Object.values(u).join('');
  assert.ok(/構想/.test(u.note) && !/1\s*pt|1ポイント|＝|=|円|有効期限|上限|換算|交換|寄付|申請|承認/.test(text), '未決定の内容を断定している');
  const html = render();
  const fn = html.split('<script>')[1];
  const usage = fn.slice(fn.indexOf('function pointUsageHtml'), fn.indexOf('function loadPoint'));
  assert.ok(!/<button|<a |<input|data-act|data-go/.test(usage), '操作（ボタン・リンク）を含まない');
  assert.ok(fn.includes('pointUsageHtml()'));
});

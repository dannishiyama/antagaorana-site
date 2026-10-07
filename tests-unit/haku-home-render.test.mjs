/**
 * 会員ホームの「画面の組み立て」のテスト。実際のRedis・ネットワークには一切つながない。
 *   node --test "tests-unit/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.deepEqual([UI.nav.home, UI.nav.learn, UI.nav.words, UI.nav.gather, UI.nav.pointFull, UI.nav.me], ['ホーム', '学ぶ', 'ことば', '集う', 'HAKUポイント', 'わたし']);
});

test('操作はすべてdata属性で受け、HTMLにonclick等のインライン操作がない／見出しは各画面に1つ', () => {
  const html = render();
  assert.ok(!/\sonclick=/i.test(html));
  const body = html.split('<script>')[0];
  assert.equal((body.match(/<h1\b/g) || []).length, 8, '各画面（8つ）にh1が1つずつ');
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

test('ロゴは総合トップと同じ既存アセット（lp-assets/logo-hero.png）を使い、右側の団体名はそのまま残る', () => {
  const html = render();
  assert.ok(html.includes('/lp-assets/logo-hero.png?v=20260501a'));
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

test('ロゴ：四角い台座は廃止し、丸いバッジに既存アセットをそのまま（切り抜かず）置く', () => {
  const html = render();
  assert.match(html, /\.brand-mark\{[^}]*border-radius:50%/);
  assert.ok(!/\.brand-mark\{[^}]*border-radius:9px/.test(html), '旧・角丸四角の台座が残っている');
  assert.ok(html.includes('src="/lp-assets/logo-hero.png?v=20260501a"'));
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

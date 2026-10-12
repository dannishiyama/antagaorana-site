/**
 * 紹介ページ（/haku-community/ と /salon/）：今回の見た目の改善で、文言・リンクが変わっていないことの確認。
 * 変更前のコミット（git の履歴）と、本文のテキスト・リンク・FAQの質問を比べる。
 * 変わってよいのは、FAQの初期状態（開閉）と、灯の一般向け表示の運営団体の表記（「株式会社あんたがおらな」→「教育支援団体あんたがおらな」）だけ。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE = '6acde1b'; // この作業の前のコミット
// HAKU Community紹介ページで、意図して変えた文言（旧機能名「TANE」→「HAKUポイント」／「使う」の活用構想の例）。これ以外は、変更前と同じでなければならない。
const HAKU_TEXT_EDITS = [
  ['<h4>循環する｜TANE</h4><p>人をつなぐ・助ける・貢献する——そうした行動が「TANE」として積み重なる仕組み。', '<h4>循環する｜HAKUポイント</h4><p>人をつなぐ・助ける・貢献する——そうした行動が「HAKUポイント」として積み重なる仕組み。'],
  ['<div class="sec-label">TANE</div>', '<div class="sec-label">HAKUポイント</div>'],
  ['<h2 class="lead">TANEは、ポイントではありません。</h2>', '<h2 class="lead">HAKUポイントは、ただのポイントではありません。</h2>'],
  ['<p class="lede" style="margin-bottom:30px">貯めることより、', '<p class="lede" style="margin-bottom:30px">HAKUポイントは、学びや行動を、次の誰かへの価値につなげていく仕組みです。貯めることより、'],
  ['<div><h4>つかう</h4><p>自分のために、挑戦のために（インド体験など）、誰かに贈る、社会に還す（富士登山プロジェクト等）。</p></div>', '<div><h4>つかう</h4><p>① 自分の学びや挑戦への活用<br>② インドプロジェクトへの支援<br>（いずれも現段階では、活用構想の例です。）</p></div>'],
  ['※ TANEの換算価値・有効期限・譲渡可否は現在検討中です。', '※ HAKUポイントの換算価値・有効期限・譲渡可否は現在検討中です。'],
  ['行動が、TANEとして積み重なる。', '行動が、HAKUポイントとして積み重なる。'],
  ['※ 紹介制度（TANE）でつながりのある方の言葉には', '※ 紹介制度（HAKUポイント）でつながりのある方の言葉には'],
  ['<li>TANE（貢献・つながりの記録）</li>', '<li>HAKUポイント（貢献・つながりの記録）</li>'],
  ['毎月わずかなTANEが育ちます。', '毎月わずかなHAKUポイントが育ちます。'],
  ['<summary>TANEは現金化できますか。</summary>', '<summary>HAKUポイントは現金化できますか。</summary>'],
  ['「1TANE＝1円」のような固定の換算は行っていません。', '「1ポイント＝1円」のような固定の換算は行っていません。'],
  ['・紹介制度（TANE）の関係がある方の声には', '・紹介制度（HAKUポイント）の関係がある方の声には'],
  ['/* TANE：説明（左の金線）と、注記（点線の下）に分ける */', '/* HAKUポイント：説明（左の金線）と、注記（点線の下）に分ける */'],
  ['// 4) 4 Pillars / TANE 育てる・つかう', '// 4) 4 Pillars / HAKUポイント 育てる・つかう'],
];
// 灯サロン紹介ページで、意図して変えた文言：人物の表記（大久保俊輝（教育学者）／文脈上は「大久保先生」）。これ以外は、変更前（運営団体の表記を除く）と同じでなければならない。
const SALON_TEXT_EDITS = [
  ['3万件の教育相談に立ち会ってきた大久保俊輝が毎日いる、預かる側のためのコミュニティ', '3万件の教育相談に立ち会ってきた大久保俊輝（教育学者）が毎日いる、預かる側のためのコミュニティ'],
  ['<span>大久保からの投稿</span>', '<span>大久保先生からの投稿</span>'],
  ['大久保が現場で積み上げてきた十ヶ条を', '大久保先生が現場で積み上げてきた十ヶ条を'],
  ['<h4>大久保の投稿を読む</h4>', '<h4>大久保先生の投稿を読む</h4>'],
  ['大久保が自身の失敗から書き起こします。', '大久保先生が自身の失敗から書き起こします。'],
];
const gitOk = spawnSync('git', ['cat-file', '-t', BASE], { cwd: ROOT }).status === 0;
const before = (file) => spawnSync('git', ['show', `${BASE}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).stdout;
const now = (file) => fs.readFileSync(ROOT + file, 'utf8').replace(/\r\n/g, '\n');

function visibleText(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, '');
}
const links = (html) => [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/\b(?:href|data-cta)="([^"]*)"/g)].map((m) => m[1]).filter((h) => !/^\/lp-assets\/.+\.css/.test(h)); // 見た目のCSSの参照は、リンクではない
const summaries = (html) => [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map((m) => m[1].replace(/\s+/g, ''));

for (const [file, label, notation] of [['haku-community/index.html', 'HAKU Community', false], ['salon/index.html', '灯サロン', true]]) {
  test(`${label}の紹介ページ：本文の文言・見出し・FAQ・CTAのリンクは、変更前と同じ（要約・言い換え・削除をしていない）`, { skip: !gitOk }, () => {
    const a = before(file).replace(/\r\n/g, '\n'); const b = now(file);
    let expected = notation ? a.replaceAll('株式会社あんたがおらな', '教育支援団体あんたがおらな') : a;
    if (notation) for (const [from, to] of SALON_TEXT_EDITS) { assert.ok(expected.includes(from), `変更前に見つかりません: ${from.slice(0, 30)}`); expected = expected.replaceAll(from, to); }
    if (!notation) for (const [from, to] of HAKU_TEXT_EDITS.filter(([from]) => !from.startsWith('/*'))) { assert.ok(expected.includes(from), `変更前に見つかりません: ${from.slice(0, 30)}`); expected = expected.replace(from, to); }
    assert.equal(visibleText(b), visibleText(expected), '表示される文言が変わっています');
    assert.deepEqual(links(b), links(expected), 'リンク（href・data-cta）が変わっています');
    assert.deepEqual(summaries(b), summaries(expected), 'FAQの質問が変わっています');
  });

  test(`${label}の紹介ページ：FAQは、すべて閉じた状態で始まる（最初の質問だけ開いている、ということがない）`, () => {
    const html = now(file);
    const faq = html.slice(html.indexOf('id="faq"'));
    const details = [...faq.matchAll(/<details[^>]*>/g)].map((m) => m[0]);
    assert.ok(details.length >= 3);
    assert.ok(details.every((d) => !/\bopen\b/.test(d)), details.join(' '));
  });
}

test('灯サロンの一般向けの画面は「教育支援団体あんたがおらな」。法人名が必要な特定商取引法・規約のページは、そのまま', () => {
  const salonFiles = [];
  const walk = (d) => { for (const f of fs.readdirSync(ROOT + d, { withFileTypes: true })) { const p = `${d}/${f.name}`; if (f.isDirectory()) walk(p); else if (f.name.endsWith('.html')) salonFiles.push(p); } };
  walk('salon');
  for (const f of salonFiles) assert.ok(!now(f).includes('株式会社あんたがおらな'), `${f} に「株式会社あんたがおらな」が残っています`);
  assert.ok(now('salon/index.html').includes('教育支援団体あんたがおらな ｜ ONLINE COMMUNITY'));
  for (const f of ['commercial-transactions.html', 'benkyokai-terms.html']) assert.ok(now(f).includes('株式会社あんたがおらな'), `${f} の法人名は維持する`);
  assert.ok(!now('haku-community/index.html').includes('株式会社あんたがおらな'));
});

test('HAKU Communityの紹介ページ：旧機能名「TANE」が表示に残っていない。「使う」は2つの活用構想の例で、実際に交換できるとは書かれていない', () => {
  const t = visibleText(now('haku-community/index.html'));
  assert.ok(!/TANE/.test(t) && !/タネ/.test(t), '旧機能名が残っています');
  assert.ok(t.includes('①自分の学びや挑戦への活用②インドプロジェクトへの支援（いずれも現段階では、活用構想の例です。）'));
  assert.ok(!t.includes('インド体験') && !t.includes('富士登山'));
  assert.ok(t.includes('HAKUポイントは、ただのポイントではありません。') && t.includes('HAKUポイントは、学びや行動を、次の誰かへの価値につなげていく仕組みです。'));
  assert.ok(!/1ポイント＝1円(です|になります|で交換)/.test(t), '換算を断定していません');
});

test('灯サロンの紹介ページ：大久保先生の表記（単独の「大久保」を残さない）と、十ヶ条の文言・第六条の扱い', () => {
  const html = now('salon/index.html');
  const t = visibleText(html);
  assert.ok(!/大久保(?!先生|俊輝)/.test(t), '敬称のない「大久保」が残っています');
  assert.ok(!/俊樹/.test(html), '「俊樹」ではなく、依頼書の「俊輝」');
  assert.ok(t.includes('大久保俊輝（教育学者）'));
  // 十ヶ条の10条は、すべて同じ作りで並び、第六条だけが特別扱いされていない（今月の一条の印は、運営の設定に連動して後から付く）
  const rows = [...html.matchAll(/<div class="c( [^"]*)?">/g)].map((m) => m[1] || '');
  assert.equal(rows.length, 10); assert.ok(rows.every((c) => c === ''), `十ヶ条の行にクラスの差があります: ${rows}`);
  for (const w of ['時に「ひと呼吸」して待つ', '「責任は我にあり」と受け止める', 'なすべきことはなす誠実さと丁寧さ']) assert.ok(t.includes(w));
  assert.ok(t.includes('※9月の第六条「ひと呼吸して待つ」は、灯では「保護者への報告をどう待たせるか」として扱います。'));
});

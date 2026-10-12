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
const gitOk = spawnSync('git', ['cat-file', '-t', BASE], { cwd: ROOT }).status === 0;
const before = (file) => spawnSync('git', ['show', `${BASE}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).stdout;
const now = (file) => fs.readFileSync(ROOT + file, 'utf8').replace(/\r\n/g, '\n');

function visibleText(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, '');
}
const links = (html) => [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/\b(?:href|data-cta)="([^"]*)"/g)].map((m) => m[1]);
const summaries = (html) => [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map((m) => m[1].replace(/\s+/g, ''));

for (const [file, label, notation] of [['haku-community/index.html', 'HAKU Community', false], ['salon/index.html', '灯サロン', true]]) {
  test(`${label}の紹介ページ：本文の文言・見出し・FAQ・CTAのリンクは、変更前と同じ（要約・言い換え・削除をしていない）`, { skip: !gitOk }, () => {
    const a = before(file).replace(/\r\n/g, '\n'); const b = now(file);
    const expected = notation ? a.replaceAll('株式会社あんたがおらな', '教育支援団体あんたがおらな') : a;
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

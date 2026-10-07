/**
 * HAKU Community Design System の約束を守っているかの検査（lp-assets/haku-*.css）。
 * 「ページごとに装飾を足さない」ことを、機械的に確認する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const FILES = ['lp-assets/haku-design.css', 'lp-assets/haku-app.css', 'lp-assets/haku-entry.css'];
const css = Object.fromEntries(FILES.map((f) => [f, read(f)]));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

test('グラデーション・光の円・ぼかしを使わない', () => {
  for (const f of FILES) assert.ok(!/gradient|backdrop-filter|filter:\s*blur|drop-shadow/.test(stripComments(css[f])), f);
});

test('影は使わない（今日の印の内側線を除く）。浮き上がり（transform:translate）も使わない', () => {
  for (const f of FILES) {
    const c = stripComments(css[f]);
    const shadows = c.match(/box-shadow:[^;}]*/g) || [];
    for (const sh of shadows) assert.ok(/inset/.test(sh), `${f}: ${sh}`);
    assert.ok(!/translateY\(-/.test(c), `${f}: ホバーで浮かせない`);
  }
});

test('角丸は 2px（操作部品）か、円（ロゴ・アバター・点）だけ', () => {
  for (const f of FILES) {
    const radii = stripComments(css[f]).match(/border-radius:[^;}]*/g) || [];
    for (const r of radii) assert.ok(/var\(--h-radius\)|50%|^border-radius:0$/.test(r.trim()), `${f}: ${r}`);
  }
});

test('文字は13px以上（下部メニューのラベルだけ12px）', () => {
  for (const f of FILES) {
    const c = stripComments(css[f]);
    const rules = c.split('}');
    for (const rule of rules) {
      const m = rule.match(/font-size:\s*(\d+(?:\.\d+)?)px/);
      if (m && Number(m[1]) < 13) assert.ok(/\.tab-lbl/.test(rule), `${f}: ${rule.trim().slice(0, 80)}`);
    }
  }
});

test('色は、デザインシステムの変数を使う（haku-app.css・haku-entry.cssに色コードを直書きしない）', () => {
  for (const f of ['lp-assets/haku-app.css', 'lp-assets/haku-entry.css']) {
    const hex = (stripComments(css[f]).match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((c) => !['#f4f1ea', '#2b2a1f', '#e3c06f', '#ffcfbf'].includes(c.toLowerCase()));
    assert.deepEqual(hex, [], `${f}: ${hex.join(',')}`);
  }
});

test('ブランドの色（深緑 #466246・生成り #f7f3ec・金 #d8b15a）が定義されている', () => {
  const d = css['lp-assets/haku-design.css'];
  assert.match(d, /--h-green:#466246/);
  assert.match(d, /--h-bg:#f7f3ec/);
  assert.match(d, /--h-gold:#d8b15a/);
  assert.match(d, /Shippori Mincho/);
  assert.match(d, /Noto Sans JP/);
});

test('会員画面・入口ページ・LPが、デザインシステムとフォントを読み込んでいる', () => {
  const pages = { 'api/_templates/haku-community-home.html': ['haku-design.css', 'haku-app.css'], 'haku-community/login/index.html': ['haku-design.css', 'haku-entry.css'],
    'haku-community/register/index.html': ['haku-design.css', 'haku-entry.css'], 'haku-community/thanks/index.html': ['haku-design.css', 'haku-entry.css'],
    'haku-community/cancel/index.html': ['haku-design.css', 'haku-entry.css'], 'haku-community/index.html': ['haku-design.css'] };
  for (const [f, sheets] of Object.entries(pages)) {
    const html = read(f);
    for (const sh of sheets) assert.ok(html.includes('/lp-assets/' + sh), `${f}: ${sh}`);
    assert.ok(html.includes('Shippori+Mincho'), `${f}: 見出しのフォント`);
  }
});

test('会員画面に、カード・バッジ・英字ラベル用のクラスが残っていない', () => {
  const html = read('api/_templates/haku-community-home.html');
  for (const w of ['class="chip', 'class="card', 'class="badge', 'haku-badge', 'greet-card', 'class="pill', 'class="tl-card', 'class="stat']) assert.ok(!html.includes(w), w);
});

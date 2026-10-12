/**
 * HAKU Communityの配色が、教育者のサロン「灯」の実際のカラーコードと一致していること（色の定義の一元化）。
 *   灯の :root（salon/index.html・サロン本体のテンプレート）＝ lp-assets/haku-palette.css の色 ＝ 会員HOMEの変数の既定値
 * 灯のCSSは変更しない。HAKUの色は haku-palette.css に集約し、将来はそこだけを直せば一括で調整できる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => fs.readFileSync(ROOT + f, 'utf8').replace(/\r\n/g, '\n');
const vars = (css) => Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2].toUpperCase()]));
const salonRoot = (html) => vars(html.slice(html.indexOf(':root{'), html.indexOf('}', html.indexOf(':root{'))));

test('灯サロンの紹介ページとサロン本体は、同じカラーコード（基準）を使っている', () => {
  const lp = salonRoot(read('salon/index.html')); const app = salonRoot(read('api/_templates/salon-tomoshibi.html'));
  for (const k of ['green', 'green-dk', 'green-lt', 'cream', 'paper', 'ink', 'mid', 'faint', 'terra', 'gold', 'line', 'line-soft']) assert.equal(lp[k], app[k], k);
  assert.deepEqual([lp.green, lp.terra, lp.gold, lp.cream, lp.paper, lp.line], ['#1E3A2F', '#B4552F', '#C0A05C', '#F6F2E9', '#FFFDF8', '#DCD5C5']);
});

test('HAKUの配色（haku-palette.css）は、灯の実際のカラーコードと同じ値', () => {
  const salon = salonRoot(read('salon/index.html')); const haku = vars(read('lp-assets/haku-palette.css'));
  const pairs = { 'haku-green-deep': 'green', 'haku-green-darker': 'green-dk', 'haku-green': 'green-lt', 'haku-cream': 'cream', 'haku-paper': 'paper', 'haku-ink': 'ink', 'haku-mid': 'mid', 'haku-faint': 'faint', 'haku-terra': 'terra', 'haku-gold': 'gold', 'haku-line': 'line', 'haku-line-soft': 'line-soft' };
  for (const [h, s] of Object.entries(pairs)) assert.equal(haku[h], salon[s], `${h} ↔ 灯の --${s}`);
});

test('会員HOMEの色の変数は、haku-palette.css の変数を参照し、未読み込みでも灯と同じ値になる（既定値）', () => {
  const html = read('api/_templates/haku-community-home.html'); const salon = salonRoot(read('salon/index.html'));
  assert.ok(html.includes('/lp-assets/haku-palette.css'));
  const root = html.slice(html.indexOf(':root{'), html.indexOf('}', html.indexOf(':root{')));
  const defaults = [...root.matchAll(/--([a-z0-9-]+):var\(--haku-[a-z-]+,(#[0-9A-Fa-f]{6})\)/g)].map((m) => m[2].toUpperCase());
  const palette = new Set(Object.values(salon).map((c) => c.toUpperCase()));
  assert.ok(defaults.length >= 12);
  for (const d of defaults) assert.ok(palette.has(d), `${d} は灯の色ではありません`);
  assert.ok(!/#(2F4D2E|3B5A3A|F6F1E8|FBF8F2|D4A843|E9EFE4)\b/i.test(html), '旧HAKUの色が残っています');
});

test('HAKU Communityの各ページが、haku-palette.css を読み込んでいる（色の定義の一元化）', () => {
  for (const f of ['haku-community/index.html', 'haku-community/register/index.html', 'haku-community/login/index.html', 'account-settings.html', 'forgot-password.html', 'community-set-password.html']) assert.ok(read(f).includes('/lp-assets/haku-palette.css'), f);
});

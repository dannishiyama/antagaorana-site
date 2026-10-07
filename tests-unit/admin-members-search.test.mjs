/**
 * 管理画面「会員一覧」の検索（haku-community/admin/index.html 内の normSearch / memberMatches）のテスト。
 * 画面のHTMLから該当の関数をそのまま取り出して実行するので、画面と同じ判定を検査できる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../haku-community/admin/index.html', import.meta.url), 'utf8');
const a = html.indexOf('function normSearch(s){');
const b = html.indexOf('function memberCardHtml(m){');
assert.ok(a > 0 && b > a, '検索関数が見つからない');
const { normSearch, memberMatches } = new Function(html.slice(a, b) + '\nreturn { normSearch, memberMatches };')();

const M = {
  taro: { fullName: '西山 太郎', fullNameKana: 'にしやま たろう', displayName: 'タロウ', email: 'nishiyama.taro@example.com' },
  hana: { fullName: '西山 花子', fullNameKana: 'にしやま はなこ', displayName: 'ハナ', email: 'hanako.nishiyama@example.com' },
  jiro: { fullName: '山田 次郎', fullNameKana: 'やまだ じろう', displayName: 'ジロー', email: 'jiro.yamada@example.com' },
  miku: { fullName: '佐藤 みく', fullNameKana: 'さとう みく', displayName: 'Miku', email: 'miku.sato@example.com' },
};
const all = Object.values(M);
const find = (q) => all.filter((m) => memberMatches(m, q)).map((m) => m.fullName);

test('氏名（全体・一部・空白あり/なし・語順違い）', () => {
  assert.deepEqual(find('西山'), ['西山 太郎', '西山 花子']);
  assert.deepEqual(find('西山 太郎'), ['西山 太郎']);
  assert.deepEqual(find('西山太郎'), ['西山 太郎']);
  assert.deepEqual(find('太郎 西山'), ['西山 太郎']);
  assert.deepEqual(find('山'), ['西山 太郎', '西山 花子', '山田 次郎']);
});
test('ふりがな（ひらがな・カタカナ入力どちらでも）', () => {
  assert.deepEqual(find('にしやま'), ['西山 太郎', '西山 花子']);
  assert.deepEqual(find('ニシヤマ'), ['西山 太郎', '西山 花子']);
  assert.deepEqual(find('たろう'), ['西山 太郎']);
  assert.deepEqual(find('ﾆｼﾔﾏ'), ['西山 太郎', '西山 花子'], '半角カタカナも同じ扱い');
});
test('表示名・メールアドレス（大文字小文字を区別しない・一部一致）', () => {
  assert.deepEqual(find('MIKU'), ['佐藤 みく']);
  assert.deepEqual(find('miku'), ['佐藤 みく']);
  assert.deepEqual(find('ジロー'), ['山田 次郎']);
  assert.deepEqual(find('NISHIYAMA.TARO@Example.COM'), ['西山 太郎']);
  assert.deepEqual(find('@example.com'), all.map((m) => m.fullName));
});
test('前後の空白・全角英数字・全角空白', () => {
  assert.deepEqual(find('   西山   '), ['西山 太郎', '西山 花子']);
  assert.deepEqual(find('　ＹＡＭＡＤＡ　'), ['山田 次郎']);
});
test('空の検索語は全員にマッチ（検索解除）。該当なしは0件', () => {
  assert.equal(find('').length, 4);
  assert.equal(find('   ').length, 4);
  assert.deepEqual(find('存在しない人'), []);
});
test('別々の会員の項目をまたいだ誤マッチをしない', () => {
  // 「太郎」(1人目の名前) と「花子」(2人目) を同時に含む人はいない
  assert.deepEqual(find('太郎 花子'), []);
});
test('項目が欠けていても落ちない', () => {
  assert.equal(memberMatches({ email: 'a@b.c' }, 'a@b'), true);
  assert.equal(memberMatches({}, 'x'), false);
  assert.equal(normSearch(null), '');
});

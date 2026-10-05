/**
 * api/_lib/text-safety.js
 * 会員が入力する文章（ことば・今月の約束）の安全化。
 *
 * - 表示時のエスケープ（HTMLとして解釈させない）は、画面側（esc()）が必ず行う。ここは「保存前の入口」の守り。
 * - 文字化け（置換文字 U+FFFD を含む）は、文字コードを誤った送信で入るもの。保存を断る。
 * - 制御文字・双方向制御文字（表示を乱す／見た目をだます）は取り除く。
 */

const REPLACEMENT_CHAR = /�/;
// 改行(\n)とタブ以外の制御文字、ゼロ幅・双方向制御文字
const STRIP_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​‎‏‪-‮⁦-⁩﻿]/g;

export function cleanUserText(value) {
  let s = String(value == null ? '' : value);
  try { s = s.normalize('NFC'); } catch { /* 不正なサロゲート等はそのまま */ }
  s = s.replace(/\r\n?/g, '\n').replace(STRIP_CHARS, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function hasInvalidChars(value) {
  return REPLACEMENT_CHAR.test(String(value == null ? '' : value));
}

// 会員向けの一覧に出してよい投稿か（文字化けしたものは出さない。保存済みの古いデータも含めて守る）
export function isDisplayablePost(post) {
  return !hasInvalidChars(post?.title) && !hasInvalidChars(post?.body);
}

// 二重送信防止用の操作ID（クライアントが1回の操作ごとに作る）。形式外は無視する。
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export function normalizeRequestId(value) {
  const s = String(value == null ? '' : value).trim();
  return REQUEST_ID_RE.test(s) ? s : null;
}

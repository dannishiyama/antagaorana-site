/**
 * api/_lib/avatar.js
 * プロフィール画像のアップロード検査。画面側で正方形・小さく整えて送る前提だが、
 * 画面を通さない直接のAPI呼び出しでも安全なように、サーバー側で必ず次を確認する。
 *
 * - 許可する形式は JPEG / PNG / WebP のみ（SVG・GIF・その他は拒否＝XSS等の経路にしない）
 * - 宣言された形式と、ファイルの先頭バイト（マジックナンバー）が一致すること
 * - サイズ上限（バイト）と、画像の縦横（32〜1024px）を、ファイル内のヘッダから確認
 * - ファイル名は受け取らない（保存先IDはサーバーが作る）／外部URLは受け付けない（データURLのみ）
 */
export const AVATAR_LIMITS = { maxBytes: 256 * 1024, minPx: 32, maxPx: 1024 };
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export class AvatarError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
function pngSize(b) {
  if (b.length < 24 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
function webpSize(b) {
  if (b.length < 30) return null;
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') {
    if (b[20] & 0x02) throw new AvatarError('animated', '動く画像は使えません。');
    return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  }
  if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') { const bits = b.readUInt32LE(21); return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 }; }
  return null;
}

/** データURL（data:image/...;base64,...）を検査して { mime, buffer, b64, width, height } を返す。ダメなら AvatarError。 */
export function parseAvatarDataUrl(input) {
  if (typeof input !== 'string' || input.length > Math.ceil(AVATAR_LIMITS.maxBytes * 4 / 3) + 64) {
    throw new AvatarError('too_large', '画像のサイズが大きすぎます。');
  }
  const m = DATA_URL_RE.exec(input);
  if (!m) throw new AvatarError('bad_type', '使える画像はJPEG・PNG・WebPです。');
  const mime = m[1];
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length) throw new AvatarError('bad_file', '画像を読み込めませんでした。');
  if (buffer.length > AVATAR_LIMITS.maxBytes) throw new AvatarError('too_large', '画像のサイズが大きすぎます。');

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  const actual = isJpeg ? 'image/jpeg' : isPng ? 'image/png' : isWebp ? 'image/webp' : null;
  if (!actual || actual !== mime) throw new AvatarError('bad_file', '画像ファイルとして読み込めませんでした。');

  let size = null;
  try { size = isJpeg ? jpegSize(buffer) : isPng ? pngSize(buffer) : webpSize(buffer); } catch (e) { if (e instanceof AvatarError) throw e; size = null; }
  if (!size || !size.w || !size.h) throw new AvatarError('bad_file', '画像ファイルとして読み込めませんでした。');
  if (size.w < AVATAR_LIMITS.minPx || size.h < AVATAR_LIMITS.minPx || size.w > AVATAR_LIMITS.maxPx || size.h > AVATAR_LIMITS.maxPx) {
    throw new AvatarError('bad_size', '画像の大きさが範囲外です。');
  }
  return { mime, buffer, b64: m[2], width: size.w, height: size.h };
}

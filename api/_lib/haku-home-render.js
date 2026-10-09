/**
 * api/_lib/haku-home-render.js
 * 会員ホームのテンプレート（api/_templates/haku-community-home.html）へ、サーバー側で値を差し込む。
 *
 *   {{t.グループ.キー}}  … 文言（api/_lib/haku-ui-strings.js）。HTMLエスケープして差し込む
 *   {{UI_JSON}}          … 全文言をJSONにしたもの（画面のJavaScriptが使う）
 *   {{MEMBER_JSON}}      … 会員情報のJSON（表示名など）
 *   {{DISPLAY_NAME}}     … 表示名（HTMLエスケープ済み）
 *   {{ADMIN_LINK}}       … 運営の管理画面へのリンク。運営権限が確認できた場合だけ中身が入る（一般会員は空）
 *
 * 差し込み後に {{ が残っていたら例外にして、未置換のまま会員に出ることを防ぐ。
 */
import { UI, lookup } from './haku-ui-strings.js';
import { escapeHtml } from './security.js';

// <script>内に安全に埋め込めるJSON（</script>・コメント開始・行区切り文字を無効化）
// バックスラッシュは文字コード(92)から作り、書き方によって消える事故を避ける。
const BS = String.fromCharCode(92);
const JSON_ESCAPES = [['<', 'u003c'], ['>', 'u003e'], ['&', 'u0026'], [String.fromCharCode(0x2028), 'u2028'], [String.fromCharCode(0x2029), 'u2029']];
export function safeJson(value) {
  let out = JSON.stringify(value);
  for (const [ch, esc] of JSON_ESCAPES) out = out.split(ch).join(BS + esc);
  return out;
}

export function renderHakuHome(template, { displayName, isAdmin = false, avatarId = null }) {
  const name = String(displayName || '').trim() || 'メンバー';
  const adminLink = isAdmin
    ? `<li><a class="row-link" href="${escapeHtml(UI.links.adminPanel)}" target="_blank" rel="noopener"><span>${escapeHtml(UI.me.admin)}</span><span class="row-arrow" aria-hidden="true">›</span></a></li>`
    : '';

  // 画面のJavaScriptに渡す文言。運営の管理画面のURL・ラベルは、運営権限がない会員のHTMLには一切含めない。
  const clientUi = JSON.parse(JSON.stringify(UI));
  if (!isAdmin) { delete clientUi.links.adminPanel; delete clientUi.me.admin; }

  let html = template
    .replaceAll('{{UI_JSON}}', () => safeJson(clientUi))
    .replaceAll('{{MEMBER_JSON}}', () => safeJson({ name, isAdmin: Boolean(isAdmin), avatarId: /^[a-f0-9]{16}$/.test(String(avatarId || '')) ? String(avatarId) : null }))
    .replaceAll('{{DISPLAY_NAME}}', () => escapeHtml(name))
    .replaceAll('{{ADMIN_LINK}}', () => adminLink)
    .replace(/\{\{t\.([A-Za-z0-9_.]+)\}\}/g, (_, path) => escapeHtml(lookup(path)));

  if (/\{\{[^}]*\}\}/.test(html)) {
    const leftover = html.match(/\{\{[^}]*\}\}/)[0];
    throw new Error(`haku-home template has an unresolved placeholder: ${leftover}`);
  }
  return html;
}

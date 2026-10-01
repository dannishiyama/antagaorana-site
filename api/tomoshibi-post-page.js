/**
 * api/tomoshibi-post-page.js
 * 教育者のサロン 灯 の会員ページ実体。vercel.jsonのrewriteにより /tomoshibi-post.html は
 * このAPIに転送される。実HTMLは api/_templates/tomoshibi-post.html にあり、静的ファイル
 * としては一切公開されていない。セッション＋灯 membership（status:'active'）を確認できない
 * 限り、HTML本文を絶対に返さない。
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { blockProduction } from './_lib/http.js';
import { getSession, getMembership, getUser } from './_lib/store.js';
import { parseCookies } from './_lib/cookies.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, '_templates', 'tomoshibi-post.html');

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (blockProduction(res)) return;

  const cookies = parseCookies(req);
  try {
    const session = await getSession(cookies.ht_session);
    if (!session) return res.redirect(302, '/tomoshibi-login.html');

    const membership = await getMembership('tomoshibi', session.email);
    if (!membership || membership.status !== 'active') {
      return res.redirect(302, '/tomoshibi-login.html');
    }

    const user = await getUser(session.email);
    const displayName = user?.displayName || session.email.split('@')[0];

    // <script>タグ内への埋め込み用。JSON.stringifyはJS文字列としては安全だが、
    // 表示名に「</script>」が含まれるとタグを閉じてしまうため、'<' をUnicodeエスケープして防ぐ
    // （値そのものは変わらず、HTML/JSソース上に該当文字列が現れなくなるだけ）。
    // displayNameへの事前HTMLエスケープは行わない（.textContentで安全に描画されるため、
    // 二重エスケープすると &amp; 等が画面にそのまま表示されるバグになる）。
    const nicknameJson = JSON.stringify(displayName).replace(/</g, '\\u003c');
    const html = readFileSync(TEMPLATE_PATH, 'utf8')
      .replaceAll('{{DISPLAY_NAME_JSON}}', nicknameJson);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[tomoshibi-post-page] error:', err.message);
    return res.status(500).send('Internal Server Error');
  }
}

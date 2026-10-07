/**
 * api/haku-home.js
 * HAKU Community 会員ホームの実体。vercel.json のrewriteにより /haku-community/home/ は
 * このAPIに転送される。実HTMLは api/_templates/haku-community-home.html にあり、
 * 静的ファイルとしては一切公開されていない（このファイル経由でしか読めない）。
 *
 * セッション＋HAKU membership（status:'active'）を確認できない限り、
 * HTML本文を絶対に返さない（未ログインならログインページへ302リダイレクト）。
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { getSession, getMembership, getUser, getApplication, getAdminSession } from './_lib/store.js';
import { parseCookies } from './_lib/cookies.js';
import { renderHakuHome } from './_lib/haku-home-render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, '_templates', 'haku-community-home.html');

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const cookies = parseCookies(req);
  try {
    const session = await getSession(cookies.ht_session);
    if (!session) return res.redirect(302, '/haku-community/login/');

    // 完全紹介制：認証成功 AND Application承認済み AND Membership active の3条件が揃わない限り、
    // HTML本文を絶対に返さない。community-auth.js のログイン時にも同じ判定があるが、
    // ここがHOME本文を実際に返す最終防衛線のため、独立してもう一度確認する（多層防御）。
    // 'approved'（承認済み・決済前）と'paid'（決済完了後）の両方を許可する。
    // 'paid'はWebhook側がapproved済みApplicationにのみ付与する状態のため、'approved'の
    // 上位互換として扱ってよい（'pending'/'rejected'はここで弾かれる）。
    const application = await getApplication('haku', session.email);
    if (!application || (application.status !== 'approved' && application.status !== 'paid')) {
      return res.redirect(302, '/haku-community/login/');
    }

    // 'canceling'（解約予約済みだが現在の請求期間はまだ終了していない）は'active'と同じく
    // アクセスを許可する。実際のアクセス遮断は、期間終了時にWebhookがMembershipを
    // 'canceled'にしてから発生する（Stripeのcustomer.subscription.deletedが唯一の起点）。
    const membership = await getMembership('haku', session.email);
    if (!membership || (membership.status !== 'active' && membership.status !== 'canceling')) {
      return res.redirect(302, '/haku-community/login/');
    }

    const user = await getUser(session.email);
    const displayName = user?.displayName || session.email.split('@')[0];

    // 運営の管理画面へのリンクは、サーバー側で「有効な運営ログイン」を確認できた場合だけHTMLに含める
    // （一般会員のHTMLには、リンクの文字列自体が入らない）。確認に失敗したら安全側（表示しない）に倒す。
    let isAdmin = false;
    try { isAdmin = Boolean(await getAdminSession(cookies.ht_admin_session)); } catch { isAdmin = false; }

    const html = renderHakuHome(readFileSync(TEMPLATE_PATH, 'utf8'), { displayName, isAdmin });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[haku-home] error:', err.message);
    return res.status(500).send('Internal Server Error');
  }
}

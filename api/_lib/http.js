/**
 * lib/http.js
 * 新規API共通のガード。既存 api/haku-checkout.js と同じ安全思想（本番では絶対に動かさない・
 * Hostヘッダーをそのまま信用しない）を踏襲する。
 */

// 本番環境ではこの一連の新規認証APIを一切動かさない（Preview専用インフラのため）。
// 灯（tomoshibi）専用ページ（api/tomoshibi-post-page.js）はHAKU Community本番化後も
// 引き続きこれで本番ブロックする。
export function blockProduction(res) {
  if (process.env.VERCEL_ENV === 'production') {
    res.status(403).json({ error: 'このAPIは現在テスト環境（Preview）でのみ利用できます。' });
    return true;
  }
  return false;
}

// community単位での本番ゲート。HAKU CommunityのみProductionで解放し、灯（tomoshibi）は
// 引き続きProductionでブロックする（community-auth.js / admin.js のように両community を
// 同じファイルで扱うAPIで、community が判明した時点で呼ぶ）。
// 'haku' 以外（'tomoshibi'を含む）は、community が指定されていない場合も安全側に倒して
// ブロックする（意図しない新規community解放を防ぐ）。
export function blockProductionForCommunity(res, community) {
  if (process.env.VERCEL_ENV === 'production' && community !== 'haku') {
    res.status(403).json({ error: 'このAPIは現在テスト環境（Preview）でのみ利用できます。' });
    return true;
  }
  return false;
}

// success_url等と同じ考え方: Hostヘッダー由来の値は許可したホストだけ使う（オープンリダイレクト防止）
export function resolveBaseUrl(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  if (/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(host)) return `http://${host}`;
  if (/^[a-z0-9-]+\.vercel\.app$/.test(host)) return `https://${host}`;
  return null;
}

export function methodGuard(req, res, method) {
  if (req.method !== method) {
    res.setHeader('Allow', method);
    res.status(405).json({ error: 'Method not allowed' });
    return false;
  }
  return true;
}

// レート制限・監査ログのキーに使うクライアントIP。Vercelは x-forwarded-for の先頭が実クライアント。
export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// CSRF多層防御: state変更系POSTのOriginが自サイト以外なら拒否する（Cookie SameSite=Laxに加えた保険）。
export function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 一部の非ブラウザ/同一オリジン経由でOriginが付かないケースは許容
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
    return originHost === host;
  } catch {
    return false;
  }
}

// レート制限チェック＋超過時の429応答をまとめたヘルパー。呼び出し側は false が返ったら即returnする。
export async function rateLimitGuard(req, res, { key, limit, windowSeconds }) {
  const { checkRateLimit } = await import('./store.js');
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(`${key}:${ip}`, limit, windowSeconds);
  if (!allowed) {
    res.status(429).json({ error: 'しばらく時間をおいてから再度お試しください。' });
    return false;
  }
  return true;
}

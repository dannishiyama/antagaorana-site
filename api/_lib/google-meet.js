/**
 * api/_lib/google-meet.js
 * Google Meet の会議（スペース）を、Googleが正式に提供する「Google Meet REST API」（spaces.create）で作る。
 * URL文字列を自前で作ることはしない。必要な設定が揃っていなければ「未設定」として何も作らない。
 *
 * 必要な環境変数（値はVercelの環境変数にだけ置く。コードやチャットには書かない）:
 *   GOOGLE_MEET_CLIENT_ID       … Google Cloud の OAuth クライアントID
 *   GOOGLE_MEET_CLIENT_SECRET   … 同 クライアントシークレット
 *   GOOGLE_MEET_REFRESH_TOKEN   … 会議を作るGoogleアカウント（主催者）が一度だけ許可して得るリフレッシュトークン
 *                                （権限: https://www.googleapis.com/auth/meetings.space.created）
 *   GOOGLE_MEET_ACCESS_TYPE     … 省略可。OPEN / TRUSTED / RESTRICTED（Meet側の入室管理。省略時はGoogle側の既定）
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SPACES_URL = 'https://meet.googleapis.com/v2/spaces';
const ACCESS_TYPES = ['OPEN', 'TRUSTED', 'RESTRICTED'];

export class MeetError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

let fetchImpl = (...args) => fetch(...args);
export function __setFetchForTests(fn) { fetchImpl = fn || ((...args) => fetch(...args)); }

export function meetConfig() {
  const clientId = process.env.GOOGLE_MEET_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_MEET_CLIENT_SECRET || '';
  const refreshToken = process.env.GOOGLE_MEET_REFRESH_TOKEN || '';
  const accessType = String(process.env.GOOGLE_MEET_ACCESS_TYPE || '').toUpperCase();
  return {
    configured: Boolean(clientId && clientSecret && refreshToken),
    clientId, clientSecret, refreshToken,
    accessType: ACCESS_TYPES.includes(accessType) ? accessType : null,
  };
}

async function timedFetch(url, init, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetchImpl(url, { ...init, signal: ctrl.signal }); }
  catch (e) { throw new MeetError(e && e.name === 'AbortError' ? 'timeout' : 'network', 'Google への接続に失敗しました。'); }
  finally { clearTimeout(timer); }
}

async function getAccessToken(cfg) {
  const res = await timedFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken, grant_type: 'refresh_token' }).toString(),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data || !data.access_token) throw new MeetError('auth', `Googleの認証に失敗しました（${res.status}）。`);
  return data.access_token;
}

/** 新しい会議を1つ作り、{ spaceName, meetingUri, meetingCode } を返す。失敗したら MeetError。設定がなければ 'unconfigured'。 */
export async function createMeetSpace() {
  const cfg = meetConfig();
  if (!cfg.configured) throw new MeetError('unconfigured', 'Google Meet の連携が未設定です。');
  const token = await getAccessToken(cfg);
  const res = await timedFetch(SPACES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg.accessType ? { config: { accessType: cfg.accessType } } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data) throw new MeetError(res.status === 403 || res.status === 401 ? 'permission' : 'api', `Google Meet API がエラーを返しました（${res.status}）。`);
  const uri = String(data.meetingUri || '');
  if (!/^https:\/\/meet\.google\.com\/[a-z0-9-]+$/i.test(uri)) throw new MeetError('api', 'Google Meet API の応答にURLがありません。');
  return { spaceName: String(data.name || ''), meetingUri: uri, meetingCode: String(data.meetingCode || '') };
}

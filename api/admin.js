/**
 * api/admin.js
 * 管理画面（/haku-community/admin/）向けAPIをまとめた単一エンドポイント。
 * Vercel Hobbyプランのサーバーレス関数数上限（12個）に収めるため、
 * login / logout / bootstrap-admin / applications / approve / reject を1ファイルに集約している。
 *
 * 管理者認証は2方式を併用する（移行期間中の後方互換）:
 *   1. 個別アカウント方式（推奨・新方式）: ht_admin_user（email + passwordHash + role + active）
 *   2. 共有パスワード方式（旧方式）: HT_ADMIN_PASSWORD 環境変数
 * 個別アカウントが1件も存在しない間は、共有パスワードでログインして bootstrap-admin から
 * 最初の個別管理者アカウントを作成できる。1件でも個別アカウントが存在すれば、
 * 以後は「email一致する個別アカウントのパスワード」でのみログイン可能（共有パスワードは
 * 個別アカウント未作成の管理者を増やさないための最終手段としてのみ残す）。
 *
 * POST /api/admin?action=login                 { email?, password }
 * POST /api/admin?action=logout                 {}
 * POST /api/admin?action=bootstrap-admin        { sharedPassword, email, password }
 * POST /api/admin?action=bootstrap-super-admin  {}  （dan.nishiyama@antagaorana.com固定・メールでリンク送付）
 * POST /api/admin?action=set-admin-password     { token, password, password2 }
 * POST /api/admin?action=bootstrap-owner-haku-membership  {}  （dan.nishiyama@antagaorana.com固定。
 *   HAKU Community会員資格を、Stripe決済・紹介申請・承認を経ずに直接有効化する。
 *   これ以外のメールアドレスには一切適用されない。パスワードは本人がメールのリンクから設定する）
 * GET  /api/admin?action=applications&community=haku|tomoshibi&status=pending|approved|rejected|all（省略時pending）
 * GET  /api/admin?action=members&community=haku|tomoshibi&status=pending|approved|active|unpaid|rejected|inactive|all
 * GET  /api/admin?action=member-detail&email=...   （User/Application/Membershipを両コミュニティ横断で返す）
 * POST /api/admin?action=reset-test-member    { email, confirm }  （Preview限定・super_admin限定）
 * POST /api/admin?action=approve                { community, email }
 * POST /api/admin?action=reject                 { community, email }
 * GET  /api/admin?action=points-member&email=...     （HAKU POINT：会員1人の現在ポイントと全履歴）
 * GET  /api/admin?action=points-recent                   （HAKU POINT：全会員の直近の履歴）
 * POST /api/admin?action=points-grant   { email, amount, reason?, requestId }   （手動付与。管理者）
 * POST /api/admin?action=points-adjust  { email, amount(±), reason, requestId } （調整。管理者）
 * POST /api/admin?action=points-reverse { entryId, reason, requestId }           （取消。管理者）
 * GET  /api/admin?action=whoami                                                  （管理者ログインの確認。未ログインは ok:false）
 * GET  /api/admin?action=audit-log
 * GET  /api/admin?action=events-list
 * POST /api/admin?action=events-create          { title, type, startsAt, location, capacity, fee, itemsToBring, description, registration? }
 * POST /api/admin?action=events-update          { id, ...同上のうち変更したいフィールドのみ（registration: 'open'|'closed'|'cancelled'）}
 * POST /api/admin?action=events-delete          { id }
 * GET  /api/admin?action=events-participants&eventId=...
 * GET  /api/admin?action=posts
 * POST /api/admin?action=posts-moderate         { id, status: 'published'|'hidden' }
 * POST /api/admin?action=posts-delete           { id }
 * GET  /api/admin?action=notes-list             （HAKU NOTE／今週の問い。全件・全ステータス）
 * POST /api/admin?action=notes-create           { title?, body, supplement?, category?, type?, publishFrom?, publishUntil?, status? }
 * POST /api/admin?action=notes-update           { id, ...同上のうち変更したいフィールドのみ }
 * POST /api/admin?action=notes-set-status       { id, status: 'published'|'hidden' }
 * POST /api/admin?action=notes-delete           { id }
 */
import { timingSafeEqual } from 'crypto';
import { resolveBaseUrl, checkOrigin, rateLimitGuard, blockProductionForCommunity } from './_lib/http.js';
import {
  createAdminSession, deleteAdminSession, getAdminSession,
  listApplications, getApplication, createApplication, resolveApplication, setMembership, getMembership, createPasswordSetupToken,
  getAdminUser, saveAdminUser, anyAdminUserExists, logAudit, listAuditLog, getUser, saveUser,
  createEvent, listEvents, getEvent, deleteEvent, updateEvent, EVENT_REGISTRATION_VALUES, countEventParticipants, listEventParticipants,
  createAdminSetupToken, consumeAdminSetupToken,
  POST_CATEGORY_LABELS, listPostsForModeration, setPostStatus, deletePost,
  createSessionFixture, listSessionFixtures,
  createOfficialWord, getOfficialWord, listAllWords, updateOfficialWord, setOfficialWordStatus, deleteOfficialWord,
  HAKU_NOTE_CATEGORIES, createHakuNote, getHakuNote, listAllHakuNotes, updateHakuNote, setHakuNoteStatus, deleteHakuNote,
  resetTestMember,
  listEmailLogForRecipient,
} from './_lib/store.js';
import { randomToken, hashPassword, verifyPassword, stripSecrets } from './_lib/security.js';
import { createHakuCheckoutSession } from './_lib/stripe-checkout.js';
import { grantPoints, adjustPoints, reversePoints, getBalance, getAdminMemberView, listRecent, PointError } from './_lib/points.js';
import { setCookie, clearCookie, parseCookies } from './_lib/cookies.js';
import { sendPasswordSetupEmail, sendRejectionEmail, sendApprovalEmail, sendAdminSetupEmail } from './_lib/notify.js';

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function requireAdminHere(req, res) {
  const cookies = parseCookies(req);
  const session = await getAdminSession(cookies.ht_admin_session);
  if (!session) {
    res.status(401).json({ error: '管理者ログインが必要です。' });
    return null;
  }
  return session; // { admin:true, actorId, role }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const action = req.query?.action;

  try {
    if (action === 'login') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      if (!(await rateLimitGuard(req, res, { key: 'admin-login', limit: 10, windowSeconds: 15 * 60 }))) return;
      return await handleLogin(req, res);
    }
    if (action === 'logout') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      return await handleLogout(req, res);
    }
    if (action === 'bootstrap-admin') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      if (!(await rateLimitGuard(req, res, { key: 'admin-bootstrap', limit: 5, windowSeconds: 60 * 60 }))) return;
      return await handleBootstrapAdmin(req, res);
    }
    if (action === 'bootstrap-super-admin') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      if (!(await rateLimitGuard(req, res, { key: 'admin-bootstrap-super', limit: 5, windowSeconds: 60 * 60 }))) return;
      return await handleBootstrapSuperAdmin(req, res);
    }
    if (action === 'set-admin-password') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      return await handleSetAdminPassword(req, res);
    }
    if (action === 'bootstrap-owner-haku-membership') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      if (!(await rateLimitGuard(req, res, { key: 'owner-haku-bootstrap', limit: 5, windowSeconds: 60 * 60 }))) return;
      return await handleBootstrapOwnerHakuMembership(req, res);
    }
    // 管理画面を開き直したときに、有効な管理者ログイン（Cookie）が残っていれば画面を復元するための確認。
    if (action === 'whoami') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      // 未ログインでもエラー（401）にはせず ok:false を返す（画面を開くたびに、ブラウザのコンソールに赤いエラーが出ないように）。
      const session = await getAdminSession(parseCookies(req).ht_admin_session);
      if (!session) return res.status(200).json({ ok: false });
      return res.status(200).json({ ok: true, actorId: session.actorId, role: session.role || null });
    }
    if (action === 'applications') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleApplications(req, res);
    }
    if (action === 'approve') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleApprove(req, res, session);
    }
    if (action === 'reject') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleReject(req, res, session);
    }
    if (action === 'members') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleMembersList(req, res);
    }
    if (action === 'member-detail') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleMemberDetail(req, res);
    }
    // HAKU POINT（管理者による手動付与・調整・取消。会員本人の画面は api/community-auth.js の points-me）。
    // 閲覧・付与・調整・取消は、いずれも「ログイン済みの管理者」だけが実行できる（既存の管理者認証を再利用）。
    // 一般会員のCookie（ht_session）では実行できない。API側で必ず確認する（画面の表示/非表示には依存しない）。
    if (action === 'points-member') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handlePointsMember(req, res);
    }
    if (action === 'points-recent') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handlePointsRecent(req, res);
    }
    if (action === 'points-grant' || action === 'points-adjust' || action === 'points-reverse') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      if (!(await rateLimitGuard(req, res, { key: 'admin-points', limit: 60, windowSeconds: 15 * 60 }))) return;
      return await handlePointsWrite(req, res, session, action);
    }
    if (action === 'reset-test-member') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleResetTestMember(req, res, session);
    }
    if (action === 'audit-log') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireAdminHere(req, res); if (!session) return;
      const entries = await listAuditLog(200);
      return res.status(200).json({ ok: true, entries });
    }
    if (action === 'events-list') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleEventsListAdmin(req, res);
    }
    if (action === 'events-create') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleEventsCreate(req, res, session);
    }
    if (action === 'events-update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleEventsUpdate(req, res, session);
    }
    if (action === 'events-delete') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleEventsDelete(req, res, session);
    }
    if (action === 'events-participants') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleEventsParticipants(req, res);
    }
    if (action === 'sessions-create') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleSessionsCreate(req, res, session);
    }
    if (action === 'sessions-list') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleSessionsListAdmin(req, res);
    }
    if (action === 'words-list') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleWordsListAdmin(req, res);
    }
    if (action === 'words-create') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleWordsCreate(req, res, session);
    }
    if (action === 'words-update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleWordsUpdate(req, res, session);
    }
    if (action === 'words-set-status') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleWordsSetStatus(req, res, session);
    }
    if (action === 'words-delete') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleWordsDelete(req, res, session);
    }
    if (action === 'notes-list') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleNotesListAdmin(req, res);
    }
    if (action === 'notes-create') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleNotesCreate(req, res, session);
    }
    if (action === 'notes-update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleNotesUpdate(req, res, session);
    }
    if (action === 'notes-set-status') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleNotesSetStatus(req, res, session);
    }
    if (action === 'notes-delete') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handleNotesDelete(req, res, session);
    }
    if (action === 'posts') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handlePostsAdmin(req, res);
    }
    if (action === 'posts-moderate') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handlePostsModerate(req, res, session);
    }
    if (action === 'posts-delete') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      const session = await requireAdminHere(req, res); if (!session) return;
      return await handlePostsDeleteAdmin(req, res, session);
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(`[admin:${action}] error:`, err.message);
    return res.status(500).json({ error: '処理に失敗しました。' });
  }
}

async function handleLogin(req, res) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!password) return res.status(401).json({ error: 'パスワードが違います。' });

  // 方式1: 個別アカウント（emailが指定されている場合はこちらを優先して試す）
  if (email) {
    const admin = await getAdminUser(email);
    if (admin && admin.active && (await verifyPassword(password, admin.passwordHash))) {
      const sessionId = await createAdminSession({ actorId: admin.email, role: admin.role });
      setCookie(res, 'ht_admin_session', sessionId, { maxAgeSeconds: 12 * 60 * 60 });
      await logAudit({ actorId: admin.email, action: 'admin_login', metadata: { method: 'individual' } });
      return res.status(200).json({ ok: true, email: admin.email, role: admin.role });
    }
    // 個別アカウントが1件でも存在する体制になったら、共有パスワードへのフォールバックはしない。
    if (await anyAdminUserExists()) {
      return res.status(401).json({ error: 'メールアドレスまたはパスワードが違います。' });
    }
  }

  // 方式2: 共有パスワード（旧方式。個別アカウントが1件も無い間の後方互換のみ）
  if (process.env.HT_ADMIN_PASSWORD && safeEqual(password, process.env.HT_ADMIN_PASSWORD) && !(await anyAdminUserExists())) {
    const sessionId = await createAdminSession({ actorId: 'shared-password', role: 'super_admin' });
    setCookie(res, 'ht_admin_session', sessionId, { maxAgeSeconds: 12 * 60 * 60 });
    await logAudit({ actorId: 'shared-password', action: 'admin_login', metadata: { method: 'legacy_shared' } });
    return res.status(200).json({ ok: true, legacy: true });
  }

  return res.status(401).json({ error: 'メールアドレスまたはパスワードが違います。' });
}

async function handleLogout(req, res) {
  const cookies = parseCookies(req);
  await deleteAdminSession(cookies.ht_admin_session);
  clearCookie(res, 'ht_admin_session');
  return res.status(200).json({ ok: true });
}

// 個別管理者アカウントの初回作成。共有パスワードを知っている人だけが実行でき、
// かつ個別アカウントが1件も無い間だけ有効（一度誰かが作成したら以後は無効）。
async function handleBootstrapAdmin(req, res) {
  if (!process.env.HT_ADMIN_PASSWORD) {
    return res.status(500).json({ error: '管理画面の設定が完了していません。' });
  }
  if (await anyAdminUserExists()) {
    return res.status(409).json({ error: 'すでに管理者アカウントが作成されています。管理者にログイン情報を確認してください。' });
  }
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const sharedPassword = String(body.sharedPassword || '');
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!safeEqual(sharedPassword, process.env.HT_ADMIN_PASSWORD)) {
    return res.status(401).json({ error: '共有パスワードが違います。' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'メールアドレスの形式をご確認ください。' });
  if (password.length < 8) return res.status(400).json({ error: 'パスワードは8文字以上でご設定ください。' });

  const passwordHash = await hashPassword(password);
  await saveAdminUser({ email, passwordHash, role: 'super_admin', active: true });
  await logAudit({ actorId: email, action: 'admin_bootstrap', metadata: { role: 'super_admin' } });

  const sessionId = await createAdminSession({ actorId: email, role: 'super_admin' });
  setCookie(res, 'ht_admin_session', sessionId, { maxAgeSeconds: 12 * 60 * 60 });
  return res.status(200).json({ ok: true, email });
}

async function handleApplications(req, res) {
  const community = req.query?.community === 'haku' ? 'haku' : 'tomoshibi';
  if (blockProductionForCommunity(res, community)) return;
  const status = ['pending', 'approved', 'rejected', 'all'].includes(req.query?.status) ? req.query.status : 'pending';
  const applications = await listApplications(community, status);
  return res.status(200).json({ ok: true, community, status, applications });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 会員一覧（User / Application / Membership を横断確認）
// Applicationの全件索引（listApplications）を母集団とし、User・Membershipを結合して返す。
// 50人規模のためN+1気味のPromise.allでも問題ない（既存のイベント参加者集計等と同じ方針）。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleMembersList(req, res) {
  const community = req.query?.community === 'haku' ? 'haku' : 'tomoshibi';
  if (blockProductionForCommunity(res, community)) return;
  const filter = req.query?.status || 'all';
  const applications = await listApplications(community, 'all');

  const members = await Promise.all(applications.map(async (app) => {
    const [user, membership] = await Promise.all([
      getUser(app.email),
      getMembership(community, app.email),
    ]);
    return {
      email: app.email,
      fullName: user?.fullName || app.fullName,
      fullNameKana: user?.fullNameKana || app.fullNameKana,
      displayName: user?.displayName || app.displayName,
      referrerName: app.referrerName,
      community,
      applicationStatus: app.status,
      membershipStatus: membership?.status || null,
      stripeCustomerId: membership?.stripeCustomerId || null,
      stripeSubscriptionId: membership?.stripeSubscriptionId || null,
      submittedAt: app.submittedAt,
      reviewedAt: app.reviewedAt,
      reviewedBy: app.reviewedBy,
      lastLoginAt: user?.lastLoginAt || null,
      // HAKUポイントは会員資格（Membership）がある人だけ。未決済・審査中・却下の人には持たせない。
      points: community === 'haku' && membership ? await getBalance(app.email) : null,
      canOperatePoints: community === 'haku' && isPointEligible(membership),
    };
  }));

  const filtered = members.filter((m) => {
    switch (filter) {
      case 'pending': return m.applicationStatus === 'pending';
      case 'approved': return m.applicationStatus === 'approved' || m.applicationStatus === 'paid';
      case 'active': return m.membershipStatus === 'active' || m.membershipStatus === 'canceling';
      case 'unpaid': return m.applicationStatus === 'approved' && m.membershipStatus !== 'active';
      case 'rejected': return m.applicationStatus === 'rejected';
      case 'inactive': return m.membershipStatus === 'canceled' || m.membershipStatus === 'past_due';
      default: return true;
    }
  });
  filtered.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

  return res.status(200).json({ ok: true, community, status: filter, members: filtered });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HAKU POINT（管理画面側）。保存・検証・二重操作防止は api/_lib/points.js（台帳）が担当し、
// ここでは「管理者かどうか」「対象がHAKU会員か」の確認と応答の整形だけを行う。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ポイントを付与・調整できるのは「現在の会員」（有効 / 解約予約中でまだ利用可）だけ。
// 解約済み・支払い遅延・会員資格が未作成の人には付与しない（誤付与の防止）。
function isPointEligible(membership) {
  return Boolean(membership) && (membership.status === 'active' || membership.status === 'canceling');
}

function respondPointError(res, err) {
  if (err instanceof PointError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

async function handlePointsMember(req, res) {
  const email = String(req.query?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'メールアドレスを指定してください。' });
  const membership = await getMembership('haku', email);
  if (!membership) return res.status(404).json({ error: '対象のHAKU Community会員が見つかりません。' });
  const [view, user] = await Promise.all([getAdminMemberView(email), getUser(email)]);
  return res.status(200).json({
    ok: true, email, membershipStatus: membership.status, canOperate: isPointEligible(membership),
    fullName: user?.fullName || '', displayName: user?.displayName || '', ...view,
  });
}

// 全会員のポイント操作履歴（新しい順）。会員名を付けて返す（会員名はUserから解決。台帳には重複保存しない）。
async function handlePointsRecent(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 100, 1), 200);
  const entries = await listRecent(limit);
  const emails = [...new Set(entries.map((e) => e.email))];
  const users = await Promise.all(emails.map((email) => getUser(email)));
  const byEmail = new Map(emails.map((email, i) => [email, users[i]]));
  return res.status(200).json({
    ok: true,
    entries: entries.map((e) => ({ ...e, fullName: byEmail.get(e.email)?.fullName || '', displayName: byEmail.get(e.email)?.displayName || '' })),
  });
}

async function handlePointsWrite(req, res, session, action) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const actorId = session.actorId;
  try {
    let result;
    if (action === 'points-reverse') {
      result = await reversePoints({ entryId: body.entryId, reason: body.reason, requestId: body.requestId, actorId });
    } else {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: '対象会員を指定してください。' });
      const membership = await getMembership('haku', email);
      if (!membership) return res.status(404).json({ error: '対象のHAKU Community会員が見つかりません。', code: 'not_member' });
      if (!isPointEligible(membership)) {
        return res.status(409).json({ error: '現在有効なHAKU Community会員ではないため、ポイントを付与・調整できません。', code: 'not_active_member' });
      }
      const fn = action === 'points-grant' ? grantPoints : adjustPoints;
      result = await fn({ email, amount: body.amount, reason: body.reason, requestId: body.requestId, actorId });
    }
    return res.status(200).json({ ok: true, duplicate: result.duplicate, entry: result.entry, balance: result.balance });
  } catch (err) {
    return respondPointError(res, err);
  }
}

// 会員詳細：同一emailについて、両コミュニティ（haku/灯）のApplication・Membershipと
// User（1件しか存在し得ない設計）をまとめて返す。「重複User」は正規化されたemailごとに
// Redisキーが一意なため構造的に発生しないが、両コミュニティにまたがる活動状況は
// ここで一目で確認できる。
async function handleMemberDetail(req, res) {
  const email = String(req.query?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'メールアドレスを指定してください。' });
  const [user, hakuApplication, hakuMembership, tomoshibiApplication, tomoshibiMembership, emailLog] = await Promise.all([
    getUser(email),
    getApplication('haku', email),
    getMembership('haku', email),
    getApplication('tomoshibi', email),
    getMembership('tomoshibi', email),
    listEmailLogForRecipient(email, 30),
  ]);
  // パスワードのハッシュ等はブラウザへ返さない（保存データは変更しない）。
  return res.status(200).json(stripSecrets({
    ok: true,
    email,
    user,
    haku: { application: hakuApplication, membership: hakuMembership },
    tomoshibi: { application: tomoshibiApplication, membership: tomoshibiMembership },
    emailLog,
  }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Preview限定：テストメールアドレスの完全リセット
// - super_admin権限必須（一般管理者は不可）
// - VERCEL_ENV===production では即403（本番データへの誤操作を防ぐ専用ガード）
// - 削除前確認必須：bodyのconfirmが対象emailと完全一致しない限り実行しない
// - Stripeのtest subscriptionが残っていれば先にキャンセルを試みる（失敗しても続行）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleResetTestMember(req, res, session) {
  if (process.env.VERCEL_ENV === 'production') {
    return res.status(403).json({ error: 'この機能は本番環境では利用できません。' });
  }
  if (session.role !== 'super_admin') {
    return res.status(403).json({ error: 'この操作にはsuper_admin権限が必要です。' });
  }
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'メールアドレスを指定してください。' });
  if (String(body.confirm || '').trim().toLowerCase() !== email) {
    return res.status(400).json({ error: '確認のため、削除対象のメールアドレスをもう一度正確にご入力ください。' });
  }

  let stripeNote = 'none';
  const membership = await getMembership('haku', email);
  if (membership?.stripeSubscriptionId) {
    const secretKey = process.env.STRIPE_SECRET_KEY || '';
    if (/^(sk|rk)_test_/.test(secretKey)) {
      try {
        const { default: Stripe } = await import('stripe');
        const stripe = new Stripe(secretKey);
        await stripe.subscriptions.cancel(membership.stripeSubscriptionId);
        stripeNote = 'subscription_canceled';
      } catch (err) {
        console.error('[admin:reset-test-member] Stripe cancel failed:', err.message);
        stripeNote = 'cancel_failed';
      }
    } else {
      stripeNote = 'skipped_no_test_key';
    }
  }

  const result = await resetTestMember(email);
  await logAudit({
    actorId: session.actorId,
    action: 'test_member_reset',
    targetId: email,
    metadata: { stripeNote, removed: result.removed, hadUser: result.hadUser },
  });
  return res.status(200).json({ ok: true, ...result, stripeNote });
}

async function handleApprove(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const community = body.community === 'haku' ? 'haku' : 'tomoshibi';
  if (blockProductionForCommunity(res, community)) return;
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'メールアドレスを指定してください。' });

  const baseUrl = resolveBaseUrl(req);
  if (!baseUrl) return res.status(400).json({ error: 'Invalid host' });

  const application = await getApplication(community, email);
  if (!application || application.status !== 'pending') {
    // 既にapproved/rejected済みの場合はここで404になるため、承認ボタンの二重クリックで
    // 複数メール・複数Membership活性化が発生することは構造的に起きない（idempotent）。
    return res.status(404).json({ error: '保留中の申請が見つかりません。' });
  }

  await resolveApplication(community, email, 'approved', session.actorId);

  // 灯（tomoshibi）は決済不要のため、承認と同時に利用開始してよい。
  // HAKU Community は完全紹介制＋決済必須のため、承認だけではMembershipを有効化しない。
  // Membershipが実際にactiveになるのは、承認後にStripe決済が完了しWebhookが確認してから
  // （api/haku-stripe-webhook.js 側で「承認済みApplicationのみ」を条件に有効化する）。
  if (community === 'tomoshibi') {
    await setMembership(community, email, { status: 'active', activatedAt: Date.now(), source: 'admin' });
  }

  // 登録時（api/community-auth.js?action=register）に既にパスワードを設定済みのはずなので、
  // 通常はログイン案内メールのみでよい。万一パスワード未設定（旧フローの名残）であれば、
  // フォールバックとしてパスワード設定リンクを送る。
  const user = await getUser(email);
  if (user?.passwordHash) {
    let ctaUrl, ctaLabel;
    if (community === 'haku') {
      const membership = await getMembership(community, email);
      if (membership?.status === 'active') {
        // 通常はここに来ない（決済前に承認するため）。手動でMembershipを与えたケース等の保険。
        ctaUrl = `${baseUrl}/haku-community/login/`;
        ctaLabel = 'ログインする';
      } else {
        // 承認済みApplicationに対して、その場でStripe Checkout Sessionを安全に生成し、
        // そのURLをメールのCTAに使う（固定URLのハードコードはしない）。
        // Stripe側の一時的な不調等でセッション作成に失敗しても承認処理自体は失敗させず、
        // フォールバックとして新規登録ページ（既存の「resumed」導線）へ誘導する。
        try {
          const checkoutSession = await createHakuCheckoutSession({ email, baseUrl });
          ctaUrl = checkoutSession.url;
          ctaLabel = 'お支払いへ進む';
        } catch (err) {
          console.error('[admin:approve] Stripe checkout session creation failed, falling back:', err.message);
          ctaUrl = `${baseUrl}/haku-community/register/`;
          ctaLabel = 'お支払いへ進む';
        }
      }
    }
    await sendApprovalEmail({ community, email, displayName: application.displayName, baseUrl, ctaUrl, ctaLabel });
  } else {
    const token = randomToken(32);
    await createPasswordSetupToken(token, {
      email, community,
      fullName: application.fullName,
      fullNameKana: application.fullNameKana,
      displayName: application.displayName,
    });
    await sendPasswordSetupEmail({ community, email, displayName: application.displayName, token, baseUrl, purpose: 'welcome' });
  }
  await logAudit({ actorId: session.actorId, action: 'application_approved', targetId: email, metadata: { targetType: 'Application', community } });

  return res.status(200).json({ ok: true });
}

async function handleReject(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const community = body.community === 'haku' ? 'haku' : 'tomoshibi';
  if (blockProductionForCommunity(res, community)) return;
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'メールアドレスを指定してください。' });

  const application = await getApplication(community, email);
  if (!application || application.status !== 'pending') {
    return res.status(404).json({ error: '保留中の申請が見つかりません。' });
  }
  // resolveApplicationは status='pending' の1件のみを対象にするため、二重却下・二重メール送信は
  // 構造的に発生しない（2回目の呼び出しは上のガードで404になる）。
  await resolveApplication(community, email, 'rejected', session.actorId);
  try {
    await sendRejectionEmail({ community, email, displayName: application.displayName });
  } catch (err) {
    console.error('[admin:reject] rejection email failed:', err.message);
  }
  await logAudit({ actorId: session.actorId, action: 'application_rejected', targetId: email, metadata: { targetType: 'Application', community } });

  return res.status(200).json({ ok: true });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// イベント管理（HAKU MORNING / HAKU MEET / ボランティア）
// v1は50人規模のため、一覧・作成のみの簡易UIでよい（元設計書 11章）。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleEventsListAdmin(req, res) {
  const events = await listEvents('haku');
  const enriched = await Promise.all(events.map(async (e) => ({
    ...e,
    participantCount: await countEventParticipants(e.id),
  })));
  // 日ごとの朝の集まり（会員の参加表明で成立）は、参加者がいる日だけ出す（誰もいない日は「開催予定なし」）
  return res.status(200).json({ ok: true, events: enriched.filter((e) => e.kind !== 'morning-day' || e.participantCount > 0) });
}

async function handleEventsCreate(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const title = String(body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'タイトルを入力してください。' });

  const event = await createEvent('haku', {
    type: body.type,
    title,
    startsAt: body.startsAt || null,
    location: String(body.location || '').trim(),
    description: String(body.description || '').trim(),
    capacity: body.capacity,
    fee: String(body.fee || '').trim(),
    itemsToBring: String(body.itemsToBring || '').trim(),
    registration: body.registration,
    createdBy: session.actorId,
  });
  await logAudit({ actorId: session.actorId, action: 'event_created', targetId: event.id, metadata: { targetType: 'Event', title } });
  return res.status(200).json({ ok: true, event });
}

async function handleEventsUpdate(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const id = String(body.id || '').trim();
  if (!id) return res.status(400).json({ error: 'idを指定してください。' });
  const existing = await getEvent(id);
  if (!existing || existing.community !== 'haku') return res.status(404).json({ error: 'イベントが見つかりません。' });

  const fields = {};
  ['title', 'type', 'location', 'description', 'fee', 'itemsToBring', 'capacity', 'startsAt', 'registration'].forEach((f) => {
    if (body[f] !== undefined) fields[f] = typeof body[f] === 'string' ? body[f].trim() : body[f];
  });
  // 受付状況（open=受付中 / closed=受付終了 / cancelled=中止）。それ以外の値は受け付けない。
  if (fields.registration !== undefined && !EVENT_REGISTRATION_VALUES.includes(fields.registration)) {
    return res.status(400).json({ error: '受付状況の値が正しくありません。' });
  }
  const updated = await updateEvent(id, fields);
  await logAudit({ actorId: session.actorId, action: 'event_updated', targetId: id, metadata: { targetType: 'Event', ...(fields.registration !== undefined ? { registration: fields.registration } : {}) } });
  return res.status(200).json({ ok: true, event: updated });
}

async function handleEventsDelete(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const id = String(body.id || '').trim();
  if (!id) return res.status(400).json({ error: 'idを指定してください。' });

  const ok = await deleteEvent(id);
  if (!ok) return res.status(404).json({ error: 'イベントが見つかりません。' });
  await logAudit({ actorId: session.actorId, action: 'event_deleted', targetId: id, metadata: { targetType: 'Event' } });
  return res.status(200).json({ ok: true });
}

async function handleEventsParticipants(req, res) {
  const eventId = String(req.query?.eventId || '').trim();
  if (!eventId) return res.status(400).json({ error: 'eventIdを指定してください。' });
  const event = await getEvent(eventId);
  if (!event) return res.status(404).json({ error: 'イベントが見つかりません。' });

  const emails = await listEventParticipants(eventId);
  const users = await Promise.all(emails.map((email) => getUser(email)));
  const participants = emails.map((email, i) => ({ email, displayName: users[i]?.displayName || 'メンバー' }));
  return res.status(200).json({ ok: true, participants });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 「ことば」モデレーション（既存admin認証をそのまま再利用。新しい別adminシステムは作らない）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handlePostsAdmin(req, res) {
  const posts = await listPostsForModeration('haku');
  const emails = [...new Set(posts.map((p) => p.authorEmail))];
  const users = await Promise.all(emails.map((email) => getUser(email)));
  const nameByEmail = new Map(emails.map((email, i) => [email, users[i]?.displayName || 'メンバー']));
  const enriched = posts.map((p) => ({
    ...p,
    displayName: nameByEmail.get(p.authorEmail) || 'メンバー',
    categoryLabel: POST_CATEGORY_LABELS[p.category] || p.category,
  }));
  return res.status(200).json({ ok: true, posts: enriched });
}

async function handlePostsModerate(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const id = String(body.id || '').trim();
  const status = body.status === 'published' ? 'published' : body.status === 'hidden' ? 'hidden' : null;
  if (!id || !status) return res.status(400).json({ error: 'idとstatusを指定してください。' });

  const updated = await setPostStatus(id, status);
  if (!updated) return res.status(404).json({ error: '投稿が見つかりません。' });
  await logAudit({ actorId: session.actorId, action: 'post_moderated', targetId: id, metadata: { targetType: 'CommunityPost', status } });
  return res.status(200).json({ ok: true });
}

async function handlePostsDeleteAdmin(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const id = String(body.id || '').trim();
  if (!id) return res.status(400).json({ error: 'idを指定してください。' });

  const ok = await deletePost(id);
  if (!ok) return res.status(404).json({ error: '投稿が見つかりません。' });
  await logAudit({ actorId: session.actorId, action: 'post_deleted_by_admin', targetId: id, metadata: { targetType: 'CommunityPost' } });
  return res.status(200).json({ ok: true });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// super_admin個別アカウントの安全な初回発行（Dan専用の一度きりの導線）。
// 平文パスワードはここでは一切扱わない：本人にメールでリンクを送り、
// 本人がそのリンク先でパスワードを入力・ハッシュ化して保存する（api/admin.js?action=set-admin-password）。
// 個別管理者アカウントが1件でも既に存在する場合は常に409（何度呼んでも安全）。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SUPER_ADMIN_BOOTSTRAP_EMAIL = 'dan.nishiyama@antagaorana.com';

async function handleBootstrapSuperAdmin(req, res) {
  // 他に既存の管理者アカウント（例: 検証用アカウント）があっても構わない。
  // このアクションは dan.nishiyama@antagaorana.com 専用で、その本人アカウントが
  // まだ無い場合にのみ動く（グローバルに「管理者が1人もいない」ことは条件にしない）。
  const existing = await getAdminUser(SUPER_ADMIN_BOOTSTRAP_EMAIL);
  if (existing) {
    return res.status(409).json({ error: `${SUPER_ADMIN_BOOTSTRAP_EMAIL} は既に管理者アカウントが作成されています。` });
  }
  const baseUrl = resolveBaseUrl(req);
  if (!baseUrl) return res.status(400).json({ error: 'Invalid host' });

  const token = randomToken(32);
  await createAdminSetupToken(token, { email: SUPER_ADMIN_BOOTSTRAP_EMAIL });
  await sendAdminSetupEmail({ email: SUPER_ADMIN_BOOTSTRAP_EMAIL, token, baseUrl });
  await logAudit({ actorId: 'system', action: 'admin_bootstrap_requested', metadata: { targetType: 'AdminUser', email: SUPER_ADMIN_BOOTSTRAP_EMAIL } });
  return res.status(200).json({ ok: true, message: `${SUPER_ADMIN_BOOTSTRAP_EMAIL} 宛に設定リンクを送信しました。` });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HAKU Community オーナー会員資格の安全な初回発行（Dan専用の一度きりの導線）。
// dan.nishiyama@antagaorana.com 固定。紹介申請・管理者審査・Stripe決済のいずれも経由せず、
// Application を'paid'、Membershipを'active'として直接発行する（stripeSubscriptionIdは
// 持たない＝実際のサブスクリプションは存在しない、オーナー専用の特例アカウント）。
// これ以外のメールアドレスには絶対に適用されない（定数で固定、リクエストからの
// email指定は一切受け付けない）。平文パスワードはここでは一切扱わない：本人にメールで
// リンクを送り、本人がそのリンク先でパスワードを入力・ハッシュ化して保存する
// （api/community-auth.js?action=set-password、既存の一般会員と全く同じ導線）。
// 既にMembershipがactiveの場合は常に409（何度呼んでも安全＝idempotent）。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleBootstrapOwnerHakuMembership(req, res) {
  const email = SUPER_ADMIN_BOOTSTRAP_EMAIL;
  const community = 'haku';

  const existingMembership = await getMembership(community, email);
  if (existingMembership?.status === 'active') {
    return res.status(409).json({ error: `${email} は既にHAKU Community会員として有効化されています。` });
  }

  const baseUrl = resolveBaseUrl(req);
  if (!baseUrl) return res.status(400).json({ error: 'Invalid host' });

  let application = await getApplication(community, email);
  if (!application) {
    application = await createApplication(community, {
      email,
      fullName: 'Dan Nishiyama',
      fullNameKana: 'だんにしやま',
      displayName: 'Dan',
      reason: 'HAKU Communityオーナーアカウント（システムにより自動発行）',
      referrerName: '（オーナーアカウントのため対象外）',
    });
  }
  if (application.status !== 'paid') {
    application = await resolveApplication(community, email, 'paid', 'system-owner-bootstrap');
  }

  const existingUser = await getUser(email);
  if (!existingUser) {
    await saveUser({ email, fullName: 'Dan Nishiyama', fullNameKana: 'だんにしやま', displayName: 'Dan' });
  }

  await setMembership(community, email, {
    status: 'active',
    activatedAt: Date.now(),
    source: 'owner-bootstrap',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
  });

  let emailSent = false;
  const refreshedUser = await getUser(email);
  if (!refreshedUser?.passwordHash) {
    const token = randomToken(32);
    await createPasswordSetupToken(token, { email, community, displayName: 'Dan' });
    await sendPasswordSetupEmail({ community, email, displayName: 'Dan', token, baseUrl, purpose: 'welcome' });
    emailSent = true;
  }

  await logAudit({ actorId: 'system', action: 'owner_haku_membership_bootstrap', targetId: email, metadata: { community, emailSent } });
  return res.status(200).json({ ok: true, email, emailSent, message: emailSent ? `${email} 宛にパスワード設定リンクを送信しました。` : 'パスワードは既に設定済みのため、既存パスワードでログインできます。' });
}

async function handleSetAdminPassword(req, res) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const token = String(body.token || '').trim();
  const password = String(body.password || '');
  const password2 = String(body.password2 || '');
  if (!token) return res.status(400).json({ error: '不正なリンクです。' });
  if (password.length < 8) return res.status(400).json({ error: 'パスワードは8文字以上でご設定ください。' });
  if (password !== password2) return res.status(400).json({ error: 'パスワードが一致しません。' });

  const data = await consumeAdminSetupToken(token);
  if (!data) return res.status(400).json({ error: 'リンクの有効期限が切れているか、すでに使用されています。' });

  const passwordHash = await hashPassword(password);
  await saveAdminUser({ email: data.email, passwordHash, role: 'super_admin', active: true });
  await logAudit({ actorId: data.email, action: 'admin_bootstrap', metadata: { targetType: 'AdminUser', role: 'super_admin' } });

  const sessionId = await createAdminSession({ actorId: data.email, role: 'super_admin' });
  setCookie(res, 'ht_admin_session', sessionId, { maxAgeSeconds: 12 * 60 * 60 });
  return res.status(200).json({ ok: true, email: data.email });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// セッション音声（Preview fixture）：既存/community管理画面の「セッション音声を追加」フォームと
// 同じ項目（対象メンバー・タイトル・種別・時間・URL・説明・チャプター）をRedisで再現する。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const FIXTURE_TAG_MAP = {
  personal: 'マイセッション', do: '導 — 自己を導く力', haku: '拓 — 未来を拓く行動',
  me: '芽 — 可能性の芽吹き', etsu: '越 — 枠を越える', morning: '朝のメッセージ',
};

async function handleSessionsCreate(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const targetEmail = String(body.targetEmail || '').trim().toLowerCase();
  const title = String(body.title || '').trim();
  if (!targetEmail) return res.status(400).json({ error: 'メールアドレスを指定してください。' });
  if (!title) return res.status(400).json({ error: 'タイトルを入力してください。' });

  const chaptersRaw = String(body.chaptersRaw || '').trim();
  const chapters = chaptersRaw
    ? chaptersRaw.split('\n').map((l) => l.trim()).filter((l) => l && l.includes('|')).map((line) => {
        const sep = line.indexOf('|');
        const timeSec = parseInt(line.slice(0, sep).trim(), 10);
        const chTitle = line.slice(sep + 1).trim();
        return Number.isNaN(timeSec) ? null : { time: timeSec, title: chTitle };
      }).filter(Boolean)
    : [];

  const record = await createSessionFixture(targetEmail, {
    title,
    tag: FIXTURE_TAG_MAP[body.type] || 'マイセッション',
    dur: String(body.dur || '').trim(),
    url: String(body.url || '').trim(),
    desc: String(body.desc || '').trim(),
    chapters,
  });
  await logAudit({ actorId: session.actorId, action: 'session_fixture_created', targetId: record.id, metadata: { targetType: 'SessionFixture', targetEmail } });
  return res.status(200).json({ ok: true, session: record });
}

async function handleSessionsListAdmin(req, res) {
  const email = String(req.query?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'emailを指定してください。' });
  const sessions = await listSessionFixtures(email);
  return res.status(200).json({ ok: true, sessions });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 運営からのことば（管理画面）
// 音声はファイル直接アップロードではなくURL入力方式とする（既存セッションフィクスチャの
// 「音声URL」と同じ考え方。新しいStorageサービスを増やさないための意図的な選択）。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function validateWordFields(body) {
  const title = String(body.title || '').trim().slice(0, 80);
  const bodyText = String(body.body || '').trim();
  const audioUrl = String(body.audioUrl || '').trim();
  if (!bodyText && !audioUrl) return { error: '本文または音声URLのどちらか一方は必須です。' };
  if (bodyText.length > 2000) return { error: '本文は2000文字以内でご入力ください。' };
  if (audioUrl && !/^https:\/\//.test(audioUrl)) return { error: '音声URLはhttps://で始まる形式でご入力ください。' };
  const authorName = String(body.authorName || '').trim().slice(0, 40) || 'HAKU運営';
  return { title, body: bodyText, audioUrl, authorName };
}

async function handleWordsListAdmin(req, res) {
  const words = await listAllWords();
  return res.status(200).json({ ok: true, words });
}

async function handleWordsCreate(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const validated = validateWordFields(body);
  if (validated.error) return res.status(400).json({ error: validated.error });
  const publishedAt = body.publishedAt ? new Date(body.publishedAt).getTime() : undefined;
  const status = body.status === 'hidden' ? 'hidden' : 'published';
  const word = await createOfficialWord({ ...validated, publishedAt, status });
  await logAudit({ actorId: session.actorId, action: 'official_word_created', targetId: word.id, metadata: { targetType: 'OfficialWord' } });
  return res.status(200).json({ ok: true, word });
}

async function handleWordsUpdate(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const id = String(body.id || '').trim();
  if (!id) return res.status(400).json({ error: 'idを指定してください。' });
  const existing = await getOfficialWord(id);
  if (!existing) return res.status(404).json({ error: '投稿が見つかりません。' });

  const validated = validateWordFields({
    title: body.title, body: body.body, audioUrl: body.audioUrl, authorName: body.authorName,
  });
  if (validated.error) return res.status(400).json({ error: validated.error });
  const publishedAt = body.publishedAt ? new Date(body.publishedAt).getTime() : undefined;
  const word = await updateOfficialWord(id, { ...validated, publishedAt });
  await logAudit({ actorId: session.actorId, action: 'official_word_updated', targetId: id, metadata: { targetType: 'OfficialWord' } });
  return res.status(200).json({ ok: true, word });
}

async function handleWordsSetStatus(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const id = String(body.id || '').trim();
  const status = body.status === 'published' ? 'published' : body.status === 'hidden' ? 'hidden' : null;
  if (!id || !status) return res.status(400).json({ error: 'idとstatusを指定してください。' });
  const word = await setOfficialWordStatus(id, status);
  if (!word) return res.status(404).json({ error: '投稿が見つかりません。' });
  await logAudit({ actorId: session.actorId, action: 'official_word_status_changed', targetId: id, metadata: { targetType: 'OfficialWord', status } });
  return res.status(200).json({ ok: true, word });
}

async function handleWordsDelete(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const id = String(body.id || '').trim();
  if (!id) return res.status(400).json({ error: 'idを指定してください。' });
  const ok = await deleteOfficialWord(id);
  if (!ok) return res.status(404).json({ error: '投稿が見つかりません。' });
  await logAudit({ actorId: session.actorId, action: 'official_word_deleted', targetId: id, metadata: { targetType: 'OfficialWord' } });
  return res.status(200).json({ ok: true });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HAKU NOTE（「今週の問い」）管理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function validateNoteFields(body) {
  const title = String(body.title || '').trim().slice(0, 100);
  const bodyText = String(body.body || '').trim();
  if (!bodyText) return { error: '問い本文は必須です。' };
  if (bodyText.length > 2000) return { error: '本文は2000文字以内でご入力ください。' };
  const supplement = String(body.supplement || '').trim().slice(0, 1000);
  const category = HAKU_NOTE_CATEGORIES.includes(body.category) ? body.category : '';
  const type = ['weekly_question', 'note', 'audio', 'video'].includes(body.type) ? body.type : 'weekly_question';
  return { title, body: bodyText, supplement, category, type };
}

// <input type="datetime-local"> は "YYYY-MM-DDTHH:mm"（タイムゾーン情報なし）を返す。
// 管理画面の入力者は日本時間のつもりで入力するため、サーバー実行環境（Vercel=UTC）の
// ローカル時刻として解釈されないよう、明示的に+09:00を付与してからパースする。
function parseJstDatetimeLocal(value) {
  if (!value) return NaN;
  const hasOffset = /Z$|[+-]\d\d:\d\d$/.test(value);
  const withSeconds = /T\d\d:\d\d$/.test(value) ? `${value}:00` : value;
  return new Date(hasOffset ? withSeconds : `${withSeconds}+09:00`).getTime();
}

function parseNotePublishWindow(body) {
  const publishFrom = body.publishFrom ? parseJstDatetimeLocal(body.publishFrom) : Date.now();
  if (Number.isNaN(publishFrom)) return { error: '公開開始日時の形式が正しくありません。' };
  let publishUntil = null;
  if (body.publishUntil) {
    publishUntil = parseJstDatetimeLocal(body.publishUntil);
    if (Number.isNaN(publishUntil)) return { error: '公開終了日時の形式が正しくありません。' };
    if (publishUntil < publishFrom) return { error: '公開終了日時は公開開始日時より後にしてください。' };
  }
  return { publishFrom, publishUntil };
}

async function handleNotesListAdmin(req, res) {
  const notes = await listAllHakuNotes();
  return res.status(200).json({ ok: true, notes, categories: HAKU_NOTE_CATEGORIES });
}

async function handleNotesCreate(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const validated = validateNoteFields(body);
  if (validated.error) return res.status(400).json({ error: validated.error });
  const window = parseNotePublishWindow(body);
  if (window.error) return res.status(400).json({ error: window.error });
  const status = body.status === 'hidden' ? 'hidden' : 'published';
  const note = await createHakuNote({ ...validated, ...window, status, createdBy: session.actorId });
  await logAudit({ actorId: session.actorId, action: 'haku_note_created', targetId: note.id, metadata: { targetType: 'HakuNote' } });
  return res.status(200).json({ ok: true, note });
}

async function handleNotesUpdate(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const id = String(body.id || '').trim();
  if (!id) return res.status(400).json({ error: 'idを指定してください。' });
  const existing = await getHakuNote(id);
  if (!existing) return res.status(404).json({ error: '問いが見つかりません。' });

  const validated = validateNoteFields({
    title: body.title, body: body.body, supplement: body.supplement, category: body.category, type: body.type,
  });
  if (validated.error) return res.status(400).json({ error: validated.error });
  const window = parseNotePublishWindow(body);
  if (window.error) return res.status(400).json({ error: window.error });
  const note = await updateHakuNote(id, { ...validated, ...window, updatedBy: session.actorId });
  await logAudit({ actorId: session.actorId, action: 'haku_note_updated', targetId: id, metadata: { targetType: 'HakuNote' } });
  return res.status(200).json({ ok: true, note });
}

async function handleNotesSetStatus(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const id = String(body.id || '').trim();
  const status = body.status === 'published' ? 'published' : body.status === 'hidden' ? 'hidden' : null;
  if (!id || !status) return res.status(400).json({ error: 'idとstatusを指定してください。' });
  const note = await setHakuNoteStatus(id, status);
  if (!note) return res.status(404).json({ error: '問いが見つかりません。' });
  await logAudit({ actorId: session.actorId, action: 'haku_note_status_changed', targetId: id, metadata: { targetType: 'HakuNote', status } });
  return res.status(200).json({ ok: true, note });
}

async function handleNotesDelete(req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const id = String(body.id || '').trim();
  if (!id) return res.status(400).json({ error: 'idを指定してください。' });
  const ok = await deleteHakuNote(id);
  if (!ok) return res.status(404).json({ error: '問いが見つかりません。' });
  await logAudit({ actorId: session.actorId, action: 'haku_note_deleted', targetId: id, metadata: { targetType: 'HakuNote' } });
  return res.status(200).json({ ok: true });
}

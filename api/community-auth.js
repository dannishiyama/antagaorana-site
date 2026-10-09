/**
 * api/community-auth.js
 * HAKU Community / 教育者のサロン 灯 の会員向けAPIをまとめた単一エンドポイント。
 * Vercel Hobbyプランのサーバーレス関数数上限（12個）に収めるため、複数actionを1ファイルに集約。
 *
 * POST /api/community-auth?action=register                { community, fullName, fullNameKana, displayName, email, password, password2, reason, termsAccepted }
 * POST /api/community-auth?action=login                   { community, email, password }
 * POST /api/community-auth?action=logout                  {}
 * POST /api/community-auth?action=set-password            { token, password, password2 }
 * POST /api/community-auth?action=request-password-reset  { community, email }
 * GET  /api/community-auth?action=me
 * POST /api/community-auth?action=update-profile          { fullName?, fullNameKana?, displayName? }
 * POST /api/community-auth?action=change-password         { currentPassword, newPassword, newPassword2 }
 * POST /api/community-auth?action=change-email            { currentPassword, newEmail }
 * POST /api/community-auth?action=cancel-membership       {}（HAKU限定。Stripe subscriptionをcancel_at_period_end=trueにし、Membershipをcancelingへ）
 * POST /api/community-auth?action=withdraw                 { community }
 * GET  /api/community-auth?action=points-me                （HAKU POINT：自分の現在ポイントと履歴のみ）
 * GET  /api/community-auth?action=events-list
 * POST /api/community-auth?action=events-join               { eventId }
 * POST /api/community-auth?action=events-leave              { eventId }
 * GET  /api/community-auth?action=posts-list&limit=
 * GET  /api/community-auth?action=posts-mine
 * POST /api/community-auth?action=posts-create              { title?, body, category }
 * POST /api/community-auth?action=posts-update              { id, title?, body, category }
 * POST /api/community-auth?action=posts-delete              { id }
 * GET  /api/community-auth?action=goals-list                 （Preview fixture）
 * POST /api/community-auth?action=goals-add                  { text }（Preview fixture）
 * POST /api/community-auth?action=goals-toggle-stamp         { goalId, day }（Preview fixture）
 * POST /api/community-auth?action=goals-delete                { goalId }（Preview fixture）
 * GET  /api/community-auth?action=sessions-list               （Preview fixture）
 * GET  /api/community-auth?action=words-list&limit=&offset=    （運営からのことば。公開分のみ）
 * GET  /api/community-auth?action=notes-current                （今週の問い／HAKU NOTE。公開期間内の最新1件）
 * GET  /api/community-auth?action=notes-past&limit=&offset=     （過去のHAKU NOTE。現在の1件を除く公開済み分）
 */
import { checkOrigin, rateLimitGuard, resolveBaseUrl, blockProductionForCommunity } from './_lib/http.js';
import {
  createApplication, getApplication, resolveApplication, renameApplicationEmail, getMembership, setMembership, deleteMembership,
  getUser, saveUser, renameUserEmail, getAllMemberships,
  createSession, deleteSession, getSession, invalidateOtherSessions,
  consumePasswordSetupToken, createPasswordResetToken, logAudit,
  setStripeCustomerEmail,
  listEvents, joinEventAtomic, leaveEvent, countEventParticipants, isEventParticipant, listMemberEventIds, getEvent,
  renameEventParticipantEmail,
  ensureMorningEvent, morningEventId, saveAvatarImage, getAvatarImage, deleteAvatarImage,
  POST_CATEGORIES, POST_CATEGORY_LABELS, isValidPostCategory,
  createPost, getPost, listPublishedPosts, listPostsByAuthor, updatePost, deletePost, renamePostAuthorEmail,
  createGoalFixture, listGoalFixtures, toggleGoalStampFixture, deleteGoalFixture, listSessionFixtures,
  renameGoalFixtureEmail, renameSessionFixtureEmail,
  listPublishedWords, countPublishedWords,
  getCurrentHakuNote, listPastHakuNotes, countPastHakuNotes,
  claimIdempotentOp, completeIdempotentOp, releaseIdempotentOp,
} from './_lib/store.js';
import { computeEventState, joinBlockReason, JOIN_BLOCK_MESSAGES, isEventPast } from './_lib/event-state.js';
import { cleanUserText, hasInvalidChars, isDisplayablePost, normalizeRequestId } from './_lib/text-safety.js';
import { hashPassword, verifyPassword, randomToken } from './_lib/security.js';
import { getMemberView } from './_lib/points.js';
import {
  MORNING_CONFIG, MORNING_BLOCK_MESSAGES, jstToday, isValidMonth, addDays, monthDates, viewableMonthRange,
  joinBlock, leaveBlock, buildMorningDays,
} from './_lib/morning.js';
import { parseAvatarDataUrl, AvatarError } from './_lib/avatar.js';
import { ensureMorningMeet, meetIsConfigured } from './_lib/morning-meet.js';
import { setCookie, clearCookie, parseCookies } from './_lib/cookies.js';
import { notifyAdminOfApplication, sendPasswordSetupEmail, sendApplicationReceivedEmail, sendCancellationScheduledEmail, sendEmailChangedEmail } from './_lib/notify.js';

const KANA_RE = /^[぀-ゟ゠-ヿー\s　]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COMMUNITY_LABEL = { haku: 'HAKU Community', tomoshibi: '教育者のサロン 灯' };
// フォームのmaxlength属性と揃えた、サーバー側の文字数上限（クライアント側バリデーションを
// 経由しない直接API呼び出しでも、巨大なペイロードを弾くために必須）。
const MAX_LEN = { fullName: 60, fullNameKana: 60, displayName: 30, referrerName: 60, reason: 600 };
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
// 現行の利用規約・プライバシーポリシーの版。どの版にいつ同意したかApplicationへ記録するために使う。
// 規約本文を改定した際はこの値を更新すること（過去の同意記録自体は書き換えない）。
const TERMS_VERSION = '2026-09-26.1';

async function requireSession(req, res) {
  const cookies = parseCookies(req);
  const session = await getSession(cookies.ht_session);
  if (!session) {
    res.status(401).json({ error: 'ログインが必要です。' });
    return null;
  }
  return { ...session, sessionId: cookies.ht_session };
}

// イベント・ことば（振り返り共有）はHAKU Community会員限定。
// 「session valid + HAKU Membership active」の両方を満たさない限り本文を一切返さない。
async function requireHakuMembership(req, res) {
  const session = await requireSession(req, res);
  if (!session) return null;
  // 'canceling'（解約予約済みだが現在の請求期間はまだ終了していない）は'active'と同じく
  // 利用可能。haku-home.js / handleLogin のアクセス判定と揃える（多層防御の各層で
  // 判定基準がずれると、解約予約中の会員だけHOME表示はできるのに個別機能だけ403になる
  // という不整合が起きるため）。
  const membership = await getMembership('haku', session.email);
  if (!membership || (membership.status !== 'active' && membership.status !== 'canceling')) {
    res.status(403).json({ error: 'HAKU Communityの会員登録が有効ではありません。' });
    return null;
  }
  return session;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const action = req.query?.action;
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};

  try {
    if (action === 'me') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      return await handleMe(req, res);
    }
    // HAKU POINT：会員本人が「自分の」現在ポイントと履歴だけを見る。ランキング・他会員の情報は返さない。
    // 付与・調整・取消のAPIは管理者専用（api/admin.js）で、この会員用APIには存在しない。
    if (action === 'points-me') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireHakuMembership(req, res); if (!session) return;
      return res.status(200).json({ ok: true, ...(await getMemberView(session.email, { limit: 50 })) });
    }
    if (action === 'events-list') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleEventsList(req, res, session);
    }
    // 朝の集まり（日ごとの参加表明）。会員の表示名とアイコンだけを他の会員に見せる。
    if (action === 'morning-month') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleMorningMonth(req, res, session);
    }
    if (action === 'morning-next') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleMorningNext(req, res, session);
    }
    // 参加表明済みの会員だけが、その日のGoogle MeetのURLを受け取れる（他のAPIにはURLを一切含めない）。
    if (action === 'morning-meet') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      if (!(await rateLimitGuard(req, res, { key: 'morning-meet', limit: 30, windowSeconds: 60 }))) return;
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleMorningMeet(req, res, session);
    }
    if (action === 'avatar') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleAvatarGet(req, res);
    }
    if (action === 'posts-list') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handlePostsList(req, res, session);
    }
    if (action === 'posts-mine') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handlePostsMine(req, res, session);
    }
    if (action === 'goals-list') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleGoalsList(req, res, session);
    }
    if (action === 'sessions-list') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleSessionsList(req, res, session);
    }
    if (action === 'words-list') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleWordsList(req, res);
    }
    if (action === 'notes-current') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleNotesCurrent(req, res);
    }
    if (action === 'notes-past') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleNotesPast(req, res);
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });

    if (action === 'register') {
      if (!(await rateLimitGuard(req, res, { key: 'register', limit: 8, windowSeconds: 60 * 60 }))) return;
      return await handleRegister(req, res, body);
    }
    if (action === 'login') {
      if (!(await rateLimitGuard(req, res, { key: 'login', limit: 15, windowSeconds: 15 * 60 }))) return;
      return await handleLogin(req, res, body);
    }
    if (action === 'logout') return await handleLogout(req, res);
    if (action === 'set-password') return await handleSetPassword(req, res, body);
    if (action === 'request-password-reset') {
      if (!(await rateLimitGuard(req, res, { key: 'pwreset', limit: 5, windowSeconds: 60 * 60 }))) return;
      return await handleRequestPasswordReset(req, res, body);
    }
    if (action === 'update-profile') {
      const session = await requireSession(req, res); if (!session) return;
      return await handleUpdateProfile(req, res, body, session);
    }
    if (action === 'change-password') {
      const session = await requireSession(req, res); if (!session) return;
      return await handleChangePassword(req, res, body, session);
    }
    if (action === 'change-email') {
      const session = await requireSession(req, res); if (!session) return;
      return await handleChangeEmail(req, res, body, session);
    }
    if (action === 'withdraw') {
      const session = await requireSession(req, res); if (!session) return;
      return await handleWithdraw(req, res, body, session);
    }
    if (action === 'events-join') {
      if (!(await rateLimitGuard(req, res, { key: 'events-join', limit: 20, windowSeconds: 60 }))) return;
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleEventsJoin(req, res, body, session);
    }
    if (action === 'events-leave') {
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleEventsLeave(req, res, body, session);
    }
    if (action === 'morning-join') {
      if (!(await rateLimitGuard(req, res, { key: 'morning-join', limit: 30, windowSeconds: 60 }))) return;
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleMorningJoin(req, res, body, session);
    }
    if (action === 'morning-leave') {
      if (!(await rateLimitGuard(req, res, { key: 'morning-leave', limit: 30, windowSeconds: 60 }))) return;
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleMorningLeave(req, res, body, session);
    }
    if (action === 'avatar-set') {
      if (!(await rateLimitGuard(req, res, { key: 'avatar-set', limit: 10, windowSeconds: 60 * 60 }))) return;
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleAvatarSet(req, res, body, session);
    }
    if (action === 'avatar-delete') {
      if (!(await rateLimitGuard(req, res, { key: 'avatar-delete', limit: 20, windowSeconds: 60 * 60 }))) return;
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleAvatarDelete(req, res, session);
    }
    if (action === 'posts-create') {
      if (!(await rateLimitGuard(req, res, { key: 'posts-create', limit: 20, windowSeconds: 60 * 60 }))) return;
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handlePostsCreate(req, res, body, session);
    }
    if (action === 'posts-update') {
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handlePostsUpdate(req, res, body, session);
    }
    if (action === 'posts-delete') {
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handlePostsDelete(req, res, body, session);
    }
    if (action === 'goals-add') {
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleGoalsAdd(req, res, body, session);
    }
    if (action === 'goals-toggle-stamp') {
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleGoalsToggleStamp(req, res, body, session);
    }
    if (action === 'goals-delete') {
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleGoalsDelete(req, res, body, session);
    }
    if (action === 'cancel-membership') {
      if (!(await rateLimitGuard(req, res, { key: 'cancel-membership', limit: 5, windowSeconds: 60 * 60 }))) return;
      const session = await requireHakuMembership(req, res); if (!session) return;
      return await handleCancelMembership(req, res, session);
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(`[community-auth:${action}] error:`, err.message);
    return res.status(500).json({ error: '処理に失敗しました。時間をおいて再度お試しください。' });
  }
}

// HAKU / 灯 共通の新規登録。この時点で本人がパスワードを設定し、そのまま実際の認証
// パスワードとして使われる（ログイン側と実装を分けない）。
//   - 灯: User+Applicationを作成し、運営承認待ちにする（決済なし）。
//   - HAKU: User+Applicationを作成した後、クライアント側が続けて /api/haku-checkout を
//     呼び出しStripe Checkoutへ進む。Membershipが有効になるのはWebhook成功後（後述）。
// 認証成功（=email+passwordが正しい）とMembership activeは常に別概念として扱う
// （本関数はUser/Applicationのみを作り、Membershipには一切触れない）。
async function handleRegister(req, res, body) {
  const community = body.community === 'haku' ? 'haku' : body.community === 'tomoshibi' ? 'tomoshibi' : null;
  if (!community) return res.status(400).json({ error: 'コミュニティを指定してください。' });
  if (blockProductionForCommunity(res, community)) return;

  const fullName = String(body.fullName || '').trim();
  const fullNameKana = String(body.fullNameKana || '').trim();
  const displayName = String(body.displayName || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = body.password || '';
  const password2 = body.password2 || '';
  const reason = String(body.reason || '').trim();
  const referrerName = String(body.referrerName || '').trim();
  const termsAccepted = body.termsAccepted === true;

  if (!fullName) return res.status(400).json({ error: '氏名をご入力ください。' });
  if (fullName.length > MAX_LEN.fullName) return res.status(400).json({ error: `氏名は${MAX_LEN.fullName}文字以内でご入力ください。` });
  if (!fullNameKana || !KANA_RE.test(fullNameKana)) return res.status(400).json({ error: 'ふりがなをひらがな・カタカナでご入力ください。' });
  if (fullNameKana.length > MAX_LEN.fullNameKana) return res.status(400).json({ error: `ふりがなは${MAX_LEN.fullNameKana}文字以内でご入力ください。` });
  if (!displayName) return res.status(400).json({ error: '表示名をご入力ください。' });
  if (displayName.length > MAX_LEN.displayName) return res.status(400).json({ error: `表示名は${MAX_LEN.displayName}文字以内でご入力ください。` });
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'メールアドレスの形式をご確認ください。' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'パスワードは8文字以上でご設定ください。' });
  if (password !== password2) return res.status(400).json({ error: 'パスワードが一致しません。' });
  // HAKU Communityは完全紹介制のため、紹介者名を必須とする（既存/community会員でも免除しない）。
  if (community === 'haku' && !referrerName) return res.status(400).json({ error: '紹介者名をご入力ください。HAKU Communityは完全紹介制です。' });
  if (referrerName.length > MAX_LEN.referrerName) return res.status(400).json({ error: `紹介者名は${MAX_LEN.referrerName}文字以内でご入力ください。` });
  if (!reason) return res.status(400).json({ error: '参加理由をご入力ください。' });
  if (reason.length > MAX_LEN.reason) return res.status(400).json({ error: `参加理由は${MAX_LEN.reason}文字以内でご入力ください。` });
  if (!termsAccepted) return res.status(400).json({ error: '利用規約・プライバシーポリシーへの同意が必要です。' });

  const [existingMembership, existingApplication, existingUser] = await Promise.all([
    getMembership(community, email),
    getApplication(community, email),
    getUser(email),
  ]);

  if (existingMembership?.status === 'active') {
    return res.status(409).json({ error: `このメールアドレスはすでに${COMMUNITY_LABEL[community]}の会員として登録されています。ログインページからお進みください。` });
  }

  // 既に同じメールアドレスで別コミュニティに登録済みの人物か確認する（1 User + 複数Membership）。
  // 本人確認のため、既存アカウントのパスワードと一致する場合のみ許可する。
  if (existingUser && !(await verifyPassword(password, existingUser.passwordHash))) {
    return res.status(409).json({
      error: 'このメールアドレスはすでに別のサービスで登録済みです。既存のパスワードでログインしてから、こちらにもお申し込みください。',
    });
  }

  // 完全紹介制：申込は必ず「審査中（pending）」から始まり、管理者の承認を経ない限り
  // 先（HAKUの場合は決済）へ進めない。既存Applicationがある場合はここで分岐し、
  // 二重にApplicationを作り直したり、pendingのまま決済へ進めたりしないようにする。
  if (existingApplication?.status === 'pending') {
    return res.status(200).json({ ok: true, email, pendingApproval: true });
  }
  if (existingApplication?.status === 'approved') {
    if (community === 'haku') {
      // 管理者承認済み。決済（/api/haku-checkout）へ進めてよい合図をclientへ返す。
      return res.status(200).json({ ok: true, email, resumed: true });
    }
    return res.status(409).json({ error: 'このメールアドレスはすでに承認済みです。ログインページからお進みください。' });
  }
  if (existingApplication?.status === 'rejected') {
    return res.status(409).json({ error: 'このメールアドレスでのお申し込みは受け付けできません。お問い合わせください。' });
  }
  if (existingApplication?.status === 'paid') {
    return res.status(409).json({ error: 'このメールアドレスはすでにお手続きが完了しています。ログインページからお進みください。' });
  }

  if (!existingUser) {
    const passwordHash = await hashPassword(password);
    await saveUser({ email, fullName, fullNameKana, displayName, passwordHash });
  }

  const submittedAt = Date.now();
  await createApplication(community, {
    fullName, fullNameKana, displayName, email, reason, referrerName,
    termsVersion: TERMS_VERSION,
    termsAcceptedAt: submittedAt,
  });
  await logAudit({ actorId: email, action: 'registered', metadata: { community } });

  // DB保存（Application作成）とメール通知は別処理として扱う。通知が失敗してもApplicationは
  // 既に保存済みであり、管理画面から引き続き確認・承認できる（notify.js の各関数は
  // 例外を投げず、成否をEmailLogへ記録する設計）。
  const baseUrl = resolveBaseUrl(req);
  await notifyAdminOfApplication({ community, fullName, displayName, email, referrerName, reason, submittedAt, baseUrl });
  await sendApplicationReceivedEmail({ community, email, displayName });

  return res.status(200).json({ ok: true, email, pendingApproval: true });
}

async function handleLogin(req, res, body) {
  const community = body.community;
  const email = String(body.email || '').trim().toLowerCase();
  const password = body.password || '';
  const GENERIC_ERROR = 'メールアドレスまたはパスワードが違います。';

  if (!COMMUNITY_LABEL[community]) return res.status(400).json({ error: 'コミュニティを指定してください。' });
  if (blockProductionForCommunity(res, community)) return;
  if (!email || !password) return res.status(400).json({ error: GENERIC_ERROR });

  const user = await getUser(email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: GENERIC_ERROR });
  }

  // 完全紹介制：認証成功だけでは会員ページに入れない。Application承認 AND Membership active の
  // 両方が揃って初めて利用可能（haku-home.js側にも同じ判定を持つが、ログイン時点でも
  // 分かりやすいメッセージを返すためにここでも確認する＝多層防御）。
  if (community === 'haku') {
    const application = await getApplication('haku', email);
    // 'approved'（承認済み・決済前）と'paid'（決済完了後）のみ先へ進める。
    if (!application || (application.status !== 'approved' && application.status !== 'paid')) {
      if (application?.status === 'rejected') {
        return res.status(403).json({ error: '大変申し訳ございませんが、このお申し込みは承認されませんでした。' });
      }
      return res.status(403).json({ error: 'お申し込みは現在確認中です。管理者の承認をお待ちください。承認され次第、メールでご案内します。' });
    }
  }

  const membership = await getMembership(community, email);
  // 'canceling'（解約予約済みだが現在の請求期間はまだ終了していない）は'active'と同様に
  // アクセスを許可する。実際にアクセス不可になるのは、期間終了時にStripeが
  // customer.subscription.deleted を送ってきてMembershipが'canceled'になったとき。
  if (!membership || (membership.status !== 'active' && membership.status !== 'canceling')) {
    const label = COMMUNITY_LABEL[community];
    // 'past_due'は「一度は決済済みだが更新決済が失敗している」状態であり、'membership'が
    // まだ存在しない（一度も決済していない）ケースとは全く別物。past_dueの会員に
    // 「お支払いが完了していないため」「Stripeへ進んでください」という案内を出すと、
    // 既にあるSubscriptionとは別の新規Subscriptionを誤って作らせてしまう
    // （二重課金のリスク）ため、canResumeCheckoutはmembership未作成の場合に限定する。
    if (community === 'haku' && !membership) {
      // 承認済みだが決済未完了（Checkout未実施／webhook未到達）。
      // 認証成功 ≠ Membership active。会員ページには入れないが、決済への再導線を示す。
      return res.status(403).json({
        error: 'お申し込みは承認されています。お支払いが完了していないため、まだ会員ページをご利用いただけません。',
        canResumeCheckout: true,
      });
    }
    const reasonText = membership?.status === 'past_due' ? 'お支払い方法をご確認ください。運営からのメールをご確認いただくか、運営までお問い合わせください。'
      : membership?.status === 'canceled' ? '解約済みです。'
      : `${label}の会員として有効化されていません。`;
    return res.status(403).json({ error: `このメールアドレスは${reasonText}` });
  }

  const sessionId = await createSession(email);
  setCookie(res, 'ht_session', sessionId, { maxAgeSeconds: SESSION_TTL_SECONDS });
  // 管理画面の会員一覧に「最終ログイン日時」を表示するための記録。ログイン処理自体の
  // 成否には影響させない（失敗しても握りつぶし、ログインは継続する）が、Vercelの
  // サーバーレス実行はレスポンス送信後に即座に凍結され得るため、必ずawaitしてから返す
  // （awaitしないfire-and-forgetは応答直後に実行が打ち切られ、書き込みが失われる場合がある）。
  await saveUser({ email, lastLoginAt: Date.now() }).catch((e) => console.error('[login] lastLoginAt update failed:', e.message));
  return res.status(200).json({ ok: true, displayName: user.displayName || email.split('@')[0] });
}

// 会員本人による解約。cancel_at_period_end=true をStripe側に設定するだけで、
// アプリDBだけを書き換えてStripe Subscriptionを残す、ということは絶対にしない。
// 現在の請求期間が残っている場合はその期間終了まで利用できるようにするため、
// 即時解約ではなくcancel_at_period_endを第一候補として採用する
// （このサービスには即時解約が必要という既存要件が現時点で無いため）。
// Membershipの実際の最終的な'canceled'遷移は、期間終了時にStripeから届く
// customer.subscription.deleted Webhookが行う（ここでは'canceling'に留める）。
// メール送信はこの関数が担当する（ユーザー自身の操作に対する即時の確認メールのため）。
// Webhook側（customer.subscription.updated）は、Stripeダッシュボード等アプリ外で
// 解約されたケースのための安全網としてのみメールを送る（重複送信しない設計）。
async function handleCancelMembership(req, res, session) {
  const email = session.email;
  const membership = await getMembership('haku', email);
  if (!membership?.stripeSubscriptionId) {
    return res.status(400).json({ error: '有効なサブスクリプションが見つかりません。運営までお問い合わせください。' });
  }
  if (membership.status === 'canceling') {
    return res.status(409).json({ error: 'すでに解約手続き済みです。', currentPeriodEnd: membership.currentPeriodEnd || null });
  }
  if (membership.status === 'canceled') {
    return res.status(409).json({ error: 'すでに解約済みです。' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  if (!/^(sk|rk)_test_/.test(secretKey)) {
    console.error('[cancel-membership] STRIPE_SECRET_KEY is missing or not test-mode');
    return res.status(500).json({ error: '解約処理を実行できませんでした。運営までお問い合わせください。' });
  }

  let updatedSubscription;
  try {
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(secretKey);
    updatedSubscription = await stripe.subscriptions.update(membership.stripeSubscriptionId, { cancel_at_period_end: true });
  } catch (err) {
    console.error('[cancel-membership] Stripe update failed:', err.message);
    return res.status(502).json({ error: '解約処理に失敗しました。時間をおいて再度お試しいただくか、運営までご連絡ください。' });
  }

  // Stripeの新しいAPIバージョンではcurrent_period_endがsubscription直下ではなく
  // items配下に移動しているため、両方を見て取得する（どちらもなければnull）。
  const rawPeriodEnd = updatedSubscription.current_period_end ?? updatedSubscription.items?.data?.[0]?.current_period_end;
  const currentPeriodEnd = rawPeriodEnd ? rawPeriodEnd * 1000 : null;
  await setMembership('haku', email, { status: 'canceling', cancelAtPeriodEnd: true, currentPeriodEnd });
  await logAudit({
    actorId: email, action: 'membership_cancellation_requested', targetId: email,
    metadata: { community: 'haku', stripeSubscriptionId: membership.stripeSubscriptionId, currentPeriodEnd },
  });

  const user = await getUser(email);
  const periodEndLabel = currentPeriodEnd ? new Date(currentPeriodEnd).toLocaleDateString('ja-JP') : null;
  await sendCancellationScheduledEmail({ email, displayName: user?.displayName, periodEndLabel, immediate: false });

  return res.status(200).json({ ok: true, currentPeriodEnd });
}

async function handleLogout(req, res) {
  const cookies = parseCookies(req);
  await deleteSession(cookies.ht_session);
  clearCookie(res, 'ht_session');
  return res.status(200).json({ ok: true });
}

// 承認メール／Stripe決済完了メールのリンク先。トークンを1回だけ消費してUserを作成/更新し、即ログインさせる。
// パスワード再設定（purpose:'reset'）の場合も同じ処理でよい（Userが既に存在すればハッシュを上書きするだけ）。
async function handleSetPassword(req, res, body) {
  const token = String(body.token || '').trim();
  const password = body.password || '';
  const password2 = body.password2 || '';

  if (!token) return res.status(400).json({ error: '不正なリンクです。' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'パスワードは8文字以上でご設定ください。' });
  if (password !== password2) return res.status(400).json({ error: 'パスワードが一致しません。' });

  const data = await consumePasswordSetupToken(token);
  if (!data) return res.status(400).json({ error: 'リンクの有効期限が切れているか、すでに使用されています。' });

  const existing = await getUser(data.email);
  const passwordHash = await hashPassword(password);
  const user = await saveUser({
    email: data.email,
    fullName: existing?.fullName || data.fullName || '',
    fullNameKana: existing?.fullNameKana || data.fullNameKana || '',
    displayName: existing?.displayName || data.displayName || data.email.split('@')[0],
    passwordHash,
  });

  // パスワード再設定の場合、既存の全セッションを無効化してから今回だけ新規発行する（乗っ取り対策）。
  if (data.purpose === 'reset') await invalidateOtherSessions(data.email, null);

  const sessionId = await createSession(data.email);
  setCookie(res, 'ht_session', sessionId, { maxAgeSeconds: SESSION_TTL_SECONDS });
  await logAudit({ actorId: data.email, action: data.purpose === 'reset' ? 'password_reset' : 'password_setup', metadata: { community: data.community } });
  return res.status(200).json({ ok: true, community: data.community, displayName: user.displayName });
}

// 「パスワードをお忘れの方」。ユーザーの存在有無に関わらず常に同じ成功レスポンスを返す
// （メールアドレス存在確認に悪用されないため）。実際に存在する場合のみ内部でメール送信する。
async function handleRequestPasswordReset(req, res, body) {
  const community = COMMUNITY_LABEL[body.community] ? body.community : 'haku';
  const email = String(body.email || '').trim().toLowerCase();
  const GENERIC_OK = { ok: true, message: 'ご入力のメールアドレスが登録されている場合、パスワード再設定用のメールをお送りしました。' };

  if (blockProductionForCommunity(res, community)) return;
  if (!email || !EMAIL_RE.test(email)) return res.status(200).json(GENERIC_OK);

  try {
    const user = await getUser(email);
    if (user) {
      const baseUrl = resolveBaseUrl(req);
      if (baseUrl) {
        const token = randomToken(32);
        await createPasswordResetToken(token, { email, community });
        await sendPasswordSetupEmail({ community, email, displayName: user.displayName, token, baseUrl, purpose: 'reset' });
      }
    }
  } catch (err) {
    console.error('[request-password-reset] error (suppressed from response):', err.message);
  }
  return res.status(200).json(GENERIC_OK);
}

async function handleMe(req, res) {
  const cookies = parseCookies(req);
  const session = await getSession(cookies.ht_session);
  if (!session) return res.status(200).json({ ok: false });
  const user = await getUser(session.email);
  if (!user) return res.status(200).json({ ok: false });
  const memberships = await getAllMemberships(session.email);

  // MY HAKU向け: 実データが存在する項目のみ返す（TANE・つないだ仲間は未実装のため含めない＝
  // クライアント側で「近日公開」等のプレースホルダー表示にする）。
  let hakuStats = null;
  if (memberships.haku) {
    const membership = await getMembership('haku', session.email);
    const eventIds = await listMemberEventIds(session.email);
    const events = (await Promise.all(eventIds.map((id) => getEvent(id)))).filter(Boolean);
    const countByType = { morning: 0, meet: 0, volunteer: 0, other: 0 };
    events.forEach((e) => { countByType[e.type] = (countByType[e.type] || 0) + 1; });
    hakuStats = {
      joinedAt: membership?.joinedAt || null,
      eventsJoinedTotal: events.length,
      morningCount: countByType.morning,
      meetCount: countByType.meet,
      volunteerCount: countByType.volunteer,
      // MY HAKUの解約状態表示用（cancelingの場合はボタンではなく利用可能期限を示す）。
      membershipStatus: membership?.status || null,
      cancelAtPeriodEnd: membership?.cancelAtPeriodEnd || false,
      currentPeriodEnd: membership?.currentPeriodEnd || null,
    };
  }

  return res.status(200).json({
    ok: true,
    email: user.email,
    fullName: user.fullName,
    fullNameKana: user.fullNameKana,
    displayName: user.displayName,
    avatarId: user.avatarId || null,
    memberships,
    hakuStats,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// イベント（HAKU MORNING / HAKU MEET / ボランティア）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 状態の判定（中止／開催済み／参加予定／受付終了／満席／受付中）は api/_lib/event-state.js に集約。
// 画面の見た目と、参加・取消APIの実際の挙動を同じ関数で揃えている。
async function handleEventsList(req, res, session) {
  // 日ごとの朝の集まり（kind: 'morning-day'）は、専用の画面（morning-*）で扱う。ここには出さない。
  const events = (await listEvents('haku')).filter((e) => e.kind !== 'morning-day');
  const nowMs = Date.now();
  const enriched = await Promise.all(events.map(async (e) => {
    const [participantCount, joined] = await Promise.all([
      countEventParticipants(e.id),
      isEventParticipant(e.id, session.email),
    ]);
    const { state, isPast, full, registration } = computeEventState({ event: e, participantCount, joined, nowMs });
    return {
      id: e.id,
      type: e.type,
      title: e.title,
      startsAt: e.startsAt,
      isPast,
      location: e.location,
      description: e.description,
      capacity: e.capacity,
      fee: e.fee,
      itemsToBring: e.itemsToBring,
      participantCount,
      full,
      joined,
      registration,
      state,
    };
  }));
  return res.status(200).json({ ok: true, events: enriched });
}

// 参加の流れ：すでに参加済みなら何もせず成功（連打・再送でも二重登録されない）→
// 中止・開催済み・受付終了は断る → 定員判定とSADDをRedis側で原子的に行う（joinEventAtomic）ため、
// 同時アクセスでも定員を超えて登録されない。
async function handleEventsJoin(req, res, body, session) {
  const eventId = String(body.eventId || '').trim();
  if (!eventId) return res.status(400).json({ error: 'イベントを指定してください。' });
  if (eventId.startsWith('morning-')) return res.status(400).json({ error: '朝の集まりは、朝の集まりの画面から操作してください。', code: 'use_morning' });
  const event = await getEvent(eventId);
  if (!event || event.community !== 'haku') return res.status(404).json({ error: 'イベントが見つかりません。' });

  if (await isEventParticipant(eventId, session.email)) return res.status(200).json({ ok: true, alreadyJoined: true });
  const blocked = joinBlockReason(event);
  if (blocked) return res.status(409).json({ error: JOIN_BLOCK_MESSAGES[blocked], code: blocked });

  const result = await joinEventAtomic(eventId, session.email, event.capacity);
  if (result === 'already') return res.status(200).json({ ok: true, alreadyJoined: true });
  if (result === 'full') return res.status(409).json({ error: '満席のため参加できません。', code: 'full' });
  await logAudit({ actorId: session.email, action: 'event_joined', targetId: eventId, metadata: { targetType: 'Event' } });
  return res.status(200).json({ ok: true });
}

// 開催済みの集まりは取り消せない（参加の記録として残す）。参加していない人の取消は何もせず成功。
// キャンセル期限は未決定のため設けていない（開始前ならいつでも取り消せる）。
async function handleEventsLeave(req, res, body, session) {
  const eventId = String(body.eventId || '').trim();
  if (!eventId) return res.status(400).json({ error: 'イベントを指定してください。' });
  if (eventId.startsWith('morning-')) return res.status(400).json({ error: '朝の集まりは、朝の集まりの画面から操作してください。', code: 'use_morning' });
  const event = await getEvent(eventId);
  if (!event || event.community !== 'haku') return res.status(404).json({ error: 'イベントが見つかりません。' });

  if (!(await isEventParticipant(eventId, session.email))) return res.status(200).json({ ok: true, alreadyLeft: true });
  if (isEventPast(event)) return res.status(409).json({ error: 'この集まりは開催済みのため、取り消せません。', code: 'ended' });

  await leaveEvent(eventId, session.email);
  await logAudit({ actorId: session.email, action: 'event_left', targetId: eventId, metadata: { targetType: 'Event' } });
  return res.status(200).json({ ok: true });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 朝の集まり：誰かが参加表明した日だけ「開催予定」になる。参加・取消は、既存のイベント参加者データ
// （event_participants）で管理するので、管理画面・会員画面は同じデータを見る。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleMorningMonth(req, res, session) {
  const month = String(req.query?.month || jstToday().slice(0, 7));
  if (!isValidMonth(month)) return res.status(400).json({ error: '月を正しく指定してください。' });
  const range = viewableMonthRange();
  if (month < range.min || month > range.max) return res.status(400).json({ error: 'この月は表示できません。', code: 'out_of_range' });
  const days = await buildMorningDays(monthDates(month), session.email);
  return res.status(200).json({
    ok: true, month, today: jstToday(), minMonth: range.min, maxMonth: range.max,
    days: days.filter((d) => d.count > 0 || d.status === 'cancelled'),
  });
}

// ホーム用：自分が参加予定の直近、なければ開催予定の直近（なければ null）。
async function handleMorningNext(req, res, session) {
  const today = jstToday();
  const dates = Array.from({ length: MORNING_CONFIG.nextScanDays }, (_, i) => addDays(today, i));
  const days = await buildMorningDays(dates, session.email);
  const live = days.filter((d) => d.status === 'scheduled');
  const next = live.find((d) => d.joined) || live[0] || null;
  return res.status(200).json({ ok: true, today, next });
}

async function handleMorningJoin(req, res, body, session) {
  const date = String(body.date || '').trim();
  const blocked = joinBlock(date);
  if (blocked) return res.status(blocked === 'invalid' ? 400 : 409).json({ error: MORNING_BLOCK_MESSAGES[blocked], code: blocked });
  const event = await ensureMorningEvent(date, session.email);
  if (event.registration === 'cancelled' || event.registration === 'closed') {
    return res.status(409).json({ error: MORNING_BLOCK_MESSAGES[event.registration], code: event.registration });
  }
  const result = await joinEventAtomic(morningEventId(date), session.email, null);
  if (result === 'joined') await logAudit({ actorId: session.email, action: 'morning_joined', targetId: morningEventId(date), metadata: { targetType: 'Event', date } });
  // その日の開催予定が成立したら、その日専用のGoogle Meetを用意する（参加表明そのものは、Meetの成否に関わらず成功させる）。
  if (meetIsConfigured()) {
    try { await Promise.race([ensureMorningMeet(date), new Promise((r) => setTimeout(r, 7000))]); } catch { /* 画面の「参加する」ボタンから再試行できる */ }
  }
  const [day] = await buildMorningDays([date], session.email);
  return res.status(200).json({ ok: true, alreadyJoined: result === 'already', day });
}

async function handleMorningMeet(req, res, session) {
  const date = String(req.query?.date || '').trim();
  const blocked = leaveBlock(date); // 過去日・不正な日付は対象外
  if (blocked === 'invalid') return res.status(400).json({ error: MORNING_BLOCK_MESSAGES.invalid, code: 'invalid' });
  if (blocked === 'past') return res.status(409).json({ error: MORNING_BLOCK_MESSAGES.past, code: 'past' });
  const id = morningEventId(date);
  const event = await getEvent(id);
  if (!event || !(await isEventParticipant(id, session.email))) {
    return res.status(403).json({ error: 'この朝の集まりに参加表明している会員だけが利用できます。', code: 'not_joined' });
  }
  if (event.registration === 'cancelled') return res.status(409).json({ error: MORNING_BLOCK_MESSAGES.cancelled, code: 'cancelled' });
  const meet = await ensureMorningMeet(date);
  if (meet.status === 'ready') return res.status(200).json({ ok: true, status: 'ready', url: meet.url });
  return res.status(meet.status === 'unavailable' ? 200 : 503).json({ ok: false, status: meet.status });
}

async function handleMorningLeave(req, res, body, session) {
  const date = String(body.date || '').trim();
  const blocked = leaveBlock(date);
  if (blocked) return res.status(blocked === 'invalid' ? 400 : 409).json({ error: MORNING_BLOCK_MESSAGES[blocked], code: blocked });
  const id = morningEventId(date);
  const was = await isEventParticipant(id, session.email);
  if (was) {
    await leaveEvent(id, session.email);
    await logAudit({ actorId: session.email, action: 'morning_left', targetId: id, metadata: { targetType: 'Event', date } });
  }
  const [day] = await buildMorningDays([date], session.email);
  return res.status(200).json({ ok: true, alreadyLeft: !was, day });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// プロフィール画像：保存先は ht:avatar:<avatarId>。Userには avatarId だけを持たせ、
// 画面はどこでもこの1か所（User.avatarId）を正として表示する。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleAvatarGet(req, res) {
  const id = String(req.query?.id || '');
  if (!/^[a-f0-9]{16}$/.test(id)) return res.status(404).json({ error: 'Not found' });
  const img = await getAvatarImage(id);
  if (!img) return res.status(404).json({ error: 'Not found' });
  const buffer = Buffer.from(img.b64, 'base64');
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Cache-Control', 'private, max-age=604800, immutable'); // 画像を変えるとIDも変わるので、長く覚えさせてよい
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  return res.status(200).send(buffer);
}

async function handleAvatarSet(req, res, body, session) {
  const user = await getUser(session.email);
  if (!user) return res.status(401).json({ error: 'ログインが必要です。' });
  let parsed;
  try { parsed = parseAvatarDataUrl(body.image); } catch (e) {
    if (e instanceof AvatarError) return res.status(400).json({ error: e.message, code: e.code });
    throw e;
  }
  const avatarId = randomToken(8);
  await saveAvatarImage(avatarId, { mime: parsed.mime, b64: parsed.b64 });
  await saveUser({ ...user, avatarId });
  if (user.avatarId) await deleteAvatarImage(user.avatarId);
  await logAudit({ actorId: session.email, action: 'avatar_updated' });
  return res.status(200).json({ ok: true, avatarId });
}

async function handleAvatarDelete(req, res, session) {
  const user = await getUser(session.email);
  if (!user) return res.status(401).json({ error: 'ログインが必要です。' });
  if (user.avatarId) {
    await deleteAvatarImage(user.avatarId);
    await saveUser({ ...user, avatarId: null });
    await logAudit({ actorId: session.email, action: 'avatar_deleted' });
  }
  return res.status(200).json({ ok: true, avatarId: null });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ことば（メンバーの振り返り共有。SNSのタイムラインにはしない：
// フォロー/いいね/ランキング等は実装しない。session valid + HAKU Membership active のみ閲覧・投稿可）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const POST_BODY_MAX = 1000;
const POST_TITLE_MAX = 60;

// 入口の安全化：制御文字・双方向制御文字を除き、文字化け（置換文字）を含む文章は保存を断る。
// 画面に出すときのHTMLエスケープは、画面側が別途かならず行う（二重の守り）。
function validatePostFields(body) {
  const rawTitle = String(body.title || '');
  const rawBody = String(body.body || '');
  if (hasInvalidChars(rawTitle) || hasInvalidChars(rawBody)) return { error: '使用できない文字（文字化け）が含まれています。入力し直してください。' };
  const title = cleanUserText(rawTitle).slice(0, POST_TITLE_MAX);
  const text = cleanUserText(rawBody);
  const category = String(body.category || '').trim();
  if (!text) return { error: '本文を入力してください。' };
  if (text.length > POST_BODY_MAX) return { error: `本文は${POST_BODY_MAX}文字以内でご入力ください。` };
  if (!isValidPostCategory(category)) return { error: 'カテゴリを選択してください。' };
  return { title, body: text, category };
}

// User参照から表示名を解決する（displayNameを投稿に重複保存しないため）。
async function resolvePostAuthors(posts) {
  const emails = [...new Set(posts.map((p) => p.authorEmail))];
  const users = await Promise.all(emails.map((email) => getUser(email)));
  const nameByEmail = new Map(emails.map((email, i) => [email, users[i]?.displayName || 'メンバー']));
  return posts.map((p) => ({
    id: p.id,
    title: p.title,
    body: p.body,
    category: p.category,
    categoryLabel: POST_CATEGORY_LABELS[p.category] || p.category,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    displayName: nameByEmail.get(p.authorEmail) || 'メンバー',
  }));
}

async function handlePostsList(req, res, session) {
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 20, 1), 50);
  // 文字化けした投稿（過去に保存されたものを含む）は会員の一覧に出さない。
  const posts = (await listPublishedPosts('haku', limit + 20)).filter(isDisplayablePost).slice(0, limit);
  const resolved = await resolvePostAuthors(posts);
  // 自分の投稿だけ編集・削除可能にするため isMine を付与する（他人の投稿には触れない）。
  const withOwnership = resolved.map((p, i) => ({ ...p, isMine: posts[i].authorEmail === session.email }));
  return res.status(200).json({ ok: true, posts: withOwnership, categories: POST_CATEGORIES.map((c) => ({ value: c, label: POST_CATEGORY_LABELS[c] })) });
}

async function handlePostsMine(req, res, session) {
  const posts = (await listPostsByAuthor('haku', session.email)).filter(isDisplayablePost);
  const resolved = await resolvePostAuthors(posts);
  const withStatus = resolved.map((p, i) => ({ ...p, isMine: true, status: posts[i].status }));
  return res.status(200).json({ ok: true, posts: withStatus, categories: POST_CATEGORIES.map((c) => ({ value: c, label: POST_CATEGORY_LABELS[c] })) });
}

// 二重送信防止：画面が1回の「残す」操作ごとに作る requestId を受け取り、同じ requestId での
// 2回目以降は新しい投稿を作らず、1回目の結果を返す（通信が不安定で再送されても1件だけ）。
async function handlePostsCreate(req, res, body, session) {
  const validated = validatePostFields(body);
  if (validated.error) return res.status(400).json({ error: validated.error });

  const requestId = normalizeRequestId(body.requestId);
  const scope = `post-create:${String(session.email).toLowerCase()}`;
  if (requestId) {
    const claim = await claimIdempotentOp(scope, requestId);
    if (claim.status === 'done') return res.status(200).json({ ok: true, id: claim.value, duplicate: true });
    if (claim.status === 'pending') return res.status(200).json({ ok: true, duplicate: true });
  }
  try {
    const post = await createPost('haku', { authorEmail: session.email, ...validated });
    if (requestId) await completeIdempotentOp(scope, requestId, post.id);
    await logAudit({ actorId: session.email, action: 'post_created', targetId: post.id });
    return res.status(200).json({ ok: true, id: post.id });
  } catch (err) {
    if (requestId) await releaseIdempotentOp(scope, requestId).catch(() => {});
    throw err;
  }
}

async function handlePostsUpdate(req, res, body, session) {
  const id = String(body.id || '').trim();
  if (!id) return res.status(400).json({ error: '投稿を指定してください。' });
  const existing = await getPost(id);
  if (!existing || existing.community !== 'haku') return res.status(404).json({ error: '投稿が見つかりません。' });
  // 他人の投稿は編集不可（サーバー側で必ず所有者チェックする）。
  if (existing.authorEmail !== session.email) return res.status(403).json({ error: 'この投稿を編集する権限がありません。' });

  const validated = validatePostFields(body);
  if (validated.error) return res.status(400).json({ error: validated.error });
  await updatePost(id, validated);
  await logAudit({ actorId: session.email, action: 'post_updated', targetId: id });
  return res.status(200).json({ ok: true });
}

async function handlePostsDelete(req, res, body, session) {
  const id = String(body.id || '').trim();
  if (!id) return res.status(400).json({ error: '投稿を指定してください。' });
  const existing = await getPost(id);
  if (!existing || existing.community !== 'haku') return res.status(404).json({ error: '投稿が見つかりません。' });
  // 他人の投稿は削除不可（サーバー側で必ず所有者チェックする）。
  if (existing.authorEmail !== session.email) return res.status(403).json({ error: 'この投稿を削除する権限がありません。' });

  await deletePost(id);
  await logAudit({ actorId: session.email, action: 'post_deleted', targetId: id });
  return res.status(200).json({ ok: true });
}

async function handleUpdateProfile(req, res, body, session) {
  const user = await getUser(session.email);
  if (!user) return res.status(401).json({ error: 'ログインが必要です。' });

  const fullName = body.fullName !== undefined ? String(body.fullName).trim() : user.fullName;
  const fullNameKana = body.fullNameKana !== undefined ? String(body.fullNameKana).trim() : user.fullNameKana;
  const displayName = body.displayName !== undefined ? String(body.displayName).trim() : user.displayName;
  if (!fullName) return res.status(400).json({ error: '氏名をご入力ください。' });
  if (fullName.length > MAX_LEN.fullName) return res.status(400).json({ error: `氏名は${MAX_LEN.fullName}文字以内でご入力ください。` });
  if (!fullNameKana || !KANA_RE.test(fullNameKana)) return res.status(400).json({ error: 'ふりがなをひらがな・カタカナでご入力ください。' });
  if (fullNameKana.length > MAX_LEN.fullNameKana) return res.status(400).json({ error: `ふりがなは${MAX_LEN.fullNameKana}文字以内でご入力ください。` });
  if (!displayName) return res.status(400).json({ error: '表示名をご入力ください。' });
  if (displayName.length > MAX_LEN.displayName) return res.status(400).json({ error: `表示名は${MAX_LEN.displayName}文字以内でご入力ください。` });

  await saveUser({ ...user, fullName, fullNameKana, displayName });
  await logAudit({ actorId: session.email, action: 'profile_updated' });
  return res.status(200).json({ ok: true, fullName, fullNameKana, displayName });
}

async function handleChangePassword(req, res, body, session) {
  const currentPassword = body.currentPassword || '';
  const newPassword = body.newPassword || '';
  const newPassword2 = body.newPassword2 || '';

  const user = await getUser(session.email);
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    return res.status(401).json({ error: '現在のパスワードが違います。' });
  }
  if (newPassword.length < 8) return res.status(400).json({ error: '新しいパスワードは8文字以上でご設定ください。' });
  if (newPassword !== newPassword2) return res.status(400).json({ error: 'パスワードが一致しません。' });

  const passwordHash = await hashPassword(newPassword);
  await saveUser({ ...user, passwordHash });
  // 他端末・他セッションを強制ログアウトする（今回のセッションだけは維持）。
  await invalidateOtherSessions(session.email, session.sessionId);
  await logAudit({ actorId: session.email, action: 'password_changed' });
  return res.status(200).json({ ok: true });
}

// メールアドレス変更：emailをキー/参照として持つ全Entity（User/Application/Membership/
// CommunityPost/Event参加/行動目標・マイセッションフィクスチャ）を新emailへ再配置する。
// Redisには複数キーにまたがる本当のトランザクション（ロールバック）が無いため、
// 「本人確認（ログイン可否）を左右するUserレコードの付け替えを最後に行う」ことで、
// 途中で失敗しても旧emailのままログイン・全機能が引き続き使える状態を保証する
// （＝処理再開・再試行が常に安全にできる設計）。各再配置関数は「移行元キーが既に
// 空/存在しない場合は何もしない」ため、途中から再実行しても二重処理にならない。
// EmailLog・AuditLogは「その時点で実際に何が起きたか」の記録であるため、意図的に
// 書き換えない（履歴の改変になるため）。
async function handleChangeEmail(req, res, body, session) {
  const currentPassword = body.currentPassword || '';
  const newEmail = String(body.newEmail || '').trim().toLowerCase();

  if (!newEmail || !EMAIL_RE.test(newEmail)) return res.status(400).json({ error: 'メールアドレスの形式をご確認ください。' });

  const user = await getUser(session.email);
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    return res.status(401).json({ error: 'パスワードが違います。' });
  }
  if (newEmail === session.email) return res.status(400).json({ error: '現在と同じメールアドレスです。' });

  const taken = await getUser(newEmail);
  if (taken) return res.status(409).json({ error: 'このメールアドレスはすでに使用されています。' });

  const oldEmail = session.email;
  const [hakuMembership, tomoshibiMembership] = await Promise.all([
    getMembership('haku', oldEmail),
    getMembership('tomoshibi', oldEmail),
  ]);

  if (hakuMembership) {
    await setMembership('haku', newEmail, hakuMembership);
    await deleteMembership('haku', oldEmail);
    if (hakuMembership.stripeCustomerId) await setStripeCustomerEmail(hakuMembership.stripeCustomerId, newEmail);
  }
  if (tomoshibiMembership) {
    await setMembership('tomoshibi', newEmail, tomoshibiMembership);
    await deleteMembership('tomoshibi', oldEmail);
    if (tomoshibiMembership.stripeCustomerId) await setStripeCustomerEmail(tomoshibiMembership.stripeCustomerId, newEmail);
  }
  // Applicationも新emailへ再配置しないと、Application/Membershipのemailがずれてしまい、
  // 決済・承認済みの会員がログイン後にHOMEへアクセスできなくなる（haku-home.js等が
  // 常にセッションの現在のemailでApplicationを検索するため）。
  await Promise.all([
    renameApplicationEmail('haku', oldEmail, newEmail),
    renameApplicationEmail('tomoshibi', oldEmail, newEmail),
  ]);
  // ことば投稿・イベント参加・行動目標・マイセッションも同様に再配置する（これらを
  // 移行しないと、メール変更後に「投稿が消えた」「参加履歴が消えた」ように見えてしまう）。
  await Promise.all([
    renamePostAuthorEmail('haku', oldEmail, newEmail),
    renamePostAuthorEmail('tomoshibi', oldEmail, newEmail),
    renameEventParticipantEmail(oldEmail, newEmail),
    renameGoalFixtureEmail(oldEmail, newEmail),
    renameSessionFixtureEmail(oldEmail, newEmail),
  ]);
  // Userレコードの付け替えは最後（＝このメール変更処理の「本コミット」）。
  await renameUserEmail(oldEmail, newEmail);

  // 旧メールアドレスに紐づく全セッションを無効化し、新しいセッションを1つだけ発行する。
  await invalidateOtherSessions(oldEmail, null);
  const sessionId = await createSession(newEmail);
  setCookie(res, 'ht_session', sessionId, { maxAgeSeconds: SESSION_TTL_SECONDS });
  await logAudit({ actorId: newEmail, action: 'email_changed', metadata: { from: oldEmail } });

  // 変更通知は旧アドレス宛（本人以外が変更した場合に気づけるようにするため）。
  // sendAndLog内部で例外を握りつぶす設計のため、ここでawaitしてもメールアドレス変更自体
  // （既にDB更新済み）が失敗することはない。awaitしないとVercelがレスポンス送信直後に
  // 関数を打ち切り、送信・EmailLog記録が完了しないことがあるため必ずawaitする。
  await sendEmailChangedEmail({ oldEmail, newEmail, displayName: user?.displayName });

  return res.status(200).json({ ok: true, email: newEmail });
}

// 灯: 即座に退会（membership inactive、決済を伴わないため）。
// HAKU: 解約処理は唯一の正式実装であるhandleCancelMembership（Stripe cancel_at_period_end
// →Membership=canceling→解約受付メール、という正式仕様）へ必ず委譲する。account-settings.html
// の旧UI（Billing Portal誘導）から呼ばれた場合も、MY HAKUの新UIと完全に同じ処理を通すことで、
// 2つの解約導線が別々の結果（片方はcanceling、片方はinactive即時／Portal未設定なら502）を
// 生む不整合を無くす。
async function handleWithdraw(req, res, body, session) {
  const community = body.community === 'haku' ? 'haku' : 'tomoshibi';

  if (community === 'haku') {
    return await handleCancelMembership(req, res, session);
  }

  if (blockProductionForCommunity(res, community)) return;

  const membership = await getMembership(community, session.email);
  if (!membership || membership.status !== 'active') {
    return res.status(404).json({ error: '有効な会員登録が見つかりません。' });
  }
  await setMembership(community, session.email, { status: 'inactive' });
  await logAudit({ actorId: session.email, action: 'membership_withdrawn', targetId: session.email, metadata: { community } });
  return res.status(200).json({ ok: true, requiresStripePortal: false });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 行動目標／セッション：Preview fixture（本番Firebase/Firestoreの操作は一切行わない。
// /haku-community/home/ に「統合後の/community完成形」を再現するための独立フィクスチャ）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function currentYYYYMM() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function handleGoalsList(req, res, session) {
  const month = currentYYYYMM();
  const goals = await listGoalFixtures(session.email, month);
  return res.status(200).json({ ok: true, goals, month });
}

// 今月の約束は最大3つまで（追加時のみ判定。すでに4つ以上ある場合も、既存分はそのまま残る）。
// 同じ文言の約束は重ねて作らず、二重送信（同じ requestId）も1件だけにする。
const GOALS_PER_MONTH_MAX = 3;

async function handleGoalsAdd(req, res, body, session) {
  const rawText = String(body.text || '');
  if (hasInvalidChars(rawText)) return res.status(400).json({ error: '使用できない文字（文字化け）が含まれています。入力し直してください。' });
  const text = cleanUserText(rawText).replace(/\n+/g, ' ');
  if (!text) return res.status(400).json({ error: '約束を入力してください。' });
  if (text.length > 100) return res.status(400).json({ error: '約束は100文字以内でご入力ください。' });

  const requestId = normalizeRequestId(body.requestId);
  const scope = `goal-add:${String(session.email).toLowerCase()}`;
  if (requestId) {
    const claim = await claimIdempotentOp(scope, requestId);
    if (claim.status !== 'new') return res.status(200).json({ ok: true, duplicate: true });
  }
  try {
    const existing = await listGoalFixtures(session.email, currentYYYYMM());
    if (existing.some((g) => g.text === text)) {
      if (requestId) await releaseIdempotentOp(scope, requestId).catch(() => {});
      return res.status(409).json({ error: 'すでに同じ約束があります。', code: 'duplicate' });
    }
    if (existing.length >= GOALS_PER_MONTH_MAX) {
      if (requestId) await releaseIdempotentOp(scope, requestId).catch(() => {});
      return res.status(409).json({ error: `今月の約束は${GOALS_PER_MONTH_MAX}つまでです。`, code: 'limit' });
    }
    const goal = await createGoalFixture(session.email, text);
    if (requestId) await completeIdempotentOp(scope, requestId, goal.id);
    return res.status(200).json({ ok: true, goal });
  } catch (err) {
    if (requestId) await releaseIdempotentOp(scope, requestId).catch(() => {});
    throw err;
  }
}

async function handleGoalsToggleStamp(req, res, body, session) {
  const goalId = String(body.goalId || '').trim();
  const day = parseInt(body.day, 10);
  if (!goalId || !Number.isFinite(day) || day < 1 || day > 31) return res.status(400).json({ error: 'goalIdとdayを指定してください。' });
  // 「未来日は押せない」判定はUI側（クライアントのローカル日時基準）に委ねる。
  // サーバー（UTC）とクライアント（JST想定）の時刻がずれるため、ここでは
  // サーバー時計を基準にした未来日拒否をしない（本番Firestore版も同様にクライアント任せ）。
  // done を明示して送る呼び出しは「その状態にする」（連打・再送で二重に反転しない）。省略時は従来どおり反転。
  const desired = typeof body.done === 'boolean' ? body.done : undefined;
  const goal = await toggleGoalStampFixture(session.email, goalId, day, desired);
  if (!goal) return res.status(404).json({ error: '約束が見つかりません。' });
  return res.status(200).json({ ok: true, goal });
}

async function handleGoalsDelete(req, res, body, session) {
  const goalId = String(body.goalId || '').trim();
  if (!goalId) return res.status(400).json({ error: 'goalIdを指定してください。' });
  const ok = await deleteGoalFixture(session.email, goalId);
  if (!ok) return res.status(404).json({ error: '目標が見つかりません。' });
  return res.status(200).json({ ok: true });
}

async function handleSessionsList(req, res, session) {
  const sessions = await listSessionFixtures(session.email);
  return res.status(200).json({ ok: true, sessions });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 運営からのことば（一般会員は公開分のみ取得可。作成・編集・削除は管理画面から）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleWordsList(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 5, 1), 50);
  const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);
  const [words, total] = await Promise.all([
    listPublishedWords(limit, offset),
    countPublishedWords(),
  ]);
  return res.status(200).json({ ok: true, words, total, hasMore: offset + words.length < total });
}

async function handleNotesCurrent(req, res) {
  const note = await getCurrentHakuNote();
  return res.status(200).json({ ok: true, note });
}

async function handleNotesPast(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 10, 1), 50);
  const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);
  const [notes, total] = await Promise.all([
    listPastHakuNotes(limit, offset),
    countPastHakuNotes(),
  ]);
  return res.status(200).json({ ok: true, notes, total, hasMore: offset + notes.length < total });
}

/**
 * api/_lib/store.js
 * データ層のディスパッチャ。呼び出し側（api/*.js）はこのファイルからimportし続ければよく、
 * バックエンドの切り替えを一切気にしなくてよい。
 *
 * User / Application / Membership / AdminUser / AuditLog は
 * process.env.DB_BACKEND === 'postgres' のとき store.pg.js（新規専用Supabase、未接続）を、
 * それ以外は常に store.redis.js（Upstash Redis、Preview接続済み・現在アクティブ）を使う。
 *
 * Session・パスワード設定/再設定トークン・レート制限・Stripe顧客ID索引・Webhook
 * idempotency ledgerは、Postgres移行後も常にRedis側（store.redis.js）のみを使う
 * （ephemeral/cache的な性質のデータであり、正式な永続化の対象ではないため）。
 *
 * 本番移行時にPostgresへ切り替える手順は supabase/schema.sql の先頭コメントを参照。
 */
import * as redisImpl from './store.redis.js';
import * as pgImpl from './store.pg.js';

function backend() {
  return process.env.DB_BACKEND === 'postgres' ? pgImpl : redisImpl;
}

// ── SWAPPABLE: User ──────────────────────────────────────────────────
export const getUser = (...args) => backend().getUser(...args);
export const saveUser = (...args) => backend().saveUser(...args);
export const renameUserEmail = (...args) => backend().renameUserEmail(...args);

// ── SWAPPABLE: Application ───────────────────────────────────────────
export const createApplication = (...args) => backend().createApplication(...args);
export const getApplication = (...args) => backend().getApplication(...args);
export const listPendingApplications = (...args) => backend().listPendingApplications(...args);
export const listApplications = (...args) => backend().listApplications(...args);
export const renameApplicationEmail = (...args) => backend().renameApplicationEmail(...args);

// ── Preview限定：テストメールアドレスの完全リセット。Redis専用（Postgres移行後は
//    別途実装。本番では呼び出し側 api/admin.js がVERCEL_ENV+super_adminで確実にブロックする） ──
export const { resetTestMember } = redisImpl;

// ── EmailLog（送信ログ。本文は保存せず、種別・宛先・成否・日時・関連IDのみ） ──
export const { logEmailSent, listEmailLog, listEmailLogForRecipient } = redisImpl;
export const resolveApplication = (...args) => backend().resolveApplication(...args);

// ── SWAPPABLE: Membership ────────────────────────────────────────────
export const getMembership = (...args) => backend().getMembership(...args);
export const setMembership = (...args) => backend().setMembership(...args);
export const deleteMembership = (...args) => backend().deleteMembership(...args);
export const getAllMemberships = (...args) => backend().getAllMemberships(...args);

// ── SWAPPABLE: AdminUser ──────────────────────────────────────────────
export const getAdminUser = (...args) => backend().getAdminUser(...args);
export const saveAdminUser = (...args) => backend().saveAdminUser(...args);
export const listAdminUsers = (...args) => backend().listAdminUsers(...args);
export const anyAdminUserExists = (...args) => backend().anyAdminUserExists(...args);

// ── SWAPPABLE: AuditLog ───────────────────────────────────────────────
export const logAudit = (...args) => backend().logAudit(...args);
export const listAuditLog = (...args) => backend().listAuditLog(...args);

// ── REDIS-ONLY: 常にstore.redis.jsを直接使う ─────────────────────────
export const {
  getRedis,
  createPasswordSetupToken,
  createPasswordResetToken,
  consumePasswordSetupToken,
  createSession,
  getSession,
  deleteSession,
  invalidateOtherSessions,
  createAdminSession,
  getAdminSession,
  deleteAdminSession,
  setStripeCustomerEmail,
  getEmailByStripeCustomer,
  isEventProcessed,
  markEventProcessed,
  checkRateLimit,
  acquireCheckoutLock,
  releaseCheckoutLock,
  claimIdempotentOp,
  completeIdempotentOp,
  releaseIdempotentOp,
} = redisImpl;

// ── EVENT（HAKU MORNING / MEET / ボランティア）: Preview中はRedis実装のみ ──
export const {
  createEvent,
  getEvent,
  listEvents,
  joinEventAtomic,
  leaveEvent,
  deleteEvent,
  updateEvent,
  EVENT_REGISTRATION_VALUES,
  countEventParticipants,
  listEventParticipants,
  isEventParticipant,
  listMemberEventIds,
  renameEventParticipantEmail,
  morningEventId,
  ensureMorningEvent,
  listMorningParticipants,
  getMorningMeet,
  saveMorningMeetOnce,
  claimMorningMeetLock,
  releaseMorningMeetLock,
  saveAvatarImage,
  getAvatarImage,
  deleteAvatarImage,
} = redisImpl;

// ── 管理者アカウントの初回パスワード設定トークン ──
export const {
  createAdminSetupToken,
  consumeAdminSetupToken,
} = redisImpl;

// ── CommunityPost（「ことば」振り返り共有）: Preview中はRedis実装のみ ──
export const {
  POST_CATEGORIES,
  POST_CATEGORY_LABELS,
  isValidPostCategory,
  createPost,
  getPost,
  listPublishedPosts,
  listPostsForModeration,
  listPostsByAuthor,
  updatePost,
  setPostStatus,
  deletePost,
  renamePostAuthorEmail,
} = redisImpl;

// ── Preview fixture（Goal/Session）: 本番Firebaseとは無関係の統合完成形プレビュー専用 ──
export const {
  createGoalFixture,
  listGoalFixtures,
  toggleGoalStampFixture,
  deleteGoalFixture,
  createSessionFixture,
  listSessionFixtures,
  renameGoalFixtureEmail,
  renameSessionFixtureEmail,
} = redisImpl;

// ── OfficialWord（「運営からのことば」）: Preview中はRedis実装のみ ──
export const {
  createOfficialWord,
  getOfficialWord,
  listPublishedWords,
  countPublishedWords,
  listAllWords,
  updateOfficialWord,
  setOfficialWordStatus,
  deleteOfficialWord,
} = redisImpl;

// ── HakuNote（「今週の問い」／HAKU NOTE）: Preview中はRedis実装のみ ──
export const {
  HAKU_NOTE_CATEGORIES,
  createHakuNote,
  getHakuNote,
  listAllHakuNotes,
  getCurrentHakuNote,
  listPastHakuNotes,
  countPastHakuNotes,
  updateHakuNote,
  setHakuNoteStatus,
  deleteHakuNote,
} = redisImpl;

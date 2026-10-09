/**
 * api/_lib/store.redis.js
 * Redis (Upstash, Preview-only) implementation of the data layer.
 *
 * This file implements BOTH:
 *   (a) the "swappable" entities (User / Application / Membership / AdminUser / AuditLog)
 *       that api/_lib/store.js can also serve from Postgres once DB_BACKEND=postgres is set
 *       (see api/_lib/store.pg.js + supabase/schema.sql for the Postgres-ready implementation) — this
 *       file remains the ACTIVE default until that switch is made;
 *   (b) entities that stay on Redis permanently regardless of backend (Session, admin session,
 *       one-time tokens, Stripe customer→email index, rate limiting, processed-webhook-event
 *       ledger) — these are ephemeral/cache-like by nature and are not part of the Postgres model.
 *
 * すべてのキーは "ht:" プレフィックスを付け、この用途専用であることを明示する。
 */
import Redis from 'ioredis';
import { randomToken } from './security.js';

const PREFIX = 'ht:';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7日
const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60; // 12時間
const PWSETUP_TTL_SECONDS = 48 * 60 * 60; // 48時間
const PASSWORD_RESET_TTL_SECONDS = 60 * 60; // 1時間（パスワード再設定は初回設定より短く）
const PROCESSED_EVENT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30日（Stripeの再送猶予を十分カバー）

let client = null;
export function getRedis() {
  if (!client) {
    if (!process.env.REDIS_URL) throw new Error('REDIS_URL is not set');
    client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, connectTimeout: 5000 });
  }
  return client;
}

// ユニットテスト専用：メモリ上のRedisモックを差し込む（本番コードからは呼ばない）。
export function __setRedisForTests(mockClient) {
  client = mockClient;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function readJSON(key) {
  const raw = await getRedis().get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function writeJSON(key, value, exSeconds) {
  const raw = JSON.stringify(value);
  if (exSeconds) await getRedis().set(key, raw, 'EX', exSeconds);
  else await getRedis().set(key, raw);
}

// ══════════════════════════════════════════════════════════════════════
// SWAPPABLE ENTITIES (Postgres-ready — see api/_lib/store.pg.js)
// ══════════════════════════════════════════════════════════════════════

// ── User ───────────────────────────────────────────────────────────────
export async function getUser(email) {
  return readJSON(`${PREFIX}user:${normalizeEmail(email)}`);
}

export async function saveUser(user) {
  const email = normalizeEmail(user.email);
  const now = Date.now();
  const existing = await readJSON(`${PREFIX}user:${email}`);
  const record = { ...existing, ...user, email, updatedAt: now, createdAt: existing?.createdAt || user.createdAt || now };
  await writeJSON(`${PREFIX}user:${email}`, record);
  return record;
}

// メールアドレス変更: レコードを新しいキーへ再配置する（Userのみ。Application/Membershipは
// email紐づけを維持したまま、参照側で新emailを使うよう呼び出し元が更新する）。
export async function renameUserEmail(oldEmail, newEmail) {
  const oldKey = `${PREFIX}user:${normalizeEmail(oldEmail)}`;
  const newKey = `${PREFIX}user:${normalizeEmail(newEmail)}`;
  const user = await readJSON(oldKey);
  if (!user) return null;
  const updated = { ...user, email: normalizeEmail(newEmail), updatedAt: Date.now() };
  await writeJSON(newKey, updated);
  await getRedis().del(oldKey);
  return updated;
}

// ── Application（申請。承認されるまでログイン不可） ───────────────────────
export async function createApplication(community, fields) {
  const email = normalizeEmail(fields.email);
  const record = {
    community,
    email,
    fullName: fields.fullName || '',
    fullNameKana: fields.fullNameKana || '',
    displayName: fields.displayName || '',
    reason: fields.reason || '',
    referrerName: fields.referrerName || '',
    status: 'pending',
    submittedAt: Date.now(),
    termsVersion: fields.termsVersion || null,
    termsAcceptedAt: fields.termsAcceptedAt || null,
  };
  await writeJSON(`${PREFIX}application:${community}:${email}`, record);
  const pipeline = getRedis().pipeline();
  pipeline.sadd(`${PREFIX}applications:${community}:pending`, email);
  pipeline.zadd(`${PREFIX}applications:${community}:all`, record.submittedAt, email);
  await pipeline.exec();
  return record;
}

export async function getApplication(community, email) {
  return readJSON(`${PREFIX}application:${community}:${normalizeEmail(email)}`);
}

export async function listPendingApplications(community) {
  const emails = await getRedis().smembers(`${PREFIX}applications:${community}:pending`);
  const apps = await Promise.all(emails.map((email) => getApplication(community, email)));
  return apps.filter(Boolean).sort((a, b) => a.submittedAt - b.submittedAt);
}

// 管理画面の「審査中/承認済み/却下/すべて」フィルタ用。resolveApplication は承認/却下時に
// pendingセットからemailを外すため、それとは別にステータスを問わず全件を追える索引を持つ
// （50人規模のため全件走査でフィルタする簡易実装で十分）。
export async function listApplications(community, status) {
  const emails = await getRedis().zrevrange(`${PREFIX}applications:${community}:all`, 0, -1);
  const apps = (await Promise.all(emails.map((email) => getApplication(community, email)))).filter(Boolean);
  if (!status || status === 'all') return apps;
  return apps.filter((a) => a.status === status);
}

export async function resolveApplication(community, email, status, reviewedBy) {
  const key = `${PREFIX}application:${community}:${normalizeEmail(email)}`;
  const app = await readJSON(key);
  if (!app) return null;
  app.status = status;
  app.reviewedAt = Date.now();
  app.reviewedBy = reviewedBy || null;
  await writeJSON(key, app);
  await getRedis().srem(`${PREFIX}applications:${community}:pending`, normalizeEmail(email));
  return app;
}

// メールアドレス変更時、Applicationも新emailへ再配置する（User/Membershipと同様）。
// これをしないと、Application が旧emailのキーに取り残され、変更後のログイン・HOME判定
// （getApplication(community, session.email) が新emailで検索する）が「Applicationなし」
// となり、既に承認・決済済みの会員がアクセス不能になる不整合が起きるため必須。
export async function renameApplicationEmail(community, oldEmail, newEmail) {
  const oldKey = `${PREFIX}application:${community}:${normalizeEmail(oldEmail)}`;
  const newKey = `${PREFIX}application:${community}:${normalizeEmail(newEmail)}`;
  const app = await readJSON(oldKey);
  if (!app) return null;
  const updated = { ...app, email: normalizeEmail(newEmail) };
  await writeJSON(newKey, updated);
  await getRedis().del(oldKey);
  const pipeline = getRedis().pipeline();
  if (app.status === 'pending') {
    pipeline.srem(`${PREFIX}applications:${community}:pending`, normalizeEmail(oldEmail));
    pipeline.sadd(`${PREFIX}applications:${community}:pending`, normalizeEmail(newEmail));
  }
  pipeline.zrem(`${PREFIX}applications:${community}:all`, normalizeEmail(oldEmail));
  pipeline.zadd(`${PREFIX}applications:${community}:all`, updated.submittedAt || Date.now(), normalizeEmail(newEmail));
  await pipeline.exec();
  return updated;
}

// ── Membership（community別の所属状態） ─────────────────────────────────
export async function getMembership(community, email) {
  return readJSON(`${PREFIX}membership:${community}:${normalizeEmail(email)}`);
}

export async function setMembership(community, email, fields) {
  const key = `${PREFIX}membership:${community}:${normalizeEmail(email)}`;
  const existing = (await readJSON(key)) || {};
  const record = {
    role: 'member',
    joinedAt: Date.now(),
    ...existing,
    ...fields,
    community,
    email: normalizeEmail(email),
    updatedAt: Date.now(),
  };
  await writeJSON(key, record);
  return record;
}

export async function deleteMembership(community, email) {
  await getRedis().del(`${PREFIX}membership:${community}:${normalizeEmail(email)}`);
}

export async function getAllMemberships(email) {
  const [haku, tomoshibi] = await Promise.all([
    getMembership('haku', email),
    getMembership('tomoshibi', email),
  ]);
  // 'canceling'（解約予約済みだが現在の請求期間はまだ終了していない）は、アクセス制御
  // （haku-home.js / requireHakuMembership 等）と同様「所属あり」として扱う。ここだけ
  // 'active'限定にすると、解約予約中の有効会員がaccount-settings.html等で「未所属」と
  // 誤表示されてしまう。
  const isMember = (m) => m?.status === 'active' || m?.status === 'canceling';
  return {
    haku: isMember(haku),
    tomoshibi: isMember(tomoshibi),
  };
}

// ── AdminUser（個別管理者アカウント。role: 'super_admin' | 'community_moderator'） ──
export async function getAdminUser(email) {
  return readJSON(`${PREFIX}admin_user:${normalizeEmail(email)}`);
}

export async function saveAdminUser(admin) {
  const email = normalizeEmail(admin.email);
  const now = Date.now();
  const existing = await readJSON(`${PREFIX}admin_user:${email}`);
  const record = {
    active: true,
    role: 'super_admin',
    ...existing,
    ...admin,
    email,
    updatedAt: now,
    createdAt: existing?.createdAt || now,
  };
  await writeJSON(`${PREFIX}admin_user:${email}`, record);
  await getRedis().sadd(`${PREFIX}admin_users`, email);
  return record;
}

export async function listAdminUsers() {
  const emails = await getRedis().smembers(`${PREFIX}admin_users`);
  const admins = await Promise.all(emails.map((email) => getAdminUser(email)));
  return admins.filter(Boolean);
}

export async function anyAdminUserExists() {
  const count = await getRedis().scard(`${PREFIX}admin_users`);
  return count > 0;
}

// ── AuditLog（管理者操作・重要な状態変更の追跡） ───────────────────────────
export async function logAudit({ actorId, action, targetId, metadata }) {
  const entry = {
    actorId: actorId || 'system',
    action,
    targetId: targetId || null,
    metadata: metadata || null,
    createdAt: Date.now(),
  };
  const id = `${entry.createdAt}:${randomToken(4)}`;
  await writeJSON(`${PREFIX}audit:${id}`, entry);
  await getRedis().zadd(`${PREFIX}audit_log`, entry.createdAt, id);
  return entry;
}

export async function listAuditLog(limit = 100) {
  const ids = await getRedis().zrevrange(`${PREFIX}audit_log`, 0, limit - 1);
  const entries = await Promise.all(ids.map((id) => readJSON(`${PREFIX}audit:${id}`)));
  return entries.filter(Boolean);
}

// ══════════════════════════════════════════════════════════════════════
// REDIS-ONLY ENTITIES (session / cache / rate-limit / one-time tokens —
// stay on Redis permanently, even after Postgres migration)
// ══════════════════════════════════════════════════════════════════════

// ── パスワード設定トークン（初回設定: 承認直後 or Stripe決済直後に発行） ────
export async function createPasswordSetupToken(token, fields) {
  const { email, community, fullName, fullNameKana, displayName } = fields;
  await writeJSON(
    `${PREFIX}pwsetup:${token}`,
    { email: normalizeEmail(email), community, fullName, fullNameKana, displayName, purpose: 'welcome' },
    PWSETUP_TTL_SECONDS,
  );
}

// ── パスワード再設定トークン（本人からの「パスワードをお忘れの方」導線） ──────
export async function createPasswordResetToken(token, { email, community }) {
  await writeJSON(
    `${PREFIX}pwsetup:${token}`,
    { email: normalizeEmail(email), community, purpose: 'reset' },
    PASSWORD_RESET_TTL_SECONDS,
  );
}

export async function consumePasswordSetupToken(token) {
  const key = `${PREFIX}pwsetup:${token}`;
  const data = await readJSON(key);
  if (!data) return null;
  await getRedis().del(key);
  return data;
}

// ── 管理者アカウントの初回パスワード設定トークン（メール経由でのみ届く。
//    平文パスワードがコード・チャット・ログに一切現れないようにするための仕組み） ──
export async function createAdminSetupToken(token, { email }) {
  await writeJSON(`${PREFIX}admin_setup:${token}`, { email: normalizeEmail(email) }, PWSETUP_TTL_SECONDS);
}

export async function consumeAdminSetupToken(token) {
  const key = `${PREFIX}admin_setup:${token}`;
  const data = await readJSON(key);
  if (!data) return null;
  await getRedis().del(key);
  return data;
}

// ── セッション（会員） ───────────────────────────────────────────────
export async function createSession(email) {
  const sessionId = randomToken(32);
  await writeJSON(`${PREFIX}session:${sessionId}`, { email: normalizeEmail(email) }, SESSION_TTL_SECONDS);
  await getRedis().sadd(`${PREFIX}user_sessions:${normalizeEmail(email)}`, sessionId);
  await getRedis().expire(`${PREFIX}user_sessions:${normalizeEmail(email)}`, SESSION_TTL_SECONDS);
  return sessionId;
}

export async function getSession(sessionId) {
  if (!sessionId) return null;
  return readJSON(`${PREFIX}session:${sessionId}`);
}

export async function deleteSession(sessionId) {
  if (!sessionId) return;
  const session = await readJSON(`${PREFIX}session:${sessionId}`);
  await getRedis().del(`${PREFIX}session:${sessionId}`);
  if (session?.email) await getRedis().srem(`${PREFIX}user_sessions:${normalizeEmail(session.email)}`, sessionId);
}

// パスワード変更・メール変更時に呼ぶ: 指定セッション以外の全セッションを強制ログアウトする。
export async function invalidateOtherSessions(email, exceptSessionId) {
  const key = `${PREFIX}user_sessions:${normalizeEmail(email)}`;
  const sessionIds = await getRedis().smembers(key);
  const toRemove = sessionIds.filter((id) => id !== exceptSessionId);
  if (toRemove.length === 0) return;
  const pipeline = getRedis().pipeline();
  toRemove.forEach((id) => pipeline.del(`${PREFIX}session:${id}`));
  pipeline.srem(key, ...toRemove);
  await pipeline.exec();
}

// ── セッション（管理者） ─────────────────────────────────────────────
export async function createAdminSession(adminInfo) {
  const sessionId = randomToken(32);
  await writeJSON(`${PREFIX}admin_session:${sessionId}`, { admin: true, ...adminInfo }, ADMIN_SESSION_TTL_SECONDS);
  return sessionId;
}

export async function getAdminSession(sessionId) {
  if (!sessionId) return null;
  return readJSON(`${PREFIX}admin_session:${sessionId}`);
}

export async function deleteAdminSession(sessionId) {
  if (!sessionId) return;
  await getRedis().del(`${PREFIX}admin_session:${sessionId}`);
}

// ── Stripe顧客ID → メールアドレス索引（subscription系イベントはemailを含まないため） ──
export async function setStripeCustomerEmail(stripeCustomerId, email) {
  if (!stripeCustomerId) return;
  await getRedis().set(`${PREFIX}stripe_customer:${stripeCustomerId}`, normalizeEmail(email));
}

export async function getEmailByStripeCustomer(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  return getRedis().get(`${PREFIX}stripe_customer:${stripeCustomerId}`);
}

// ── Stripe Webhook idempotency（同一event.idの二重処理防止） ────────────────
export async function isEventProcessed(eventId) {
  const exists = await getRedis().exists(`${PREFIX}processed_event:${eventId}`);
  return exists === 1;
}

export async function markEventProcessed(eventId) {
  await getRedis().set(`${PREFIX}processed_event:${eventId}`, '1', 'EX', PROCESSED_EVENT_TTL_SECONDS);
}

// ── Checkout Session作成の排他ロック（承認直後〜初回決済完了までの間に、同一emailで
//    複数のCheckout Session／複数Subscriptionが作られることを防ぐ）。SET NX EXは
//    Redisの単一コマンドとしてアトミックなため、ほぼ同時に届いた複数リクエストの
//    うち1つだけがロックを取得できる（承認メールを2タブで開く、連打、通信リトライ等）。──
export async function acquireCheckoutLock(email, ttlSeconds = 600) {
  const key = `${PREFIX}checkout_lock:${normalizeEmail(email)}`;
  const result = await getRedis().set(key, '1', 'NX', 'EX', ttlSeconds);
  return result === 'OK';
}

export async function releaseCheckoutLock(email) {
  await getRedis().del(`${PREFIX}checkout_lock:${normalizeEmail(email)}`);
}

// ── レート制限（固定ウィンドウ方式。key例: "login:203.0.113.5" や "apply:email@..."） ──
// 戻り値: 許可なら true。Redis未接続等で判定できない場合は「安全側に倒して許可」する
// （レート制限の一時的な機能不全でユーザーが完全にロックアウトされるより、多少の
//   過剰通過を許容するほうが実害が小さいため）。
export async function checkRateLimit(key, limit, windowSeconds) {
  try {
    const redisKey = `${PREFIX}ratelimit:${key}`;
    const count = await getRedis().incr(redisKey);
    if (count === 1) await getRedis().expire(redisKey, windowSeconds);
    return count <= limit;
  } catch (err) {
    console.error('[rate-limit] check failed, allowing request:', err.message);
    return true;
  }
}

// ── 二重送信防止（クライアントが1回の操作ごとに作る「操作ID」の先着確保） ──
// 同じ操作ID（同じ会員・同じ種類）での2回目以降は、新しく作らず1回目の結果を返すために使う。
// 戻り値: { status: 'new' }（初回。続けて処理し、完了時に completeIdempotentOp）
//       | { status: 'pending' }（同じ操作が処理中）
//       | { status: 'done', value }（処理済み。valueは1回目の結果ID）
// 途中で異常終了しても詰まらないよう、処理中の印は120秒で自動的に消える。
export async function claimIdempotentOp(scope, requestId) {
  const key = `${PREFIX}idem:${scope}:${requestId}`;
  const ok = await getRedis().set(key, 'pending', 'EX', 120, 'NX');
  if (ok === 'OK') return { status: 'new' };
  const v = await getRedis().get(key);
  return v && v !== 'pending' ? { status: 'done', value: v } : { status: 'pending' };
}

export async function completeIdempotentOp(scope, requestId, value) {
  await getRedis().set(`${PREFIX}idem:${scope}:${requestId}`, String(value), 'EX', 24 * 60 * 60);
}

export async function releaseIdempotentOp(scope, requestId) {
  await getRedis().del(`${PREFIX}idem:${scope}:${requestId}`);
}

// ══════════════════════════════════════════════════════════════════════
// EVENT（HAKU MORNING / HAKU MEET / ボランティア等）
// Preview: Redis実装のみ。将来Postgres移行時はUser/Application等と同様に
// swappableな設計へ寄せる想定だが、v1（50人規模）はRedisで十分なため見送る。
// ══════════════════════════════════════════════════════════════════════
export const EVENT_REGISTRATION_VALUES = ['open', 'closed', 'cancelled'];

export async function createEvent(community, fields) {
  const id = `${Date.now()}_${randomToken(4)}`;
  const startsAtMs = fields.startsAt ? new Date(fields.startsAt).getTime() : NaN;
  const record = {
    id,
    community,
    type: ['morning', 'meet', 'volunteer', 'other'].includes(fields.type) ? fields.type : 'other',
    title: fields.title || '',
    startsAt: fields.startsAt || null, // ISO文字列（未定の場合はnull）
    location: fields.location || '',
    description: fields.description || '',
    capacity: Number.isFinite(Number(fields.capacity)) && fields.capacity !== '' ? Number(fields.capacity) : null,
    fee: fields.fee || '',
    itemsToBring: fields.itemsToBring || '',
    // 受付状況（運営が手動で切り替える）: open=受付中 / closed=受付終了 / cancelled=中止。
    // 開始時刻の経過による「開催済み」は保存せず、表示のたびに開始時刻から判定する。
    registration: EVENT_REGISTRATION_VALUES.includes(fields.registration) ? fields.registration : 'open',
    createdAt: Date.now(),
    createdBy: fields.createdBy || null,
  };
  await writeJSON(`${PREFIX}event:${id}`, record);
  await getRedis().zadd(`${PREFIX}events:${community}`, Number.isFinite(startsAtMs) ? startsAtMs : record.createdAt, id);
  return record;
}

export async function getEvent(id) {
  return readJSON(`${PREFIX}event:${id}`);
}

// ── 朝の集まり（日ごと）──────────────────────────────────────────────
// 「毎日の開催予定」を先に作っておくのではなく、メンバーの誰かがその日の朝に参加表明したとき、
// はじめて開催予定（イベント）が作られる。既存のイベント/参加者の仕組みをそのまま使い、
// IDを日付から決める（morning-YYYY-MM-DD）ので、同時に最初の2人が参加表明しても1件しか作られない。
export function morningEventId(date) { return `morning-${date}`; }

export async function ensureMorningEvent(date, createdBy) {
  const id = morningEventId(date);
  const startsAt = `${date}T00:00:00+09:00`; // 日付の始まり（日本時間）。時刻は未決定のため表示には使わない
  const record = {
    id, community: 'haku', type: 'morning', kind: 'morning-day', auto: true, allDay: true,
    title: '朝の集まり', startsAt, location: '', description: '', capacity: null, fee: '', itemsToBring: '',
    registration: 'open', createdAt: Date.now(), createdBy: createdBy || null,
  };
  const created = await getRedis().set(`${PREFIX}event:${id}`, JSON.stringify(record), 'NX');
  if (created) await getRedis().zadd(`${PREFIX}events:haku`, new Date(startsAt).getTime(), id);
  return getEvent(id);
}

// 指定した日付ごとの参加者（メールアドレス）を、まとめて1回の通信で取る。
export async function listMorningParticipants(dates) {
  if (!dates.length) return [];
  const pipeline = getRedis().pipeline();
  dates.forEach((d) => pipeline.smembers(`${PREFIX}event_participants:${morningEventId(d)}`));
  const results = await pipeline.exec();
  return results.map(([err, members]) => (err ? [] : members || []));
}

// ── プロフィール画像 ─────────────────────────────────────────────────
// 画像本体は別キー（ht:avatar:<avatarId>）に保存し、Userには avatarId だけを持たせる（正は User.avatarId 1か所）。
// avatarId は保存のたびに新しくなるので、画像を変えると表示側のキャッシュも自然に切り替わる。
export async function saveAvatarImage(avatarId, { mime, b64 }) {
  await writeJSON(`${PREFIX}avatar:${avatarId}`, { mime, b64, savedAt: Date.now() });
}
export async function getAvatarImage(avatarId) {
  return readJSON(`${PREFIX}avatar:${avatarId}`);
}
export async function deleteAvatarImage(avatarId) {
  if (avatarId) await getRedis().del(`${PREFIX}avatar:${avatarId}`);
}

// 開催日時の昇順（近い予定が先）で返す。
export async function listEvents(community, limit = 100) {
  const ids = await getRedis().zrange(`${PREFIX}events:${community}`, 0, limit - 1);
  const events = await Promise.all(ids.map((id) => getEvent(id)));
  return events.filter(Boolean);
}

// 定員チェック＋参加登録をRedis側で1オペレーションとして原子的に行う（Lua/EVAL）。
// 同時に複数人が最後の1席へ参加しても、定員を超えて登録されることがない。
// 戻り値: 'joined'（新規参加できた） | 'already'（すでに参加済み） | 'full'（満席）
const JOIN_EVENT_LUA = `
local participantsKey = KEYS[1]
local email = ARGV[1]
local capacity = tonumber(ARGV[2])
if redis.call('SISMEMBER', participantsKey, email) == 1 then
  return 'already'
end
if capacity >= 0 then
  local count = redis.call('SCARD', participantsKey)
  if count >= capacity then
    return 'full'
  end
end
redis.call('SADD', participantsKey, email)
return 'joined'
`;

export async function joinEventAtomic(eventId, email, capacity) {
  const norm = normalizeEmail(email);
  const result = await getRedis().eval(
    JOIN_EVENT_LUA,
    1,
    `${PREFIX}event_participants:${eventId}`,
    norm,
    capacity == null ? -1 : capacity,
  );
  if (result === 'joined') {
    await getRedis().sadd(`${PREFIX}member_events:${norm}`, eventId);
  }
  return result;
}

// 参加取消。MY HAKUの集計は member_events セットから都度数えるため、
// 取消したイベントは自動的にカウントから外れる（二重管理なし）。
export async function leaveEvent(eventId, email) {
  const norm = normalizeEmail(email);
  await getRedis().srem(`${PREFIX}event_participants:${eventId}`, norm);
  await getRedis().srem(`${PREFIX}member_events:${norm}`, eventId);
}

export async function countEventParticipants(eventId) {
  return getRedis().scard(`${PREFIX}event_participants:${eventId}`);
}

// 管理者向け：参加者メールアドレス一覧（Event参加者確認用）。
export async function listEventParticipants(eventId) {
  return getRedis().smembers(`${PREFIX}event_participants:${eventId}`);
}

export async function isEventParticipant(eventId, email) {
  const exists = await getRedis().sismember(`${PREFIX}event_participants:${eventId}`, normalizeEmail(email));
  return exists === 1;
}

export async function listMemberEventIds(email) {
  return getRedis().smembers(`${PREFIX}member_events:${normalizeEmail(email)}`);
}

// メールアドレス変更時、参加中イベントの参加者情報を新emailへ再配置する。
// これをしないと、メール変更後にMY HAKUの参加実績・isEventParticipant判定が
// すべて「未参加」に戻って見えてしまう（定員判定・重複参加防止にも影響する）。
export async function renameEventParticipantEmail(oldEmail, newEmail) {
  const oldNorm = normalizeEmail(oldEmail);
  const newNorm = normalizeEmail(newEmail);
  const memberEventsKey = `${PREFIX}member_events:${oldNorm}`;
  const eventIds = await getRedis().smembers(memberEventsKey);
  if (eventIds.length === 0) return 0;
  const pipeline = getRedis().pipeline();
  eventIds.forEach((eventId) => {
    pipeline.srem(`${PREFIX}event_participants:${eventId}`, oldNorm);
    pipeline.sadd(`${PREFIX}event_participants:${eventId}`, newNorm);
    pipeline.sadd(`${PREFIX}member_events:${newNorm}`, eventId);
  });
  pipeline.del(memberEventsKey);
  await pipeline.exec();
  return eventIds.length;
}

// イベント削除（管理者用）。参加者全員の member_events からもこのイベントを取り除き、
// 削除済みイベントがMY HAKUの集計に残り続けないようにする（50人規模なので参加者を
// 個別にSREMしても十分軽い）。
export async function deleteEvent(id) {
  const event = await readJSON(`${PREFIX}event:${id}`);
  if (!event) return false;
  const participantsKey = `${PREFIX}event_participants:${id}`;
  const participants = await getRedis().smembers(participantsKey);
  const pipeline = getRedis().pipeline();
  participants.forEach((email) => pipeline.srem(`${PREFIX}member_events:${email}`, id));
  pipeline.del(`${PREFIX}event:${id}`);
  pipeline.del(participantsKey);
  pipeline.zrem(`${PREFIX}events:${event.community}`, id);
  await pipeline.exec();
  return true;
}

export async function updateEvent(id, fields) {
  const key = `${PREFIX}event:${id}`;
  const event = await readJSON(key);
  if (!event) return null;
  const updated = { ...event };
  ['title', 'type', 'location', 'description', 'fee', 'itemsToBring'].forEach((f) => {
    if (fields[f] !== undefined) updated[f] = fields[f];
  });
  if (fields.capacity !== undefined) {
    updated.capacity = Number.isFinite(Number(fields.capacity)) && fields.capacity !== '' ? Number(fields.capacity) : null;
  }
  if (fields.registration !== undefined && EVENT_REGISTRATION_VALUES.includes(fields.registration)) {
    updated.registration = fields.registration;
  }
  if (fields.startsAt !== undefined) {
    updated.startsAt = fields.startsAt || null;
    const startsAtMs = updated.startsAt ? new Date(updated.startsAt).getTime() : NaN;
    await getRedis().zadd(`${PREFIX}events:${event.community}`, Number.isFinite(startsAtMs) ? startsAtMs : event.createdAt, id);
  }
  await writeJSON(key, updated);
  return updated;
}

// ══════════════════════════════════════════════════════════════════════
// CommunityPost（HAKU Community会員の振り返り共有「ことば」）
// User参照で表示名を解決できるため、displayNameはここに重複保存しない。
// status: 'published'（通常表示） | 'hidden'（管理者モデレーションで非表示） 。
// 完全削除（本人 or 管理者）はレコードごと削除する（soft-delete用のstatusは持たない）。
// Preview: Redis実装のみ（EVENTと同様の理由でPostgres移行は今回見送り）。
// ══════════════════════════════════════════════════════════════════════
export const POST_CATEGORIES = [
  'today_did', 'today_noticed', 'this_week_thinking', 'learned_from_someone',
  'tried_something', 'question_to_self', 'valuing_now', 'challenging_now',
];
export const POST_CATEGORY_LABELS = {
  today_did: '今日できたこと',
  today_noticed: '今日気づいたこと',
  this_week_thinking: '今週考えていること',
  learned_from_someone: '誰かから学んだこと',
  tried_something: 'やってみたこと',
  question_to_self: '自分への問い',
  valuing_now: '今大切にしていること',
  challenging_now: '今挑戦していること',
};

export function isValidPostCategory(category) {
  return POST_CATEGORIES.includes(category);
}

export async function createPost(community, { authorEmail, title, body, category }) {
  const id = `${Date.now()}_${randomToken(4)}`;
  const now = Date.now();
  const record = {
    id,
    community,
    authorEmail: normalizeEmail(authorEmail),
    title: title || '',
    body,
    category,
    status: 'published',
    createdAt: now,
    updatedAt: now,
  };
  await writeJSON(`${PREFIX}post:${id}`, record);
  const pipeline = getRedis().pipeline();
  pipeline.zadd(`${PREFIX}posts:${community}:published`, now, id);
  pipeline.zadd(`${PREFIX}posts:${community}:all`, now, id);
  pipeline.zadd(`${PREFIX}posts:${community}:by-user:${record.authorEmail}`, now, id);
  await pipeline.exec();
  return record;
}

export async function getPost(id) {
  return readJSON(`${PREFIX}post:${id}`);
}

export async function listPublishedPosts(community, limit = 20) {
  const ids = await getRedis().zrevrange(`${PREFIX}posts:${community}:published`, 0, limit - 1);
  const posts = await Promise.all(ids.map((id) => getPost(id)));
  return posts.filter(Boolean);
}

// 管理者モデレーション用: published/hidden 両方（削除済みは物理削除されているため含まれない）。
export async function listPostsForModeration(community, limit = 200) {
  const ids = await getRedis().zrevrange(`${PREFIX}posts:${community}:all`, 0, limit - 1);
  const posts = await Promise.all(ids.map((id) => getPost(id)));
  return posts.filter(Boolean);
}

export async function listPostsByAuthor(community, email, limit = 100) {
  const ids = await getRedis().zrevrange(`${PREFIX}posts:${community}:by-user:${normalizeEmail(email)}`, 0, limit - 1);
  const posts = await Promise.all(ids.map((id) => getPost(id)));
  return posts.filter(Boolean);
}

// メールアドレス変更時、投稿の著者索引（by-user）と各投稿レコードのauthorEmailを
// 新emailへ再配置する。これをしないと、メール変更後に本人が自分の過去の投稿を
// 「自分の投稿」として認識・編集・削除できなくなり（authorEmail !== session.email に
// なるため）、公開フィード上の表示名も解決できず「メンバー」という匿名表示に
// 落ちてしまう（getUser(oldEmail)が既に存在しないため）。
export async function renamePostAuthorEmail(community, oldEmail, newEmail) {
  const oldNorm = normalizeEmail(oldEmail);
  const newNorm = normalizeEmail(newEmail);
  const oldKey = `${PREFIX}posts:${community}:by-user:${oldNorm}`;
  const idsWithScores = await getRedis().zrange(oldKey, 0, -1, 'WITHSCORES');
  if (idsWithScores.length === 0) return 0;
  const pipeline = getRedis().pipeline();
  for (let i = 0; i < idsWithScores.length; i += 2) {
    pipeline.zadd(`${PREFIX}posts:${community}:by-user:${newNorm}`, idsWithScores[i + 1], idsWithScores[i]);
  }
  pipeline.del(oldKey);
  await pipeline.exec();
  const ids = idsWithScores.filter((_, i) => i % 2 === 0);
  for (const id of ids) {
    const post = await readJSON(`${PREFIX}post:${id}`);
    if (post && post.authorEmail === oldNorm) {
      post.authorEmail = newNorm;
      await writeJSON(`${PREFIX}post:${id}`, post);
    }
  }
  return ids.length;
}

export async function updatePost(id, { title, body, category }) {
  const key = `${PREFIX}post:${id}`;
  const post = await readJSON(key);
  if (!post) return null;
  if (title !== undefined) post.title = title;
  if (body !== undefined) post.body = body;
  if (category !== undefined) post.category = category;
  post.updatedAt = Date.now();
  await writeJSON(key, post);
  return post;
}

// 管理者モデレーション: 'published' に戻す／'hidden' にする。
export async function setPostStatus(id, status) {
  const key = `${PREFIX}post:${id}`;
  const post = await readJSON(key);
  if (!post) return null;
  post.status = status;
  post.updatedAt = Date.now();
  await writeJSON(key, post);
  if (status === 'published') {
    await getRedis().zadd(`${PREFIX}posts:${post.community}:published`, post.createdAt, id);
  } else {
    await getRedis().zrem(`${PREFIX}posts:${post.community}:published`, id);
  }
  return post;
}

// 本人による削除、または管理者による削除（呼び出し側で権限チェック済みであること）。
export async function deletePost(id) {
  const key = `${PREFIX}post:${id}`;
  const post = await readJSON(key);
  if (!post) return false;
  const pipeline = getRedis().pipeline();
  pipeline.del(key);
  pipeline.zrem(`${PREFIX}posts:${post.community}:published`, id);
  pipeline.zrem(`${PREFIX}posts:${post.community}:all`, id);
  pipeline.zrem(`${PREFIX}posts:${post.community}:by-user:${post.authorEmail}`, id);
  await pipeline.exec();
  return true;
}

// ══════════════════════════════════════════════════════════════════════
// PREVIEW FIXTURE: Goal（行動目標）/ Session（マイセッション）
//
// 本番 /community は Firebase Auth + Firestore（users/{uid}/goals,
// users/{uid}/sessions）で実装されており、Claude からは本番Firebaseの
// Authユーザー作成・Firestore権限を一切操作できない（意図的な制約）。
//
// このセクションは「/haku-community/home/ に統合後の /community 完成形を
// Preview限定で再現する」ためだけの、Firestoreとは無関係な独立フィクスチャ。
// - キーは ht:fixture: 名前空間で明示的に分離する。
// - blockProduction() により本番環境では常に403（このモジュールを呼ぶ
//   すべてのAPIハンドラが既にガード済み）。
// - 本番Firebaseのデータ・権限・Rulesには一切触れない。
// - 本番移行時はこのフィクスチャごと不要になる（本番は引き続きFirebase）。
// ══════════════════════════════════════════════════════════════════════

// ── Goal fixture（本番 users/{uid}/goals と同じ形・同じロジックをRedisで再現） ──
export async function createGoalFixture(email, text) {
  const id = `${Date.now()}_${randomToken(4)}`;
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const record = { id, email: normalizeEmail(email), text, stamps: [], month, createdAt: Date.now() };
  await writeJSON(`${PREFIX}fixture:goal:${id}`, record);
  await getRedis().zadd(`${PREFIX}fixture:goals:${normalizeEmail(email)}`, record.createdAt, id);
  return record;
}

export async function listGoalFixtures(email, month) {
  const ids = await getRedis().zrevrange(`${PREFIX}fixture:goals:${normalizeEmail(email)}`, 0, -1);
  const goals = await Promise.all(ids.map((id) => readJSON(`${PREFIX}fixture:goal:${id}`)));
  return goals.filter((g) => g && g.month === month);
}

// desired: true=その日を「できた」にする / false=外す / 省略=従来どおり反転。
// 画面からは desired を明示して送るため、連打・再送しても結果は同じになる（二重反転しない）。
export async function toggleGoalStampFixture(email, goalId, day, desired) {
  const key = `${PREFIX}fixture:goal:${goalId}`;
  const goal = await readJSON(key);
  if (!goal || goal.email !== normalizeEmail(email)) return null;
  const idx = goal.stamps.indexOf(day);
  const want = typeof desired === 'boolean' ? desired : idx < 0;
  if (want && idx < 0) goal.stamps.push(day);
  else if (!want && idx >= 0) goal.stamps.splice(idx, 1);
  else return goal;
  await writeJSON(key, goal);
  return goal;
}

export async function deleteGoalFixture(email, goalId) {
  const key = `${PREFIX}fixture:goal:${goalId}`;
  const goal = await readJSON(key);
  if (!goal || goal.email !== normalizeEmail(email)) return false;
  await getRedis().del(key);
  await getRedis().zrem(`${PREFIX}fixture:goals:${normalizeEmail(email)}`, goalId);
  return true;
}

// メールアドレス変更時、行動目標フィクスチャ（一覧索引＋各レコードのemail・スタンプ）を
// 新emailへ再配置する。スタンプは各goalレコード内に埋め込まれているため、レコードごと
// 引き継げばスタンプも自動的に維持される。
export async function renameGoalFixtureEmail(oldEmail, newEmail) {
  const oldNorm = normalizeEmail(oldEmail);
  const newNorm = normalizeEmail(newEmail);
  const oldKey = `${PREFIX}fixture:goals:${oldNorm}`;
  const idsWithScores = await getRedis().zrange(oldKey, 0, -1, 'WITHSCORES');
  if (idsWithScores.length === 0) return 0;
  const pipeline = getRedis().pipeline();
  for (let i = 0; i < idsWithScores.length; i += 2) {
    pipeline.zadd(`${PREFIX}fixture:goals:${newNorm}`, idsWithScores[i + 1], idsWithScores[i]);
  }
  pipeline.del(oldKey);
  await pipeline.exec();
  const ids = idsWithScores.filter((_, i) => i % 2 === 0);
  for (const id of ids) {
    const goal = await readJSON(`${PREFIX}fixture:goal:${id}`);
    if (goal && goal.email === oldNorm) {
      goal.email = newNorm;
      await writeJSON(`${PREFIX}fixture:goal:${id}`, goal);
    }
  }
  return ids.length;
}

// ── Session fixture（本番 users/{uid}/sessions と同じ形。管理者が対象メンバーへ追加） ──
export async function createSessionFixture(targetEmail, fields) {
  const id = `${Date.now()}_${randomToken(4)}`;
  const record = {
    id,
    email: normalizeEmail(targetEmail),
    title: fields.title || '',
    tag: fields.tag || 'マイセッション',
    dur: fields.dur || '—',
    url: fields.url || '',
    desc: fields.desc || '',
    date: fields.date || new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' }),
    chapters: Array.isArray(fields.chapters) ? fields.chapters : [],
    createdAt: Date.now(),
  };
  await writeJSON(`${PREFIX}fixture:session:${id}`, record);
  await getRedis().zadd(`${PREFIX}fixture:sessions:${record.email}`, record.createdAt, id);
  return record;
}

export async function listSessionFixtures(email) {
  const ids = await getRedis().zrevrange(`${PREFIX}fixture:sessions:${normalizeEmail(email)}`, 0, -1);
  const sessions = await Promise.all(ids.map((id) => readJSON(`${PREFIX}fixture:session:${id}`)));
  return sessions.filter(Boolean);
}

// メールアドレス変更時、マイセッションフィクスチャ（一覧索引＋各レコードのemail）を
// 新emailへ再配置する。
export async function renameSessionFixtureEmail(oldEmail, newEmail) {
  const oldNorm = normalizeEmail(oldEmail);
  const newNorm = normalizeEmail(newEmail);
  const oldKey = `${PREFIX}fixture:sessions:${oldNorm}`;
  const idsWithScores = await getRedis().zrange(oldKey, 0, -1, 'WITHSCORES');
  if (idsWithScores.length === 0) return 0;
  const pipeline = getRedis().pipeline();
  for (let i = 0; i < idsWithScores.length; i += 2) {
    pipeline.zadd(`${PREFIX}fixture:sessions:${newNorm}`, idsWithScores[i + 1], idsWithScores[i]);
  }
  pipeline.del(oldKey);
  await pipeline.exec();
  const ids = idsWithScores.filter((_, i) => i % 2 === 0);
  for (const id of ids) {
    const session = await readJSON(`${PREFIX}fixture:session:${id}`);
    if (session && session.email === oldNorm) {
      session.email = newNorm;
      await writeJSON(`${PREFIX}fixture:session:${id}`, session);
    }
  }
  return ids.length;
}

// ══════════════════════════════════════════════════════════════════════
// OfficialWord（「運営からのことば」）
// 会員投稿のCommunityPost（「ことば」）とは別の実体。運営が届ける短いメッセージ。
// 本文・音声のどちらか一方があれば投稿可能（両方あっても良い）。
// 一般会員は status:'published' のみ取得できる（非公開は管理者のみ）。
// ══════════════════════════════════════════════════════════════════════
export async function createOfficialWord(fields) {
  const id = `${Date.now()}_${randomToken(4)}`;
  const now = Date.now();
  const record = {
    id,
    title: fields.title || '',
    body: fields.body || '',
    audioUrl: fields.audioUrl || '',
    authorName: fields.authorName || 'HAKU運営',
    status: fields.status === 'hidden' ? 'hidden' : 'published',
    publishedAt: fields.publishedAt || now,
    createdAt: now,
    updatedAt: now,
  };
  await writeJSON(`${PREFIX}word:${id}`, record);
  const pipeline = getRedis().pipeline();
  pipeline.zadd(`${PREFIX}words:all`, record.publishedAt, id);
  if (record.status === 'published') pipeline.zadd(`${PREFIX}words:published`, record.publishedAt, id);
  await pipeline.exec();
  return record;
}

export async function getOfficialWord(id) {
  return readJSON(`${PREFIX}word:${id}`);
}

export async function listPublishedWords(limit = 5, offset = 0) {
  const ids = await getRedis().zrevrange(`${PREFIX}words:published`, offset, offset + limit - 1);
  const words = await Promise.all(ids.map((id) => getOfficialWord(id)));
  return words.filter(Boolean);
}

export async function countPublishedWords() {
  return getRedis().zcard(`${PREFIX}words:published`);
}

export async function listAllWords(limit = 100) {
  const ids = await getRedis().zrevrange(`${PREFIX}words:all`, 0, limit - 1);
  const words = await Promise.all(ids.map((id) => getOfficialWord(id)));
  return words.filter(Boolean);
}

export async function updateOfficialWord(id, fields) {
  const key = `${PREFIX}word:${id}`;
  const word = await readJSON(key);
  if (!word) return null;
  ['title', 'body', 'audioUrl', 'authorName'].forEach((f) => {
    if (fields[f] !== undefined) word[f] = fields[f];
  });
  if (fields.publishedAt !== undefined) word.publishedAt = fields.publishedAt;
  word.updatedAt = Date.now();
  await writeJSON(key, word);
  // 公開日時が変わった場合、published索引のスコアも更新する。
  if (fields.publishedAt !== undefined) {
    await getRedis().zadd(`${PREFIX}words:all`, word.publishedAt, id);
    if (word.status === 'published') await getRedis().zadd(`${PREFIX}words:published`, word.publishedAt, id);
  }
  return word;
}

export async function setOfficialWordStatus(id, status) {
  const key = `${PREFIX}word:${id}`;
  const word = await readJSON(key);
  if (!word) return null;
  word.status = status;
  word.updatedAt = Date.now();
  await writeJSON(key, word);
  if (status === 'published') await getRedis().zadd(`${PREFIX}words:published`, word.publishedAt, id);
  else await getRedis().zrem(`${PREFIX}words:published`, id);
  return word;
}

export async function deleteOfficialWord(id) {
  const key = `${PREFIX}word:${id}`;
  const word = await readJSON(key);
  if (!word) return false;
  const pipeline = getRedis().pipeline();
  pipeline.del(key);
  pipeline.zrem(`${PREFIX}words:all`, id);
  pipeline.zrem(`${PREFIX}words:published`, id);
  await pipeline.exec();
  return true;
}

// ══════════════════════════════════════════════════════════════════════
// HakuNote（「今週の問い」／HAKU NOTE）
// 「学ぶ」タブと HOME に表示する、運営が届ける問い・文章のコンテンツ。
// type は将来 note/audio/video 等へ拡張する余地として持たせるが、現時点では
// weekly_question のみが実際に使われる（表示ロジックはtypeで分岐しない）。
// 「現在の1件」は、公開期間（publishFrom〜publishUntil）に該当し、かつ
// status:'published' な中で publishFrom が最も新しいものを採用する。
// 「過去のHAKU NOTE」は、公開済み（publishFromを過ぎている）かつ現在の1件を除いたもの。
// ══════════════════════════════════════════════════════════════════════
export const HAKU_NOTE_CATEGORIES = ['人間関係', '仕事', '営業', '人生', '自己理解', 'コミュニケーション'];

export async function createHakuNote(fields) {
  const id = `${Date.now()}_${randomToken(4)}`;
  const now = Date.now();
  const record = {
    id,
    type: ['weekly_question', 'note', 'audio', 'video'].includes(fields.type) ? fields.type : 'weekly_question',
    title: fields.title || '',
    body: fields.body || '',
    supplement: fields.supplement || '',
    category: HAKU_NOTE_CATEGORIES.includes(fields.category) ? fields.category : '',
    status: fields.status === 'hidden' ? 'hidden' : 'published',
    publishFrom: Number.isFinite(fields.publishFrom) ? fields.publishFrom : now,
    publishUntil: Number.isFinite(fields.publishUntil) ? fields.publishUntil : null,
    createdAt: now,
    updatedAt: now,
    createdBy: fields.createdBy || null,
    updatedBy: fields.createdBy || null,
  };
  await writeJSON(`${PREFIX}note:${id}`, record);
  const pipeline = getRedis().pipeline();
  pipeline.zadd(`${PREFIX}notes:all`, record.publishFrom, id);
  if (record.status === 'published') pipeline.zadd(`${PREFIX}notes:published`, record.publishFrom, id);
  await pipeline.exec();
  return record;
}

export async function getHakuNote(id) {
  return readJSON(`${PREFIX}note:${id}`);
}

export async function listAllHakuNotes(limit = 200) {
  const ids = await getRedis().zrevrange(`${PREFIX}notes:all`, 0, limit - 1);
  const notes = await Promise.all(ids.map((id) => getHakuNote(id)));
  return notes.filter(Boolean);
}

// 会員向け「今週の問い」：公開期間内・公開状態のものの中で最新の1件。
export async function getCurrentHakuNote() {
  const now = Date.now();
  const ids = await getRedis().zrevrange(`${PREFIX}notes:published`, 0, 499);
  const notes = (await Promise.all(ids.map((id) => getHakuNote(id)))).filter(Boolean);
  return notes.find((n) => n.publishFrom <= now && (n.publishUntil == null || n.publishUntil >= now)) || null;
}

// 会員向け「過去のHAKU NOTE」：公開開始済み・現在の1件を除いたもの（50人規模の想定で全件走査）。
async function pastHakuNotesFiltered() {
  const now = Date.now();
  const current = await getCurrentHakuNote();
  const ids = await getRedis().zrevrange(`${PREFIX}notes:published`, 0, 499);
  const notes = (await Promise.all(ids.map((id) => getHakuNote(id)))).filter(Boolean);
  return notes.filter((n) => n.publishFrom <= now && (!current || n.id !== current.id));
}

export async function listPastHakuNotes(limit = 20, offset = 0) {
  const notes = await pastHakuNotesFiltered();
  return notes.slice(offset, offset + limit);
}

export async function countPastHakuNotes() {
  const notes = await pastHakuNotesFiltered();
  return notes.length;
}

export async function updateHakuNote(id, fields) {
  const key = `${PREFIX}note:${id}`;
  const note = await readJSON(key);
  if (!note) return null;
  ['title', 'body', 'supplement', 'type'].forEach((f) => {
    if (fields[f] !== undefined) note[f] = fields[f];
  });
  if (fields.category !== undefined) note.category = HAKU_NOTE_CATEGORIES.includes(fields.category) ? fields.category : '';
  if (fields.publishUntil !== undefined) note.publishUntil = Number.isFinite(fields.publishUntil) ? fields.publishUntil : null;
  note.updatedAt = Date.now();
  note.updatedBy = fields.updatedBy || note.updatedBy;
  await writeJSON(key, note);
  if (fields.publishFrom !== undefined && Number.isFinite(fields.publishFrom)) {
    note.publishFrom = fields.publishFrom;
    await writeJSON(key, note);
    await getRedis().zadd(`${PREFIX}notes:all`, note.publishFrom, id);
    if (note.status === 'published') await getRedis().zadd(`${PREFIX}notes:published`, note.publishFrom, id);
  }
  return note;
}

export async function setHakuNoteStatus(id, status) {
  const key = `${PREFIX}note:${id}`;
  const note = await readJSON(key);
  if (!note) return null;
  note.status = status;
  note.updatedAt = Date.now();
  await writeJSON(key, note);
  if (status === 'published') await getRedis().zadd(`${PREFIX}notes:published`, note.publishFrom, id);
  else await getRedis().zrem(`${PREFIX}notes:published`, id);
  return note;
}

export async function deleteHakuNote(id) {
  const key = `${PREFIX}note:${id}`;
  const note = await readJSON(key);
  if (!note) return false;
  const pipeline = getRedis().pipeline();
  pipeline.del(key);
  pipeline.zrem(`${PREFIX}notes:all`, id);
  pipeline.zrem(`${PREFIX}notes:published`, id);
  await pipeline.exec();
  return true;
}

// ══════════════════════════════════════════════════════════════════════
// Preview限定：テストメールアドレスの完全リセット
// 「+tag付きemailで毎回新しいApplicationを作る」運用を優先する設計だが、
// 特定のテストアドレスを使い切って完全にリセットしたい場合のための補助機能。
// User / Application（haku・灯 両方） / Membership（両方） / Session /
// CommunityPost / Event参加 を、指定emailについて漏れなく削除する。
// Stripe側のtest customer/subscriptionの解約はSDKを持つ呼び出し側（api/admin.js）が
// このデータ削除の「前」に行う（Membershipを消してしまうとstripeSubscriptionIdが
// 読めなくなるため、呼び出し順はadmin.js側の責務とする）。
// Productionでは呼び出し側（api/admin.js）がsuper_admin権限とVERCEL_ENVを確認してから
// この関数を呼ぶ。この関数自体はガードを持たない（データ層はポリシーを持たない設計方針）。
// ══════════════════════════════════════════════════════════════════════
export async function resetTestMember(email) {
  const norm = normalizeEmail(email);
  const removed = { sessions: 0, posts: 0, eventParticipations: 0, applications: 0, memberships: 0 };

  const sessionIds = await getRedis().smembers(`${PREFIX}user_sessions:${norm}`);
  for (const sid of sessionIds) {
    await getRedis().del(`${PREFIX}session:${sid}`);
    removed.sessions++;
  }
  await getRedis().del(`${PREFIX}user_sessions:${norm}`);

  for (const community of ['haku', 'tomoshibi']) {
    const postIds = await getRedis().zrevrange(`${PREFIX}posts:${community}:by-user:${norm}`, 0, -1);
    for (const id of postIds) {
      const ok = await deletePost(id);
      if (ok) removed.posts++;
    }
  }

  const eventIds = await getRedis().smembers(`${PREFIX}member_events:${norm}`);
  for (const eid of eventIds) {
    await leaveEvent(eid, norm);
    removed.eventParticipations++;
  }
  await getRedis().del(`${PREFIX}member_events:${norm}`);

  for (const community of ['haku', 'tomoshibi']) {
    const hadMembership = await getRedis().del(`${PREFIX}membership:${community}:${norm}`);
    if (hadMembership) removed.memberships++;
    const hadApplication = await getRedis().del(`${PREFIX}application:${community}:${norm}`);
    if (hadApplication) removed.applications++;
    await getRedis().srem(`${PREFIX}applications:${community}:pending`, norm);
    await getRedis().zrem(`${PREFIX}applications:${community}:all`, norm);
  }

  const hadUser = !!(await getRedis().del(`${PREFIX}user:${norm}`));

  return { removed, hadUser };
}

// ══════════════════════════════════════════════════════════════════════
// EmailLog（管理者が運用状況を確認するための送信ログ）
// 本文全体は保存しない。emailType/recipient/status/sentAt/relatedEntityIdのみ。
// ══════════════════════════════════════════════════════════════════════
export async function logEmailSent({ emailType, recipient, status, relatedEntityId }) {
  const norm = normalizeEmail(recipient);
  const entry = {
    emailType,
    recipient: norm,
    status: status === 'failed' ? 'failed' : 'sent',
    relatedEntityId: relatedEntityId || null,
    sentAt: Date.now(),
  };
  const id = `${entry.sentAt}_${randomToken(4)}`;
  await writeJSON(`${PREFIX}emaillog:${id}`, entry);
  const pipeline = getRedis().pipeline();
  pipeline.zadd(`${PREFIX}emaillog:all`, entry.sentAt, id);
  pipeline.zadd(`${PREFIX}emaillog:by-recipient:${norm}`, entry.sentAt, id);
  await pipeline.exec();
  return entry;
}

export async function listEmailLog(limit = 200) {
  const ids = await getRedis().zrevrange(`${PREFIX}emaillog:all`, 0, limit - 1);
  return (await Promise.all(ids.map((id) => readJSON(`${PREFIX}emaillog:${id}`)))).filter(Boolean);
}

export async function listEmailLogForRecipient(email, limit = 50) {
  const ids = await getRedis().zrevrange(`${PREFIX}emaillog:by-recipient:${normalizeEmail(email)}`, 0, limit - 1);
  return (await Promise.all(ids.map((id) => readJSON(`${PREFIX}emaillog:${id}`)))).filter(Boolean);
}

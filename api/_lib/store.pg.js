/**
 * api/_lib/store.pg.js
 * Postgres（新規・専用のSupabaseプロジェクトを想定）実装。
 *
 * 【現状は未接続・未使用】api/_lib/store.js が process.env.DB_BACKEND === 'postgres' の
 * 場合にのみこのファイルを使う。それ以外は常に store.redis.js が使われる。
 *
 * 前提: 既存本番Supabase（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY、api/stripe-webhook.js が
 * 使用中）とは完全に別の、新規作成する「HAKU/灯専用」Supabaseプロジェクトを指す。
 * そのため環境変数名もあえて別名にしている:
 *   HT_SUPABASE_URL
 *   HT_SUPABASE_SERVICE_ROLE_KEY
 * 既存本番Supabaseの認証情報をここに設定しないこと。
 *
 * 呼び出し側（store.redis.jsを使っていた既存コード）が一切変更不要になるよう、
 * このファイルが返すオブジェクトは store.redis.js と同じ camelCase 形状に正規化している
 * （DBのカラム名自体は snake_case のまま。マッピングはこのファイル内で完結させる）。
 *
 * テーブル定義: supabase/schema.sql を参照（User / Application / Membership / AdminUser / AuditLog）。
 * Session・一時トークン・レート制限・Stripe顧客ID索引・Webhook idempotencyは対象外
 * （store.redis.js のみに存在し、Postgres移行後もRedisに残る）。
 */
import { createClient } from '@supabase/supabase-js';

let client = null;
function db() {
  if (!client) {
    const url = process.env.HT_SUPABASE_URL;
    const key = process.env.HT_SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('HT_SUPABASE_URL / HT_SUPABASE_SERVICE_ROLE_KEY is not set');
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function throwIfError(error, context) {
  if (error) throw new Error(`[store.pg:${context}] ${error.message}`);
}

const toMs = (iso) => (iso ? new Date(iso).getTime() : null);

// ── field-name mapping (DB snake_case <-> JS camelCase, matching store.redis.js's shape) ──
function userFromRow(row) {
  if (!row) return null;
  return {
    email: row.email,
    fullName: row.full_name,
    fullNameKana: row.full_name_kana,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
  };
}
function userToRow(user) {
  const row = {};
  if ('fullName' in user) row.full_name = user.fullName;
  if ('fullNameKana' in user) row.full_name_kana = user.fullNameKana;
  if ('displayName' in user) row.display_name = user.displayName;
  if ('passwordHash' in user) row.password_hash = user.passwordHash;
  return row;
}

function applicationFromRow(row) {
  if (!row) return null;
  return {
    community: row.community,
    email: row.email,
    fullName: row.full_name,
    fullNameKana: row.full_name_kana,
    displayName: row.display_name,
    reason: row.reason,
    referrerName: row.referrer_name,
    status: row.status,
    submittedAt: toMs(row.applied_at),
    reviewedAt: toMs(row.reviewed_at),
    reviewedBy: row.reviewed_by,
    termsVersion: row.terms_version,
    termsAcceptedAt: toMs(row.terms_accepted_at),
  };
}

function membershipFromRow(row) {
  if (!row) return null;
  return {
    community: row.community,
    email: row.email,
    status: row.status,
    plan: row.plan,
    source: row.source,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    currentPeriodEnd: toMs(row.current_period_end),
    canceledAt: toMs(row.canceled_at),
    role: row.role,
    joinedAt: toMs(row.joined_at),
    activatedAt: toMs(row.activated_at),
    updatedAt: toMs(row.updated_at),
  };
}

function adminUserFromRow(row) {
  if (!row) return null;
  return {
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    active: row.active,
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
  };
}

function auditFromRow(row) {
  if (!row) return null;
  return {
    actorId: row.actor_id,
    action: row.action,
    targetId: row.target_id,
    metadata: row.metadata,
    createdAt: toMs(row.created_at),
  };
}

// ── User ───────────────────────────────────────────────────────────────
export async function getUser(email) {
  const { data, error } = await db().from('ht_users').select('*').eq('email', normalizeEmail(email)).maybeSingle();
  throwIfError(error, 'getUser');
  return userFromRow(data);
}

export async function saveUser(user) {
  const email = normalizeEmail(user.email);
  const row = { ...userToRow(user), email, updated_at: new Date().toISOString() };
  const { data, error } = await db().from('ht_users').upsert(row, { onConflict: 'email' }).select().single();
  throwIfError(error, 'saveUser');
  return userFromRow(data);
}

export async function renameUserEmail(oldEmail, newEmail) {
  const { data, error } = await db().from('ht_users')
    .update({ email: normalizeEmail(newEmail), updated_at: new Date().toISOString() })
    .eq('email', normalizeEmail(oldEmail))
    .select().maybeSingle();
  throwIfError(error, 'renameUserEmail');
  return userFromRow(data);
}

// ── Application ──────────────────────────────────────────────────────
export async function createApplication(community, fields) {
  const email = normalizeEmail(fields.email);
  const row = {
    community, email,
    full_name: fields.fullName || '',
    full_name_kana: fields.fullNameKana || '',
    display_name: fields.displayName || '',
    reason: fields.reason || '',
    referrer_name: fields.referrerName || '',
    status: 'pending',
    terms_version: fields.termsVersion || null,
    terms_accepted_at: fields.termsAcceptedAt ? new Date(fields.termsAcceptedAt).toISOString() : null,
  };
  const { data, error } = await db().from('ht_applications').insert(row).select().single();
  throwIfError(error, 'createApplication');
  return applicationFromRow(data);
}

export async function getApplication(community, email) {
  const { data, error } = await db().from('ht_applications')
    .select('*').eq('community', community).eq('email', normalizeEmail(email))
    .order('applied_at', { ascending: false }).limit(1).maybeSingle();
  throwIfError(error, 'getApplication');
  return applicationFromRow(data);
}

export async function listPendingApplications(community) {
  const { data, error } = await db().from('ht_applications')
    .select('*').eq('community', community).eq('status', 'pending').order('applied_at', { ascending: true });
  throwIfError(error, 'listPendingApplications');
  return (data || []).map(applicationFromRow);
}

export async function listApplications(community, status) {
  let query = db().from('ht_applications').select('*').eq('community', community).order('applied_at', { ascending: false });
  if (status && status !== 'all') query = query.eq('status', status);
  const { data, error } = await query;
  throwIfError(error, 'listApplications');
  return (data || []).map(applicationFromRow);
}

export async function resolveApplication(community, email, status, reviewedBy) {
  const { data, error } = await db().from('ht_applications')
    .update({ status, reviewed_at: new Date().toISOString(), reviewed_by: reviewedBy || null })
    .eq('community', community).eq('email', normalizeEmail(email)).eq('status', 'pending')
    .select().maybeSingle();
  throwIfError(error, 'resolveApplication');
  return applicationFromRow(data);
}

export async function renameApplicationEmail(community, oldEmail, newEmail) {
  const { data, error } = await db().from('ht_applications')
    .update({ email: normalizeEmail(newEmail) })
    .eq('community', community).eq('email', normalizeEmail(oldEmail))
    .select().maybeSingle();
  throwIfError(error, 'renameApplicationEmail');
  return applicationFromRow(data);
}

// ── Membership ───────────────────────────────────────────────────────
export async function getMembership(community, email) {
  const { data, error } = await db().from('ht_memberships')
    .select('*').eq('community', community).eq('email', normalizeEmail(email)).maybeSingle();
  throwIfError(error, 'getMembership');
  return membershipFromRow(data);
}

export async function setMembership(community, email, fields) {
  const row = {
    community, email: normalizeEmail(email),
    ...(fields.status !== undefined && { status: fields.status }),
    ...(fields.plan !== undefined && { plan: fields.plan }),
    ...(fields.source !== undefined && { source: fields.source }),
    ...(fields.stripeCustomerId !== undefined && { stripe_customer_id: fields.stripeCustomerId }),
    ...(fields.stripeSubscriptionId !== undefined && { stripe_subscription_id: fields.stripeSubscriptionId }),
    ...(fields.cancelAtPeriodEnd !== undefined && { cancel_at_period_end: fields.cancelAtPeriodEnd }),
    ...(fields.currentPeriodEnd !== undefined && { current_period_end: fields.currentPeriodEnd ? new Date(fields.currentPeriodEnd).toISOString() : null }),
    ...(fields.canceledAt !== undefined && { canceled_at: fields.canceledAt ? new Date(fields.canceledAt).toISOString() : null }),
    ...(fields.activatedAt !== undefined && { activated_at: new Date(fields.activatedAt).toISOString() }),
    role: fields.role || 'member',
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db().from('ht_memberships').upsert(row, { onConflict: 'community,email' }).select().single();
  throwIfError(error, 'setMembership');
  return membershipFromRow(data);
}

export async function deleteMembership(community, email) {
  const { error } = await db().from('ht_memberships').delete().eq('community', community).eq('email', normalizeEmail(email));
  throwIfError(error, 'deleteMembership');
}

export async function getAllMemberships(email) {
  const { data, error } = await db().from('ht_memberships').select('community,status').eq('email', normalizeEmail(email));
  throwIfError(error, 'getAllMemberships');
  const rows = data || [];
  // store.redis.js と同様、'canceling'（解約予約済みだが現在の請求期間はまだ終了していない）
  // も「所属あり」として扱う（アクセス制御側の判定と揃える）。
  const isMember = (community) => rows.some((r) => r.community === community && (r.status === 'active' || r.status === 'canceling'));
  return {
    haku: isMember('haku'),
    tomoshibi: isMember('tomoshibi'),
  };
}

// ── AdminUser ────────────────────────────────────────────────────────
export async function getAdminUser(email) {
  const { data, error } = await db().from('ht_admin_users').select('*').eq('email', normalizeEmail(email)).maybeSingle();
  throwIfError(error, 'getAdminUser');
  return adminUserFromRow(data);
}

export async function saveAdminUser(admin) {
  const email = normalizeEmail(admin.email);
  const row = {
    email,
    password_hash: admin.passwordHash,
    role: admin.role || 'super_admin',
    active: admin.active !== undefined ? admin.active : true,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db().from('ht_admin_users').upsert(row, { onConflict: 'email' }).select().single();
  throwIfError(error, 'saveAdminUser');
  return adminUserFromRow(data);
}

export async function listAdminUsers() {
  const { data, error } = await db().from('ht_admin_users').select('*');
  throwIfError(error, 'listAdminUsers');
  return (data || []).map(adminUserFromRow);
}

export async function anyAdminUserExists() {
  const { count, error } = await db().from('ht_admin_users').select('*', { count: 'exact', head: true });
  throwIfError(error, 'anyAdminUserExists');
  return (count || 0) > 0;
}

// ── AuditLog ─────────────────────────────────────────────────────────
export async function logAudit({ actorId, action, targetId, metadata }) {
  const row = { actor_id: actorId || 'system', action, target_id: targetId || null, metadata: metadata || null };
  const { data, error } = await db().from('ht_audit_log').insert(row).select().single();
  throwIfError(error, 'logAudit');
  return auditFromRow(data);
}

export async function listAuditLog(limit = 100) {
  const { data, error } = await db().from('ht_audit_log').select('*').order('created_at', { ascending: false }).limit(limit);
  throwIfError(error, 'listAuditLog');
  return (data || []).map(auditFromRow);
}

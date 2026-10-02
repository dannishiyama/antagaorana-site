/**
 * api/_lib/points.js
 * HAKU POINT のサービス層（入力検証・種別・監査ログ）。
 *
 * 画面（admin.js / community-auth.js）はこのファイルの関数だけを呼ぶ。保存先（Redis台帳）の詳細は
 * point-store.redis.js に閉じ込めてあり、将来Postgres等へ移す場合はstoreの差し替えだけで済む。
 *
 * 今回の範囲：管理者による手動の付与・調整・取消のみ。
 * 「〇〇したら自動で〇pt」といった自動付与ルールは未実装（ルール未確定のため）。
 * 将来の自動付与は、同じ grantPoints() を refType/refId と固定のidempotencyKey
 * （例: `event:${eventId}:${email}:attend`）付きで呼ぶだけで追加できる構造にしてある。
 */
import { redisPointStore } from './point-store.redis.js';
import { logAudit as defaultLogAudit } from './store.js';

export const POINT_KINDS = {
  ADMIN_GRANT: 'admin_grant',
  ADMIN_ADJUST: 'admin_adjust',
  ADMIN_REVERSAL: 'admin_reversal',
};

// 会員本人に見せる名称（運営の個人名・メールアドレスは見せない）。
export const POINT_KIND_LABELS = {
  admin_grant: '運営からのポイント',
  admin_adjust: 'ポイントの調整',
  admin_reversal: 'ポイントの取り消し',
};

export const MAX_POINTS_PER_OPERATION = 1_000_000;
export const MAX_REASON_LENGTH = 200;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

export class PointError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function parseAmount(value, { allowNegative }) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new PointError('invalid_amount', 'ポイント数は整数で入力してください。');
  if (n === 0) throw new PointError('invalid_amount', 'ポイント数は0以外で入力してください。');
  if (!allowNegative && n < 0) throw new PointError('invalid_amount', '付与するポイント数は1以上で入力してください。');
  if (Math.abs(n) > MAX_POINTS_PER_OPERATION) {
    throw new PointError('invalid_amount', `1回の操作で扱えるのは${MAX_POINTS_PER_OPERATION.toLocaleString('ja-JP')}ptまでです。`);
  }
  return n;
}

function parseReason(value, { required }) {
  const reason = String(value || '').trim();
  if (required && !reason) throw new PointError('reason_required', '理由を入力してください。');
  if (reason.length > MAX_REASON_LENGTH) throw new PointError('reason_too_long', `理由は${MAX_REASON_LENGTH}文字以内で入力してください。`);
  return reason;
}

function parseRequestId(value) {
  const id = String(value || '').trim();
  if (!REQUEST_ID_RE.test(id)) throw new PointError('invalid_request_id', '操作IDが不正です。画面を開き直してもう一度お試しください。');
  return id;
}

function toPublicEntry(e) {
  return {
    id: e.id,
    delta: e.delta,
    kind: e.kind,
    kindLabel: POINT_KIND_LABELS[e.kind] || 'ポイント',
    reason: e.reason || '',
    createdAt: e.createdAt,
    balanceAfter: e.balanceAfter,
  };
}

export function createPointService({ store = redisPointStore, logAudit = defaultLogAudit } = {}) {
  async function audit(actorId, action, email, entry) {
    try {
      await logAudit({ actorId, action, targetId: email, metadata: { entryId: entry.id, delta: entry.delta, reason: entry.reason } });
    } catch (err) {
      // 台帳への記録が本体。操作ログの書き込み失敗でポイント操作自体は取り消さない。
      console.error('[points] audit log failed:', err.message);
    }
  }

  // 同じ操作ID（requestId）で再送された場合は、新しく付与せず最初の結果をそのまま返す。
  // 同じ操作IDで内容が違う場合は、取り違えを防ぐためエラーにする。
  function resolveAppend(result, expected) {
    if (result.status === 'ok') return { entry: result.entry, duplicate: false };
    if (result.status === 'duplicate') {
      const e = result.entry;
      if (!e || e.email !== expected.email || e.delta !== expected.delta || e.kind !== expected.kind || e.reversalOf !== (expected.reversalOf || null)) {
        throw new PointError('idempotency_conflict', '同じ操作IDで内容の異なる操作がありました。画面を開き直してもう一度お試しください。', 409);
      }
      return { entry: e, duplicate: true };
    }
    if (result.status === 'insufficient') {
      throw new PointError('insufficient', `この操作を行うと現在ポイント（${result.balance.toLocaleString('ja-JP')}pt）がマイナスになるため実行できません。`, 409);
    }
    if (result.status === 'already_reversed') {
      throw new PointError('already_reversed', 'この履歴はすでに取り消されています。', 409);
    }
    throw new PointError('append_failed', 'ポイントの記録に失敗しました。');
  }

  // 管理者による付与（常にプラス）。
  async function grantPoints({ email, amount, reason, requestId, actorId, refType = null, refId = null }) {
    const target = normalizeEmail(email);
    const delta = parseAmount(amount, { allowNegative: false });
    const reasonText = parseReason(reason, { required: false });
    const rid = parseRequestId(requestId);
    const result = await store.appendEntry({
      email: target, delta, kind: POINT_KINDS.ADMIN_GRANT, reason: reasonText, actorId,
      idempotencyKey: `admin:${rid}`, refType, refId, allowNegative: false,
    });
    const out = resolveAppend(result, { email: target, delta, kind: POINT_KINDS.ADMIN_GRANT });
    if (!out.duplicate) await audit(actorId, 'point_grant', target, out.entry);
    return { ...out, balance: await store.getBalance(target) };
  }

  // 管理者による調整（プラスもマイナスも可。理由必須。残高がマイナスになる調整は不可）。
  async function adjustPoints({ email, amount, reason, requestId, actorId }) {
    const target = normalizeEmail(email);
    const delta = parseAmount(amount, { allowNegative: true });
    const reasonText = parseReason(reason, { required: true });
    const rid = parseRequestId(requestId);
    const result = await store.appendEntry({
      email: target, delta, kind: POINT_KINDS.ADMIN_ADJUST, reason: reasonText, actorId,
      idempotencyKey: `admin:${rid}`, allowNegative: false,
    });
    const out = resolveAppend(result, { email: target, delta, kind: POINT_KINDS.ADMIN_ADJUST });
    if (!out.duplicate) await audit(actorId, 'point_adjust', target, out.entry);
    return { ...out, balance: await store.getBalance(target) };
  }

  // 誤って付与・調整した履歴の取消。元の履歴は消さず、逆符号の履歴を追記する。
  // 1つの履歴は1回しか取り消せない。取消履歴そのものは取り消せない。
  async function reversePoints({ entryId, reason, requestId, actorId }) {
    const original = await store.getEntry(String(entryId || ''));
    if (!original) throw new PointError('not_found', '取り消す履歴が見つかりません。', 404);
    if (original.kind === POINT_KINDS.ADMIN_REVERSAL) throw new PointError('not_reversible', '取消の履歴を取り消すことはできません。', 409);
    const reasonText = parseReason(reason, { required: true });
    const rid = parseRequestId(requestId);
    const delta = -original.delta;
    const result = await store.appendEntry({
      email: original.email, delta, kind: POINT_KINDS.ADMIN_REVERSAL, reason: reasonText, actorId,
      idempotencyKey: `admin:${rid}`, reversalOf: original.id, refType: original.refType, refId: original.refId,
      allowNegative: false,
    });
    const out = resolveAppend(result, { email: original.email, delta, kind: POINT_KINDS.ADMIN_REVERSAL, reversalOf: original.id });
    if (!out.duplicate) await audit(actorId, 'point_reverse', original.email, out.entry);
    return { ...out, balance: await store.getBalance(original.email) };
  }

  const getBalance = (email) => store.getBalance(normalizeEmail(email));

  // 会員本人向け：自分の現在ポイントと履歴（運営の個人情報は含めない）。
  async function getMemberView(email, { limit = 50 } = {}) {
    const { entries, total, balance } = await store.listEntries(normalizeEmail(email), { limit });
    return { balance, total, hasMore: total > entries.length, entries: entries.map(toPublicEntry) };
  }

  // 管理者向け：会員1人の全履歴（操作した管理者・取消済みフラグ・関連IDつき）。
  async function getAdminMemberView(email, { limit = 200 } = {}) {
    const { entries, total, balance } = await store.listEntries(normalizeEmail(email), { limit });
    return { balance, total, entries };
  }

  const listRecent = (limit = 100) => store.listRecentEntries(limit);

  return { grantPoints, adjustPoints, reversePoints, getBalance, getMemberView, getAdminMemberView, listRecent };
}

export const {
  grantPoints, adjustPoints, reversePoints, getBalance, getMemberView, getAdminMemberView, listRecent,
} = createPointService();

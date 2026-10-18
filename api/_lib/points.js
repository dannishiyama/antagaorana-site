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
  MORNING_ATTENDANCE: 'morning_attendance', // 朝の集まりに実際に参加したとき（自動／出席訂正）
  DONATION_HOLD: 'donation_hold', // 社会貢献の申請でポイントを確保（残高から除く）
  DONATION_RELEASE: 'donation_release', // 申請の却下・取消で、確保したポイントを元に戻す
};

// 会員本人に見せる名称（運営の個人名・メールアドレスは見せない）。
export const POINT_KIND_LABELS = {
  admin_grant: '運営からのポイント',
  admin_adjust: 'ポイントの調整',
  admin_reversal: 'ポイントの取り消し',
  morning_attendance: '朝の集まりへの参加',
  donation_hold: '社会貢献の申請（ポイントを確保）',
  donation_release: '社会貢献の申請（確保を解除）',
};
const DONATION_KINDS = ['donation_hold', 'donation_release'];

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

  // システムによる付与（朝の集まりへの実参加など）。操作キー（idempotencyKey）が同じなら、何度呼んでも1回しか付与されない。
  async function awardPoints({ email, amount, kind, reason, idempotencyKey, actorId = 'system', refType = null, refId = null }) {
    const target = normalizeEmail(email);
    const delta = parseAmount(amount, { allowNegative: false });
    if (!Object.values(POINT_KINDS).includes(kind)) throw new PointError('invalid_kind', 'ポイントの種別が不正です。');
    if (!/^[A-Za-z0-9_:.@+-]{8,200}$/.test(String(idempotencyKey || ''))) throw new PointError('invalid_request_id', '操作キーが不正です。');
    const result = await store.appendEntry({
      email: target, delta, kind, reason: parseReason(reason, { required: false }), actorId,
      idempotencyKey: `auto:${idempotencyKey}`, refType, refId, allowNegative: false,
    });
    const out = resolveAppend(result, { email: target, delta, kind });
    if (!out.duplicate) await audit(actorId, 'point_award', target, out.entry);
    return { ...out, balance: await store.getBalance(target) };
  }

  // 社会貢献の申請：ポイントを確保する（残高から除く）。台帳が正本。残高が足りなければ記録されない（マイナスにならない）。
  // 同じ idempotencyKey の再送では、1回しか確保されない。
  async function holdForDonation({ email, amount, idempotencyKey, reason, refId, actorId }) {
    const target = normalizeEmail(email);
    const n = parseAmount(amount, { allowNegative: false });
    if (!/^[A-Za-z0-9_:.@+-]{8,200}$/.test(String(idempotencyKey || ''))) throw new PointError('invalid_request_id', '操作キーが不正です。');
    const result = await store.appendEntry({
      email: target, delta: -n, kind: POINT_KINDS.DONATION_HOLD, reason: parseReason(reason, { required: false }), actorId: actorId || target,
      idempotencyKey: `donation:${idempotencyKey}`, refType: 'donation', refId: refId || null, allowNegative: false,
    });
    const out = resolveAppend(result, { email: target, delta: -n, kind: POINT_KINDS.DONATION_HOLD });
    return { ...out, balance: await store.getBalance(target) };
  }
  // 確保したポイントを元に戻す（却下・取消）。確保した履歴1行につき、1回しか解除できない（reversalOf）。
  async function releaseDonationHold({ holdEntryId, idempotencyKey, reason, actorId }) {
    const hold = await store.getEntry(String(holdEntryId || ''));
    if (!hold || hold.kind !== POINT_KINDS.DONATION_HOLD) throw new PointError('not_found', '確保した履歴が見つかりません。', 404);
    const delta = -hold.delta;
    const result = await store.appendEntry({
      email: hold.email, delta, kind: POINT_KINDS.DONATION_RELEASE, reason: parseReason(reason, { required: false }), actorId: actorId || 'system',
      idempotencyKey: `donation:${idempotencyKey}`, reversalOf: hold.id, refType: 'donation', refId: hold.refId, allowNegative: true,
    });
    let out;
    try { out = resolveAppend(result, { email: hold.email, delta, kind: POINT_KINDS.DONATION_RELEASE, reversalOf: hold.id }); }
    catch (err) { if (err.code === 'already_reversed') return { entry: null, duplicate: true, balance: await store.getBalance(hold.email) }; throw err; }
    return { ...out, balance: await store.getBalance(hold.email) };
  }

  const isEntryReversed = (id) => store.isReversed(String(id || ''));
  const getEntryById = (id) => store.getEntry(String(id || ''));

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
    if (DONATION_KINDS.includes(original.kind)) throw new PointError('not_reversible', '社会貢献の申請に関する履歴は、「ポイント利用｜申請管理」から操作してください。', 409);
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
    const { entries: all, total, balance } = await store.listEntries(normalizeEmail(email), { limit: 100000 });
    // 「これまでの積み重ね」：社会貢献への利用（確保・解除）を除いた合計。誰かのために使っても、成長の目安は減らない（残高とは別のもの）
    const grown = all.filter((e) => !DONATION_KINDS.includes(e.kind)).reduce((s, e) => s + e.delta, 0);
    const entries = all.slice(0, limit);
    return { balance, grown, total, hasMore: total > entries.length, entries: entries.map(toPublicEntry) };
  }

  // 管理者向け：会員1人の全履歴（操作した管理者・取消済みフラグ・関連IDつき）。
  async function getAdminMemberView(email, { limit = 200 } = {}) {
    const { entries, total, balance } = await store.listEntries(normalizeEmail(email), { limit });
    return { balance, total, entries };
  }

  const listRecent = (limit = 100) => store.listRecentEntries(limit);

  return { grantPoints, adjustPoints, reversePoints, awardPoints, holdForDonation, releaseDonationHold, isEntryReversed, getEntryById, getBalance, getMemberView, getAdminMemberView, listRecent };
}

export const {
  grantPoints, adjustPoints, reversePoints, awardPoints, holdForDonation, releaseDonationHold, isEntryReversed, getEntryById, getBalance, getMemberView, getAdminMemberView, listRecent,
} = createPointService();

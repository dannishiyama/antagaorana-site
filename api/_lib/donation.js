/**
 * api/_lib/donation.js
 * HAKUポイントを社会貢献に活用する申請（ポイント利用申請）のサービス層とRedis保存。
 *
 * 仕組み：会員がポイントの利用を申請 → 運営が確認 → 教育支援団体「あんたがおらな」が団体名義で実際に寄付（銀行振込・手動）。
 * 会員から金銭は集めない。ポイントと円の換算は行わない（寄付金額は、運営が実際の振込時に記録するだけ）。
 *
 * ポイントの正本は、既存のHAKUポイント台帳（point-store.redis.js）。
 *   申請        ：台帳に「確保（donation_hold）」を −1,000pt で追記（残高が足りなければ記録されない＝二重利用・マイナスなし）
 *   承認        ：確保をそのまま利用として確定（台帳の追記なし。holdState = consumed）
 *   却下・取消  ：台帳に「解除（donation_release）」を +1,000pt で追記（確保した1行につき1回だけ。reversalOf）
 * 履歴は削除しない。訂正は補正記録（解除・調整）で行う。
 *
 * 保存（Redis。すべて "ht:donation:" 配下。灯サロンのデータとは別）
 *   causes            hash  支援先ID → JSON（管理者が追加・公開・停止できる）
 *   req:{id}          申請1件のJSON      status:{id}  状態の正本（compare-and-setで遷移）
 *   reqs              zset  全申請の索引   member:{email}  zset 会員別の索引
 *   idem:{email}:{rid} 申請の冪等性キー     log:{id}  list 操作履歴（追記のみ）    mail:{id}:{type} 通知の重複防止
 */
import { getRedis } from './store.redis.js';
import { randomToken } from './security.js';
import { holdForDonation, releaseDonationHold, PointError } from './points.js';
import { logAudit } from './store.js';

export const DONATION_POINTS = 1000; // 暫定：1回の申請＝1,000pt
export const STATUS = { CREATING: 'creating', PENDING: 'pending', APPROVED: 'approved', COMPLETED: 'completed', REJECTED: 'rejected', CANCELLED: 'cancelled' };
export const STATUS_LABEL = { pending: '申請中', approved: '承認済み・振込待ち', completed: '振込完了', rejected: '却下', cancelled: '取消' };
export const DEFAULT_CAUSE = { id: 'india', name: 'インドプロジェクトへの支援', status: 'published' };
const ORG = '教育支援団体「あんたがおらな」';

export class DonationError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// 本番では、寄付の運用（受付先・運用の最終承認・保存の確認）が済むまで、申請を受け付けない。DONATION_ENABLED=1 のときだけ有効。
export const donationEnabled = (env = process.env) => env.VERCEL_ENV !== 'production' || env.DONATION_ENABLED === '1';

const NS = 'ht:donation:';
const k = {
  causes: () => `${NS}causes`, req: (id) => `${NS}req:${id}`, status: (id) => `${NS}status:${id}`, all: () => `${NS}reqs`,
  member: (e) => `${NS}member:${e}`, idem: (e, rid) => `${NS}idem:${e}:${rid}`, log: (id) => `${NS}log:${id}`, mail: (id, t) => `${NS}mail:${id}:${t}`,
};
const redis = () => getRedis();
const normEmail = (e) => String(e || '').trim().toLowerCase();
const RID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const CAS = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end return 0";
async function cas(id, from, to) { return Number(await redis().eval(CAS, 1, k.status(id), from, to)) === 1; }
async function readJSON(key) { const raw = await redis().get(key); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } }
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

// ── 支援先（管理者が追加・編集・公開・非公開・受付停止・並び替えできる。公開中のものだけが、会員の選択肢になる） ──
// 削除はしない（過去の申請が参照するため）。申請には、その時点の名称・説明・URLを写し（スナップショット）、あとで編集しても過去の記録は変わらない。
export const CAUSE_STATUS = { published: '公開中', unpublished: '非公開', stopped: '受付停止' };
export const OTHER_CAUSE_ID = 'other'; // 「その他の支援先」（会員の希望。運営が内容を確認して承認するまで、支援先として登録・公開されない）
// 公式URLの検証：http / https だけ。ユーザー名・パスワード付き、javascript: などは拒否。空は許可（任意項目）
export function cleanUrl(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return '';
  if (raw.length > 200) throw new DonationError('bad_url', 'URLは200文字以内で入力してください。');
  let u; try { u = new URL(raw); } catch { throw new DonationError('bad_url', 'URLは、http:// または https:// から始まる形式で入力してください。'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !u.hostname.includes('.')) throw new DonationError('bad_url', 'URLは、http:// または https:// から始まる形式で入力してください。');
  return u.href;
}
const pubCause = (c) => ({ id: c.id, name: c.name, description: c.description || '', url: c.url || '', status: c.status, order: c.order || 0 });
export async function listCauses({ publishedOnly = false } = {}) {
  const r = redis();
  if (!(await r.exists(k.causes()))) await r.hsetnx(k.causes(), DEFAULT_CAUSE.id, JSON.stringify({ ...DEFAULT_CAUSE, order: 1, createdAt: Date.now() }));
  const all = Object.values(await r.hgetall(k.causes())).map((v) => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
  const list = publishedOnly ? all.filter((c) => c.status === 'published') : all;
  return list.sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0)).map(pubCause);
}
export async function saveCause({ id, name, description, url, status, actorId }) {
  const nm = text(name, 40); if (!nm) throw new DonationError('bad_name', '支援先の名称を入力してください。');
  if (!Object.keys(CAUSE_STATUS).includes(status)) throw new DonationError('bad_status', '状態が正しくありません。');
  const link = cleanUrl(url);
  const all = await listCauses();
  const cid = id ? String(id) : `c${Date.now().toString(36)}${randomToken(2)}`;
  if (id && !all.some((c) => c.id === cid)) throw new DonationError('not_found', '支援先が見つかりません。', 404);
  if (cid === OTHER_CAUSE_ID) throw new DonationError('bad_id', 'このIDは使えません。');
  const cur = id ? JSON.parse(await redis().hget(k.causes(), cid)) : {};
  const order = id ? (cur.order || 0) : Math.max(0, ...all.map((c) => c.order || 0)) + 1;
  const rec = { ...cur, id: cid, name: nm, description: text(description, 200), url: link, status, order, createdAt: cur.createdAt || Date.now(), updatedAt: Date.now() };
  await redis().hset(k.causes(), cid, JSON.stringify(rec));
  await safeAudit(actorId, 'donation_cause_save', cid, { name: nm, status });
  return pubCause(rec);
}
// 表示順の変更（1つ上／下へ）。順番は、通し番号に振り直してから入れ替える
export async function moveCause({ id, dir, actorId }) {
  const all = await listCauses();
  const i = all.findIndex((c) => c.id === String(id));
  if (i < 0) throw new DonationError('not_found', '支援先が見つかりません。', 404);
  const j = dir === 'up' ? i - 1 : dir === 'down' ? i + 1 : -1;
  if (j >= 0 && j < all.length) { const t = all[i]; all[i] = all[j]; all[j] = t; }
  for (let n = 0; n < all.length; n++) {
    const cur = JSON.parse(await redis().hget(k.causes(), all[n].id));
    if ((cur.order || 0) !== n + 1) await redis().hset(k.causes(), all[n].id, JSON.stringify({ ...cur, order: n + 1, updatedAt: Date.now() }));
  }
  await safeAudit(actorId, 'donation_cause_move', String(id), { dir });
  return listCauses();
}

async function safeAudit(actorId, action, targetId, metadata) {
  try { await logAudit({ actorId, action, targetId, metadata }); } catch (e) { console.error('[donation] audit failed:', e.message); }
}
async function appendLog(id, actor, type, detail) {
  await redis().rpush(k.log(id), JSON.stringify({ at: Date.now(), actor, type, detail: detail || null }));
}

// ── 読み取り ──
async function load(id) {
  if (!/^DN-[0-9]{8}-[A-Z0-9]{4,8}$/.test(String(id || ''))) return null;
  const rec = await readJSON(k.req(id));
  if (!rec) return null;
  const st = await redis().get(k.status(id));
  return { ...rec, status: st || rec.status };
}
export async function getRequest(id) { return load(id); }
export async function getLog(id) { return (await redis().lrange(k.log(id), 0, -1)).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean); }

// 会員本人に見せる形（管理者メモ・振込先・金額・処理した管理者は含めない）
export const toMemberView = (r) => ({ id: r.id, causeName: r.causeName, causeKind: r.causeKind || 'registered', causeReview: r.causeReview || 'none', points: r.points, status: r.status, statusLabel: STATUS_LABEL[r.status] || r.status, createdAt: r.createdAt, approvedAt: r.approvedAt || null, completedAt: r.completedAt || null });
export async function listMine(email) {
  const e = normEmail(email);
  const ids = await redis().zrevrange(k.member(e), 0, 49);
  const recs = (await Promise.all(ids.map(load))).filter((r) => r && r.email === e && r.status !== STATUS.CREATING);
  return recs.map(toMemberView);
}

// ── 申請（会員） ──
export async function createRequest({ email, causeId, requestId, memberName = '', other = null }) {
  const e = normEmail(email);
  const rid = String(requestId || '').trim();
  if (!RID_RE.test(rid)) throw new DonationError('invalid_request_id', '操作IDが不正です。画面を開き直してもう一度お試しください。');
  const isOther = String(causeId || '') === OTHER_CAUSE_ID;
  let cause, oc = null, sig = '';
  if (isOther) { // 希望先の入力検証（必須・長さ・URL）。希望しただけでは、支援先として登録も公開もされない
    const o = other && typeof other === 'object' ? other : {};
    const nm = text(o.name, 60), reason = text(o.reason, 300);
    if (!nm) throw new DonationError('bad_other_name', '希望する支援先（団体名・プロジェクト名）を入力してください。');
    if (!reason) throw new DonationError('bad_other_reason', '支援したい理由を入力してください。');
    oc = { name: nm, url: cleanUrl(o.url), reason };
    sig = `${oc.name}|${oc.url}|${oc.reason}`;
    cause = { id: OTHER_CAUSE_ID, name: oc.name, description: '', url: oc.url };
  } else {
    cause = (await listCauses({ publishedOnly: true })).find((c) => c.id === String(causeId || ''));
    if (!cause) throw new DonationError('cause_unavailable', '選べる支援先がありません。画面を開き直してください。', 409);
  }

  const id = `DN-${new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '')}-${randomToken(3).toUpperCase()}`;
  const claimed = await redis().set(k.idem(e, rid), id, 'EX', 60 * 60 * 24 * 30, 'NX');
  if (!claimed) { // 同じ操作IDの再送：新しく作らず、最初の結果を返す
    const prev = await load(await redis().get(k.idem(e, rid)));
    if (prev && prev.email === e && prev.causeId === cause.id && (prev.otherSig || '') === sig && prev.status !== STATUS.CREATING) return { request: prev, duplicate: true };
    if (prev && prev.status === STATUS.CREATING) throw new DonationError('in_progress', '処理中です。少し待ってから、画面を開き直してください。', 409);
    throw new DonationError('idempotency_conflict', '同じ操作IDで内容の異なる申請がありました。画面を開き直してもう一度お試しください。', 409);
  }
  const now = Date.now();
  const rec = { id, community: 'haku', email: e, memberName: text(memberName, 40), causeId: cause.id, causeName: cause.name, causeDescription: cause.description || '', causeUrl: cause.url || '', causeKind: isOther ? 'other' : 'registered', causeReview: isOther ? 'pending' : 'none', ...(isOther ? { otherCause: oc, otherSig: sig } : {}), points: DONATION_POINTS, status: STATUS.CREATING, holdState: 'none', holdEntryId: null, createdAt: now, idempotencyKey: rid };
  await redis().set(k.req(id), JSON.stringify(rec)); await redis().set(k.status(id), STATUS.CREATING);
  try {
    const held = await holdForDonation({ email: e, amount: DONATION_POINTS, idempotencyKey: `hold:${id}`, reason: `ポイント利用申請 ${id}`, refId: id, actorId: e });
    rec.holdEntryId = held.entry.id; rec.holdState = 'held';
  } catch (err) { // 残高不足など：何も残さない（同じ操作IDで再試行できるようにキーも外す）
    await redis().del(k.idem(e, rid), k.req(id), k.status(id));
    if (err instanceof PointError && err.code === 'insufficient') throw new DonationError('insufficient', `利用できるポイントが足りません（申請には${DONATION_POINTS.toLocaleString('ja-JP')}pt が必要です）。`, 409);
    throw err;
  }
  rec.status = STATUS.PENDING;
  await redis().set(k.req(id), JSON.stringify(rec));
  await cas(id, STATUS.CREATING, STATUS.PENDING);
  await redis().zadd(k.all(), now, id); await redis().zadd(k.member(e), now, id);
  await appendLog(id, e, 'created', { points: DONATION_POINTS, cause: cause.name });
  await safeAudit(e, 'donation_request', id, { points: DONATION_POINTS, causeId: cause.id });
  return { request: rec, duplicate: false };
}

// ── 管理操作 ──
async function save(rec, patch) { const next = { ...rec, ...patch }; await redis().set(k.req(rec.id), JSON.stringify(next)); return next; }
function need(rec) { if (!rec) throw new DonationError('not_found', '申請が見つかりません。', 404); return rec; }
const bad = (rec, expect) => new DonationError('invalid_state', `この申請は「${STATUS_LABEL[rec.status] || rec.status}」のため、この操作はできません（${expect}の申請のみ）。`, 409);

// 確保したポイントを解除する（却下・取消）。途中で失敗しても、同じ操作をやり直せば解除が完了する（冪等）。
async function releaseHold(rec, actor, reason) {
  if (rec.holdState === 'released') return rec;
  const out = await releaseDonationHold({ holdEntryId: rec.holdEntryId, idempotencyKey: `release:${rec.id}`, reason, actorId: actor });
  return save(rec, { holdState: 'released', releaseEntryId: out.entry?.id || rec.releaseEntryId || null });
}

export async function approve(id, actor) {
  let rec = need(await load(id));
  if (rec.status === STATUS.APPROVED) return { request: rec, duplicate: true };
  if (rec.status !== STATUS.PENDING || rec.holdState !== 'held') throw bad(rec, '申請中');
  if (rec.causeKind === 'other' && rec.causeReview !== 'approved') throw new DonationError('cause_review_required', 'その他の支援先は、先に「希望先を承認する」で、希望先を承認してください。', 409);
  if (!(await cas(id, STATUS.PENDING, STATUS.APPROVED))) throw bad(need(await load(id)), '申請中');
  rec = await save(rec, { status: STATUS.APPROVED, approvedAt: Date.now(), approvedBy: actor, holdState: 'consumed' });
  await appendLog(id, actor, 'approved'); await safeAudit(actor, 'donation_approve', id, { email: rec.email });
  return { request: rec, duplicate: false };
}
async function closeUnpaid(id, actor, reason, { to, from, exception = false }) {
  let rec = need(await load(id));
  const why = text(reason, 200);
  if (!why) throw new DonationError('reason_required', '理由を入力してください。');
  if (rec.status === to) { rec = await releaseHold(rec, actor, why); return { request: rec, duplicate: true }; } // 前回、途中で止まった解除の再実行
  if (rec.status !== from) throw bad(rec, STATUS_LABEL[from]);
  if (!(await cas(id, from, to))) throw bad(need(await load(id)), STATUS_LABEL[from]);
  const at = Date.now();
  rec = await save(rec, to === STATUS.REJECTED ? { status: to, rejectedAt: at, rejectedBy: actor, rejectReason: why, ...(rec.causeKind === 'other' ? { causeReview: 'rejected' } : {}) } : { status: to, cancelledAt: at, cancelledBy: actor, cancelReason: why, ...(exception ? { cancelledAfterApproval: true } : {}) });
  rec = await releaseHold(rec, actor, why);
  await appendLog(id, actor, to === STATUS.REJECTED ? 'rejected' : (exception ? 'cancelled_after_approval' : 'cancelled'), { reason: why });
  await safeAudit(actor, to === STATUS.REJECTED ? 'donation_reject' : (exception ? 'donation_cancel_after_approval' : 'donation_cancel'), id, { email: rec.email, reason: why });
  return { request: rec, duplicate: false };
}
// 希望先の確認：承認／保留（確認中）／却下。承認しても、支援先の一覧には自動で公開されない（公開は、別途、管理者が支援先として登録する）。
// 却下は、既存の却下（確保したポイントの解除）をそのまま使う。
export async function reviewCause(id, actor, decision, note) {
  let rec = need(await load(id));
  if (rec.causeKind !== 'other') throw new DonationError('not_other', 'この申請は、運営が登録した支援先への申請です。', 409);
  const memo = text(note, 200);
  if (decision === 'reject') {
    const out = await reject(id, actor, memo);
    const next = await save(out.request, { causeReview: 'rejected', causeReviewAt: Date.now(), causeReviewBy: actor, causeReviewNote: memo });
    await appendLog(id, actor, 'cause_rejected', { note: memo });
    return { request: next, duplicate: out.duplicate };
  }
  if (!['approve', 'hold'].includes(decision)) throw new DonationError('bad_decision', '操作が正しくありません。');
  if (rec.status !== STATUS.PENDING) throw bad(rec, '申請中');
  const to = decision === 'approve' ? 'approved' : 'hold';
  if (rec.causeReview === to) return { request: rec, duplicate: true };
  if (rec.causeReview === 'rejected' || (rec.causeReview === 'approved' && to === 'hold')) throw new DonationError('invalid_state', '希望先は、すでに確認済みです。', 409);
  rec = await save(rec, { causeReview: to, causeReviewAt: Date.now(), causeReviewBy: actor, causeReviewNote: memo });
  await appendLog(id, actor, to === 'approved' ? 'cause_approved' : 'cause_hold', { note: memo });
  await safeAudit(actor, to === 'approved' ? 'donation_cause_approve' : 'donation_cause_hold', id, { name: rec.causeName });
  return { request: rec, duplicate: false };
}
export const reject = (id, actor, reason) => closeUnpaid(id, actor, reason, { from: STATUS.PENDING, to: STATUS.REJECTED });
export const cancel = (id, actor, reason) => closeUnpaid(id, actor, reason, { from: STATUS.PENDING, to: STATUS.CANCELLED });
// 承認後の取消・誤りの訂正は、通常の取消とは別の例外処理（理由と確認が必須。振込完了後は、この操作ではできない）
export async function exceptionCancel(id, actor, reason, confirm) {
  if (confirm !== id) throw new DonationError('confirm_required', '確認のため、申請IDを入力してください。');
  return closeUnpaid(id, actor, reason, { from: STATUS.APPROVED, to: STATUS.CANCELLED, exception: true });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export async function registerTransfer(id, actor, { amountYen, date, destination, reference }) {
  let rec = need(await load(id));
  if (rec.status !== STATUS.APPROVED) throw bad(rec, '承認済み・振込待ち');
  const amt = typeof amountYen === 'string' && /^\d{1,9}$/.test(amountYen.trim()) ? Number(amountYen) : amountYen;
  if (!Number.isInteger(amt) || amt < 1 || amt > 100_000_000) throw new DonationError('bad_amount', '寄付金額（円）は、1〜100,000,000の整数で入力してください。');
  const d = String(date || '').trim();
  if (!DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) throw new DonationError('bad_date', '振込日を正しく入力してください。');
  const dest = text(destination, 80); if (!dest) throw new DonationError('bad_destination', '振込先を入力してください。');
  const transfer = { amountYen: amt, date: d, destination: dest, reference: text(reference, 60), registeredAt: Date.now(), registeredBy: actor };
  rec = await save(rec, { transfer });
  await appendLog(id, actor, 'transfer_registered', { amountYen: amt, date: d, destination: dest });
  await safeAudit(actor, 'donation_transfer_register', id, { amountYen: amt, date: d });
  return { request: rec };
}
export async function complete(id, actor) {
  let rec = need(await load(id));
  if (rec.status === STATUS.COMPLETED) return { request: rec, duplicate: true };
  if (rec.status !== STATUS.APPROVED) throw bad(rec, '承認済み・振込待ち');
  const t = rec.transfer;
  if (!t || !t.amountYen || !t.date || !t.destination) throw new DonationError('transfer_required', '振込完了にするには、先に振込日・実際の金額・振込先を登録してください。', 409);
  if (!(await cas(id, STATUS.APPROVED, STATUS.COMPLETED))) throw bad(need(await load(id)), '承認済み・振込待ち');
  rec = await save(rec, { status: STATUS.COMPLETED, completedAt: Date.now(), completedBy: actor });
  await appendLog(id, actor, 'completed', { amountYen: t.amountYen, date: t.date }); await safeAudit(actor, 'donation_complete', id, { email: rec.email, amountYen: t.amountYen });
  return { request: rec, duplicate: false };
}
export async function addNote(id, actor, memo) {
  const rec = need(await load(id));
  const m = text(memo, 500);
  const next = await save(rec, { memo: m });
  await appendLog(id, actor, 'memo', { memo: m }); await safeAudit(actor, 'donation_memo', id, {});
  return { request: next };
}

// 通知の重複防止：同じ申請・同じ種類は1回だけ（送信に失敗しても、申請・ポイント・振込記録は消えない）
export async function claimMail(id, type) { return Boolean(await redis().set(k.mail(id, type), String(Date.now()), 'NX')); }
export async function noteMail(id, type, ok) { await appendLog(id, 'system', ok ? 'mail_sent' : 'mail_failed', { type }); }

// ── 一覧・集計・CSV（管理者） ──
const handledBy = (r) => r.completedBy || r.approvedBy || r.rejectedBy || r.cancelledBy || '';
export async function listAll({ status = '', q = '', cause = '', kind = '', from = '', to = '', sort = 'new', field = 'created' } = {}) {
  const ids = await redis().zrevrange(k.all(), 0, 1999);
  let recs = (await Promise.all(ids.map(load))).filter((r) => r && r.status !== STATUS.CREATING);
  const fieldAt = (r) => (field === 'approved' ? r.approvedAt : field === 'completed' ? r.completedAt : r.createdAt);
  if (status) recs = recs.filter((r) => r.status === status);
  if (cause) recs = recs.filter((r) => r.causeId === cause);
  if (kind === 'other') recs = recs.filter((r) => r.causeKind === 'other');
  if (kind === 'registered') recs = recs.filter((r) => r.causeKind !== 'other');
  if (kind === 'review') recs = recs.filter((r) => r.causeKind === 'other' && ['pending', 'hold'].includes(r.causeReview) && r.status === STATUS.PENDING);
  const f = from && DATE_RE.test(from) ? Date.parse(`${from}T00:00:00+09:00`) : null;
  const t = to && DATE_RE.test(to) ? Date.parse(`${to}T23:59:59.999+09:00`) : null;
  if (f !== null) recs = recs.filter((r) => fieldAt(r) && fieldAt(r) >= f);
  if (t !== null) recs = recs.filter((r) => fieldAt(r) && fieldAt(r) <= t);
  const needle = String(q || '').trim().toLowerCase();
  if (needle) recs = recs.filter((r) => [r.id, r.email, r.memberName, r.causeName, r.memo, r.transfer?.reference, r.otherCause?.name, r.otherCause?.reason, r.otherCause?.url].join(' ').toLowerCase().includes(needle));
  recs.sort((a, b) => (sort === 'old' ? a.createdAt - b.createdAt : sort === 'points' ? b.points - a.points || b.createdAt - a.createdAt : b.createdAt - a.createdAt));
  return recs;
}
export function summarize(recs) {
  const by = {};
  for (const r of recs) {
    const c = (by[r.causeId] ||= { causeId: r.causeId, causeName: r.causeName, statuses: {}, totalPoints: 0, completedYen: 0 });
    const s = (c.statuses[r.status] ||= { count: 0, points: 0 });
    s.count += 1; s.points += r.points;
    if (r.status === STATUS.PENDING || r.status === STATUS.APPROVED || r.status === STATUS.COMPLETED) c.totalPoints += r.points;
    if (r.status === STATUS.COMPLETED) c.completedYen += r.transfer?.amountYen || 0;
  }
  return Object.values(by);
}
const jst = (ms) => (ms ? new Date(ms + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) : '');
function cell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // 表計算ソフトの数式として実行されないようにする
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(recs) {
  const head = ['申請ID', '会員名', '会員ID（メール）', '申請日時', '利用ポイント', '支援先', '支援先の種類', '希望先のURL', '希望の理由', '希望先の確認', 'ステータス', '承認日時', '却下日時', '寄付金額（円）', '振込日', '振込先', '振込控えの参照番号', '処理した管理者', '管理者メモ'];
  const rows = recs.map((r) => [r.id, r.memberName || '', r.email, jst(r.createdAt), r.points, r.causeName, r.causeKind === 'other' ? 'その他（会員の希望）' : '運営が登録', r.otherCause?.url || r.causeUrl || '', r.otherCause?.reason || '', { none: '', pending: '確認前', hold: '確認中（保留）', approved: '承認', rejected: '却下' }[r.causeReview || 'none'] || '', STATUS_LABEL[r.status] || r.status, jst(r.approvedAt), jst(r.rejectedAt), r.transfer?.amountYen ?? '', r.transfer?.date || '', r.transfer?.destination || '', r.transfer?.reference || '', handledBy(r), r.memo || '']);
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
export const ORG_NAME = ORG;
export { handledBy };

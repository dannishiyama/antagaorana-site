/**
 * api/_lib/morning-attendance.js
 * 朝の集まりの「出席の記録」（スタンプ）と、実参加に連動するHAKUポイントの付与・取消。
 *
 * 大原則
 *   - ポイントは、既存のHAKUポイント台帳（api/_lib/points.js）にだけ記録する。ここに残高は持たない。
 *   - 付与は「出席が確定したとき」だけ。参加表明・Meetのボタンを押しただけでは付与しない。
 *   - 1会員／1開催日につき、有効な付与は1回。操作キー（morning:日付:会員:世代）を台帳が見て、重複・同時・再試行でも二重にならない。
 *   - 取消・訂正は履歴を消さない。台帳に逆符号の履歴を足して相殺する。取消のあとに再び確定すると、世代が1つ進み、新しく付与される。
 *   - 出席を確定する経路は2つだけ：Google Meetの参加履歴との照合（meet-attendance.js）／運営の出席訂正（理由必須）。
 *
 * 保存（Redis。台帳とは別のキー。HAKU会員のメールをキーにする）
 *   ht:attendance:rec:{date}:{email}   記録 { status:'attended'|'cancelled', gen, entryId, source, ... }
 *   ht:attendance:idx:{email}          zset 会員別の出席日（score=日付の数値）。スタンプ表示用
 *   ht:attendance:lock:{date}:{email}  処理中の印（短いTTL）
 *   ht:attendance:pending:{date}       hash 照合できなかった参加者（確認待ち）
 *   ht:attendance:identity:{googleId}  Googleアカウントの識別子 → 会員のメール（運営が結び付けたものだけ）
 */
import { getRedis, getMembership, logAudit } from './store.js';
import { awardPoints, reversePoints, isEntryReversed, POINT_KINDS, PointError } from './points.js';
import { MORNING_CONFIG, isValidDate, isValidMonth, jstToday, monthDates } from './morning.js';

const P = 'ht:attendance:';
const k = {
  rec: (date, email) => `${P}rec:${date}:${email}`,
  idx: (email) => `${P}idx:${email}`,
  lock: (date, email) => `${P}lock:${date}:${email}`,
  pending: (date) => `${P}pending:${date}`,
  identity: (id) => `${P}identity:${id}`,
};
const normEmail = (e) => String(e || '').trim().toLowerCase();
const dateScore = (date) => Number(date.replace(/-/g, ''));

export class AttendanceError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

async function readRec(date, email) {
  const raw = await getRedis().get(k.rec(date, email));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function writeRec(rec) {
  await getRedis().set(k.rec(rec.date, rec.email), JSON.stringify(rec));
  await getRedis().zadd(k.idx(rec.email), dateScore(rec.date), rec.date);
}

export async function getAttendance(date, email) { return readRec(date, normEmail(email)); }

// 有効な会員資格（有効／解約予約中）。ポイントを付けてよい人だけ。
async function assertActiveMember(email) {
  const m = await getMembership('haku', email);
  if (!m || (m.status !== 'active' && m.status !== 'canceling')) throw new AttendanceError('not_member', '現在有効なHAKU Community会員ではないため、出席を記録できません。', 409);
}

/**
 * 出席を確定する（スタンプ＋ポイント）。
 * @returns {{status:'confirmed'|'already', record}} 同じ日・同じ会員は、何度呼んでも1回だけ付与される
 */
export async function confirmAttendance({ date, email, source, actorId = 'system', reason = '', now = Date.now() }) {
  const e = normEmail(email);
  if (!isValidDate(date)) throw new AttendanceError('invalid_date', '日付を正しく指定してください。');
  if (date > jstToday(now)) throw new AttendanceError('future', '開催日より前には、出席を記録できません。', 409);
  if (!['google', 'admin'].includes(source)) throw new AttendanceError('invalid_source', '出席の確認方法が不正です。');
  await assertActiveMember(e);

  const lock = await getRedis().set(k.lock(date, e), '1', 'EX', 30, 'NX');
  if (lock !== 'OK') throw new AttendanceError('busy', '同じ出席を処理中です。少し待ってから、もう一度お試しください。', 409);
  try {
    const rec = await readRec(date, e);
    // すでに有効な出席がある（台帳の付与が取り消されていない）なら、何もしない
    if (rec?.status === 'attended' && rec.entryId && !(await isEntryReversed(rec.entryId))) return { status: 'already', record: rec };
    const gen = (rec?.gen || 0) + 1; // 取消のあとの再確定は、新しい世代として付与し直す
    const key = `morning:${date}:${e}:g${gen}`;
    const award = await awardPoints({
      email: e, amount: MORNING_CONFIG.attendancePoints, kind: POINT_KINDS.MORNING_ATTENDANCE,
      reason: `朝の集まり（${date}）への参加`, idempotencyKey: key, actorId, refType: 'morning_attendance', refId: `${date}`,
    });
    const record = {
      date, email: e, status: 'attended', gen, entryId: award.entry.id, points: award.entry.delta, source,
      confirmedAt: now, confirmedBy: actorId, reason: String(reason || '').slice(0, 200), eventId: `morning-${date}`,
    };
    await writeRec(record);
    await getRedis().hdel(k.pending(date), e);
    await logAudit({ actorId, action: 'morning_attendance_confirmed', targetId: e, metadata: { date, source, gen, entryId: award.entry.id } }).catch(() => {});
    return { status: 'confirmed', record };
  } finally {
    await getRedis().del(k.lock(date, e));
  }
}

/** 出席の取消・訂正。ポイントは、台帳に取消（逆符号）の履歴を足して相殺する（履歴は消さない）。 */
export async function cancelAttendance({ date, email, actorId, reason, now = Date.now() }) {
  const e = normEmail(email);
  if (!isValidDate(date)) throw new AttendanceError('invalid_date', '日付を正しく指定してください。');
  const why = String(reason || '').trim();
  if (!why) throw new AttendanceError('reason_required', '理由を入力してください。');
  const lock = await getRedis().set(k.lock(date, e), '1', 'EX', 30, 'NX');
  if (lock !== 'OK') throw new AttendanceError('busy', '同じ出席を処理中です。少し待ってから、もう一度お試しください。', 409);
  try {
    const rec = await readRec(date, e);
    if (!rec || rec.status !== 'attended') throw new AttendanceError('not_attended', 'この日の出席の記録はありません。', 404);
    if (rec.entryId && !(await isEntryReversed(rec.entryId))) {
      try {
        await reversePoints({ entryId: rec.entryId, reason: `出席の取消：${why}`.slice(0, 200), requestId: `attcancel-${rec.entryId}`, actorId });
      } catch (err) {
        if (err instanceof PointError && err.code !== 'already_reversed') throw new AttendanceError(err.code === 'insufficient' ? 'insufficient' : 'reverse_failed', err.message, err.status || 409);
      }
    }
    const next = { ...rec, status: 'cancelled', cancelledAt: now, cancelledBy: actorId, cancelReason: why.slice(0, 200) };
    await writeRec(next);
    await logAudit({ actorId, action: 'morning_attendance_cancelled', targetId: e, metadata: { date, gen: rec.gen, entryId: rec.entryId } }).catch(() => {});
    return { status: 'cancelled', record: next };
  } finally {
    await getRedis().del(k.lock(date, e));
  }
}

/** 会員本人のスタンプ（その月の、実際に参加した日だけ）。取り消された出席は含めない。他の会員の記録は返さない。 */
export async function getStampDates(email, month) {
  if (!isValidMonth(month)) throw new AttendanceError('invalid_month', '月を正しく指定してください。');
  const e = normEmail(email);
  const dates = monthDates(month);
  const found = await getRedis().zrangebyscore(k.idx(e), dateScore(dates[0]), dateScore(dates[dates.length - 1]));
  const out = [];
  for (const d of found) {
    const rec = await readRec(d, e);
    if (rec?.status === 'attended' && rec.entryId && !(await isEntryReversed(rec.entryId))) out.push(d);
  }
  return out.sort();
}

// ── 確認待ち（Googleの参加者のうち、会員と照合できなかった人） ──
export async function setPending(date, items) {
  const key = k.pending(date);
  await getRedis().del(key);
  for (const it of items) await getRedis().hset(key, it.participantKey, JSON.stringify(it));
}
export async function listPending(date) {
  const h = await getRedis().hgetall(k.pending(date));
  return Object.values(h).map((v) => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
}
export async function getPendingItem(date, participantKey) {
  const raw = await getRedis().hget(k.pending(date), participantKey);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export async function removePending(date, participantKey) { await getRedis().hdel(k.pending(date), participantKey); }

// ── Googleアカウントと会員の結び付け（運営が確認したものだけ。表示名の一致では結び付けない） ──
export async function linkGoogleIdentity(googleUserId, email) {
  if (!/^users\/[A-Za-z0-9_-]{3,100}$/.test(String(googleUserId || ''))) throw new AttendanceError('invalid_identity', 'Googleアカウントの識別子が不正です。');
  await getRedis().set(k.identity(googleUserId), normEmail(email));
}
export async function emailByGoogleIdentity(googleUserId) {
  return googleUserId ? getRedis().get(k.identity(googleUserId)) : null;
}

/**
 * api/_lib/morning.js
 * 「朝の集まり」：メンバーの誰かが、その日の朝に参加表明したことで開催予定が成立する仕組み。
 *
 * - 毎日の開催予定は最初から存在しない。参加者が0人の日は「開催予定なし」。
 * - 日付（日本時間）ごとに、既存のイベント/参加者の仕組み（ID: morning-YYYY-MM-DD）を使う。
 * - 未決定のルール（1人でも開催か／当日の締切／取消の締切／参加者の公開範囲）は、
 *   下の MORNING_CONFIG と各関数だけを直せば変えられるようにしてある。
 */
import {
  getEvent, getMembership, getUser, listMorningParticipants, morningEventId,
} from './store.js';

export const MORNING_CONFIG = {
  // 未決定：何人から「開催」とするか（いまは1人でも開催予定）
  minParticipantsToHold: 1,
  // 未決定：当日参加の受付締切／取消の締切。null＝設けない。例：{ hour: 5, minute: 0 }（日本時間・当日）
  joinCutoff: null,
  cancelCutoff: null,
  // 何日先まで参加表明できるか、何か月前まで見られるか（むやみに先の日を作られないための上限）
  maxDaysAhead: 120,
  viewMonthsBack: 6,
  // HOMEで「次の朝の集まり」を探す日数
  nextScanDays: 60,
  // 未決定：参加者の名前・アイコンを誰に見せるか。いまは会員全員（表示名とアイコンだけ。氏名・メールは出さない）
  publicFields: ['name', 'avatarId'],
};

const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const JST_MS = 9 * 3600 * 1000;

export function jstToday(now = Date.now()) {
  return new Date(now + JST_MS).toISOString().slice(0, 10);
}
export function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function isValidMonth(s) { return typeof s === 'string' && MONTH_RE.test(s); }
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function monthDates(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}
export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
export function viewableMonthRange(now = Date.now()) {
  const today = jstToday(now);
  return { min: addMonths(today.slice(0, 7), -MORNING_CONFIG.viewMonthsBack), max: addDays(today, MORNING_CONFIG.maxDaysAhead).slice(0, 7) };
}

function afterCutoff(cutoff, date, now) {
  if (!cutoff) return false;
  if (date !== jstToday(now)) return false;
  const jst = new Date(now + JST_MS);
  return jst.getUTCHours() * 60 + jst.getUTCMinutes() >= cutoff.hour * 60 + (cutoff.minute || 0);
}
// 参加表明できない理由（できるなら null）
export function joinBlock(date, now = Date.now()) {
  if (!isValidDate(date)) return 'invalid';
  const today = jstToday(now);
  if (date < today) return 'past';
  if (date > addDays(today, MORNING_CONFIG.maxDaysAhead)) return 'too_far';
  if (afterCutoff(MORNING_CONFIG.joinCutoff, date, now)) return 'cutoff';
  return null;
}
// 取り消せない理由（できるなら null）。過去の日は記録として残す。
export function leaveBlock(date, now = Date.now()) {
  if (!isValidDate(date)) return 'invalid';
  if (date < jstToday(now)) return 'past';
  if (afterCutoff(MORNING_CONFIG.cancelCutoff, date, now)) return 'cutoff';
  return null;
}
export const MORNING_BLOCK_MESSAGES = {
  invalid: '日付を正しく指定してください。',
  past: '過ぎた日には、参加表明も取り消しもできません。',
  too_far: 'この日は、まだ先すぎて参加表明できません。',
  cutoff: '受付の時間を過ぎています。',
  cancelled: 'この日の朝の集まりは中止になりました。',
  closed: 'この日の朝の集まりは、受付を終了しました。',
};

function initialOf(user) { return String(user?.displayName || '').trim(); }

/**
 * 指定した日付それぞれの「開催予定／参加者」を作る。
 * 参加者は、有効な会員（active／解約予約中）だけ。名前は表示名、画像は avatarId のみ（氏名・メールは含めない）。
 */
export async function buildMorningDays(dates, viewerEmail) {
  const viewer = String(viewerEmail || '').toLowerCase();
  const lists = await listMorningParticipants(dates);
  const emails = [...new Set(lists.flat())];
  const people = new Map();
  await Promise.all(emails.map(async (email) => {
    const [user, membership] = await Promise.all([getUser(email), getMembership('haku', email)]);
    const ok = user && membership && (membership.status === 'active' || membership.status === 'canceling');
    if (ok) people.set(email, { name: initialOf(user) || 'メンバー', avatarId: user.avatarId || null });
  }));
  const events = await Promise.all(dates.map((d, i) => (lists[i].length ? getEvent(morningEventId(d)) : null)));
  return dates.map((date, i) => {
    const valid = lists[i].filter((e) => people.has(e));
    const participants = valid.map((e) => ({ name: people.get(e).name, avatarId: people.get(e).avatarId, me: e === viewer }))
      .sort((a, b) => (b.me - a.me) || a.name.localeCompare(b.name, 'ja'));
    const registration = events[i]?.registration || 'open';
    const count = participants.length;
    const status = registration === 'cancelled' ? 'cancelled' : count >= MORNING_CONFIG.minParticipantsToHold ? 'scheduled' : 'none';
    return { date, count, status, registration, joined: participants.some((p) => p.me), participants };
  });
}

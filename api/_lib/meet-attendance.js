/**
 * api/_lib/meet-attendance.js
 * Google Meet の実際の参加履歴（会議記録・参加者・参加セッション）と、HAKU会員を照合して、出席を確定する。
 *
 * 安全のための決まり
 *   - 日付別のMeet（api/_lib/morning-meet.js が作った会議。space名を保存してある日）だけが対象。
 *     従来の共通Meet（暫定）や、会議がまだ無い日は、日付と会議記録を正しく結べないので、何もしない（'no_meet'）。
 *   - 本人確認は、Googleがログイン済みの参加者に付ける識別子（signedinUser.user = "users/…"）で行う。
 *     運営が確認して結び付けた（linkGoogleIdentity）識別子だけが、会員とみなされる。表示名・匿名・電話の参加は、会員と判断しない。
 *   - 照合できなかった参加者は「確認待ち」として記録するだけ（付与しない）。運営の出席訂正で解決する。
 *   - 参加表明済みで、有効な会員だけが対象。表明していない会員の参加では付与しない。欠席者には付与しない。
 *   - 出席の条件（滞在時間）は未確定。環境変数 MORNING_ATTENDANCE_MIN_MINUTES が設定されるまで、何も確定しない（'rule_unset'）。
 *     0 を設定すると「参加の記録があれば出席」、1 なら「同じ日の入退室の合計が1分以上」（暫定。依頼主の指示）、15 なら「合計15分以上」。
 *   - 会議がまだ終了していない／Google APIが失敗した場合は、途中までの結果で付与しない。取得が全部成功した後にだけ確定する。
 *   - 再実行しても二重に付与されない（confirmAttendance が台帳の操作キーで守る）。
 *   - 定期実行（cron）は MORNING_ATTENDANCE_AUTO=1 のときだけ。既定では無効。
 */
import { meetApiGet, meetConfig, MeetError } from './google-meet.js';
import { getMorningMeet, listMorningParticipants } from './store.js';
import { confirmAttendance, setPending, emailByGoogleIdentity, AttendanceError } from './morning-attendance.js';
import { isValidDate } from './morning.js';

export function attendanceRule() {
  const raw = process.env.MORNING_ATTENDANCE_MIN_MINUTES;
  if (raw === undefined || String(raw).trim() === '') return { set: false, minMinutes: null };
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 600 ? { set: true, minMinutes: n } : { set: false, minMinutes: null };
}
export function autoEnabled() { return process.env.MORNING_ATTENDANCE_AUTO === '1'; }

async function listAll(path, key, params = {}) {
  const out = [];
  let pageToken;
  for (let i = 0; i < 20; i++) {
    const data = await meetApiGet(path, { ...params, pageSize: 100, pageToken });
    out.push(...(data[key] || []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/**
 * space（"spaces/…"）の会議記録から、参加者ごとの合計滞在時間を集める。
 * 戻り値: { ended, participants: [{ participantKey, userId|null, kind, displayName, totalMs, open }] }
 * 1つでも会議が終了していなければ ended:false（まだ確定しない）。
 */
export async function fetchParticipation(spaceName) {
  const records = await listAll('conferenceRecords', 'conferenceRecords', { filter: `space.name = "${spaceName}"` });
  let ended = records.length > 0;
  const byKey = new Map();
  for (const rec of records) {
    if (!rec.endTime) ended = false;
    const people = await listAll(`${rec.name}/participants`, 'participants');
    for (const p of people) {
      const su = p.signedinUser;
      const kind = su ? 'signedin' : p.anonymousUser ? 'anonymous' : p.phoneUser ? 'phone' : 'unknown';
      const userId = su?.user || null;
      const key = userId || p.name;
      const sessions = await listAll(`${p.name}/participantSessions`, 'participantSessions');
      const cur = byKey.get(key) || { participantKey: key, userId, kind, displayName: (su || p.anonymousUser || p.phoneUser || {}).displayName || '', totalMs: 0, open: false, intervals: [] };
      for (const s of sessions) {
        if (!s.startTime) continue;
        if (!s.endTime) { cur.open = true; continue; } // まだ退出していない（会議が続いている）
        const a = Date.parse(s.startTime); const b = Date.parse(s.endTime);
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) cur.intervals.push([a, b]);
      }
      byKey.set(key, cur);
    }
  }
  // 同じ人の入退室を合算する。2台の端末で同時に入っていた時間などの重なりは、二重に数えない（時間帯を統合してから合計する）
  const participants = [...byKey.values()].map(({ intervals, ...rest }) => ({ ...rest, totalMs: unionMs(intervals) }));
  return { ended, participants };
}

export function unionMs(intervals) {
  const sorted = [...intervals].sort((x, y) => x[0] - y[0]);
  let total = 0; let curS = null; let curE = null;
  for (const [a, b] of sorted) {
    if (curE === null || a > curE) { if (curE !== null) total += curE - curS; curS = a; curE = b; } else if (b > curE) curE = b;
  }
  if (curE !== null) total += curE - curS;
  return total;
}

/**
 * 指定した開催日の出席を、Meetの参加履歴と照合して確定する。
 * 戻り値の status: 'done' | 'unconfigured' | 'no_meet' | 'rule_unset' | 'in_progress' | 'no_record'
 * （'error' のときは例外を投げる。この場合、何も確定していない）
 */
export async function syncDayAttendance(date, { now = Date.now(), actorId = 'system' } = {}) {
  if (!isValidDate(date)) throw new AttendanceError('invalid_date', '日付を正しく指定してください。');
  if (!meetConfig().configured) return { status: 'unconfigured' };
  const rule = attendanceRule();
  if (!rule.set) return { status: 'rule_unset' };
  const meet = await getMorningMeet(date);
  if (!meet?.spaceName) return { status: 'no_meet' };

  const { ended, participants } = await fetchParticipation(meet.spaceName); // 失敗したら例外（何も確定しない）
  if (!participants.length && !ended) return { status: 'no_record' };
  if (!ended || participants.some((p) => p.open)) return { status: 'in_progress' };

  const joined = new Set((await listMorningParticipants([date]))[0].map((e) => e.toLowerCase()));
  const need = rule.minMinutes * 60 * 1000;
  const confirmed = []; const pending = []; const notRegistered = []; const short = [];
  for (const p of participants) {
    const email = p.kind === 'signedin' ? await emailByGoogleIdentity(p.userId) : null;
    if (!email) {
      // 会員と結び付いていない参加者（匿名・電話・未確認のGoogleアカウント）。付与せず「確認待ち」にする
      pending.push({ participantKey: p.participantKey, userId: p.userId, kind: p.kind, displayName: p.displayName, minutes: Math.round(p.totalMs / 60000), at: now });
      continue;
    }
    if (!joined.has(email)) { notRegistered.push(email); continue; } // 参加表明していない会員では、付与しない
    if (p.totalMs < need) { short.push(email); continue; }
    try {
      const r = await confirmAttendance({ date, email, source: 'google', actorId, reason: 'Google Meetの参加履歴', now });
      confirmed.push({ email, result: r.status });
    } catch (err) {
      if (err instanceof AttendanceError && err.code === 'not_member') { notRegistered.push(email); continue; }
      throw err;
    }
  }
  await setPending(date, pending);
  return { status: 'done', confirmed: confirmed.length, already: confirmed.filter((c) => c.result === 'already').length, pending: pending.length, belowRule: short.length, notRegistered: notRegistered.length };
}

export { MeetError };

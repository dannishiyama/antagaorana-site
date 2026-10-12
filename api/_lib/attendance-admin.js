/**
 * api/_lib/attendance-admin.js
 * 朝の集まりの出席の管理API（api/admin.js から、attendance- で始まるアクションだけが呼ばれる）。
 * 通常の運用は、Google Meetの参加履歴との自動の照合。ここは「確認状況の確認」と、照合できなかった・誤記録の「例外対応」のため。
 * 毎朝の手動確認を前提にしていない。出席訂正（確定・取消）は理由が必須で、台帳（HAKUポイント）に履歴が残る。
 *
 * GET  ?action=attendance-day&date=YYYY-MM-DD    その日の参加表明者・出席の状態・確認待ち・自動化の設定状況
 * POST ?action=attendance-set   { date, email, op: 'confirm'|'cancel', reason }   出席訂正
 * POST ?action=attendance-sync  { date }         Google Meetの参加履歴と照合して確定（設定が整っている場合だけ）
 * POST ?action=attendance-link  { date, participantKey, email, reason }   確認待ちのGoogle参加者を会員に結び付けて確定
 * GET  ?action=attendance-cron                   定期実行（CRON_SECRET必須。MORNING_ATTENDANCE_AUTO=1 のときだけ動く）
 */
import { checkOrigin, rateLimitGuard } from './http.js';
import { getUser, getMembership, listMorningParticipants, getMorningMeet, getRedis } from './store.js';
import { MORNING_CONFIG, isValidDate, jstToday, addDays } from './morning.js';
import { meetConfig, MeetError } from './google-meet.js';
import { legacyMeetUrl } from './morning-meet.js';
import { attendanceRule, autoEnabled, syncDayAttendance } from './meet-attendance.js';
import {
  confirmAttendance, cancelAttendance, getAttendance, listPending, getPendingItem, removePending, linkGoogleIdentity, AttendanceError,
} from './morning-attendance.js';

const norm = (e) => String(e || '').trim().toLowerCase();

async function recordedEmails(date) {
  const out = []; let cursor = '0';
  const prefix = `ht:attendance:rec:${date}:`;
  do {
    const [next, keys] = await getRedis().scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
    keys.forEach((key) => out.push(key.slice(prefix.length)));
    cursor = next;
  } while (cursor !== '0');
  return out;
}

async function dayView(date) {
  const joined = (await listMorningParticipants([date]))[0].map(norm);
  const recorded = await recordedEmails(date);
  const emails = [...new Set([...joined, ...recorded])];
  const members = await Promise.all(emails.map(async (email) => {
    const [user, membership, rec] = await Promise.all([getUser(email), getMembership('haku', email), getAttendance(date, email)]);
    return {
      email, name: user?.displayName || '', fullName: user?.fullName || '', joined: joined.includes(email), membership: membership?.status || null,
      attendance: rec ? rec.status : 'none', source: rec?.source || null, points: rec?.status === 'attended' ? rec.points : 0, confirmedAt: rec?.confirmedAt || null,
    };
  }));
  const meet = await getMorningMeet(date);
  const rule = attendanceRule();
  return {
    ok: true, date, today: jstToday(), pointsPerAttendance: MORNING_CONFIG.attendancePoints,
    automation: { googleConfigured: meetConfig().configured, dateMeet: Boolean(meet?.spaceName), legacyMeetOnly: !meet?.spaceName && Boolean(legacyMeetUrl()), ruleSet: rule.set, minMinutes: rule.minMinutes, autoEnabled: autoEnabled() },
    members: members.sort((a, b) => (b.joined - a.joined) || a.name.localeCompare(b.name, 'ja')),
    pending: (await listPending(date)).map((p) => ({ participantKey: p.participantKey, kind: p.kind, displayName: p.displayName, minutes: p.minutes, linkable: /^users\//.test(p.participantKey) })),
  };
}

function fail(res, err) {
  if (err instanceof AttendanceError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err instanceof MeetError) return res.status(502).json({ error: 'Google Meetの参加履歴を取得できませんでした。何も記録していません。時間をおいて、もう一度お試しください。', code: `meet_${err.code}` });
  throw err;
}

export async function handleAttendanceAdmin(action, req, res, session) {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const actor = session?.actorId || 'system';
  try {
    if (action === 'attendance-cron') { // 認証は管理者ではなくCRON_SECRET
      const secret = process.env.CRON_SECRET || '';
      if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
      if (!autoEnabled()) return res.status(200).json({ ok: true, skipped: 'auto_disabled' });
      const results = {};
      for (const d of [addDays(jstToday(), -1), jstToday()]) results[d] = await syncDayAttendance(d, { actorId: 'meet-sync' }).catch((e) => ({ status: 'error', code: e.code || 'unknown' }));
      return res.status(200).json({ ok: true, results });
    }
    const isPost = req.method === 'POST';
    if (isPost && !checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
    if ((action === 'attendance-day') === isPost) return res.status(405).json({ error: 'Method not allowed' });
    const date = String(isPost ? body.date : req.query?.date || '');
    if (!isValidDate(date)) return res.status(400).json({ error: '日付を正しく指定してください。' });

    if (action === 'attendance-day') return res.status(200).json(await dayView(date));

    if (!(await rateLimitGuard(req, res, { key: 'admin-attendance', limit: 60, windowSeconds: 15 * 60 }))) return;
    if (action === 'attendance-set') {
      const email = norm(body.email);
      const reason = String(body.reason || '').trim();
      if (!email) return res.status(400).json({ error: '対象の会員を指定してください。' });
      if (!reason) return res.status(400).json({ error: '理由を入力してください。', code: 'reason_required' });
      if (body.op === 'confirm') return res.status(200).json({ ok: true, ...(await confirmAttendance({ date, email, source: 'admin', actorId: actor, reason })) });
      if (body.op === 'cancel') return res.status(200).json({ ok: true, ...(await cancelAttendance({ date, email, actorId: actor, reason })) });
      return res.status(400).json({ error: '操作が正しくありません。' });
    }
    if (action === 'attendance-sync') {
      const out = await syncDayAttendance(date, { actorId: `meet-sync:${actor}` });
      return res.status(200).json({ ok: true, ...out });
    }
    if (action === 'attendance-link') {
      const email = norm(body.email); const reason = String(body.reason || '').trim();
      if (!email || !reason) return res.status(400).json({ error: '会員と理由を入力してください。', code: 'reason_required' });
      const item = await getPendingItem(date, String(body.participantKey || ''));
      if (!item) return res.status(404).json({ error: '確認待ちの参加者が見つかりません。' });
      const m = await getMembership('haku', email);
      if (!m) return res.status(404).json({ error: '対象のHAKU Community会員が見つかりません。' });
      // 結び付けは、Googleにログインして参加した人（識別子がある人）だけ。次回から自動で照合される
      if (/^users\//.test(item.participantKey)) await linkGoogleIdentity(item.participantKey, email);
      const out = await confirmAttendance({ date, email, source: 'admin', actorId: actor, reason: `Google参加者の確認：${reason}` });
      await removePending(date, item.participantKey);
      return res.status(200).json({ ok: true, linked: /^users\//.test(item.participantKey), ...out });
    }
    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    return fail(res, err);
  }
}

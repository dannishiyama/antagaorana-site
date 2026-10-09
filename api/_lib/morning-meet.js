/**
 * api/_lib/morning-meet.js
 * 朝の集まりの「開催日ごとの Google Meet」を、日付に1件だけ用意する。
 *
 * - 日付（日本時間）ごとに1つの会議。同じ日に参加する会員は同じURL、別の日は別のURL。
 * - 同時に何人が参加表明しても、作成は1回だけ（作成ロック＋保存時のSET NX）。作成に成功した1件だけが残る。
 * - URLはこのサーバーとRedisの中だけにあり、参加表明済みの有効な会員にだけ morning-meet API が返す。
 * - Googleの設定がない・作成に失敗した場合は、URLを作らず状態（unavailable / error / pending）だけ返す。
 */
import { getMorningMeet, saveMorningMeetOnce, claimMorningMeetLock, releaseMorningMeetLock } from './store.js';
import { createMeetSpace, meetConfig, MeetError } from './google-meet.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function meetIsConfigured() { return meetConfig().configured; }

/** 戻り値: { status: 'ready', url } | { status: 'unavailable' } | { status: 'pending' } | { status: 'error', code } */
export async function ensureMorningMeet(date) {
  const existing = await getMorningMeet(date);
  if (existing?.url) return { status: 'ready', url: existing.url };
  if (!meetConfig().configured) return { status: 'unavailable' };

  if (!(await claimMorningMeetLock(date))) {
    // 別の人の参加表明が、いまこの日の会議を作っている。少し待って、できていればそれを使う。
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      const made = await getMorningMeet(date);
      if (made?.url) return { status: 'ready', url: made.url };
    }
    return { status: 'pending' };
  }
  try {
    const again = await getMorningMeet(date); // ロックを取るまでの間に作られていないか、もう一度確認
    if (again?.url) return { status: 'ready', url: again.url };
    const space = await createMeetSpace();
    await saveMorningMeetOnce(date, { url: space.meetingUri, spaceName: space.spaceName, meetingCode: space.meetingCode });
    const saved = await getMorningMeet(date);
    return { status: 'ready', url: saved.url }; // 先に保存された1件を必ず使う
  } catch (e) {
    return { status: 'error', code: e instanceof MeetError ? e.code : 'unknown' };
  } finally {
    await releaseMorningMeetLock(date);
  }
}

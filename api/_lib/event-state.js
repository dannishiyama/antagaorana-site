/**
 * api/_lib/event-state.js
 * 集まり（HAKU MORNING / HAKU MEET 等）の「いま予約できるか」の判定。画面表示と予約APIで同じ関数を使い、
 * 見た目と実際の挙動がずれないようにする。
 *
 * state の優先順位（上ほど強い）:
 *   cancelled（中止）> ended（開催済み）> joined（参加予定）> closed（受付終了）> full（満席）> open（受付中）
 *
 * 受付終了の「時刻による自動判定」や、キャンセル期限は未決定のため入れていない。
 * いまの「受付終了」は、運営が管理画面で手動で切り替えたものだけ。
 */

export function isEventPast(event, nowMs = Date.now()) {
  if (!event || !event.startsAt) return false; // 日程調整中は、開催済みとは扱わない
  const t = new Date(event.startsAt).getTime();
  return Number.isFinite(t) && t < nowMs;
}

export function computeEventState({ event, participantCount, joined, nowMs = Date.now() }) {
  const registration = event?.registration || 'open';
  const isPast = isEventPast(event, nowMs);
  const capacity = event?.capacity;
  const full = capacity != null && participantCount >= capacity && !joined;
  let state = 'open';
  if (registration === 'cancelled') state = 'cancelled';
  else if (isPast) state = 'ended';
  else if (joined) state = 'joined';
  else if (registration === 'closed') state = 'closed';
  else if (full) state = 'full';
  return { state, isPast, full, registration };
}

// まだ参加していない人が参加しようとしたとき、断る理由（なければnull）。満席は原子的な処理側で判定する。
export const JOIN_BLOCK_MESSAGES = {
  cancelled: 'この集まりは中止になりました。',
  ended: 'この集まりは開催済みです。',
  closed: 'この集まりは受付を終了しました。',
};

export function joinBlockReason(event, nowMs = Date.now()) {
  const registration = event?.registration || 'open';
  if (registration === 'cancelled') return 'cancelled';
  if (isEventPast(event, nowMs)) return 'ended';
  if (registration === 'closed') return 'closed';
  return null;
}

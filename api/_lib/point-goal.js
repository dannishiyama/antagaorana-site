/**
 * api/_lib/point-goal.js
 * 会員が自分で決める「HAKUポイントの目標」の保存。ポイント台帳（point-store.redis.js）とは完全に別のキーで、
 * 目標を変えても、残高・付与履歴には一切影響しない（台帳には触れない）。
 *
 *   ht:point:goal:{email}   目標ポイント（整数）。会員本人のメールアドレス（セッション由来）だけがキー。
 *
 * 呼び出し側（api/community-auth.js）は、セッションのメールアドレスだけを渡す。リクエストにメールアドレスを
 * 指定する経路は無いので、他の会員の目標は読めない・変えられない（IDORなし）。
 */
import { getRedis } from './store.redis.js';

export const GOAL_MIN = 1;
export const GOAL_MAX = 100000;
export class GoalError extends Error { constructor(message, code) { super(message); this.code = code; this.status = 400; } }

const key = (email) => `ht:point:goal:${String(email || '').trim().toLowerCase()}`;

// 1〜100,000の整数だけを受け付ける。0・負数・小数・文字列・指数表記・異常に大きな値は拒否する
export function parseGoal(value) {
  const s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value ?? '').trim();
  if (!/^\d{1,7}$/.test(s)) throw new GoalError(`目標は、${GOAL_MIN.toLocaleString('ja-JP')}〜${GOAL_MAX.toLocaleString('ja-JP')}の整数で入力してください。`, 'bad_goal');
  const n = Number(s);
  if (n < GOAL_MIN || n > GOAL_MAX) throw new GoalError(`目標は、${GOAL_MIN.toLocaleString('ja-JP')}〜${GOAL_MAX.toLocaleString('ja-JP')}の整数で入力してください。`, 'bad_goal');
  return n;
}

export async function getGoal(email) {
  const raw = await getRedis().get(key(email));
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= GOAL_MIN && n <= GOAL_MAX ? n : null;
}

// value が null のときは、目標を解除する（残高・履歴は変わらない）
export async function setGoal(email, value) {
  if (value === null || value === undefined || value === '') { await getRedis().del(key(email)); return null; }
  const n = parseGoal(value);
  await getRedis().set(key(email), String(n));
  return n;
}

/**
 * api/_lib/salon-store.js
 * 教育者のサロン「灯」専用のデータ層（Redis）。HAKU Communityとはキーの接頭辞から分けてあり、
 * 投稿・コメント・イベント・講義・通知設定などを共有しない。会員資格（Application / Membership）だけは、
 * 既存の会員基盤（community: 'tomoshibi'）をそのまま使う。
 *
 * キーは  ht:salon:<サロンID>:…  の形。将来「縁」を足すときは、サロンIDを変えるだけで分離できる。
 * 保存する個人情報は最小限（プロフィールは 都道府県／場の種類 の表示用ラベルのみ。教室名などの固有名は集めない）。
 */
import { getRedis } from './store.js';
import { randomToken } from './security.js';

export const SALON_ID = 'tomoshibi';
const P = `ht:salon:${SALON_ID}:`;
const k = (...parts) => P + parts.join(':');

async function readJSON(key) {
  const raw = await getRedis().get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function writeJSON(key, value) { await getRedis().set(key, JSON.stringify(value)); }
const normEmail = (e) => String(e || '').trim().toLowerCase();
export const newId = () => `${Date.now().toString(36)}${randomToken(4)}`;

// ── プロフィール（サロン内の表示用。都道府県・場の種類の表示ラベル・一覧への表示・メール通知の可否）──
export async function getProfile(email) { return readJSON(k('profile', normEmail(email))); }
export async function saveProfile(email, patch) {
  const e = normEmail(email);
  const cur = (await readJSON(k('profile', e))) || {};
  const next = { ...cur, ...patch, notify: { reply: true, reminder: true, ...(cur.notify || {}), ...(patch.notify || {}) }, updatedAt: Date.now() };
  await writeJSON(k('profile', e), next);
  return next;
}

// ── 運営ロール（大久保・事務局）。HAKU Communityの管理者権限とは別に、灯のロールとして持つ ──
export async function getStaff(email) { return readJSON(k('staff', normEmail(email))); }
export async function setStaff(email, rec) {
  const e = normEmail(email);
  if (!rec) { await getRedis().del(k('staff', e)); await getRedis().srem(k('staff_index'), e); return null; }
  await writeJSON(k('staff', e), rec);
  await getRedis().sadd(k('staff_index'), e);
  return rec;
}
export async function listStaff() {
  const emails = await getRedis().smembers(k('staff_index'));
  const rows = await Promise.all(emails.map(async (e) => ({ email: e, ...(await getStaff(e)) })));
  return rows.filter((r) => r.role).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

// ── 投稿 ──
export async function createPost(rec) {
  const post = { id: newId(), createdAt: Date.now(), updatedAt: null, pinned: false, ...rec };
  await writeJSON(k('post', post.id), post);
  const r = getRedis();
  await r.zadd(k('posts', 'all'), post.createdAt, post.id);
  await r.zadd(k('posts', 'ch', post.channel), post.createdAt, post.id);
  return post;
}
export async function getPost(id) { return /^[a-z0-9]{6,40}$/.test(String(id || '')) ? readJSON(k('post', id)) : null; }
export async function updatePost(id, patch) {
  const cur = await getPost(id); if (!cur) return null;
  const next = { ...cur, ...patch, updatedAt: patch.pinned !== undefined && Object.keys(patch).length === 1 ? cur.updatedAt : Date.now() };
  await writeJSON(k('post', id), next);
  if (patch.pinned !== undefined) { if (patch.pinned) await getRedis().sadd(k('pinned'), id); else await getRedis().srem(k('pinned'), id); }
  return next;
}
// 投稿の削除：コメント・ありがとう・あとで読む も一緒に消す（残骸を残さない）
export async function deletePost(id) {
  const post = await getPost(id); if (!post) return false;
  const r = getRedis();
  const cids = await r.zrange(k('comments', id), 0, -1);
  const bm = await r.smembers(k('bm_rev', id));
  const p = r.pipeline();
  cids.forEach((c) => p.del(k('comment', c)));
  bm.forEach((e) => p.zrem(k('bm', e), id));
  p.del(k('comments', id)); p.del(k('react', id)); p.del(k('bm_rev', id)); p.del(k('file_opens', id)); p.del(k('post', id));
  p.zrem(k('posts', 'all'), id); p.zrem(k('posts', 'ch', post.channel), id); p.srem(k('pinned'), id);
  await p.exec();
  return true;
}
/** チャンネルの投稿ID（新しい順）。before（ミリ秒）より古いものだけ。 */
export async function listPostIds(channel, { before = null, limit = 20 } = {}) {
  const key = channel === 'home' ? k('posts', 'all') : k('posts', 'ch', channel);
  const max = before ? `(${before}` : '+inf';
  return getRedis().zrevrangebyscore(key, max, '-inf', 'LIMIT', 0, limit);
}
export async function latestPostMeta(channel) {
  const key = channel === 'home' ? k('posts', 'all') : k('posts', 'ch', channel);
  const ids = await getRedis().zrevrange(key, 0, 4);
  const posts = (await Promise.all(ids.map((i) => getPost(i)))).filter(Boolean);
  return posts; // 新しい順（最大5件）
}
export async function allPostIds(limit = 2000) { return getRedis().zrevrange(k('posts', 'all'), 0, limit - 1); }
export async function pinnedPostIds() { return getRedis().smembers(k('pinned')); }

// ── コメント（返信の返信まで＝深さ最大3）──
export async function createComment(rec) {
  const c = { id: newId(), createdAt: Date.now(), ...rec };
  await writeJSON(k('comment', c.id), c);
  await getRedis().zadd(k('comments', c.postId), c.createdAt, c.id);
  return c;
}
export async function getComment(id) { return /^[a-z0-9]{6,40}$/.test(String(id || '')) ? readJSON(k('comment', id)) : null; }
export async function listComments(postId) {
  const ids = await getRedis().zrange(k('comments', postId), 0, -1);
  return (await Promise.all(ids.map((i) => getComment(i)))).filter(Boolean);
}
export async function countComments(postId) { return getRedis().zcard(k('comments', postId)); }
// 指定コメントと、その返信（子孫）をすべて削除する
export async function deleteCommentTree(postId, commentId) {
  const all = await listComments(postId);
  const kill = new Set([commentId]);
  let grew = true;
  while (grew) { grew = false; for (const c of all) if (!kill.has(c.id) && kill.has(c.parentId)) { kill.add(c.id); grew = true; } }
  const p = getRedis().pipeline();
  kill.forEach((id) => { p.del(k('comment', id)); p.zrem(k('comments', postId), id); });
  await p.exec();
  return kill.size;
}

// ── ありがとう（1種類のみ）／あとで読む ──
export async function setReaction(postId, email, on) {
  const r = getRedis();
  if (on) await r.sadd(k('react', postId), normEmail(email)); else await r.srem(k('react', postId), normEmail(email));
  return r.scard(k('react', postId));
}
export async function reactionInfo(postIds, email) {
  const r = getRedis(); const e = normEmail(email);
  const p = r.pipeline();
  postIds.forEach((id) => { p.scard(k('react', id)); p.sismember(k('react', id), e); p.sismember(k('bm_rev', id), e); p.zcard(k('comments', id)); });
  const res = await p.exec();
  return postIds.map((id, i) => ({ id, count: res[i * 4][1] || 0, reacted: res[i * 4 + 1][1] === 1, bookmarked: res[i * 4 + 2][1] === 1, comments: res[i * 4 + 3][1] || 0 }));
}
export async function setBookmark(email, postId, on) {
  const r = getRedis(); const e = normEmail(email);
  if (on) { await r.zadd(k('bm', e), Date.now(), postId); await r.sadd(k('bm_rev', postId), e); }
  else { await r.zrem(k('bm', e), postId); await r.srem(k('bm_rev', postId), e); }
}
export async function listBookmarkIds(email, limit = 100) { return getRedis().zrevrange(k('bm', normEmail(email)), 0, limit - 1); }
export async function bumpFileOpens(postId) { return getRedis().incr(k('file_opens', postId)); }
export async function fileOpens(postId) { return Number(await getRedis().get(k('file_opens', postId))) || 0; }

// ── 未読（チャンネルごとの「最後に見た時刻」）──
export async function getSeen(email) { return (await getRedis().hgetall(k('seen', normEmail(email)))) || {}; }
export async function markSeen(email, channel, ts = Date.now()) { await getRedis().hset(k('seen', normEmail(email)), channel, String(ts)); }

// ── 今月の一条（運営が設定）──
export async function getCreed() { return readJSON(k('creed')); }
export async function setCreed(rec) { await writeJSON(k('creed'), rec); return rec; }

// ── イベント（月1回の実践講義・オフ会など）。参加は原子的に（定員を後から足せる）──
export async function createEvent(rec) {
  const ev = { id: newId(), createdAt: Date.now(), capacity: null, ...rec };
  await writeJSON(k('event', ev.id), ev);
  await getRedis().zadd(k('events'), ev.startsAt, ev.id);
  return ev;
}
export async function getEvent(id) { return /^[a-z0-9]{6,40}$/.test(String(id || '')) ? readJSON(k('event', id)) : null; }
export async function updateEvent(id, patch) {
  const cur = await getEvent(id); if (!cur) return null;
  const next = { ...cur, ...patch, id: cur.id };
  await writeJSON(k('event', id), next);
  if (patch.startsAt !== undefined) await getRedis().zadd(k('events'), next.startsAt, id);
  return next;
}
export async function deleteEvent(id) {
  const r = getRedis();
  const members = await r.smembers(k('event_p', id));
  const p = r.pipeline();
  members.forEach((e) => p.srem(k('my_events', e), id));
  p.del(k('event', id)); p.del(k('event_p', id)); p.zrem(k('events'), id);
  await p.exec();
}
export async function listEvents({ from = '-inf', to = '+inf', limit = 200 } = {}) {
  const ids = await getRedis().zrangebyscore(k('events'), from, to, 'LIMIT', 0, limit);
  return (await Promise.all(ids.map((i) => getEvent(i)))).filter(Boolean);
}
const JOIN_LUA = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 'already' end
local cap = tonumber(ARGV[2])
if cap >= 0 and redis.call('SCARD', KEYS[1]) >= cap then return 'full' end
redis.call('SADD', KEYS[1], ARGV[1])
return 'joined'`;
export async function joinEvent(id, email, capacity) {
  const e = normEmail(email);
  const res = await getRedis().eval(JOIN_LUA, 1, k('event_p', id), e, capacity == null ? -1 : capacity);
  if (res === 'joined') await getRedis().sadd(k('my_events', e), id);
  return res;
}
export async function leaveEvent(id, email) {
  const e = normEmail(email);
  await getRedis().srem(k('event_p', id), e); await getRedis().srem(k('my_events', e), id);
}
export async function eventParticipants(id) { return getRedis().smembers(k('event_p', id)); }
export async function eventCounts(ids, email) {
  const r = getRedis(); const e = normEmail(email);
  const p = r.pipeline();
  ids.forEach((id) => { p.scard(k('event_p', id)); p.sismember(k('event_p', id), e); });
  const res = await p.exec();
  return ids.map((id, i) => ({ id, count: res[i * 2][1] || 0, joined: res[i * 2 + 1][1] === 1 }));
}
// リマインドの二重送信防止（同じイベント・同じ会員には1回だけ）
export async function claimReminder(eventId, email) { return Boolean(await getRedis().set(k('reminded', eventId, normEmail(email)), '1', 'EX', 60 * 60 * 24 * 14, 'NX')); }

// ── 実践講義（動画）。動画のURLはここにだけ保存し、一覧では返さない（視聴する会員にだけ lecture-play で返す）──
export async function createLecture(rec) {
  const l = { id: newId(), createdAt: Date.now(), ...rec };
  await writeJSON(k('lecture', l.id), l);
  await getRedis().zadd(k('lectures'), l.heldAt || l.createdAt, l.id);
  return l;
}
export async function getLecture(id) { return /^[a-z0-9]{6,40}$/.test(String(id || '')) ? readJSON(k('lecture', id)) : null; }
export async function updateLecture(id, patch) {
  const cur = await getLecture(id); if (!cur) return null;
  const next = { ...cur, ...patch, id: cur.id };
  await writeJSON(k('lecture', id), next);
  if (patch.heldAt !== undefined) await getRedis().zadd(k('lectures'), next.heldAt, id);
  return next;
}
export async function deleteLecture(id) { const r = getRedis(); await r.del(k('lecture', id)); await r.del(k('lecture_views', id)); await r.zrem(k('lectures'), id); }
export async function listLectures(limit = 100) {
  const ids = await getRedis().zrevrange(k('lectures'), 0, limit - 1);
  return (await Promise.all(ids.map((i) => getLecture(i)))).filter(Boolean);
}
export async function recordLectureView(id, email) { await getRedis().sadd(k('lecture_views', id), normEmail(email)); return getRedis().scard(k('lecture_views', id)); }
export async function lectureViewCount(id) { return getRedis().scard(k('lecture_views', id)); }

// ── 通知・ログイン失敗の制御 ──
export async function loginFailure(email, windowSeconds = 900) {
  const key = k('loginfail', normEmail(email));
  const n = await getRedis().incr(key);
  if (n === 1) await getRedis().expire(key, windowSeconds);
  return n;
}
export async function loginFailureCount(email) { return Number(await getRedis().get(k('loginfail', normEmail(email)))) || 0; }
export async function clearLoginFailures(email) { await getRedis().del(k('loginfail', normEmail(email))); }

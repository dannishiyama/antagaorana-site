/**
 * api/salon.js
 * 教育者のサロン「灯」の会員向けAPI。HAKU Communityとは独立（データも権限も分離）。
 *
 * - 会員の判定は必ずサーバー側：ログイン中（ht_session）かつ「灯」のMembershipが有効な人だけ。
 *   HAKU Communityの会員というだけでは、どのアクションも通らない。
 * - 運営（大久保・事務局）の権限は、HAKUの管理者権限とは別に、灯のロール（salon-store の staff）で判定する。
 * - 本番（Production）では動かさない（Previewのみ）。正式な仕様が決まり、本番化を指示されるまで止めておく。
 * - 匿名の扱い・表示の形は api/_lib/salon-core.js に集約。投稿者のメール・会員IDはレスポンスに含めない。
 *
 * GET  ?action=page                       会員専用のサロン画面（HTML）。未ログインはログインへ転送（元のURLに戻れる）
 * GET  ?action=bootstrap                  画面の初期データ（自分・今月の一条・右カラム・未読）
 * GET  ?action=feed&ch=&before=           チャンネルの投稿（新着順）
 * GET  ?action=post&id= / comments&postId= / search&q= / members / bookmarks / me
 * POST ?action=post-create|post-update|post-delete|post-pin|comment-create|comment-delete|react|bookmark|seen
 *      event-join|event-leave|attach-open|profile-update|notify-update
 * GET  ?action=event-url&id=              参加予定の会員にだけ、開催URLを返す
 * GET  ?action=lecture-play&id=           会員にだけ、講義動画のURLを返す（一覧には含めない）
 * GET  ?action=cron-reminders             講義の前日リマインド（CRON_SECRET必須）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSession, listApplications, claimIdempotentOp, completeIdempotentOp, releaseIdempotentOp } from './_lib/store.js';
import { parseCookies } from './_lib/cookies.js';
import { blockProduction, checkOrigin, rateLimitGuard, resolveBaseUrl } from './_lib/http.js';
import { normalizeRequestId } from './_lib/text-safety.js';
import * as S from './_lib/salon-store.js';
import * as C from './_lib/salon-core.js';
import { sendSalonReplyEmail, sendSalonReminderEmail } from './_lib/notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, '_templates', 'salon-tomoshibi.html');
const APP_URL = '/salon/tomoshibi/';
const LOGIN_URL = '/salon/tomoshibi/login/';

// テストで差し替えられるよう、メール送信は hooks 経由で呼ぶ
export const hooks = { replyMail: sendSalonReplyEmail, reminderMail: sendSalonReminderEmail };

const bool = (v) => v === true || v === 'true' || v === 1;

async function requireMember(req, res) {
  const session = await getSession(parseCookies(req).ht_session);
  if (!session) { res.status(401).json({ error: 'ログインが必要です。', code: 'login' }); return null; }
  const email = session.email;
  const R = C.makeResolver();
  const membership = await R.membership(email);
  if (!C.isActiveStatus(membership)) { res.status(403).json({ error: 'このサロンの会員ではありません。', code: 'not_member' }); return null; }
  const [user, profile, staff] = await Promise.all([R.user(email), R.profile(email), R.staff(email)]);
  if (!user) { res.status(401).json({ error: 'ログインが必要です。', code: 'login' }); return null; }
  return { email, user, profile, staff, membership, R, viewer: { email, staff } };
}

async function idempotent(scope, requestId, fn) {
  if (!requestId) return fn();
  const claim = await claimIdempotentOp(scope, requestId);
  if (claim.status === 'done') return { replayId: claim.value };
  if (claim.status === 'pending') throw new C.SalonError(409, '処理中です。少し待ってから、もう一度お試しください。', 'pending');
  try { const out = await fn(); await completeIdempotentOp(scope, requestId, out.id); return out; } catch (e) { await releaseIdempotentOp(scope, requestId); throw e; }
}

// ── 会員一覧（公開してよい項目だけ。メール・本名・非公開情報は含めない） ──
async function loadRoster(R) {
  const [apps, staffList] = await Promise.all([listApplications(S.SALON_ID, 'all'), S.listStaff()]);
  const emails = [...new Set([...apps.map((a) => a.email), ...staffList.map((s) => s.email)])];
  const rows = [];
  await Promise.all(emails.map(async (email) => {
    const m = await R.membership(email);
    if (!C.isActiveStatus(m)) return;
    const [name, profile, staff] = await Promise.all([C.displayNameOf(email, R), R.profile(email), R.staff(email)]);
    rows.push({ email, name, profile, staff, since: m.activatedAt || m.updatedAt || m.createdAt || 0 });
  }));
  return rows;
}
const tenure = (since) => { const m = C.monthsSince(since); return m < 1 ? '今月' : `${m}ヶ月`; };
function memberRow(r) {
  const initial = Array.from(r.name)[0] || '？';
  if (r.staff) return { name: r.name, sub: [r.staff.title || (r.staff.role === 'owner' ? '代表' : '事務局'), r.staff.subtitle].filter(Boolean).join(' ／ '), since: r.staff.role === 'owner' ? '開設より' : tenure(r.since), av: r.staff.role === 'owner' ? 't' : 'g', initial };
  if (r.profile?.listVisibility === 'anonymous') return { name: '匿名希望', sub: `非公開 ／ ${r.profile?.facilityLabel || '非公開'}`, since: tenure(r.since), av: 'p', initial: '?' };
  return { name: `${r.name} さん`, sub: `${r.profile?.prefecture || '非公開'} ／ ${r.profile?.facilityLabel || '非公開'}`, since: tenure(r.since), av: '', initial };
}
const staffOrder = (a, b) => (b.staff ? 1 : 0) - (a.staff ? 1 : 0) || (a.staff?.role === 'owner' ? -1 : 0) - (b.staff?.role === 'owner' ? -1 : 0) || a.since - b.since;

async function unreadMap(email) {
  const seen = await S.getSeen(email);
  const out = {};
  await Promise.all(C.FEED_CHANNELS.map(async (ch) => {
    const latest = (await S.latestPostMeta(ch)).find((p) => p.authorEmail !== email);
    out[ch] = Boolean(latest) && latest.createdAt > (Number(seen[ch]) || 0);
  }));
  return out;
}

async function railData(ctx) {
  const now = Date.now();
  const [events, pinnedIds, roster] = await Promise.all([S.listEvents({ from: now - 3 * 3600e3, limit: 8 }), S.pinnedPostIds(), loadRoster(ctx.R)]);
  const counts = await S.eventCounts(events.map((e) => e.id), ctx.email);
  const cmap = new Map(counts.map((c) => [c.id, c]));
  const members = roster.filter((r) => !r.staff).sort((a, b) => b.since - a.since);
  const week = members.filter((r) => r.since > now - 7 * 86400e3).length;
  const pinnedPosts = (await Promise.all(pinnedIds.map((i) => S.getPost(i)))).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  return {
    events: events.slice(0, 5).map((e) => { const n = cmap.get(e.id)?.count || 0; return { id: e.id, title: `${C.fmtSlash(e.startsAt)} ${e.title}`, sub: `${e.summary || ''}${n > 0 ? `${e.summary ? ' ・' : ''}応募${n}名` : ''}` }; }),
    pinned: pinnedPosts[0] ? { id: pinnedPosts[0].id, title: pinnedPosts[0].pinTitle || '運営からのご案内', excerpt: pinnedPosts[0].body.slice(0, 120) } : null,
    recent: members.slice(0, 4).map((r) => ({ initial: r.profile?.listVisibility === 'anonymous' ? '?' : (Array.from(r.name)[0] || '？'), av: r.profile?.listVisibility === 'anonymous' ? 'p' : '' })),
    recentMore: Math.max(0, week - 4),
    weekJoined: week,
  };
}

async function creedView() {
  const c = await S.getCreed();
  if (!c || !C.CREEDS[c.n]) return null;
  return { n: c.n, label: C.creedLabel(c.n), title: C.CREEDS[c.n], full: C.creedFull(c.n), reading: c.reading || '' };
}

function channelDesc(ch, creed, memberCount) {
  if (ch === 'home') { const m = new Date(Date.now() + 9 * 3600e3).getUTCMonth() + 1; return `メンバー ${memberCount}名${creed ? ` ／ ${m}月のテーマ：${creed.full}` : ''}`; }
  if (ch === 'creed') return `${creed ? creed.full + '。' : ''}毎月ひとつ、十ヶ条を順に扱います。`;
  return C.CHANNELS[ch].desc;
}

// ── 各アクション ──
async function bootstrap(ctx, res) {
  const [creed, rail, unread, roster] = await Promise.all([creedView(), railData(ctx), unreadMap(ctx.email), loadRoster(ctx.R)]);
  const name = await C.displayNameOf(ctx.email, ctx.R);
  const memberCount = roster.length;
  const descs = {}; C.FEED_CHANNELS.forEach((ch) => { descs[ch] = channelDesc(ch, creed, memberCount); });
  return res.status(200).json({
    ok: true,
    me: { name, initial: Array.from(name)[0] || '？', isStaff: Boolean(ctx.staff), staffTitle: ctx.staff?.title || null, status: ctx.membership.status },
    memberCount, creed, rail, unread, descs,
    channels: Object.fromEntries(Object.entries(C.CHANNELS).map(([k, v]) => [k, v.label])),
    postableChannels: ctx.staff ? C.STAFF_POST_CHANNELS : C.MEMBER_POST_CHANNELS,
    canPostIn: ctx.staff ? ['home', ...C.STAFF_POST_CHANNELS] : ['home', ...C.MEMBER_POST_CHANNELS],
  });
}

async function feed(ctx, req, res) {
  const ch = String(req.query?.ch || 'home');
  if (!C.FEED_CHANNELS.includes(ch)) throw new C.SalonError(400, 'チャンネルを指定してください。', 'bad_channel');
  const before = Number(req.query?.before) || null;
  const ids = await S.listPostIds(ch, { before, limit: C.SALON_CONFIG.pageSize + 1 });
  const hasMore = ids.length > C.SALON_CONFIG.pageSize;
  let posts = (await Promise.all(ids.slice(0, C.SALON_CONFIG.pageSize).map((i) => S.getPost(i)))).filter(Boolean);
  if (!before) { // 先頭のページには、ピン留めされた投稿を先に出す
    const pins = (await Promise.all((await S.pinnedPostIds()).map((i) => S.getPost(i)))).filter((p) => p && (ch === 'home' || p.channel === ch));
    const have = new Set(posts.map((p) => p.id));
    posts = [...pins.filter((p) => !have.has(p.id)).sort((a, b) => b.createdAt - a.createdAt), ...posts];
    posts.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  }
  const views = await C.viewPosts(posts, ctx.viewer, ctx.R);
  return res.status(200).json({ ok: true, channel: ch, posts: views, hasMore, nextBefore: posts.length ? posts[posts.length - 1].createdAt : null });
}

async function postCreate(ctx, req, res, body) {
  const channel = String(body.channel || '');
  const allowed = ctx.staff ? C.STAFF_POST_CHANNELS : C.MEMBER_POST_CHANNELS;
  if (!allowed.includes(channel)) throw new C.SalonError(403, 'このチャンネルには、運営のみ投稿できます。', 'forbidden_channel');
  const text = C.cleanBody(body.body, C.SALON_CONFIG.postMax);
  const requestId = normalizeRequestId(body.requestId);
  const staffOnly = channel === 'archive' || channel === 'news';
  const anonymous = staffOnly ? false : bool(body.anonymous);
  const hideFacility = body.hideFacility === undefined ? true : bool(body.hideFacility); // 初期値ON
  let creedTag = C.parseCreedTag(body.creedTag);
  if (channel === 'creed' && !creedTag) creedTag = (await S.getCreed())?.n || null;
  let attachment = null;
  if (body.attachment) {
    if (!ctx.staff) throw new C.SalonError(403, '添付は運営のみ設定できます。', 'forbidden_attachment');
    attachment = await validateAttachment(body.attachment);
  }
  const out = await idempotent(`salonpost:${ctx.email}`, requestId, async () => {
    const post = await S.createPost({ channel, authorEmail: ctx.email, body: text, anonymous, hideFacility, creedTag, attachment, requestId: requestId || null });
    return { id: post.id, post };
  });
  const post = out.post || await S.getPost(out.replayId);
  if (!post) throw new C.SalonError(409, '投稿を確認できませんでした。', 'gone');
  if (out.post && ctx.staff) await C.audit(ctx.email, 'post_created_staff', post.id, { channel });
  const [view] = await C.viewPosts([post], ctx.viewer, ctx.R);
  await S.markSeen(ctx.email, channel === 'home' ? 'home' : channel);
  return res.status(200).json({ ok: true, post: view, duplicate: Boolean(out.replayId) });
}

async function validateAttachment(a) {
  if (a.type === 'event') { const ev = await S.getEvent(a.eventId); if (!ev) throw new C.SalonError(400, 'イベントが見つかりません。', 'bad_attachment'); return { type: 'event', eventId: ev.id }; }
  if (a.type === 'video') { const l = await S.getLecture(a.lectureId); if (!l) throw new C.SalonError(400, '講義が見つかりません。', 'bad_attachment'); return { type: 'video', lectureId: l.id }; }
  if (a.type === 'file') {
    const url = C.safeHttpsUrl(a.url);
    if (!url) throw new C.SalonError(400, '資料のURLは https:// で始まるものを指定してください。', 'bad_attachment');
    return { type: 'file', title: C.cleanLabel(a.title, 80) || '資料', url, note: a.note ? C.cleanLabel(a.note, 80) : '' };
  }
  throw new C.SalonError(400, '添付の種類が正しくありません。', 'bad_attachment');
}

async function loadPostOr404(id) {
  const post = await S.getPost(id);
  if (!post) throw new C.SalonError(404, '投稿が見つかりません。', 'not_found');
  return post;
}

async function postUpdate(ctx, res, body) {
  const post = await loadPostOr404(body.id);
  if (post.authorEmail !== ctx.email) throw new C.SalonError(403, '編集できるのは、自分の投稿だけです。', 'forbidden'); // 運営でも他人の投稿は編集できない
  const patch = { body: C.cleanBody(body.body, C.SALON_CONFIG.postMax) };
  if (body.creedTag !== undefined) patch.creedTag = C.parseCreedTag(body.creedTag);
  const next = await S.updatePost(post.id, patch);
  const [view] = await C.viewPosts([next], ctx.viewer, ctx.R);
  return res.status(200).json({ ok: true, post: view });
}

async function postDelete(ctx, res, body) {
  const post = await loadPostOr404(body.id);
  const mine = post.authorEmail === ctx.email;
  if (!mine && !ctx.staff) throw new C.SalonError(403, '削除できるのは、自分の投稿だけです。', 'forbidden');
  await S.deletePost(post.id);
  await C.audit(ctx.email, mine ? 'post_deleted_own' : 'post_deleted_by_staff', post.id, { channel: post.channel });
  return res.status(200).json({ ok: true });
}

async function postPin(ctx, res, body) {
  if (!ctx.staff) throw new C.SalonError(403, 'ピン留めは運営のみ行えます。', 'forbidden');
  const post = await loadPostOr404(body.id);
  await S.updatePost(post.id, { pinned: bool(body.pinned) });
  await C.audit(ctx.email, bool(body.pinned) ? 'post_pinned' : 'post_unpinned', post.id);
  return res.status(200).json({ ok: true });
}

async function commentsList(ctx, req, res) {
  const post = await loadPostOr404(req.query?.postId);
  const list = C.orderComments(await S.listComments(post.id));
  return res.status(200).json({ ok: true, comments: await C.viewComments(list, ctx.viewer, ctx.R) });
}

async function commentCreate(ctx, req, res, body) {
  const post = await loadPostOr404(body.postId);
  const text = C.cleanBody(body.body, C.SALON_CONFIG.commentMax, 'コメント');
  let parent = null, depth = 1;
  if (body.parentId) {
    parent = await S.getComment(body.parentId);
    if (!parent || parent.postId !== post.id) throw new C.SalonError(404, '返信先が見つかりません。', 'not_found');
    depth = parent.depth + 1;
    if (depth > C.SALON_CONFIG.maxCommentDepth) throw new C.SalonError(400, 'これ以上は返信できません。', 'too_deep');
  }
  const requestId = normalizeRequestId(body.requestId);
  const out = await idempotent(`saloncmt:${ctx.email}`, requestId, async () => {
    const c = await S.createComment({ postId: post.id, parentId: parent ? parent.id : null, depth, authorEmail: ctx.email, body: text });
    return { id: c.id, comment: c };
  });
  const comment = out.comment || await S.getComment(out.replayId);
  // 運営の返信は、投稿した本人にメールでお知らせ（本人が通知を切っていなければ）。本文は入れない
  if (out.comment && ctx.staff && post.authorEmail !== ctx.email) {
    try {
      const [m, p] = await Promise.all([ctx.R.membership(post.authorEmail), ctx.R.profile(post.authorEmail)]);
      const baseUrl = resolveBaseUrl(req);
      if (C.isActiveStatus(m) && p?.notify?.reply !== false && baseUrl) await hooks.replyMail({ email: post.authorEmail, url: `${baseUrl}${APP_URL}#post=${post.id}` });
    } catch (e) { console.error('[salon] reply notification failed:', e.message); }
  }
  const [view] = await C.viewComments([comment], ctx.viewer, ctx.R);
  return res.status(200).json({ ok: true, comment: view });
}

async function commentDelete(ctx, res, body) {
  const c = await S.getComment(body.id);
  if (!c) throw new C.SalonError(404, 'コメントが見つかりません。', 'not_found');
  const mine = c.authorEmail === ctx.email;
  if (!mine && !ctx.staff) throw new C.SalonError(403, '削除できるのは、自分のコメントだけです。', 'forbidden');
  await S.deleteCommentTree(c.postId, c.id);
  await C.audit(ctx.email, mine ? 'comment_deleted_own' : 'comment_deleted_by_staff', c.id, { postId: c.postId });
  return res.status(200).json({ ok: true });
}

async function search(ctx, req, res) {
  const raw = String(req.query?.q || '').trim();
  if (raw.length < 1 || raw.length > 60) throw new C.SalonError(400, '検索する言葉を入力してください。', 'bad_query');
  const norm = (s) => String(s || '').normalize('NFKC').toLowerCase();
  const q = norm(raw);
  const ids = await S.allPostIds(600);
  const hits = [];
  for (const id of ids) {
    const post = await S.getPost(id); if (!post) continue;
    const tagHit = post.creedTag && norm(C.creedLabel(post.creedTag)).includes(q);
    const bodyHit = norm(post.body).includes(q);
    const comments = await S.listComments(id);
    const cm = comments.filter((c) => norm(c.body).includes(q));
    if (bodyHit || tagHit || cm.length) hits.push({ post, matches: cm.slice(0, 2).map((c) => ({ id: c.id, snippet: snippet(c.body, raw) })) });
    if (hits.length >= 30) break;
  }
  const views = await C.viewPosts(hits.map((h) => h.post), ctx.viewer, ctx.R);
  return res.status(200).json({ ok: true, q: raw, results: views.map((v, i) => ({ post: v, matches: hits[i].matches })) });
}
function snippet(text, q) {
  const i = text.normalize('NFKC').toLowerCase().indexOf(q.normalize('NFKC').toLowerCase());
  const start = Math.max(0, i - 24);
  return (start > 0 ? '…' : '') + text.slice(start, start + 80) + (text.length > start + 80 ? '…' : '');
}

async function setFlag(ctx, res, body, kind) {
  const post = await loadPostOr404(body.postId);
  const on = bool(body.on);
  if (kind === 'react') { const n = await S.setReaction(post.id, ctx.email, on); return res.status(200).json({ ok: true, on, count: n }); }
  await S.setBookmark(ctx.email, post.id, on);
  return res.status(200).json({ ok: true, on });
}

async function eventAction(ctx, res, body, join) {
  const ev = await S.getEvent(body.eventId);
  if (!ev) throw new C.SalonError(404, 'イベントが見つかりません。', 'not_found');
  if (join) {
    if (ev.startsAt < Date.now() - 3 * 3600e3) throw new C.SalonError(409, 'このイベントは終了しました。', 'ended');
    const r = await S.joinEvent(ev.id, ctx.email, ev.capacity);
    if (r === 'full') throw new C.SalonError(409, '定員に達しました。', 'full');
  } else {
    await S.leaveEvent(ev.id, ctx.email);
  }
  const [info] = await S.eventCounts([ev.id], ctx.email);
  return res.status(200).json({ ok: true, joined: info.joined, count: info.count });
}

async function eventUrl(ctx, req, res) {
  const ev = await S.getEvent(req.query?.id);
  if (!ev) throw new C.SalonError(404, 'イベントが見つかりません。', 'not_found');
  const [info] = await S.eventCounts([ev.id], ctx.email);
  if (!info.joined) throw new C.SalonError(403, '参加予定に登録すると、開催URLをご案内します。', 'not_joined'); // 未参加者にはURLを返さない
  if (!ev.url) return res.status(200).json({ ok: true, url: null, message: '開催URLは、準備ができ次第こちらにお知らせします。' });
  return res.status(200).json({ ok: true, url: ev.url });
}

// 講義動画：URLは視聴する会員にだけ返す。埋め込み可能な既知の配信元は埋め込み用に、直接のファイルは再生用に分ける
export function playbackFor(url) {
  const u = new URL(url);
  const yt = u.hostname.replace(/^www\./, '');
  if (yt === 'youtube.com' || yt === 'm.youtube.com') { const v = u.searchParams.get('v'); if (v && /^[\w-]{6,20}$/.test(v)) return { kind: 'embed', url: `https://www.youtube-nocookie.com/embed/${v}` }; }
  if (yt === 'youtu.be') { const v = u.pathname.slice(1); if (/^[\w-]{6,20}$/.test(v)) return { kind: 'embed', url: `https://www.youtube-nocookie.com/embed/${v}` }; }
  if (yt === 'vimeo.com') { const m = u.pathname.match(/^\/(\d{5,12})(?:\/([a-z0-9]+))?/i); if (m) return { kind: 'embed', url: `https://player.vimeo.com/video/${m[1]}${m[2] ? '?h=' + m[2] : ''}` }; }
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(u.pathname + u.search)) return { kind: 'video', url };
  return { kind: 'link', url };
}
async function lecturePlay(ctx, req, res) {
  const l = await S.getLecture(req.query?.id);
  if (!l || !l.videoUrl) throw new C.SalonError(404, '動画が見つかりません。', 'not_found');
  const views = await S.recordLectureView(l.id, ctx.email);
  return res.status(200).json({ ok: true, title: l.title, description: l.description || '', views, ...playbackFor(l.videoUrl) });
}

async function profileUpdate(ctx, res, body) {
  const patch = {};
  if (body.displayName !== undefined) { const n = C.cleanLabel(body.displayName, 30); if (!n) throw new C.SalonError(400, '表示名を入力してください。', 'empty'); patch.displayName = n; }
  if (body.prefecture !== undefined) { if (body.prefecture !== '' && !C.PREFECTURES.includes(body.prefecture)) throw new C.SalonError(400, '都道府県が正しくありません。', 'bad_pref'); patch.prefecture = body.prefecture; }
  if (body.facilityLabel !== undefined) patch.facilityLabel = C.cleanLabel(body.facilityLabel, 30);
  if (body.listVisibility !== undefined) { if (!['public', 'anonymous'].includes(body.listVisibility)) throw new C.SalonError(400, '表示の設定が正しくありません。', 'bad_visibility'); patch.listVisibility = body.listVisibility; }
  const saved = await S.saveProfile(ctx.email, patch);
  return res.status(200).json({ ok: true, profile: publicProfile(saved, ctx.user) });
}
function publicProfile(p, user) { return { displayName: p?.displayName || user?.displayName || '', prefecture: p?.prefecture || '', facilityLabel: p?.facilityLabel || '', listVisibility: p?.listVisibility || 'public', notify: { reply: p?.notify?.reply !== false, reminder: p?.notify?.reminder !== false } }; }

async function cronReminders(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
  const now = Date.now();
  const dayStart = Date.parse(`${C.jstDayKey(now)}T00:00:00+09:00`) + 86400e3; // 明日の0:00（日本時間）
  const events = await S.listEvents({ from: dayStart, to: dayStart + 86400e3 - 1 });
  const baseUrl = process.env.SALON_BASE_URL || resolveBaseUrl(req);
  const R = C.makeResolver();
  let sent = 0, skipped = 0;
  for (const ev of events) {
    for (const email of await S.eventParticipants(ev.id)) {
      const [m, p] = await Promise.all([R.membership(email), R.profile(email)]);
      if (!C.isActiveStatus(m) || p?.notify?.reminder === false || !(await S.claimReminder(ev.id, email))) { skipped++; continue; }
      if (baseUrl) { await hooks.reminderMail({ email, eventTitle: ev.title, whenLabel: C.fmtJaRange(ev.startsAt, ev.endsAt), url: `${baseUrl}${APP_URL}` }); sent++; }
    }
  }
  return res.status(200).json({ ok: true, events: events.length, sent, skipped });
}

function servePage(req, res, sessionOk) {
  if (!sessionOk) return res.redirect(302, `${LOGIN_URL}?next=${encodeURIComponent(APP_URL)}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return res.status(200).send(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
}

const WRITE_LIMITS = { 'post-create': [30, 3600], 'comment-create': [90, 3600], react: [240, 60], bookmark: [240, 60], 'event-join': [30, 60], 'profile-update': [30, 3600] };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (blockProduction(res)) return; // 本番では動かさない（Previewのみ）
  const action = String(req.query?.action || '');
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  try {
    if (action === 'cron-reminders') return await cronReminders(req, res);
    const isPost = req.method === 'POST';
    if (isPost && !checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
    if (isPost && WRITE_LIMITS[action] && !(await rateLimitGuard(req, res, { key: `salon-${action}`, limit: WRITE_LIMITS[action][0], windowSeconds: WRITE_LIMITS[action][1] }))) return;

    if (action === 'page') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const session = await getSession(parseCookies(req).ht_session);
      let ok = false;
      if (session) { const m = await C.makeResolver().membership(session.email); ok = C.isActiveStatus(m); }
      return servePage(req, res, ok);
    }

    const GET = { bootstrap: 1, feed: 1, post: 1, comments: 1, search: 1, members: 1, bookmarks: 1, me: 1, 'event-url': 1, 'lecture-play': 1 };
    const POST = { 'post-create': 1, 'post-update': 1, 'post-delete': 1, 'post-pin': 1, 'comment-create': 1, 'comment-delete': 1, react: 1, bookmark: 1, seen: 1, 'event-join': 1, 'event-leave': 1, 'attach-open': 1, 'profile-update': 1, 'notify-update': 1 };
    if (!GET[action] && !POST[action]) return res.status(404).json({ error: 'Not found' });
    if (GET[action] && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    if (POST[action] && !isPost) return res.status(405).json({ error: 'Method not allowed' });

    const ctx = await requireMember(req, res);
    if (!ctx) return;

    switch (action) {
      case 'bootstrap': return await bootstrap(ctx, res);
      case 'feed': return await feed(ctx, req, res);
      case 'post': { const [v] = await C.viewPosts([await loadPostOr404(req.query?.id)], ctx.viewer, ctx.R); return res.status(200).json({ ok: true, post: v }); }
      case 'comments': return await commentsList(ctx, req, res);
      case 'search': return await search(ctx, req, res);
      case 'members': { const roster = (await loadRoster(ctx.R)).sort(staffOrder); return res.status(200).json({ ok: true, count: roster.length, members: roster.map(memberRow) }); }
      case 'bookmarks': { const posts = (await Promise.all((await S.listBookmarkIds(ctx.email)).map((i) => S.getPost(i)))).filter(Boolean); return res.status(200).json({ ok: true, posts: await C.viewPosts(posts, ctx.viewer, ctx.R) }); }
      case 'me': return res.status(200).json({ ok: true, profile: publicProfile(ctx.profile, ctx.user), membership: { status: ctx.membership.status, since: ctx.membership.activatedAt || null }, isStaff: Boolean(ctx.staff), prefectures: C.PREFECTURES });
      case 'event-url': return await eventUrl(ctx, req, res);
      case 'lecture-play': return await lecturePlay(ctx, req, res);
      case 'post-create': return await postCreate(ctx, req, res, body);
      case 'post-update': return await postUpdate(ctx, res, body);
      case 'post-delete': return await postDelete(ctx, res, body);
      case 'post-pin': return await postPin(ctx, res, body);
      case 'comment-create': return await commentCreate(ctx, req, res, body);
      case 'comment-delete': return await commentDelete(ctx, res, body);
      case 'react': return await setFlag(ctx, res, body, 'react');
      case 'bookmark': return await setFlag(ctx, res, body, 'bookmark');
      case 'seen': { if (!C.FEED_CHANNELS.includes(body.channel)) throw new C.SalonError(400, 'チャンネルが正しくありません。', 'bad_channel'); await S.markSeen(ctx.email, body.channel); return res.status(200).json({ ok: true }); }
      case 'event-join': return await eventAction(ctx, res, body, true);
      case 'event-leave': return await eventAction(ctx, res, body, false);
      case 'attach-open': {
        const post = await loadPostOr404(body.postId);
        if (post.attachment?.type !== 'file') throw new C.SalonError(404, '資料が見つかりません。', 'not_found');
        await S.bumpFileOpens(post.id);
        return res.status(200).json({ ok: true, url: post.attachment.url });
      }
      case 'profile-update': return await profileUpdate(ctx, res, body);
      case 'notify-update': {
        const patch = { notify: {} };
        if (body.reply !== undefined) patch.notify.reply = bool(body.reply);
        if (body.reminder !== undefined) patch.notify.reminder = bool(body.reminder);
        const saved = await S.saveProfile(ctx.email, patch);
        return res.status(200).json({ ok: true, profile: publicProfile(saved, ctx.user) });
      }
      default: return res.status(404).json({ error: 'Not found' });
    }
  } catch (err) {
    if (err instanceof C.SalonError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[salon] error:', err.message);
    return res.status(500).json({ error: '処理できませんでした。時間をおいて、もう一度お試しください。' });
  }
}

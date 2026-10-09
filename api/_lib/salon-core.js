/**
 * api/_lib/salon-core.js
 * 教育者のサロン「灯」：定数・入力の検査・画面に返す形への変換（匿名・教室名の扱いはすべてここ）。
 *
 * 匿名の扱い（重要）：
 *   - 匿名投稿は、一般会員向けのAPIレスポンスに「投稿者を特定できる情報」を一切含めない
 *     （名前・所属・会員ID・メール・色分けのような安定した目印・プロフィール）。
 *   - ただし、編集・削除・返信通知のため、サーバーのデータには投稿者を残している。
 *     「運営から誰の投稿か見えるか」はまだ決まっていないため、既定では運営向けAPIでも匿名のままにしてあり、
 *     SALON_CONFIG.anonymousAuthorVisibleToStaff を変えない限り、運営にも表示しない。
 *     これは「完全な匿名性の保証」ではない（データベースを直接見られる立場の人には分かる）。正式な仕様が決まるまで、
 *     画面・文言で匿名性を保証しない。
 */
import { getUser, getMembership, logAudit } from './store.js';
import * as S from './salon-store.js';
import { cleanUserText, hasInvalidChars } from './text-safety.js';

export const SALON_CONFIG = {
  // 未決定：匿名投稿の投稿者を、運営（大久保・事務局）が見られるか。false＝運営向けのAPIにも出さない。
  anonymousAuthorVisibleToStaff: false,
  postMax: 5000,
  commentMax: 2000,
  maxCommentDepth: 3, // コメント(1)→返信(2)→返信の返信(3)まで
  pageSize: 20,
  // 未決定：承認後に決済を求めるか。'1' にすると承認だけでは会員資格を有効にしない（決済確認後に運営が有効化する前提の設計）。
  requirePaymentEnv: 'SALON_REQUIRE_PAYMENT',
};

const KANJI = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
// 「負の連鎖を止める心得十ヶ条」。依頼書（Word）の正式な文言をそのまま使う（要約・改変しない）。
export const CREEDS = [
  null,
  '「不登校・いじめ」に負けない・気にしない技',
  '「何のために」を常に自己に問い、志を堅実する',
  'リフレクションして、自らの力を客観する',
  '背水・不退転の覚悟を決めて臨む',
  '決めつけない・慣習にとらわれない',
  '時に「ひと呼吸」して待つ',
  '後継を自分以上に育てる覚悟で鍛える',
  '「責任は我にあり」と受け止める',
  '率直な意見を聞ける寛容性と度量の鍛錬',
  'なすべきことはなす誠実さと丁寧さ',
];
export const creedLabel = (n) => `第${KANJI[n]}条`;
// 「第六条「時に『ひと呼吸』して待つ」」の形（入れ子の鉤括弧は二重鉤括弧にする）
export const creedFull = (n) => `${creedLabel(n)}「${CREEDS[n].replace(/「/g, '『').replace(/」/g, '』')}」`;

export const CHANNELS = {
  home: { label: 'ホーム' },
  creed: { label: '今月の一条', desc: null }, // 説明は今月の一条から作る
  case: { label: 'ケース検討', desc: 'いま関わっている子のことを相談する場所。教室名・学校名は伏せてください。' },
  mgmt: { label: '運営の相談', desc: '募集・月謝・スタッフ・続け方。数字の話もここでします。' },
  archive: { label: '実践講義アーカイブ', desc: '過去の講義を視聴できます。入会前の回もご覧いただけます。' },
  news: { label: 'お知らせ', desc: '事務局からのご案内。' },
  members: { label: 'メンバー一覧', desc: '' },
};
export const MEMBER_POST_CHANNELS = ['case', 'mgmt', 'creed'];
export const STAFF_POST_CHANNELS = ['case', 'mgmt', 'creed', 'archive', 'news'];
export const FEED_CHANNELS = ['home', 'creed', 'case', 'mgmt', 'archive', 'news'];

export const PREFECTURES = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];

// ── 入力の検査 ──
export class SalonError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export function cleanBody(value, max, what = '本文') {
  const s = cleanUserText(value);
  if (!s) throw new SalonError(400, `${what}を入力してください。`, 'empty');
  if (hasInvalidChars(s)) throw new SalonError(400, '文字を正しく読み取れませんでした。もう一度入力してください。', 'bad_chars');
  if (s.length > max) throw new SalonError(400, `${what}は${max}文字以内で入力してください。`, 'too_long');
  return s;
}
export function cleanLabel(value, max) {
  const s = cleanUserText(value).replace(/\n/g, ' ');
  if (hasInvalidChars(s) || s.length > max) throw new SalonError(400, `${max}文字以内で入力してください。`, 'bad_label');
  return s;
}
export function parseCreedTag(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new SalonError(400, '十ヶ条の指定が正しくありません。', 'bad_creed');
  return n;
}
export function safeHttpsUrl(value, { hosts = null } = {}) {
  let u;
  try { u = new URL(String(value || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (hosts && !hosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) return null;
  return u.toString();
}

// ── 日本時間の表示 ──
const WD = '日月火水木金土';
const jst = (ms) => new Date(ms + 9 * 3600e3);
const p2 = (n) => String(n).padStart(2, '0');
export function fmtJaDay(ms) { const d = jst(ms); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${WD[d.getUTCDay()]}）`; }
export function fmtJaTime(ms) { const d = jst(ms); return `${d.getUTCHours()}:${p2(d.getUTCMinutes())}`; }
export function fmtJaRange(startMs, endMs) { return `${fmtJaDay(startMs)}${fmtJaTime(startMs)}${endMs ? '〜' + fmtJaTime(endMs) : '〜'}`; }
export const fmtSlash = (ms) => { const d = jst(ms); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
export function jstDayKey(ms) { return jst(ms).toISOString().slice(0, 10); }
export function monthsSince(ms, now = Date.now()) {
  const a = jst(ms), b = jst(now);
  return Math.max(0, (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()));
}

// ── 会員資格（灯）。HAKU Communityの会員というだけでは通らない ──
export const isActiveStatus = (m) => Boolean(m) && (m.status === 'active' || m.status === 'canceling');

// リクエスト内の読み込みをまとめる（同じ人を何度も読まない）
export function makeResolver() {
  const c = { user: new Map(), profile: new Map(), staff: new Map(), member: new Map(), event: new Map(), lecture: new Map() };
  const memo = (map, key, fn) => { if (!map.has(key)) map.set(key, fn()); return map.get(key); };
  return {
    user: (e) => memo(c.user, e, () => getUser(e)),
    profile: (e) => memo(c.profile, e, () => S.getProfile(e)),
    staff: (e) => memo(c.staff, e, () => S.getStaff(e)),
    membership: (e) => memo(c.member, e, () => getMembership(S.SALON_ID, e)),
    event: (id) => memo(c.event, id, () => S.getEvent(id)),
    lecture: (id) => memo(c.lecture, id, () => S.getLecture(id)),
  };
}

export async function displayNameOf(email, R) {
  const [profile, user] = await Promise.all([R.profile(email), R.user(email)]);
  return profile?.displayName || user?.displayName || 'メンバー';
}

/**
 * 画面に出す「投稿者」。匿名・退会済み・教室名を伏せる、をここで決める。
 * 戻り値に、メール・会員ID・安定した色の目印は含めない。
 */
export async function authorView(email, flags, R, { asStaffViewer = false } = {}) {
  const anon = flags?.anonymous === true;
  const hide = asStaffViewer && SALON_CONFIG.anonymousAuthorVisibleToStaff;
  if (anon && !hide) return { label: '匿名', initial: '?', av: 'p', badge: null };
  const [membership, staff] = await Promise.all([R.membership(email), R.staff(email)]);
  if (!isActiveStatus(membership) && !staff) return { label: '退会した会員', initial: '?', av: 'p', badge: null };
  const [name, profile] = await Promise.all([displayNameOf(email, R), R.profile(email)]);
  const initial = Array.from(name)[0] || '？';
  if (staff) return { label: name, initial, av: staff.role === 'owner' ? 't' : 'g', badge: staff.title || (staff.role === 'owner' ? '代表' : '事務局') };
  const facility = profile?.facilityLabel;
  const showFacility = facility && flags?.hideFacility !== true && profile?.listVisibility !== 'anonymous';
  return { label: showFacility ? `${name}（${facility}）` : name, initial, av: '', badge: null };
}

// ── 添付（資料・動画・イベント）の表示用データ。動画のURL・イベントの開催URLは含めない ──
async function attachmentView(att, post, viewer, R) {
  if (!att) return null;
  if (att.type === 'video') {
    const l = await R.lecture(att.lectureId);
    if (!l) return null;
    const views = await S.lectureViewCount(l.id);
    return { type: 'video', ic: '動画', title: l.title, sub: [`${l.minutes ? l.minutes + '分' : ''}`, `視聴 ${views}名`, l.note || ''].filter(Boolean).join(' ／ '), id: l.id, button: '視聴する' };
  }
  if (att.type === 'event') {
    const ev = await R.event(att.eventId);
    if (!ev) return null;
    const [info] = await S.eventCounts([ev.id], viewer.email);
    const ended = ev.startsAt < Date.now() - 3 * 3600e3;
    return { type: 'event', ic: fmtSlash(ev.startsAt), title: ev.title, sub: `${fmtJaRange(ev.startsAt, ev.endsAt)}${ev.summary ? ' ／ ' + ev.summary : ''}`, id: ev.id, joined: info.joined, count: info.count, ended, full: ev.capacity != null && info.count >= ev.capacity && !info.joined, hasUrl: Boolean(ev.url) };
  }
  if (att.type === 'file') {
    const opens = await S.fileOpens(post.id);
    return { type: 'file', ic: '資料', title: att.title, sub: [att.note || '', opens > 0 ? `ダウンロード ${opens}件` : ''].filter(Boolean).join(' ／ '), button: '開く' };
  }
  return null;
}

/** 投稿一覧を、画面に返す形へ。viewer = { email, staff }。 */
export async function viewPosts(posts, viewer, R, { asStaffViewer = false } = {}) {
  const infos = await S.reactionInfo(posts.map((p) => p.id), viewer.email);
  const byId = new Map(infos.map((i) => [i.id, i]));
  return Promise.all(posts.map(async (p) => {
    const info = byId.get(p.id) || { count: 0, reacted: false, bookmarked: false, comments: 0 };
    const mine = p.authorEmail === viewer.email;
    return {
      id: p.id,
      channel: p.channel,
      channelLabel: CHANNELS[p.channel]?.label || '',
      body: p.body,
      createdAt: p.createdAt,
      edited: Boolean(p.updatedAt),
      creedTag: p.creedTag || null,
      creedLabel: p.creedTag ? creedLabel(p.creedTag) : null,
      pinned: Boolean(p.pinned),
      author: await authorView(p.authorEmail, p, R, { asStaffViewer }),
      isMine: mine,
      canEdit: mine,
      canDelete: mine || Boolean(viewer.staff),
      reactions: info.count, reacted: info.reacted, bookmarked: info.bookmarked, commentCount: info.comments,
      attachment: await attachmentView(p.attachment, p, viewer, R),
    };
  }));
}

export async function viewComments(comments, viewer, R) {
  return Promise.all(comments.map(async (c) => {
    const profile = await R.profile(c.authorEmail);
    return {
      id: c.id, postId: c.postId, parentId: c.parentId || null, depth: c.depth, body: c.body, createdAt: c.createdAt,
      author: await authorView(c.authorEmail, { anonymous: false, hideFacility: profile?.listVisibility === 'anonymous' }, R),
      canDelete: c.authorEmail === viewer.email || Boolean(viewer.staff),
    };
  }));
}

// 返信が親の直後に並ぶ順（親→子→孫）にする
export function orderComments(list) {
  const kids = new Map();
  list.forEach((c) => { const key = c.parentId || ''; if (!kids.has(key)) kids.set(key, []); kids.get(key).push(c); });
  const out = [];
  const walk = (parent) => (kids.get(parent) || []).sort((a, b) => a.createdAt - b.createdAt).forEach((c) => { out.push(c); walk(c.id); });
  walk('');
  return out;
}

export async function audit(actorEmail, action, targetId, metadata) {
  return logAudit({ actorId: actorEmail, action: `salon_${action}`, targetId: targetId || null, metadata: { salon: S.SALON_ID, ...(metadata || {}) } });
}

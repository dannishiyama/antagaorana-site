/**
 * api/_lib/reflection.js
 * 会員本人だけの「月ごとの振り返り」と「1か月前のあなたから」への返信。
 *
 * 守ること
 *  - 非公開：本人のセッションのメールアドレスだけがキー。リクエストにメールアドレスを指定する経路は無い（IDORなし）。
 *    管理画面のAPIには、この記録を読む経路を作らない（運営も、業務上不要な非公開記録は閲覧しない）。
 *  - 公開投稿と分離：公開投稿は「本人の公開投稿」として元のデータから読み出すだけ（コピーしない）。
 *    元の投稿を編集・削除・非表示にすれば、表示にもそのまま反映される。非表示（モデレーション）の投稿は出さない。
 *  - 任意：毎日書く義務はない。空の保存は拒否（削除は別操作）。
 *
 * 保存（Redis）
 *   ht:reflect:{email}        hash  月（YYYY-MM）→ 振り返り1件のJSON
 *   ht:reflect:echo:{email}   hash  "kind:id" → 1か月前の記録に対する、いまの気持ち（JSON）
 */
import { getRedis } from './store.redis.js';
import { listPostsByAuthor } from './store.js';

export class ReflectError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }
export const FIELDS = ['noticed', 'practiced', 'changed', 'nextMonth'];
export const MAX_LEN = 500;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const key = (email) => `ht:reflect:${String(email || '').trim().toLowerCase()}`;
const echoKey = (email) => `ht:reflect:echo:${String(email || '').trim().toLowerCase()}`;
const clean = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
export const currentMonth = (now = Date.now()) => new Date(now + 9 * 3600e3).toISOString().slice(0, 7);
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

export async function listReflections(email) {
  const all = Object.values(await getRedis().hgetall(key(email))).map(parse).filter(Boolean);
  return all.sort((a, b) => (a.month < b.month ? 1 : -1));
}

export async function saveReflection(email, { month, baseUpdatedAt, ...input }, now = Date.now()) {
  const m = String(month || '');
  if (!MONTH_RE.test(m) || m > currentMonth(now) || m < '2025-01') throw new ReflectError('bad_month', '月が正しくありません。');
  const rec = { month: m };
  for (const f of FIELDS) {
    const v = clean(input[f]);
    if (v.length > MAX_LEN) throw new ReflectError('too_long', `1つの項目は${MAX_LEN}文字までです。`);
    rec[f] = v;
  }
  if (!FIELDS.some((f) => rec[f])) throw new ReflectError('empty', 'どれか1つ、書いてから保存してください。');
  const cur = parse(await getRedis().hget(key(email), m));
  // 別の画面で編集された内容を、気づかずに上書きしない
  if (cur && baseUpdatedAt !== undefined && baseUpdatedAt !== null && Number(baseUpdatedAt) !== cur.updatedAt) throw new ReflectError('conflict', '別の画面で内容が更新されています。開き直して、もう一度お試しください。', 409);
  if (cur && FIELDS.every((f) => cur[f] === rec[f])) return { reflection: cur, unchanged: true }; // 二重保存・再送で、更新日時だけが変わらない
  const next = { ...rec, createdAt: cur?.createdAt || now, updatedAt: Math.max(now, (cur?.updatedAt || 0) + 1) }; // 更新のたびに必ず増える（競合の検出のため）
  await getRedis().hset(key(email), m, JSON.stringify(next));
  return { reflection: next, unchanged: false };
}

export async function deleteReflection(email, month) {
  if (!MONTH_RE.test(String(month || ''))) throw new ReflectError('bad_month', '月が正しくありません。');
  await getRedis().hdel(key(email), String(month));
  return { ok: true };
}

// ── 1か月前のあなたから（本人の記録だけ） ──
const DAY = 86400e3;
const WINDOW = [20 * DAY, 40 * DAY]; // 20〜40日前
const text280 = (s) => { const t = clean(s); return t.length > 280 ? `${t.slice(0, 280)}…` : t; };
const LABEL = { post: '公開したことば', goal: '今月の約束', reflection: '月ごとの振り返り' };
const reflText = (r) => text280([r.noticed && `気づいたこと：${r.noticed}`, r.practiced && `実践したこと：${r.practiced}`, r.changed && `変わったこと：${r.changed}`, r.nextMonth && `来月大切にしたいこと：${r.nextMonth}`].filter(Boolean).join(' ／ '));

async function myGoals(email) {
  const e = String(email || '').trim().toLowerCase();
  const ids = await getRedis().zrevrange(`ht:fixture:goals:${e}`, 0, 99);
  const recs = await Promise.all(ids.map(async (id) => parse(await getRedis().get(`ht:fixture:goal:${id}`))));
  return recs.filter((g) => g && g.email === e);
}
async function candidates(email) {
  const e = String(email || '').trim().toLowerCase();
  const [posts, goals, refl] = await Promise.all([listPostsByAuthor('haku', e, 100), myGoals(e), listReflections(e)]);
  return [
    ...posts.filter((p) => p.status === 'published' && p.authorEmail === e).map((p) => ({ kind: 'post', id: p.id, at: p.createdAt, title: p.title || '', text: text280(p.body) })),
    ...goals.map((g) => ({ kind: 'goal', id: g.id, at: g.createdAt, title: '', text: text280(g.text) })),
    ...refl.map((r) => ({ kind: 'reflection', id: r.month, at: r.createdAt, title: '', text: reflText(r) })),
  ].filter((c) => c.text);
}
async function resolveItem(email, kind, id) {
  return (await candidates(email)).find((c) => c.kind === kind && c.id === String(id)) || null;
}

export async function oneMonthAgo(email, now = Date.now()) {
  const inWin = (await candidates(email)).filter((c) => now - c.at >= WINDOW[0] && now - c.at <= WINDOW[1]);
  if (!inWin.length) return { item: null, response: null };
  inWin.sort((a, b) => Math.abs(now - a.at - 30 * DAY) - Math.abs(now - b.at - 30 * DAY));
  const c = inWin[0];
  const resp = parse(await getRedis().hget(echoKey(email), `${c.kind}:${c.id}`));
  return { item: { kind: c.kind, id: c.id, label: LABEL[c.kind], title: c.title, text: c.text, at: c.at }, response: resp ? { text: resp.text, updatedAt: resp.updatedAt } : null };
}

// いまの気持ち（任意）。元の記録が本人のものとして存在するときだけ保存できる。空にすると削除
export async function saveEcho(email, { kind, id, text }, now = Date.now()) {
  if (!['post', 'goal', 'reflection'].includes(kind)) throw new ReflectError('bad_kind', '対象が正しくありません。');
  const item = await resolveItem(email, kind, id);
  if (!item) throw new ReflectError('not_found', '元の記録が見つかりません。', 404);
  const t = clean(text);
  if (t.length > MAX_LEN) throw new ReflectError('too_long', `${MAX_LEN}文字までです。`);
  const k = `${kind}:${item.id}`;
  if (!t) { await getRedis().hdel(echoKey(email), k); return { response: null }; }
  const cur = parse(await getRedis().hget(echoKey(email), k));
  if (cur && cur.text === t) return { response: { text: cur.text, updatedAt: cur.updatedAt }, unchanged: true };
  const next = { text: t, createdAt: cur?.createdAt || now, updatedAt: now };
  await getRedis().hset(echoKey(email), k, JSON.stringify(next));
  return { response: { text: next.text, updatedAt: next.updatedAt } };
}

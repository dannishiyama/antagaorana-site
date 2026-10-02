/**
 * api/_lib/point-store.redis.js
 * HAKU POINT 台帳のデータアクセス層（Redis実装）。
 *
 * 画面・APIハンドラはこのファイルを直接触らず、必ず api/_lib/points.js（サービス層）経由で使う。
 * 将来Postgres等へ移す場合は、ここと同じ関数群（appendEntry / getBalance / listEntries /
 * listRecentEntries / getEntry）を持つ別実装を用意し、points.js の差し替えだけで済ませる。
 *
 * ── 保存構造（すべて "ht:point:" 配下。既存の ht: 名前空間の他キーとは衝突しない）──
 *   ht:point:entry:{id}          台帳1行分のJSON（追記専用。更新・削除しない）
 *   ht:point:amounts:{email}     hash  entryId → 増減値（残高＝この全値の合計）
 *   ht:point:ledger:{email}      zset  会員別の履歴索引（score=作成日時）
 *   ht:point:ledger:all          zset  全会員の履歴索引（運営の一覧用）
 *   ht:point:idem:{key}          二重操作防止（同じ操作キー → 最初に作られたentryId）
 *   ht:point:reversed:{id}       取消済みマーク（1つの履歴は1回しか取消せない）
 *
 * 台帳は「追記のみ」。誤付与は履歴を消さず、取消（逆符号の履歴）を足して直す。
 * 現在ポイントは amounts の合計から算出する（残高の数字だけを直接書き換える経路はない）。
 *
 * 規模の前提：50人規模・1会員あたり履歴数百件まで。一覧は全件を読んで集計する簡易実装。
 */
import { getRedis } from './store.redis.js';
import { randomToken } from './security.js';

const NS = 'ht:point:';

const k = {
  entry: (id) => `${NS}entry:${id}`,
  amounts: (email) => `${NS}amounts:${email}`,
  ledger: (email) => `${NS}ledger:${email}`,
  all: () => `${NS}ledger:all`,
  idem: (key) => `${NS}idem:${key}`,
  reversed: (id) => `${NS}reversed:${id}`,
};

// 「重複チェック → 取消済みチェック → 残高チェック → 追記」を1つの不可分な処理として行う。
// 同時に複数の操作が来ても、二重付与・二重取消・残高マイナスが起きない。
// 戻り値: ['ok', id] | ['duplicate', 既存id] | ['already_reversed', ''] | ['insufficient', 現在残高]
const APPEND_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing then return {'duplicate', existing} end
if ARGV[6] == '1' then
  if redis.call('EXISTS', KEYS[6]) == 1 then return {'already_reversed', ''} end
end
local delta = tonumber(ARGV[2])
if ARGV[5] == '0' then
  local sum = 0
  local vals = redis.call('HVALS', KEYS[2])
  for i = 1, #vals do sum = sum + tonumber(vals[i]) end
  if sum + delta < 0 then return {'insufficient', tostring(sum)} end
end
redis.call('SET', KEYS[5], ARGV[4])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
redis.call('SET', KEYS[1], ARGV[1])
if ARGV[6] == '1' then redis.call('SET', KEYS[6], ARGV[1]) end
return {'ok', ARGV[1]}
`;

function parseEntry(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function createPointStore(getClient = getRedis) {
  async function getEntry(id) {
    return parseEntry(await getClient().get(k.entry(id)));
  }

  async function getEntriesByIds(ids) {
    if (!ids.length) return [];
    const raws = await getClient().mget(ids.map(k.entry));
    return raws.map(parseEntry).filter(Boolean);
  }

  /**
   * 台帳へ1行追記する。
   * @param {object} p
   * @param {string} p.email 正規化済み対象会員
   * @param {number} p.delta 整数の増減値（0は不可）
   * @param {string} p.kind 種別
   * @param {string} p.reason 理由
   * @param {string} p.actorId 操作した管理者
   * @param {string} p.idempotencyKey 二重操作防止キー
   * @param {string|null} p.refType 将来、イベント等と紐付けるための種別（今回は未使用）
   * @param {string|null} p.refId 同・関連ID
   * @param {string|null} p.reversalOf 取消の場合、取り消す対象のentry id
   * @param {boolean} p.allowNegative 残高がマイナスになる操作を許すか
   * @returns {Promise<{status:'ok'|'duplicate'|'already_reversed'|'insufficient', entry?:object, balance?:number}>}
   */
  async function appendEntry(p) {
    const createdAt = Date.now();
    const id = `${createdAt}_${randomToken(4)}`;
    const entry = {
      id,
      email: p.email,
      delta: p.delta,
      kind: p.kind,
      reason: p.reason || '',
      actorId: p.actorId || 'system',
      createdAt,
      refType: p.refType || null,
      refId: p.refId || null,
      reversalOf: p.reversalOf || null,
      idempotencyKey: p.idempotencyKey,
    };
    const isReversal = Boolean(p.reversalOf);
    const result = await getClient().eval(
      APPEND_LUA,
      6,
      k.idem(p.idempotencyKey),
      k.amounts(p.email),
      k.ledger(p.email),
      k.all(),
      k.entry(id),
      isReversal ? k.reversed(p.reversalOf) : k.reversed('none'),
      id,
      String(p.delta),
      String(createdAt),
      JSON.stringify(entry),
      p.allowNegative ? '1' : '0',
      isReversal ? '1' : '0',
    );
    const [status, value] = result;
    if (status === 'ok') return { status, entry };
    if (status === 'duplicate') return { status, entry: await getEntry(value) };
    if (status === 'insufficient') return { status, balance: Number(value) };
    return { status };
  }

  // 現在ポイント＝台帳に記録された全増減値の合計。
  async function getBalance(email) {
    const vals = await getClient().hvals(k.amounts(email));
    return vals.reduce((sum, v) => sum + Number(v), 0);
  }

  // 会員1人分の履歴（新しい順）。各行に「その行を反映した後の残高」と「取消済みか」を付けて返す。
  async function listEntries(email, { limit = 50 } = {}) {
    const ids = await getClient().zrange(k.ledger(email), 0, -1);
    const entries = await getEntriesByIds(ids);
    const reversedIds = new Set(entries.filter((e) => e.reversalOf).map((e) => e.reversalOf));
    let running = 0;
    const withBalance = entries.map((e) => {
      running += e.delta;
      return { ...e, balanceAfter: running, reversed: reversedIds.has(e.id) };
    });
    const total = withBalance.length;
    return { entries: withBalance.reverse().slice(0, limit), total, balance: running };
  }

  // 全会員の直近の履歴（新しい順）。運営の確認用。
  async function listRecentEntries(limit = 100) {
    const ids = await getClient().zrevrange(k.all(), 0, limit - 1);
    const entries = await getEntriesByIds(ids);
    if (!entries.length) return [];
    const pipeline = getClient().pipeline();
    entries.forEach((e) => pipeline.exists(k.reversed(e.id)));
    const flags = await pipeline.exec();
    return entries.map((e, i) => ({ ...e, reversed: Number(flags[i]?.[1]) === 1 }));
  }

  return { appendEntry, getBalance, listEntries, listRecentEntries, getEntry };
}

export const redisPointStore = createPointStore();

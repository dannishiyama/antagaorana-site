/**
 * HAKU POINT 台帳のユニットテスト（Lua込みでメモリ上のRedisモックに対して実行する）。
 * 本物のRedis（Preview/Production）には一切接続しない。
 *
 * 実行方法（ioredis-mockはioredis 5系向けでpackage.jsonの6系と合わないため、
 * package.jsonには追加せず、ローカルで都度--no-saveで入れる。リポジトリの依存関係は変わらない）:
 *   npm install --no-save --legacy-peer-deps ioredis@5 ioredis-mock
 *   node --test "tests-unit/*.test.mjs"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import { createPointStore } from '../api/_lib/point-store.redis.js';
import { createPointService, PointError } from '../api/_lib/points.js';

let hostSeq = 0;
function setup() {
  // ioredis-mockは同じhost:portのインスタンス間でデータを共有するため、テストごとに別ホストにして完全に分離する。
  const client = new RedisMock({ host: `mock-${++hostSeq}`, port: 6379 });
  const store = createPointStore(() => client);
  const audits = [];
  const svc = createPointService({ store, logAudit: async (a) => { audits.push(a); } });
  return { client, store, svc, audits };
}
let n = 0;
const rid = () => `req_${String(++n).padStart(6, '0')}_abcdef`;
const ADMIN = 'admin@example.com';
const M = 'member@example.com';

async function rejects(promise, code) {
  await assert.rejects(promise, (e) => { assert.ok(e instanceof PointError, `PointErrorではない: ${e}`); assert.equal(e.code, code); return true; });
}

test('付与すると履歴が1行増え、現在ポイントは履歴の合計になる', async () => {
  const { svc, store } = setup();
  const r = await svc.grantPoints({ email: 'Member@Example.com ', amount: 100, reason: '朝会の手伝い', requestId: rid(), actorId: ADMIN });
  assert.equal(r.duplicate, false);
  assert.equal(r.balance, 100);
  assert.equal(r.entry.email, M);
  assert.equal(r.entry.kind, 'admin_grant');
  assert.equal(r.entry.actorId, ADMIN);
  assert.equal(r.entry.reason, '朝会の手伝い');
  await svc.grantPoints({ email: M, amount: '500', requestId: rid(), actorId: ADMIN });
  assert.equal(await store.getBalance(M), 600);
  const view = await svc.getAdminMemberView(M);
  assert.equal(view.entries.length, 2);
  assert.equal(view.entries[0].balanceAfter, 600);
});

test('同じ操作IDの二重送信では二重付与されない', async () => {
  const { svc, audits } = setup();
  const id = rid();
  const a = await svc.grantPoints({ email: M, amount: 300, requestId: id, actorId: ADMIN });
  const b = await svc.grantPoints({ email: M, amount: 300, requestId: id, actorId: ADMIN });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.entry.id, a.entry.id);
  assert.equal(b.balance, 300);
  assert.equal(audits.length, 1, '操作ログも1回だけ');
});

test('同時に20回の同一操作が来ても付与は1回だけ', async () => {
  const { svc } = setup();
  const id = rid();
  const results = await Promise.all(Array.from({ length: 20 }, () => svc.grantPoints({ email: M, amount: 50, requestId: id, actorId: ADMIN })));
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.equal(results[0].balance, 50);
});

test('同じ操作IDで内容が違う場合は取り違え防止のためエラー', async () => {
  const { svc } = setup();
  const id = rid();
  await svc.grantPoints({ email: M, amount: 100, requestId: id, actorId: ADMIN });
  await rejects(svc.grantPoints({ email: M, amount: 999, requestId: id, actorId: ADMIN }), 'idempotency_conflict');
  await rejects(svc.grantPoints({ email: 'other@example.com', amount: 100, requestId: id, actorId: ADMIN }), 'idempotency_conflict');
});

test('入力検証：整数以外・0・マイナス付与・上限超過・操作ID不正を拒否する', async () => {
  const { svc } = setup();
  for (const amount of [0, 1.5, -5, 'abc', '', null, undefined, 1_000_001, NaN]) {
    await rejects(svc.grantPoints({ email: M, amount, requestId: rid(), actorId: ADMIN }), 'invalid_amount');
  }
  await rejects(svc.grantPoints({ email: M, amount: 10, requestId: 'short', actorId: ADMIN }), 'invalid_request_id');
  await rejects(svc.grantPoints({ email: M, amount: 10, reason: 'あ'.repeat(201), requestId: rid(), actorId: ADMIN }), 'reason_too_long');
});

test('調整は理由必須。マイナス調整は残高の範囲内でのみ可能', async () => {
  const { svc } = setup();
  await svc.grantPoints({ email: M, amount: 100, requestId: rid(), actorId: ADMIN });
  await rejects(svc.adjustPoints({ email: M, amount: -10, reason: '', requestId: rid(), actorId: ADMIN }), 'reason_required');
  const ok = await svc.adjustPoints({ email: M, amount: -40, reason: '付与数の訂正', requestId: rid(), actorId: ADMIN });
  assert.equal(ok.balance, 60);
  assert.equal(ok.entry.kind, 'admin_adjust');
  await rejects(svc.adjustPoints({ email: M, amount: -61, reason: '多すぎる', requestId: rid(), actorId: ADMIN }), 'insufficient');
  const up = await svc.adjustPoints({ email: M, amount: 15, reason: 'プラス調整', requestId: rid(), actorId: ADMIN });
  assert.equal(up.balance, 75);
});

test('残高を超えるマイナス調整が同時に来ても、残高はマイナスにならない', async () => {
  const { svc, store } = setup();
  await svc.grantPoints({ email: M, amount: 100, requestId: rid(), actorId: ADMIN });
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => svc.adjustPoints({ email: M, amount: -30, reason: '同時調整', requestId: rid(), actorId: ADMIN })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(await store.getBalance(M), 10);
});

test('取消：履歴は消さず逆符号の履歴を足す。元の履歴は取消済みと表示される', async () => {
  const { svc, store } = setup();
  const g = await svc.grantPoints({ email: M, amount: 500, reason: '誤付与', requestId: rid(), actorId: ADMIN });
  const r = await svc.reversePoints({ entryId: g.entry.id, reason: '付与ミスのため取消', requestId: rid(), actorId: ADMIN });
  assert.equal(r.entry.delta, -500);
  assert.equal(r.entry.kind, 'admin_reversal');
  assert.equal(r.entry.reversalOf, g.entry.id);
  assert.equal(r.balance, 0);
  const view = await svc.getAdminMemberView(M);
  assert.equal(view.entries.length, 2, '元の履歴は残っている');
  assert.equal(view.entries.find((e) => e.id === g.entry.id).reversed, true);
  assert.ok(await store.getEntry(g.entry.id), '元の履歴は削除されていない');
});

test('取消は1つの履歴につき1回だけ。同時に別の操作IDで2回来ても1回だけ成功する', async () => {
  const { svc, store } = setup();
  const g = await svc.grantPoints({ email: M, amount: 200, requestId: rid(), actorId: ADMIN });
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => svc.reversePoints({ entryId: g.entry.id, reason: '取消', requestId: rid(), actorId: ADMIN })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'already_reversed').length, 3);
  assert.equal(await store.getBalance(M), 0);
});

test('取消の取消・存在しない履歴の取消・理由なしの取消は拒否する', async () => {
  const { svc } = setup();
  const g = await svc.grantPoints({ email: M, amount: 100, requestId: rid(), actorId: ADMIN });
  await rejects(svc.reversePoints({ entryId: g.entry.id, reason: '', requestId: rid(), actorId: ADMIN }), 'reason_required');
  const r = await svc.reversePoints({ entryId: g.entry.id, reason: '取消', requestId: rid(), actorId: ADMIN });
  await rejects(svc.reversePoints({ entryId: r.entry.id, reason: 'やっぱり戻す', requestId: rid(), actorId: ADMIN }), 'not_reversible');
  await rejects(svc.reversePoints({ entryId: 'nope', reason: '取消', requestId: rid(), actorId: ADMIN }), 'not_found');
});

test('取消で残高がマイナスになる場合は拒否する（先に使われた分は調整で対応）', async () => {
  const { svc } = setup();
  const g = await svc.grantPoints({ email: M, amount: 100, requestId: rid(), actorId: ADMIN });
  await svc.adjustPoints({ email: M, amount: -80, reason: '調整', requestId: rid(), actorId: ADMIN });
  await rejects(svc.reversePoints({ entryId: g.entry.id, reason: '取消', requestId: rid(), actorId: ADMIN }), 'insufficient');
});

test('会員本人向けの表示には、操作した管理者のメールなどを含めない', async () => {
  const { svc } = setup();
  await svc.grantPoints({ email: M, amount: 100, reason: 'ありがとう', requestId: rid(), actorId: ADMIN });
  const view = await svc.getMemberView(M);
  assert.equal(view.balance, 100);
  assert.equal(view.entries[0].reason, 'ありがとう');
  assert.equal(view.entries[0].kindLabel, '運営からのポイント');
  const json = JSON.stringify(view);
  assert.ok(!json.includes(ADMIN) && !json.includes('actorId') && !json.includes('idempotencyKey') && !json.includes(M), '管理者・内部キー・メールを含まない');
});

test('他の会員のポイントや履歴は混ざらない', async () => {
  const { svc } = setup();
  await svc.grantPoints({ email: 'a@example.com', amount: 100, requestId: rid(), actorId: ADMIN });
  await svc.grantPoints({ email: 'b@example.com', amount: 7, requestId: rid(), actorId: ADMIN });
  assert.equal((await svc.getMemberView('a@example.com')).balance, 100);
  assert.equal((await svc.getMemberView('b@example.com')).balance, 7);
  assert.equal((await svc.getMemberView('c@example.com')).balance, 0);
  assert.equal((await svc.getMemberView('c@example.com')).entries.length, 0);
});

test('全体の直近履歴に取消済みフラグが付く。履歴が無ければ空', async () => {
  const { svc } = setup();
  assert.deepEqual(await svc.listRecent(), []);
  const g = await svc.grantPoints({ email: M, amount: 100, requestId: rid(), actorId: ADMIN });
  await svc.reversePoints({ entryId: g.entry.id, reason: '取消', requestId: rid(), actorId: ADMIN });
  const recent = await svc.listRecent();
  assert.equal(recent.length, 2);
  assert.equal(recent.find((e) => e.id === g.entry.id).reversed, true);
  assert.equal(recent.find((e) => e.kind === 'admin_reversal').reversed, false);
});

test('将来の自動付与向け：関連ID・固定の操作キーでも同じ台帳で二重付与を防げる', async () => {
  const { store } = setup();
  const p = { email: M, delta: 100, kind: 'admin_grant', reason: '', actorId: 'system', idempotencyKey: 'event:E1:member@example.com:attend', refType: 'event', refId: 'E1', allowNegative: false };
  const first = await store.appendEntry(p);
  const second = await store.appendEntry(p);
  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'duplicate');
  assert.equal(first.entry.refType, 'event');
  assert.equal(await store.getBalance(M), 100);
});

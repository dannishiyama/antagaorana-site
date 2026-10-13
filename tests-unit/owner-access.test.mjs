/**
 * 依頼主本人への権限付与（scripts/lib/owner-access.mjs）のテスト。メモリ上のRedisだけを使う（本物には接続しない）。
 * 確かめること：新規／既存の両方で足りないものだけを足す・既存データを壊さない・冪等・他の人に広がらない・
 *   Stripe契約が有効なら触れない・却下済みは止まる・パスワード無しでは書かない・操作履歴に変更前が残る・ハッシュが出力に出ない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import { planOwnerAccess, applyOwnerAccess, formatPlan } from '../scripts/lib/owner-access.mjs';

const DAN = 'dan.nishiyama@antagaorana.com';
const get = async (r, k) => { const v = await r.get(k); return v ? JSON.parse(v) : null; };
let n = 0; const fresh = () => new RedisMock({ host: `mock-owner-${++n}` });

test('新規：パスワードが無いと書かない。ハッシュを渡すと、管理者・会員・両サービスの承認と会費免除・灯の運営ロールが付く', async () => {
  const r = fresh();
  const p = await planOwnerAccess(r, DAN);
  assert.equal(p.needsPassword, true);
  const noPw = await applyOwnerAccess(r, DAN);
  assert.deepEqual([noPw.applied, noPw.reason], [false, 'password_required']);
  assert.equal((await r.keys('*')).length, 0, 'パスワード無しでは何も書かない');

  const res = await applyOwnerAccess(r, DAN, { passwordHash: 'salt:hashvalue' });
  assert.equal(res.applied, true);
  assert.equal((await get(r, `ht:admin_user:${DAN}`)).role, 'super_admin');
  assert.ok(await r.sismember('ht:admin_users', DAN));
  assert.equal((await get(r, `ht:user:${DAN}`)).passwordHash, 'salt:hashvalue');
  for (const svc of ['haku', 'tomoshibi']) {
    assert.equal((await get(r, `ht:application:${svc}:${DAN}`)).status, 'approved');
    const m = await get(r, `ht:membership:${svc}:${DAN}`);
    assert.deepEqual([m.status, m.billingExempt, m.source, m.stripeSubscriptionId], ['active', true, 'owner-grant', null]);
    assert.ok(m.exemptReason && m.exemptGrantedAt);
  }
  assert.equal((await get(r, `ht:salon:tomoshibi:staff:${DAN}`)).role, 'secretariat');
  assert.ok(await r.sismember('ht:salon:tomoshibi:staff_index', DAN));
  // 操作履歴が残る
  const ids = await r.zrange('ht:audit_log', 0, -1);
  assert.ok(ids.length >= 6);
  const actions = (await Promise.all(ids.map((i) => get(r, `ht:audit:${i}`)))).map((e) => e.action);
  assert.ok(actions.includes('owner_access_membership_exempt') && actions.includes('owner_access_salon_staff') && actions.includes('owner_access_admin_create'));
});

test('冪等：2回目は変更なし・操作履歴も増えない', async () => {
  const r = fresh();
  await applyOwnerAccess(r, DAN, { passwordHash: 'salt:hashvalue' });
  const snap = JSON.stringify(await Promise.all((await r.keys('*')).sort().map((k) => r.get(k))));
  const auditBefore = await r.zcard('ht:audit_log');
  const again = await applyOwnerAccess(r, DAN, { passwordHash: 'salt:other' });
  assert.deepEqual([again.applied, again.steps.length], [true, 0]);
  assert.equal(await r.zcard('ht:audit_log'), auditBefore);
  assert.equal(JSON.stringify(await Promise.all((await r.keys('*')).sort().map((k) => r.get(k)))), snap, '2回目は何も変えない');
});

test('既存：パスワードのハッシュ・プロフィール・作成日を保持し、足りない権限と資格だけを足す', async () => {
  const r = fresh();
  await r.set(`ht:admin_user:${DAN}`, JSON.stringify({ email: DAN, role: 'community_moderator', active: true, passwordHash: 'ADMIN-HASH', createdAt: 111 }));
  await r.sadd('ht:admin_users', DAN);
  await r.set(`ht:user:${DAN}`, JSON.stringify({ email: DAN, displayName: 'ダン', fullName: '西山 大', passwordHash: 'USER-HASH', createdAt: 222, lastLoginAt: 333 }));
  await r.set(`ht:application:haku:${DAN}`, JSON.stringify({ community: 'haku', email: DAN, status: 'approved', fullName: '西山 大', submittedAt: 1 }));
  await r.set(`ht:membership:haku:${DAN}`, JSON.stringify({ status: 'active', stripeSubscriptionId: 'sub_REAL', stripeCustomerId: 'cus_REAL', joinedAt: 5, role: 'member' }));
  const res = await applyOwnerAccess(r, DAN); // パスワードは要らない（既存を使う）
  assert.equal(res.applied, true);
  const admin = await get(r, `ht:admin_user:${DAN}`);
  assert.deepEqual([admin.role, admin.passwordHash, admin.createdAt], ['super_admin', 'ADMIN-HASH', 111]);
  const user = await get(r, `ht:user:${DAN}`);
  assert.deepEqual([user.passwordHash, user.displayName, user.fullName, user.createdAt, user.lastLoginAt], ['USER-HASH', 'ダン', '西山 大', 222, 333]);
  // HAKU：既存のStripe契約が有効なので、会員資格は一切変更しない（免除も付けない）
  const haku = await get(r, `ht:membership:haku:${DAN}`);
  assert.deepEqual([haku.status, haku.stripeSubscriptionId, haku.stripeCustomerId, haku.billingExempt], ['active', 'sub_REAL', 'cus_REAL', undefined]);
  assert.ok(res.warnings.some((w) => /HAKU Community：Stripeの契約が有効/.test(w)));
  assert.equal((await get(r, `ht:application:haku:${DAN}`)).submittedAt, 1, '既存の申請は書き換えない');
  // 灯：新規に承認・免除
  assert.equal((await get(r, `ht:membership:tomoshibi:${DAN}`)).billingExempt, true);
  // 変更前が操作履歴に残る
  const ids = await r.zrange('ht:audit_log', 0, -1);
  const roleAudit = (await Promise.all(ids.map((i) => get(r, `ht:audit:${i}`)))).find((e) => e.action === 'owner_access_admin_role');
  assert.deepEqual(roleAudit.metadata.before, { role: 'community_moderator', active: true });
});

test('他の人には広がらない：他の管理者・会員は一切変わらない／Super Adminというだけでは免除しない', async () => {
  const r = fresh();
  await r.set('ht:admin_user:other@example.com', JSON.stringify({ email: 'other@example.com', role: 'super_admin', active: true, passwordHash: 'X' }));
  await r.sadd('ht:admin_users', 'other@example.com');
  await r.set('ht:membership:haku:member@example.com', JSON.stringify({ status: 'canceled' }));
  await r.set('ht:application:haku:member@example.com', JSON.stringify({ status: 'pending' }));
  const snapKeys = ['ht:admin_user:other@example.com', 'ht:membership:haku:member@example.com', 'ht:application:haku:member@example.com'];
  const before = await Promise.all(snapKeys.map((k) => r.get(k)));
  await applyOwnerAccess(r, DAN, { passwordHash: 'salt:hash' });
  assert.deepEqual(await Promise.all(snapKeys.map((k) => r.get(k))), before);
  assert.equal(await r.get('ht:membership:haku:other@example.com'), null, '他の管理者に免除は付かない');
  assert.equal(await r.get('ht:membership:tomoshibi:other@example.com'), null);
  assert.equal(await r.scard('ht:salon:tomoshibi:staff_index'), 1, '運営ロールも対象だけ');
});

test('却下済みの申請がある場合は止まる（何も書かない）', async () => {
  const r = fresh();
  await r.set(`ht:application:tomoshibi:${DAN}`, JSON.stringify({ status: 'rejected' }));
  const before = (await r.keys('*')).length;
  const res = await applyOwnerAccess(r, DAN, { passwordHash: 'salt:hash' });
  assert.deepEqual([res.applied, res.reason], [false, 'blocked']);
  assert.equal((await r.keys('*')).length, before);
  assert.match(formatPlan(res), /停止：灯サロン：既存の申請が「却下」/);
});

test('最初の管理者になる場合は、共有パスワード（旧方式）が使えなくなる旨を警告する。出力にハッシュは出ない', async () => {
  const r = fresh();
  const p = await planOwnerAccess(r, DAN);
  assert.ok(p.warnings.some((w) => /共有パスワード/.test(w)));
  const out = formatPlan(p);
  assert.ok(!/hash|salt:/.test(out));
});

test('メールアドレスの形式が不正なら拒否', async () => {
  await assert.rejects(() => planOwnerAccess(fresh(), 'not-an-email'), /形式/);
});

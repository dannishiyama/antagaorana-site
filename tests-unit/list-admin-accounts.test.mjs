/**
 * 管理者アカウント一覧（scripts/lib/admin-accounts.mjs）のテスト。メモリ上のRedisで確かめる（本物には接続しない）。
 * 確かめること：管理者・権限・灯の運営ロールが集計される／パスワードのハッシュは出ない／何も書き込まない／共有パスワード方式の注意。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import { collectAccounts, formatReport } from '../scripts/lib/admin-accounts.mjs';

const seedAdmin = async (r, email, role, extra = {}) => {
  await r.set(`ht:admin_user:${email}`, JSON.stringify({ email, role, active: true, passwordHash: 'SECRET-HASH-VALUE:xyz', createdAt: Date.now() - 86400e3, ...extra }));
  if (!extra.__skipIndex) await r.sadd('ht:admin_users', email);
};

test('管理者一覧：権限・状態・最後のログイン・灯の運営ロールを集計する。ハッシュは出さず、何も書き込まない', async () => {
  const r = new RedisMock({ host: 'mock-admin-list-1' });
  await seedAdmin(r, 'dan.nishiyama@antagaorana.com', 'super_admin');
  await seedAdmin(r, 'mod@example.com', 'community_moderator', { active: false });
  await seedAdmin(r, 'orphan@example.com', 'super_admin', { __skipIndex: true }); // 一覧に未登録
  await r.set('ht:audit:1', JSON.stringify({ actorId: 'dan.nishiyama@antagaorana.com', action: 'admin_login', createdAt: 1760000000000 }));
  await r.zadd('ht:audit_log', 1760000000000, '1');
  await r.set('ht:salon:tomoshibi:staff:owner@example.com', JSON.stringify({ role: 'owner', title: '代表', addedBy: 'x', addedAt: 1 }));
  await r.sadd('ht:salon:tomoshibi:staff_index', 'owner@example.com');
  await r.set('ht:salon:tomoshibi:staff:mod@example.com', JSON.stringify({ role: 'secretariat', title: '事務局', addedBy: 'dan', addedAt: 2 }));
  await r.sadd('ht:salon:tomoshibi:staff_index', 'mod@example.com');
  await r.set('ht:membership:haku:dan.nishiyama@antagaorana.com', JSON.stringify({ status: 'active' }));
  const before = (await r.keys('*')).length;

  const d = await collectAccounts(r);
  assert.deepEqual(d.admins.map((a) => [a.email, a.role, a.active, a.inIndex]), [
    ['dan.nishiyama@antagaorana.com', 'super_admin', true, true], ['mod@example.com', 'community_moderator', false, true], ['orphan@example.com', 'super_admin', true, false]]);
  assert.equal(d.admins[0].lastLogin, 1760000000000);
  assert.equal(d.admins[0].hakuMembership, 'active');
  assert.deepEqual(d.admins[1].salonStaff, { role: 'secretariat', title: '事務局', addedBy: 'dan' });
  assert.deepEqual(d.salonStaff.map((s) => [s.email, s.isAdminAccount]), [['mod@example.com', true], ['owner@example.com', false]]);
  assert.equal(d.sharedPasswordMode, false);
  const text = formatReport('テスト', d);
  assert.ok(!text.includes('SECRET-HASH-VALUE') && !text.includes('passwordHash'), 'ハッシュは出ない');
  assert.match(text, /dan\.nishiyama@antagaorana\.com[\s\S]*super_admin/);
  assert.match(text, /無効（ログイン不可）/); assert.match(text, /一覧に未登録/); assert.match(text, /管理者アカウントではない/);
  assert.equal((await r.keys('*')).length, before, '何も書き込まない');
});

test('管理者一覧：個別アカウントが0件なら、共有パスワード（旧方式）で入れる状態だと知らせる。灯の運営ロールが無いことも示す', async () => {
  const r = new RedisMock({ host: 'mock-admin-list-2' });
  const d = await collectAccounts(r);
  assert.equal(d.sharedPasswordMode, true);
  const text = formatReport('本番', d);
  assert.match(text, /共有パスワード/); assert.match(text, /誰も操作できない状態/);
});

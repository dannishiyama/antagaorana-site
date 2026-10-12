// 管理画面に入れるアカウントと権限の「読み取り専用」の集計。書き込みは一切しない。パスワードのハッシュは取り出さない。
// scripts/list-admin-accounts.mjs が使う。テスト：tests-unit/list-admin-accounts.test.mjs
const P = 'ht:';
const SALON = 'ht:salon:tomoshibi:';
const norm = (e) => String(e || '').trim().toLowerCase();
async function json(redis, key) { const raw = await redis.get(key); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } }

export async function collectAccounts(redis) {
  const listed = (await redis.smembers(`${P}admin_users`)).map(norm).sort();
  // 一覧に載っていないのに保存されている管理者（取りこぼし）も拾う
  const stored = new Set();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${P}admin_user:*`, 'COUNT', 200);
    keys.forEach((key) => stored.add(key.slice(`${P}admin_user:`.length)));
    cursor = next;
  } while (cursor !== '0');
  const emails = [...new Set([...listed, ...stored])].sort();

  // 直近の管理者ログイン（操作履歴から）
  const lastLogin = {};
  const ids = await redis.zrevrange(`${P}audit_log`, 0, 999);
  for (const id of ids) {
    const e = await json(redis, `${P}audit:${id}`);
    if (e?.action === 'admin_login' && e.actorId && !lastLogin[norm(e.actorId)]) lastLogin[norm(e.actorId)] = e.createdAt;
  }

  const admins = [];
  for (const email of emails) {
    const rec = await json(redis, `${P}admin_user:${email}`);
    if (!rec) continue;
    const [haku, tomo, staff] = await Promise.all([json(redis, `${P}membership:haku:${email}`), json(redis, `${P}membership:tomoshibi:${email}`), json(redis, `${SALON}staff:${email}`)]);
    admins.push({
      email, role: rec.role || '(未設定)', active: rec.active !== false, createdAt: rec.createdAt || null, lastLogin: lastLogin[email] || null,
      inIndex: listed.includes(email), hakuMembership: haku?.status || null, salonMembership: tomo?.status || null,
      salonStaff: staff ? { role: staff.role, title: staff.title || '', addedBy: staff.addedBy || '' } : null,
    });
  }
  // 灯の運営ロール（管理者アカウントでない人も含む）
  const staffEmails = (await redis.smembers(`${SALON}staff_index`)).map(norm).sort();
  const salonStaff = [];
  for (const email of staffEmails) {
    const s = await json(redis, `${SALON}staff:${email}`);
    if (s) salonStaff.push({ email, role: s.role, title: s.title || '', addedBy: s.addedBy || '', addedAt: s.addedAt || null, isAdminAccount: admins.some((a) => a.email === email) });
  }
  return { admins, salonStaff, sharedPasswordMode: admins.length === 0 };
}

const fmt = (ms) => (ms ? new Date(ms + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' JST' : '—');
const ROLE_NOTE = { super_admin: '最高管理者（全操作・運営ロールの付与・テスト会員のリセット）', community_moderator: 'コミュニティ管理者（一般の管理操作。運営ロールの付与・リセットは不可）' };

export function formatReport(label, data) {
  const L = [];
  L.push(`■ ${label}：管理画面に入れる個別アカウント ${data.admins.length}件`);
  if (!data.admins.length) L.push('  （なし）');
  for (const a of data.admins) {
    L.push(`  ・${a.email}`);
    L.push(`      権限：${a.role}${ROLE_NOTE[a.role] ? '＝' + ROLE_NOTE[a.role] : ''}`);
    L.push(`      状態：${a.active ? '有効' : '無効（ログイン不可）'}｜作成：${fmt(a.createdAt)}｜最後の管理者ログイン：${fmt(a.lastLogin)}${a.inIndex ? '' : '｜※一覧に未登録'}`);
    L.push(`      灯の運営ロール：${a.salonStaff ? `${a.salonStaff.role}（${a.salonStaff.title}）` : 'なし'}｜HAKU会員資格：${a.hakuMembership || 'なし'}｜灯の会員資格：${a.salonMembership || 'なし'}`);
  }
  L.push('');
  L.push(`■ ${label}：灯の運営ロール ${data.salonStaff.length}件`);
  if (!data.salonStaff.length) L.push('  （なし）＝灯の「申請・決済」「投稿・コメント」などは、誰も操作できない状態です');
  for (const s of data.salonStaff) L.push(`  ・${s.email}｜${s.role}（${s.title}）｜付与：${s.addedBy || '—'} ${fmt(s.addedAt)}${s.isAdminAccount ? '' : '｜※管理者アカウントではない（管理画面には入れない）'}`);
  L.push('');
  if (data.sharedPasswordMode) L.push('■ 注意：個別の管理者アカウントが0件です。この間は、共有パスワード（旧方式 HT_ADMIN_PASSWORD）を知っている人が、最高管理者として管理画面に入れます。');
  else L.push('■ 個別の管理者アカウントがあるため、共有パスワード（旧方式）ではログインできません。');
  return L.join('\n');
}

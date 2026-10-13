// 依頼主本人（1つのメールアドレス）に、最高管理者・HAKU会員・灯会員・灯の運営ロール・会費免除を付与する。
// scripts/grant-owner-access.mjs が使う。テスト：tests-unit/owner-access.test.mjs（メモリ上のRedis。本物には接続しない）
//
// 決まり
//  - 対象は、渡された1つのメールアドレスだけ。他の運営者・会員には何もしない（Super Adminだから免除、とはしない）
//  - 既存のアカウント（ID・メール・パスワードのハッシュ・プロフィール・履歴）は作り直さない・上書きしない。足りないものだけを足す
//  - Stripeの契約が生きている会員資格には触れない（免除も付けない）。Stripeには一切アクセスしない
//  - 却下済みの申請など、勝手に変えてはいけない状態は変更せず、blockers に出して止める（STOP）
//  - 何度実行しても同じ結果（冪等）。変更したときだけ、変更前の状態つきで操作履歴に残す
const P = 'ht:';
const SALON = 'ht:salon:tomoshibi:';
const norm = (e) => String(e || '').trim().toLowerCase();
const LIVE = (m) => Boolean(m?.stripeSubscriptionId) && ['active', 'canceling', 'past_due'].includes(m?.status);
const SERVICES = [{ id: 'haku', label: 'HAKU Community' }, { id: 'tomoshibi', label: '灯サロン' }];
const ACTOR = 'owner-grant-script';
export const EXEMPT_REASON = '運営者（依頼主本人）の特別資格';

async function json(redis, key) { const raw = await redis.get(key); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } }
const put = (redis, key, v) => redis.set(key, JSON.stringify(v));
// 操作履歴・報告に出す、秘密を含まない要約
const brief = (m) => (m ? { status: m.status || null, billingExempt: Boolean(m.billingExempt), hasStripeSubscription: Boolean(m.stripeSubscriptionId), source: m.source || null } : null);

export async function planOwnerAccess(redis, emailRaw) {
  const email = norm(emailRaw);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('メールアドレスの形式が正しくありません。');
  const [admin, user, adminCount] = await Promise.all([json(redis, `${P}admin_user:${email}`), json(redis, `${P}user:${email}`), redis.scard(`${P}admin_users`)]);
  const plan = { email, adminCount, needsPassword: false, blockers: [], warnings: [], steps: [], state: {} };

  // 管理者アカウント
  plan.state.admin = admin ? { exists: true, role: admin.role || '(未設定)', active: admin.active !== false } : { exists: false };
  if (!admin) {
    plan.needsPassword = true;
    plan.steps.push({ kind: 'admin-create', note: '管理者アカウントを新規作成（最高管理者）' });
    if (adminCount === 0) plan.warnings.push('個別の管理者アカウントが0件のため、これが最初のアカウントになります。作成すると、共有パスワード（旧方式）でのログインは使えなくなり、このアカウントでのログインに切り替わります。');
  } else if (admin.role !== 'super_admin' || admin.active === false) {
    plan.steps.push({ kind: 'admin-role', note: `既存の管理者アカウントを最高管理者・有効にする（パスワード等は変更しない／現在：${admin.role || '未設定'}・${admin.active === false ? '無効' : '有効'}）` });
  }

  // 会員アカウント（HAKU・灯で共通のユーザー）
  plan.state.user = user ? { exists: true, hasPassword: Boolean(user.passwordHash), createdAt: user.createdAt || null } : { exists: false };
  if (!user) { plan.needsPassword = true; plan.steps.push({ kind: 'user-create', note: '会員アカウント（HAKU・灯で共通）を新規作成' }); }
  else if (!user.passwordHash) { plan.needsPassword = true; plan.steps.push({ kind: 'user-password', note: '会員アカウントにパスワードが無いため設定' }); }

  // サービスごと
  for (const svc of SERVICES) {
    const app = await json(redis, `${P}application:${svc.id}:${email}`);
    const mem = await json(redis, `${P}membership:${svc.id}:${email}`);
    plan.state[svc.id] = { application: app?.status || null, membership: brief(mem) };
    if (app?.status === 'rejected') { plan.blockers.push(`${svc.label}：既存の申請が「却下」になっています。勝手に変更しません。内容を確認してください。`); continue; }
    if (!app) plan.steps.push({ kind: 'app-create', svc: svc.id, note: `${svc.label}：申請を作成して承認（記録に残る）` });
    else if (app.status === 'pending') plan.steps.push({ kind: 'app-approve', svc: svc.id, note: `${svc.label}：審査中の申請を承認` });
    if (LIVE(mem)) { plan.warnings.push(`${svc.label}：Stripeの契約が有効な会員資格があります。そのまま保持し、会費免除は設定しません（重複請求の扱いは変更しません）。`); continue; }
    if (mem?.status === 'active' && mem.billingExempt) continue; // すでに設定済み
    plan.steps.push({ kind: 'member-exempt', svc: svc.id, note: `${svc.label}：会員資格を有効にし、会費免除（運営の特別資格）を設定${mem ? `（現在：${mem.status || '未設定'}）` : ''}` });
  }

  // 灯の運営ロール
  const staff = await json(redis, `${SALON}staff:${email}`);
  plan.state.salonStaff = staff ? { role: staff.role, title: staff.title || '' } : null;
  if (!staff) plan.steps.push({ kind: 'staff-set', note: '灯の運営ロール「事務局（secretariat）」を付与（灯の運営機能はowner/事務局とも同じ権限）' });
  return plan;
}

export async function applyOwnerAccess(redis, emailRaw, { passwordHash = null, now = Date.now() } = {}) {
  const plan = await planOwnerAccess(redis, emailRaw);
  if (plan.blockers.length) return { ...plan, applied: false, reason: 'blocked' };
  if (plan.needsPassword && !passwordHash) return { ...plan, applied: false, reason: 'password_required' };
  const email = plan.email;
  const audit = async (action, metadata) => {
    const id = `${now}:${Math.random().toString(16).slice(2, 10)}`;
    await put(redis, `${P}audit:${id}`, { actorId: ACTOR, action, targetId: email, metadata, createdAt: now });
    await redis.zadd(`${P}audit_log`, now, id);
  };
  const done = [];
  for (const step of plan.steps) {
    if (step.kind === 'admin-create') {
      const rec = { active: true, role: 'super_admin', email, passwordHash, createdAt: now, updatedAt: now };
      await put(redis, `${P}admin_user:${email}`, rec); await redis.sadd(`${P}admin_users`, email);
      await audit('owner_access_admin_create', { role: 'super_admin' });
    } else if (step.kind === 'admin-role') {
      const cur = await json(redis, `${P}admin_user:${email}`);
      await put(redis, `${P}admin_user:${email}`, { ...cur, role: 'super_admin', active: true, updatedAt: now }); await redis.sadd(`${P}admin_users`, email);
      await audit('owner_access_admin_role', { before: { role: cur.role || null, active: cur.active !== false }, after: { role: 'super_admin', active: true } });
    } else if (step.kind === 'user-create') {
      await put(redis, `${P}user:${email}`, { email, displayName: email.split('@')[0], fullName: '', fullNameKana: '', passwordHash, createdAt: now, updatedAt: now });
      await audit('owner_access_user_create', {});
    } else if (step.kind === 'user-password') {
      const cur = await json(redis, `${P}user:${email}`);
      await put(redis, `${P}user:${email}`, { ...cur, passwordHash, updatedAt: now });
      await audit('owner_access_user_password', {});
    } else if (step.kind === 'app-create') {
      const rec = { community: step.svc, email, fullName: '', fullNameKana: '', displayName: email.split('@')[0], reason: '運営者（依頼主本人）', referrerName: '', status: 'approved', submittedAt: now, reviewedAt: now, reviewedBy: ACTOR, termsVersion: null, termsAcceptedAt: null };
      await put(redis, `${P}application:${step.svc}:${email}`, rec);
      await redis.zadd(`${P}applications:${step.svc}:all`, now, email);
      await audit('owner_access_application', { service: step.svc, before: null, after: 'approved' });
    } else if (step.kind === 'app-approve') {
      const cur = await json(redis, `${P}application:${step.svc}:${email}`);
      await put(redis, `${P}application:${step.svc}:${email}`, { ...cur, status: 'approved', reviewedAt: now, reviewedBy: ACTOR });
      await redis.srem(`${P}applications:${step.svc}:pending`, email);
      await audit('owner_access_application', { service: step.svc, before: cur.status, after: 'approved' });
    } else if (step.kind === 'member-exempt') {
      const key = `${P}membership:${step.svc}:${email}`;
      const cur = await json(redis, key);
      // Stripeの契約が生きていないことを、書く直前にもう一度確かめる
      if (LIVE(cur)) continue;
      const rec = { role: 'member', joinedAt: now, ...(cur || {}), status: 'active', activatedAt: now, source: 'owner-grant', billingExempt: true, exemptReason: EXEMPT_REASON, exemptGrantedBy: ACTOR, exemptGrantedAt: now, stripeSubscriptionId: null, community: step.svc, email, updatedAt: now };
      await put(redis, key, rec);
      await audit('owner_access_membership_exempt', { service: step.svc, before: brief(cur), after: brief(rec), reason: EXEMPT_REASON });
    } else if (step.kind === 'staff-set') {
      await put(redis, `${SALON}staff:${email}`, { role: 'secretariat', title: '事務局', addedBy: ACTOR, addedAt: now });
      await redis.sadd(`${SALON}staff_index`, email);
      await audit('owner_access_salon_staff', { role: 'secretariat' });
    }
    done.push(step.note);
  }
  return { ...plan, applied: true, done };
}

export function formatPlan(plan, { apply = false } = {}) {
  const L = [`対象：${plan.email}`, ''];
  const st = plan.state;
  L.push(`  管理者アカウント：${st.admin.exists ? `あり（権限 ${st.admin.role}・${st.admin.active ? '有効' : '無効'}）` : 'なし'}`);
  L.push(`  会員アカウント：${st.user.exists ? (st.user.hasPassword ? 'あり' : 'あり（パスワード未設定）') : 'なし'}`);
  for (const svc of SERVICES) L.push(`  ${svc.label}：申請 ${st[svc.id].application || 'なし'}／会員資格 ${st[svc.id].membership ? `${st[svc.id].membership.status}${st[svc.id].membership.billingExempt ? '（会費免除）' : ''}${st[svc.id].membership.hasStripeSubscription ? '（Stripe契約あり）' : ''}` : 'なし'}`);
  L.push(`  灯の運営ロール：${st.salonStaff ? `${st.salonStaff.role}（${st.salonStaff.title}）` : 'なし'}`);
  L.push('');
  L.push(plan.steps.length ? (apply ? '行う変更：' : '行う変更（まだ書き込んでいません）：') : '変更はありません（すでにすべて設定済みです）。');
  plan.steps.forEach((s) => L.push(`  ・${s.note}`));
  plan.warnings.forEach((w) => L.push(`  ※ ${w}`));
  plan.blockers.forEach((b) => L.push(`  ✖ 停止：${b}`));
  return L.join('\n');
}

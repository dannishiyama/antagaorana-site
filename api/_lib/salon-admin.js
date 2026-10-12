/**
 * api/_lib/salon-admin.js
 * 灯サロンの運営向け管理API（api/admin.js から呼ばれる）。
 *
 * 権限は二重に確認する：
 *   1. 管理画面にログイン済み（ht_admin_session）であること（api/admin.js 側で確認済み）
 *   2. その管理者のメールアドレスが、灯の「運営ロール（staff）」に登録されていること
 * HAKU Communityの管理者というだけでは、灯の投稿内容・会員情報は見られない。
 * 運営ロールの追加・削除は super_admin のみ。すべての変更は監査ログに残す。
 */
import { blockProduction, checkOrigin, resolveBaseUrl } from './http.js';
import { listApplications, getApplication, resolveApplication, getMembership, setMembership, getUser, logAudit, claimIdempotentOp, completeIdempotentOp, releaseIdempotentOp, checkRateLimit } from './store.js';
import * as S from './salon-store.js';
import * as C from './salon-core.js';
import { startCheckout, BillingError } from './salon-billing.js';
import { mail } from './salon-mail.js';

const bool = (v) => v === true || v === 'true';
const toMs = (v) => { const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : null; };

async function needStaff(session) {
  const staff = await S.getStaff(session.actorId);
  if (!staff) throw new C.SalonError(403, '灯の運営ロールが必要です。この管理者は、灯の運営ロールに登録されていません。', 'salon_staff_required');
  return staff;
}

const LOGIN_PATH = '/salon/tomoshibi/login/';

// 申請の承認：pending → approved。承認だけでは会員にならない（お支払いをWebhookが確認して初めて有効になる）。
// 承認ボタンの二重操作は、処理中の印（claimIdempotentOp）と「pendingのときだけ承認できる」確認で防ぐ。
export async function approveSalonApplication({ email, actor, baseUrl }) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) throw new C.SalonError(400, 'メールアドレスを指定してください。', 'bad_email');
  const claim = await claimIdempotentOp('salon-approve', e);
  if (claim.status !== 'new') throw new C.SalonError(409, 'この申請は処理中、または処理済みです。', 'duplicate');
  try {
    const application = await getApplication(S.SALON_ID, e);
    if (!application || application.status !== 'pending') throw new C.SalonError(404, '保留中の申請が見つかりません。', 'not_pending');
    await resolveApplication(S.SALON_ID, e, 'approved', actor);
    await logAudit({ actorId: actor, action: 'salon_application_approved', targetId: e, metadata: { targetType: 'Application', salon: S.SALON_ID } });
    const out = await sendPaymentGuide({ email: e, displayName: application.displayName, baseUrl });
    await completeIdempotentOp('salon-approve', e, 'done');
    return { ok: true, ...out };
  } catch (err) { await releaseIdempotentOp('salon-approve', e).catch(() => {}); throw err; }
}

// 承認メール（お支払いのご案内）。Checkoutの作成に失敗しても承認は取り消さず、ログイン画面から進むご案内にする
async function sendPaymentGuide({ email, displayName, baseUrl }) {
  let checkoutUrl = null; let checkout = 'created'; let reason = null;
  try { checkoutUrl = (await startCheckout({ email, baseUrl })).url; } catch (err) {
    checkout = 'fallback'; reason = err instanceof BillingError ? err.code : 'error';
    console.error('[salon-admin] checkout for approval mail failed:', reason);
  }
  const sent = await mail.approved({ email, displayName, checkoutUrl, loginUrl: `${baseUrl}${LOGIN_PATH}` });
  return { checkout, checkoutReason: reason, emailSent: Boolean(sent?.ok) };
}

export async function rejectSalonApplication({ email, actor }) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) throw new C.SalonError(400, 'メールアドレスを指定してください。', 'bad_email');
  const claim = await claimIdempotentOp('salon-reject', e);
  if (claim.status !== 'new') throw new C.SalonError(409, 'この申請は処理中、または処理済みです。', 'duplicate');
  try {
    const application = await getApplication(S.SALON_ID, e);
    if (!application || application.status !== 'pending') throw new C.SalonError(404, '保留中の申請が見つかりません。', 'not_pending');
    await resolveApplication(S.SALON_ID, e, 'rejected', actor);
    await mail.rejected({ email: e, displayName: application.displayName });
    await logAudit({ actorId: actor, action: 'salon_application_rejected', targetId: e, metadata: { targetType: 'Application', salon: S.SALON_ID } });
    await completeIdempotentOp('salon-reject', e, 'done');
    return { ok: true };
  } catch (err) { await releaseIdempotentOp('salon-reject', e).catch(() => {}); throw err; }
}

// 管理画面の申請・決済の1行（運営が見てよい項目。Stripeの内部IDそのものは返さず、契約の有無と期間だけ返す）
function billingView(app, m) {
  const unpaid = app.status === 'approved' && !m;
  return {
    email: app.email, fullName: app.fullName, fullNameKana: app.fullNameKana, displayName: app.displayName, referrerName: app.referrerName || '', reason: app.reason || '',
    prefecture: app.prefecture || '', facilityLabel: app.facilityLabel || '', source: app.source || '',
    application: app.status, submittedAt: app.submittedAt, reviewedAt: app.reviewedAt || null, reviewedBy: app.reviewedBy || null,
    payment: app.status === 'pending' ? 'review' : app.status === 'rejected' ? 'none' : unpaid ? 'unpaid' : (m?.source === 'stripe' ? 'paid' : m ? 'exempt' : 'unpaid'),
    membership: m?.status || null, hasSubscription: Boolean(m?.stripeSubscriptionId), currentPeriodEnd: m?.currentPeriodEnd || null, cancelAtPeriodEnd: Boolean(m?.cancelAtPeriodEnd),
    billingExempt: Boolean(m?.billingExempt), exemptReason: m?.exemptReason || '',
  };
}

export async function handleSalonAdmin(action, req, res, session) {
  if (blockProduction(res)) return;
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const isPost = req.method === 'POST';
  try {
    if (isPost && !checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
    const POSTS = new Set(['salon-application-approve', 'salon-application-reject', 'salon-payment-link', 'salon-staff-set', 'salon-post-delete', 'salon-post-pin', 'salon-comment-delete', 'salon-creed-set', 'salon-lecture-create', 'salon-lecture-update', 'salon-lecture-delete', 'salon-news-create', 'salon-event-create', 'salon-event-update', 'salon-event-delete', 'salon-member-set']);
    if (POSTS.has(action) !== isPost) return res.status(405).json({ error: 'Method not allowed' });
    const actor = session.actorId;
    const R = C.makeResolver();

    // 運営ロールの一覧・変更（変更は super_admin のみ。一覧は管理者なら確認できる＝最初の登録のため）
    if (action === 'salon-staff-list') return res.status(200).json({ ok: true, staff: await S.listStaff(), you: await S.getStaff(actor), canEditStaff: session.role === 'super_admin' });
    if (action === 'salon-staff-set') {
      if (session.role !== 'super_admin') throw new C.SalonError(403, '運営ロールの変更は、最高管理者のみ行えます。', 'forbidden');
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new C.SalonError(400, 'メールアドレスの形式をご確認ください。', 'bad_email');
      if (!body.role || body.role === 'none') { await S.setStaff(email, null); await C.audit(actor, 'staff_removed', email); return res.status(200).json({ ok: true, staff: await S.listStaff() }); }
      if (!['owner', 'secretariat'].includes(body.role)) throw new C.SalonError(400, 'ロールが正しくありません。', 'bad_role');
      const title = C.cleanLabel(body.title || (body.role === 'owner' ? '代表' : '事務局'), 20);
      const subtitle = body.subtitle ? C.cleanLabel(body.subtitle, 30) : '';
      await S.setStaff(email, { role: body.role, title, subtitle, addedBy: actor, addedAt: Date.now() });
      await C.audit(actor, 'staff_set', email, { role: body.role });
      return res.status(200).json({ ok: true, staff: await S.listStaff() });
    }

    const staff = await needStaff(session);
    const viewer = { email: actor, staff };

    switch (action) {
      case 'salon-overview': {
        const [apps, roster] = await Promise.all([listApplications(S.SALON_ID, 'all'), S.listStaff()]);
        const memberships = await Promise.all(apps.map((a) => getMembership(S.SALON_ID, a.email)));
        return res.status(200).json({ ok: true, applications: apps.length, pending: apps.filter((a) => a.status === 'pending').length, activeMembers: memberships.filter(C.isActiveStatus).length, staff: roster.length, posts: (await S.allPostIds(5000)).length });
      }
      case 'salon-applications': {
        const f = ['pending', 'approved', 'rejected', 'all'].includes(req.query?.status) ? req.query.status : 'all';
        const apps = await listApplications(S.SALON_ID, 'all');
        const rows = await Promise.all(apps.map(async (a) => billingView(a, await getMembership(S.SALON_ID, a.email))));
        const list = rows.filter((r) => f === 'all' || (f === 'approved' ? r.application === 'approved' || r.application === 'paid' : r.application === f))
          .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
        return res.status(200).json({ ok: true, applications: list });
      }
      case 'salon-application-approve': {
        const baseUrl = resolveBaseUrl(req); if (!baseUrl) return res.status(400).json({ error: 'Invalid host' });
        return res.status(200).json(await approveSalonApplication({ email: body.email, actor, baseUrl }));
      }
      case 'salon-application-reject': return res.status(200).json(await rejectSalonApplication({ email: body.email, actor }));
      case 'salon-payment-link': { // 承認済み・未決済の人へ、お支払いのご案内を再送する（有効なCheckoutがあれば、同じものを再利用する）
        const email = String(body.email || '').trim().toLowerCase();
        const baseUrl = resolveBaseUrl(req); if (!baseUrl) return res.status(400).json({ error: 'Invalid host' });
        const app = await getApplication(S.SALON_ID, email);
        const m = await getMembership(S.SALON_ID, email);
        if (!app || app.status !== 'approved' || m) throw new C.SalonError(409, '承認済みで、未決済の方だけに送れます。', 'not_unpaid');
        if (!(await checkRateLimit(`salon-paylink:${email}`, 3, 3600))) throw new C.SalonError(429, '送信の回数が多すぎます。しばらく時間をおいてください。', 'rate');
        const out = await sendPaymentGuide({ email, displayName: app.displayName, baseUrl });
        await logAudit({ actorId: actor, action: 'salon_payment_link_sent', targetId: email, metadata: { salon: S.SALON_ID, checkout: out.checkout } });
        return res.status(200).json({ ok: true, ...out });
      }
      case 'salon-members': {
        const apps = await listApplications(S.SALON_ID, 'all');
        const rows = await Promise.all(apps.map(async (a) => {
          const [m, p, st, u] = await Promise.all([getMembership(S.SALON_ID, a.email), S.getProfile(a.email), S.getStaff(a.email), getUser(a.email)]);
          const b = billingView(a, m);
          return { email: a.email, name: p?.displayName || u?.displayName || a.displayName || '', application: a.status, membership: m?.status || null, prefecture: p?.prefecture || '', facilityLabel: p?.facilityLabel || '', listVisibility: p?.listVisibility || 'public', role: st?.role || null, since: m?.activatedAt || null, source: a.source || null, payment: b.payment, hasSubscription: b.hasSubscription, currentPeriodEnd: b.currentPeriodEnd, cancelAtPeriodEnd: b.cancelAtPeriodEnd, billingExempt: b.billingExempt };
        }));
        return res.status(200).json({ ok: true, members: rows });
      }
      case 'salon-member-set': { // 決済を経ない手動の有効化／無効化（招待・テスト・退会処理用）。理由が必要。審査（承認）は「申請・決済」で行う
        const email = String(body.email || '').trim().toLowerCase();
        const status = body.status;
        const reason = C.cleanLabel(body.reason || '', 80);
        if (!['active', 'inactive'].includes(status)) throw new C.SalonError(400, '状態が正しくありません。', 'bad_status');
        if (!reason) throw new C.SalonError(400, '理由を入力してください（記録に残ります）。', 'reason_required');
        const apps = await listApplications(S.SALON_ID, 'all');
        const app = apps.find((a) => a.email === email);
        if (!app || !['approved', 'paid'].includes(app.status)) throw new C.SalonError(409, '承認済みの申請がある会員だけ変更できます。', 'not_approved');
        const cur = await getMembership(S.SALON_ID, email);
        // Stripeの契約が生きている人は、手動では変えない（請求だけが続くのを防ぐ）。本人の退会、またはStripeでの解約を先に行う
        if (cur?.stripeSubscriptionId && ['active', 'canceling', 'past_due'].includes(cur.status)) throw new C.SalonError(409, 'お支払い（Stripe）の契約がある会員は、ここでは変更できません。本人の退会、またはStripeでの解約をしてください。', 'has_subscription');
        await setMembership(S.SALON_ID, email, status === 'active' ? { status, activatedAt: Date.now(), source: 'salon-admin', billingExempt: true, exemptReason: reason, stripeSubscriptionId: null } : { status });
        await C.audit(actor, 'member_status_set', email, { status, reason });
        return res.status(200).json({ ok: true });
      }
      case 'salon-posts': {
        const ch = String(req.query?.ch || 'home');
        if (!C.FEED_CHANNELS.includes(ch)) throw new C.SalonError(400, 'チャンネルが正しくありません。', 'bad_channel');
        const ids = await S.listPostIds(ch, { before: Number(req.query?.before) || null, limit: 30 });
        const posts = (await Promise.all(ids.map((i) => S.getPost(i)))).filter(Boolean);
        return res.status(200).json({ ok: true, posts: await C.viewPosts(posts, viewer, R, { asStaffViewer: true }), nextBefore: posts.length ? posts[posts.length - 1].createdAt : null });
      }
      case 'salon-comments': {
        const list = C.orderComments(await S.listComments(String(req.query?.postId || '')));
        return res.status(200).json({ ok: true, comments: await C.viewComments(list, viewer, R) });
      }
      case 'salon-post-delete': {
        const post = await S.getPost(body.id); if (!post) throw new C.SalonError(404, '投稿が見つかりません。', 'not_found');
        await S.deletePost(post.id); await C.audit(actor, 'post_deleted_by_staff', post.id, { channel: post.channel, via: 'admin' });
        return res.status(200).json({ ok: true });
      }
      case 'salon-post-pin': {
        const post = await S.getPost(body.id); if (!post) throw new C.SalonError(404, '投稿が見つかりません。', 'not_found');
        const patch = { pinned: bool(body.pinned) };
        await S.updatePost(post.id, patch);
        if (body.pinTitle !== undefined) await S.updatePost(post.id, { pinTitle: C.cleanLabel(body.pinTitle, 40) });
        await C.audit(actor, bool(body.pinned) ? 'post_pinned' : 'post_unpinned', post.id, { via: 'admin' });
        return res.status(200).json({ ok: true });
      }
      case 'salon-comment-delete': {
        const c = await S.getComment(body.id); if (!c) throw new C.SalonError(404, 'コメントが見つかりません。', 'not_found');
        await S.deleteCommentTree(c.postId, c.id); await C.audit(actor, 'comment_deleted_by_staff', c.id, { postId: c.postId, via: 'admin' });
        return res.status(200).json({ ok: true });
      }
      case 'salon-creed-get': return res.status(200).json({ ok: true, current: await S.getCreed(), creeds: C.CREEDS.slice(1).map((t, i) => ({ n: i + 1, label: C.creedLabel(i + 1), title: t })) });
      case 'salon-creed-set': {
        const n = C.parseCreedTag(body.n); if (!n) throw new C.SalonError(400, '十ヶ条のどれかを選んでください。', 'bad_creed');
        const reading = body.reading ? C.cleanLabel(body.reading, 80) : '';
        const rec = await S.setCreed({ n, reading, setAt: Date.now(), setBy: actor });
        await C.audit(actor, 'creed_set', String(n));
        return res.status(200).json({ ok: true, current: rec });
      }
      case 'salon-lecture-list': return res.status(200).json({ ok: true, lectures: await S.listLectures() });
      case 'salon-lecture-create':
      case 'salon-lecture-update': {
        const create = action === 'salon-lecture-create';
        const rec = {};
        if (create || body.title !== undefined) rec.title = C.cleanLabel(body.title, 100) || (() => { throw new C.SalonError(400, 'タイトルを入力してください。', 'empty'); })();
        if (create || body.description !== undefined) rec.description = body.description ? C.cleanBody(body.description, 3000, '説明') : '';
        if (create || body.heldAt !== undefined) { rec.heldAt = toMs(body.heldAt); if (!rec.heldAt) throw new C.SalonError(400, '開催日を入力してください。', 'bad_date'); }
        if (body.minutes !== undefined) { const m = Number(body.minutes); rec.minutes = Number.isFinite(m) && m > 0 && m < 600 ? Math.round(m) : null; }
        if (body.creedTag !== undefined) rec.creedTag = C.parseCreedTag(body.creedTag);
        if (body.note !== undefined) rec.note = body.note ? C.cleanLabel(body.note, 80) : '';
        if (create || body.videoUrl !== undefined) {
          const url = C.safeHttpsUrl(body.videoUrl);
          if (!url) throw new C.SalonError(400, '動画のURLは https:// で始まるものを指定してください。', 'bad_url');
          rec.videoUrl = url;
        }
        if (create) {
          const lecture = await S.createLecture(rec);
          let post = null;
          if (body.publishPost !== false) post = await S.createPost({ channel: 'archive', authorEmail: actor, body: rec.description || rec.title, anonymous: false, hideFacility: true, creedTag: rec.creedTag || null, attachment: { type: 'video', lectureId: lecture.id } });
          await C.audit(actor, 'lecture_created', lecture.id);
          return res.status(200).json({ ok: true, lecture, postId: post?.id || null });
        }
        const lecture = await S.updateLecture(body.id, rec);
        if (!lecture) throw new C.SalonError(404, '講義が見つかりません。', 'not_found');
        await C.audit(actor, 'lecture_updated', lecture.id);
        return res.status(200).json({ ok: true, lecture });
      }
      case 'salon-lecture-delete': {
        const l = await S.getLecture(body.id); if (!l) throw new C.SalonError(404, '講義が見つかりません。', 'not_found');
        for (const id of await S.allPostIds(5000)) { const p = await S.getPost(id); if (p?.attachment?.type === 'video' && p.attachment.lectureId === l.id) await S.deletePost(id); }
        await S.deleteLecture(l.id); await C.audit(actor, 'lecture_deleted', l.id);
        return res.status(200).json({ ok: true });
      }
      case 'salon-news-create': {
        const text = C.cleanBody(body.body, C.SALON_CONFIG.postMax);
        let attachment = null;
        if (body.eventId) { const ev = await S.getEvent(body.eventId); if (!ev) throw new C.SalonError(400, 'イベントが見つかりません。', 'bad_attachment'); attachment = { type: 'event', eventId: ev.id }; }
        const post = await S.createPost({ channel: 'news', authorEmail: actor, body: text, anonymous: false, hideFacility: true, attachment, pinned: false });
        if (bool(body.pinned)) await S.updatePost(post.id, { pinned: true });
        await C.audit(actor, 'news_created', post.id);
        return res.status(200).json({ ok: true, postId: post.id });
      }
      case 'salon-event-list': {
        const events = await S.listEvents({ limit: 200 });
        const counts = await S.eventCounts(events.map((e) => e.id), actor);
        return res.status(200).json({ ok: true, events: events.map((e, i) => ({ ...e, participants: counts[i].count })).reverse() });
      }
      case 'salon-event-create':
      case 'salon-event-update': {
        const create = action === 'salon-event-create';
        const rec = {};
        if (create || body.title !== undefined) rec.title = C.cleanLabel(body.title, 100) || (() => { throw new C.SalonError(400, 'タイトルを入力してください。', 'empty'); })();
        if (create || body.startsAt !== undefined) { rec.startsAt = toMs(body.startsAt); if (!rec.startsAt) throw new C.SalonError(400, '開催日時を入力してください。', 'bad_date'); }
        if (body.endsAt !== undefined) rec.endsAt = body.endsAt ? toMs(body.endsAt) : null;
        if (body.summary !== undefined) rec.summary = body.summary ? C.cleanLabel(body.summary, 120) : '';
        if (body.capacity !== undefined) { const c = body.capacity === null || body.capacity === '' ? null : Number(body.capacity); if (c !== null && (!Number.isInteger(c) || c < 1 || c > 10000)) throw new C.SalonError(400, '定員が正しくありません。', 'bad_capacity'); rec.capacity = c; }
        if (body.url !== undefined) { if (body.url === '' || body.url === null) rec.url = null; else { const u = C.safeHttpsUrl(body.url); if (!u) throw new C.SalonError(400, '開催URLは https:// で始まるものを指定してください。', 'bad_url'); rec.url = u; } }
        if (create) {
          const ev = await S.createEvent({ ...rec, createdBy: actor });
          let postId = null;
          if (bool(body.announce)) postId = (await S.createPost({ channel: 'news', authorEmail: actor, body: C.cleanBody(body.announceBody || rec.title, C.SALON_CONFIG.postMax), anonymous: false, hideFacility: true, attachment: { type: 'event', eventId: ev.id } })).id;
          await C.audit(actor, 'event_created', ev.id);
          return res.status(200).json({ ok: true, event: ev, postId });
        }
        const ev = await S.updateEvent(body.id, rec);
        if (!ev) throw new C.SalonError(404, 'イベントが見つかりません。', 'not_found');
        await C.audit(actor, 'event_updated', ev.id);
        return res.status(200).json({ ok: true, event: ev });
      }
      case 'salon-event-delete': {
        const ev = await S.getEvent(body.id); if (!ev) throw new C.SalonError(404, 'イベントが見つかりません。', 'not_found');
        await S.deleteEvent(ev.id); await C.audit(actor, 'event_deleted', ev.id);
        return res.status(200).json({ ok: true });
      }
      case 'salon-event-participants': {
        const ev = await S.getEvent(String(req.query?.id || '')); if (!ev) throw new C.SalonError(404, 'イベントが見つかりません。', 'not_found');
        const emails = await S.eventParticipants(ev.id);
        return res.status(200).json({ ok: true, participants: await Promise.all(emails.map(async (e) => ({ email: e, name: await C.displayNameOf(e, R) }))) });
      }
      case 'salon-audit': { // 灯に関する監査履歴（直近）
        const { listAuditLog } = await import('./store.js');
        const entries = (await listAuditLog(300)).filter((e) => String(e.action || '').startsWith('salon_'));
        return res.status(200).json({ ok: true, entries: entries.slice(0, 100) });
      }
      default: return res.status(404).json({ error: 'Not found' });
    }
  } catch (err) {
    if (err instanceof C.SalonError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[salon-admin] error:', err.message);
    return res.status(500).json({ error: '処理できませんでした。時間をおいて、もう一度お試しください。' });
  }
}

/**
 * api/_lib/donation-admin.js
 * 管理画面「ポイント利用｜申請管理」のAPI。api/admin.js から、管理者ログインを確認したあとに呼ばれる。
 * 承認・却下・取消・振込情報の登録・振込完了は、ログイン済みの管理者だけ（権限はサーバー側で確認。画面の表示には依存しない）。
 */
import * as D from './donation.js';
import { PointError } from './points.js';
import { donationMail } from './donation-mail.js';
import { checkOrigin, rateLimitGuard, resolveBaseUrl } from './http.js';

const q = (req, k) => String(req.query?.[k] ?? '').slice(0, 100);

function asAdminView(r) {
  return { ...r, statusLabel: D.STATUS_LABEL[r.status] || r.status, handledBy: D.handledBy(r) };
}

export async function handleDonationAdmin(action, req, res, session) {
  if (!D.donationEnabled()) return res.status(403).json({ error: 'この機能は、この環境ではまだ利用できません。', code: 'disabled' });
  const isPost = req.method === 'POST';
  const POSTS = new Set(['donation-approve', 'donation-reject', 'donation-cancel', 'donation-transfer', 'donation-complete', 'donation-exception-cancel', 'donation-note', 'donation-cause-save', 'donation-cause-move', 'donation-cause-review']);
  if (POSTS.has(action) !== isPost) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const actor = session.actorId;
    if (isPost) {
      if (!checkOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
      if (!(await rateLimitGuard(req, res, { key: 'admin-donation', limit: 120, windowSeconds: 15 * 60 }))) return;
    }
    const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
    const baseUrl = resolveBaseUrl(req);
    const reply = (r, extra = {}) => res.status(200).json({ ok: true, request: asAdminView(r.request), duplicate: Boolean(r.duplicate), ...extra });

    if (action === 'donation-list') {
      const filters = { status: q(req, 'status'), q: q(req, 'q'), cause: q(req, 'cause'), kind: q(req, 'kind'), from: q(req, 'from'), to: q(req, 'to'), sort: q(req, 'sort'), field: q(req, 'field') };
      const recs = await D.listAll(filters);
      return res.status(200).json({ ok: true, requests: recs.map(asAdminView), summary: D.summarize(recs), causes: await D.listCauses(), points: D.DONATION_POINTS, statusLabels: D.STATUS_LABEL });
    }
    if (action === 'donation-detail') {
      const r = await D.getRequest(q(req, 'id'));
      if (!r) return res.status(404).json({ error: '申請が見つかりません。' });
      return res.status(200).json({ ok: true, request: asAdminView(r), log: await D.getLog(r.id) });
    }
    if (action === 'donation-csv') {
      const recs = await D.listAll({ status: q(req, 'status'), q: q(req, 'q'), cause: q(req, 'cause'), kind: q(req, 'kind'), from: q(req, 'from'), to: q(req, 'to'), sort: 'old', field: q(req, 'field') });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="haku-point-donations.csv"');
      return res.status(200).send(D.toCsv(recs));
    }
    if (action === 'donation-cause-save') {
      if (session.role !== 'super_admin') return res.status(403).json({ error: '支援先の追加・公開・停止は、最高管理者のみ行えます。' });
      return res.status(200).json({ ok: true, cause: await D.saveCause({ id: body.id, name: body.name, description: body.description, url: body.url, status: body.status, actorId: actor }), causes: await D.listCauses() });
    }
    if (action === 'donation-cause-move') {
      if (session.role !== 'super_admin') return res.status(403).json({ error: '支援先の並び替えは、最高管理者のみ行えます。' });
      return res.status(200).json({ ok: true, causes: await D.moveCause({ id: body.id, dir: body.dir, actorId: actor }) });
    }
    const id = String(body.id || '');
    if (action === 'donation-approve') { const r = await D.approve(id, actor); if (!r.duplicate) await donationMail.approved(r.request); return reply(r); }
    if (action === 'donation-reject') { const r = await D.reject(id, actor, body.reason); if (!r.duplicate) await donationMail.rejected(r.request); return reply(r); }
    if (action === 'donation-cause-review') { const r = await D.reviewCause(id, actor, String(body.decision || ''), body.note ?? body.reason); if (body.decision === 'reject' && !r.duplicate) await donationMail.rejected(r.request); return reply(r); }
    if (action === 'donation-cancel') return reply(await D.cancel(id, actor, body.reason));
    if (action === 'donation-exception-cancel') return reply(await D.exceptionCancel(id, actor, body.reason, String(body.confirm || '')));
    if (action === 'donation-transfer') return reply(await D.registerTransfer(id, actor, body));
    if (action === 'donation-complete') { const r = await D.complete(id, actor); if (!r.duplicate) await donationMail.completed(r.request); return reply(r); }
    if (action === 'donation-note') return reply(await D.addNote(id, actor, body.memo));
    void baseUrl;
    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    if (err instanceof D.DonationError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof PointError) return res.status(err.status || 400).json({ error: err.message, code: err.code });
    console.error('[donation-admin] error:', err);
    return res.status(500).json({ error: '処理に失敗しました。' });
  }
}

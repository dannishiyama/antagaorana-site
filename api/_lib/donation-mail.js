/**
 * api/_lib/donation-mail.js
 * ポイント利用申請の通知メール（申請受付／運営への新規申請／承認／却下／振込完了）。
 * 既存の送信方法（Resend・FROM_EMAIL・ADMIN_EMAILS・EmailLog）を踏襲する。
 *
 * 契約：送信に失敗しても例外を投げず、申請・ポイント・振込の記録には一切影響しない。
 *       同じ申請・同じ種類の通知は1回だけ（claimMail）。結果は申請の操作履歴（mail_sent / mail_failed）に残る。
 */
import { Resend } from 'resend';
import { escapeHtml } from './security.js';
import { logEmailSent, getUser } from './store.js';
import { claimMail, noteMail, STATUS_LABEL, ORG_NAME } from './donation.js';

export const deps = { send: null }; // テストで、実際の送信を差し替える入口

const LABEL = 'HAKU Community';
const fromEmail = () => process.env.FROM_EMAIL || 'info@antagaorana.com';
const adminRecipients = () => (process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',').map((e) => e.trim()).filter(Boolean) : [fromEmail()]);
const previewNote = () => (process.env.VERCEL_ENV === 'production' ? '' : '※これはテスト環境（Preview）からの送信です。');

async function deliver({ emailType, to, subject, lines, cta }) {
  const recipients = Array.isArray(to) ? to : [to];
  try {
    const body = [...lines, ...(cta ? ['', `${cta.label}：${cta.url}`] : []), ...(previewNote() ? ['', previewNote()] : [])].join('\n');
    const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head><body style="margin:0;background:#F6F2E9;font-family:'Yu Gothic','Hiragino Sans',sans-serif"><div style="max-width:520px;margin:28px auto;background:#FFFDF8;border:1px solid #DCD5C5;border-radius:10px;overflow:hidden"><div style="background:#1E3A2F;padding:18px 26px"><p style="color:#F6F2E9;font-size:15px;margin:0;letter-spacing:.06em">${escapeHtml(LABEL)}</p></div><div style="padding:26px;font-size:14px;line-height:1.9;color:#2B2926">${lines.map((l) => (l ? `<p style="margin:0 0 10px">${escapeHtml(l)}</p>` : '<p style="margin:0 0 6px">&nbsp;</p>')).join('')}${cta ? `<p style="margin:18px 0 0"><a href="${escapeHtml(cta.url)}" style="color:#1E3A2F">${escapeHtml(cta.label)}</a></p>` : ''}${previewNote() ? `<p style="margin:18px 0 0;font-size:12px;color:#6E685F">${escapeHtml(previewNote())}</p>` : ''}</div></div></body></html>`;
    const payload = { from: `${LABEL} <${fromEmail()}>`, to: recipients, replyTo: fromEmail(), subject, text: body, html };
    const result = deps.send ? await deps.send(payload) : await new Resend(process.env.RESEND_API_KEY).emails.send(payload);
    await logEmailSent({ emailType, recipient: recipients[0], status: 'sent', relatedEntityId: recipients[0] }).catch(() => {});
    return { ok: true, id: result?.data?.id };
  } catch (err) {
    console.error(`[donation-mail] ${emailType} failed:`, err.message);
    await logEmailSent({ emailType, recipient: recipients[0], status: 'failed', relatedEntityId: recipients[0] }).catch(() => {});
    return { ok: false, error: err.message };
  }
}

const hi = async (email) => `${(await getUser(email).catch(() => null))?.displayName || 'ご参加者'} 様`;
const baseUrl = (b) => (b ? `${b}/haku-community/home/#point` : null);

// 同じ申請・同じ種類は1回だけ送る。失敗しても、記録は残る。
async function once(req, type, build) {
  try {
    if (!(await claimMail(req.id, type))) return { ok: true, skipped: 'duplicate' };
    const r = await deliver(await build());
    await noteMail(req.id, type, r.ok).catch(() => {});
    return r;
  } catch (err) { console.error('[donation-mail] failed:', err.message); return { ok: false, error: err.message }; }
}

export const donationMail = {
  received: (req, { baseUrl: b } = {}) => once(req, 'received', async () => ({
    emailType: 'donation_received', to: req.email, subject: `【${LABEL}】ポイント利用の申請を受け付けました`,
    lines: [await hi(req.email), '', 'HAKUポイントの利用（社会貢献）の申請を受け付けました。', `申請ID：${req.id}`, `支援先：${req.causeName}`, `利用ポイント：${req.points.toLocaleString('ja-JP')} pt`, '', '運営が内容を確認します。結果は、あらためてメールでお知らせします。申請したポイントは、確認が終わるまで確保されます。'],
    cta: baseUrl(b) ? { label: '申請の状況を見る', url: baseUrl(b) } : null,
  })),
  adminNew: (req, { baseUrl: b } = {}) => once(req, 'admin_new', async () => ({
    emailType: 'donation_admin_new', to: adminRecipients(), subject: `【${LABEL}】ポイント利用の新しい申請があります`,
    lines: ['HAKUポイントの利用（社会貢献）の新しい申請がありました。', '', `申請ID：${req.id}`, `会員：${req.memberName || ''}（${req.email}）`, `支援先：${req.causeName}`, `利用ポイント：${req.points.toLocaleString('ja-JP')} pt`, '', '管理画面の「HAKU Community運営 › ポイント｜利用申請管理」から、内容をご確認ください。'],
    cta: b ? { label: '管理画面を開く', url: `${b}/haku-community/admin/` } : null,
  })),
  approved: (req) => once(req, 'approved', async () => ({
    emailType: 'donation_approved', to: req.email, subject: `【${LABEL}】ポイント利用の申請が承認されました`,
    lines: [await hi(req.email), '', 'ポイント利用の申請が承認されました。', `申請ID：${req.id}`, `支援先：${req.causeName}`, `利用ポイント：${req.points.toLocaleString('ja-JP')} pt`, '', `実際の寄付は、${ORG_NAME}が団体名義で行います。実施まで、お時間をいただくことがあります。完了しましたら、あらためてお知らせします。`],
  })),
  rejected: (req) => once(req, 'rejected', async () => ({
    emailType: 'donation_rejected', to: req.email, subject: `【${LABEL}】ポイント利用の申請について`,
    lines: [await hi(req.email), '', 'ポイント利用の申請は、今回は見送りとなりました。', `申請ID：${req.id}`, '', '確保していたポイントは、元に戻っています。ご不明な点は、運営までお問い合わせください。'],
  })),
  completed: (req) => once(req, 'completed', async () => ({
    emailType: 'donation_completed', to: req.email, subject: `【${LABEL}】寄付が完了しました`,
    lines: [await hi(req.email), '', 'ポイント利用の申請にもとづく寄付が完了しました。', `申請ID：${req.id}`, `支援先：${req.causeName}`, `利用ポイント：${req.points.toLocaleString('ja-JP')} pt`, '', `${ORG_NAME}が、団体名義で寄付を行いました。あなたの積み重ねに、心から感謝いたします。`],
  })),
};
export { STATUS_LABEL };

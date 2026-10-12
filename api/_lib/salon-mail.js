/**
 * api/_lib/salon-mail.js
 * 教育者のサロン「灯」専用の取引メール（申請受付・運営への通知・承認／お支払い案内・却下・利用開始・支払い失敗・解約予約・終了）。
 * HAKU Communityのメールテンプレート（api/_lib/notify.js）には触れない。文面・遷移先・配色は灯専用。
 *
 * 共通の約束（notify.js と同じ）：
 *   - 送信に失敗しても例外を投げない（申請・決済の状態は先に保存済みで、メールの失敗で巻き戻さない）
 *   - 成否を EmailLog へ記録する（awaitして記録する）
 * テストでは hooks を差し替えて、実際には送信しない。
 */
import { Resend } from 'resend';
import { escapeHtml } from './security.js';
import { logEmailSent } from './store.js';

export const LABEL = '教育者のサロン 灯';
export const PRICE_LABEL = '月額2,980円';

const previewNote = () => (process.env.VERCEL_ENV === 'production' ? '' : '※これはテスト環境（Preview）からの送信です。実際の請求は発生していません。');
const fromEmail = () => process.env.FROM_EMAIL || 'info@antagaorana.com';
const adminRecipients = () => (process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',').map((e) => e.trim()).filter(Boolean) : [fromEmail()]);

async function sendMail({ emailType, to, subject, greeting, lines, cta, tone = 'terra' }) {
  const recipients = Array.isArray(to) ? to : [to];
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const note = previewNote();
    const color = tone === 'alert' ? '#9A3B1F' : '#B4552F';
    const text = [greeting, '', ...lines, ...(cta ? ['', `${cta.label}：${cta.url}`] : []), ...(note ? ['', note] : [])].filter((l) => l !== undefined).join('\n');
    const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"></head><body style="margin:0;background:#F6F2E9;font-family:'Yu Gothic','Hiragino Sans',sans-serif"><div style="max-width:520px;margin:0 auto;background:#FFFDF8;border:1px solid #DCD5C5"><div style="background:#1E3A2F;color:#fff;padding:18px 24px;font-size:14px;letter-spacing:.1em">${escapeHtml(LABEL)}</div><div style="padding:26px 24px;color:#2B2926;font-size:14px;line-height:1.9">${greeting ? `<p style="margin:0 0 14px">${escapeHtml(greeting)}</p>` : ''}${lines.map((l) => (l === '' ? '' : `<p style="margin:0 0 12px">${escapeHtml(l)}</p>`)).join('')}${cta ? `<p style="margin:22px 0"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:12px 24px;font-size:13px">${escapeHtml(cta.label)}</a></p>` : ''}${note ? `<p style="margin:0;color:#9A9388;font-size:12px">${escapeHtml(note)}</p>` : ''}</div></div></body></html>`;
    const result = await resend.emails.send({ from: `${LABEL} <${fromEmail()}>`, to: recipients, replyTo: fromEmail(), subject, html, text });
    await logEmailSent({ emailType, recipient: recipients[0], status: 'sent', relatedEntityId: recipients[0] }).catch(() => {});
    return { ok: true, id: result?.data?.id };
  } catch (err) {
    console.error(`[salon-mail] ${emailType} failed:`, err.message);
    await logEmailSent({ emailType, recipient: recipients[0], status: 'failed', relatedEntityId: recipients[0] }).catch(() => {});
    return { ok: false, error: err.message };
  }
}

const hi = (name) => `${name || 'ご参加者'} 様`;

const real = {
  // ② 申請受付（本人宛）。この時点では決済は発生しない
  applicationReceived: ({ email, displayName }) => sendMail({
    emailType: 'salon_application_received', to: email, subject: `【${LABEL}】参加申請を受け付けました`, greeting: hi(displayName),
    lines: [`${LABEL}への参加申請を受け付けました。`, '運営にてお申し込み内容を確認しています。審査の結果は、ご登録のメールアドレスにお送りします。', 'この時点では、お支払いは発生していません。'],
  }),
  // ④ 運営への申請通知
  adminNotice: ({ fullName, displayName, email, referrerName, reason, submittedAt, baseUrl }) => sendMail({
    emailType: 'salon_admin_new_application', to: adminRecipients(), subject: `【${LABEL}】新しい参加申請があります`, greeting: '',
    lines: [`${LABEL}への新しい参加申請がありました。`, '', `氏名: ${fullName}`, `表示名: ${displayName}`, `メールアドレス: ${email}`, `紹介者名: ${referrerName || '(未入力)'}`, `参加理由: ${reason || '(未入力)'}`, `申請日時: ${new Date(submittedAt || Date.now()).toLocaleString('ja-JP')}`, '', '管理画面の「灯サロン運営」→「申請・決済」で、承認または却下してください。'],
    cta: baseUrl ? { label: '管理画面を開く', url: `${baseUrl}/haku-community/admin/` } : null,
  }),
  // ⑥⑦ 承認とお支払いのご案内。checkoutUrl が無い（Stripe側の不調など）ときは、ログイン画面から進むご案内にする
  approved: ({ email, displayName, checkoutUrl, loginUrl }) => sendMail({
    emailType: 'salon_application_approved', to: email, subject: `【${LABEL}】参加申請が承認されました。お支払いのご案内`, greeting: hi(displayName),
    lines: [`${LABEL}への参加申請が承認されました。お待たせいたしました。`, `下記より、${PRICE_LABEL}（毎月自動更新）のお支払い手続きをお願いします。お支払いの確認ができ次第、サロンをご利用いただけます。`, ...(checkoutUrl ? ['お支払い画面の有効期限は24時間です。切れた場合は、ログイン画面からもう一度お進みください。'] : ['お支払い画面へは、ログイン画面からお進みください。'])],
    cta: checkoutUrl ? { label: 'お支払いへ進む', url: checkoutUrl } : { label: 'ログインして、お支払いへ進む', url: loginUrl },
  }),
  rejected: ({ email, displayName }) => sendMail({
    emailType: 'salon_application_rejected', to: email, subject: `【${LABEL}】お申し込み結果のご案内`, greeting: hi(displayName),
    lines: [`${LABEL}へのお申し込みをいただき、ありがとうございました。`, '慎重に検討しました結果、今回は参加を見送らせていただくこととなりました。', 'ご不明な点は、このメールへの返信でお問い合わせください。'],
  }),
  // ⑪ 利用開始（Webhookで決済を確認した直後にだけ送る）
  usageStart: ({ email, displayName, loginUrl, amountLabel }) => sendMail({
    emailType: 'salon_payment_completed', to: email, subject: `【${LABEL}】お支払いを確認しました。ご利用を開始できます`, greeting: hi(displayName),
    lines: [`${LABEL}のお支払いを確認しました。ご利用いただけるようになりました。`, `料金：${amountLabel || PRICE_LABEL}（毎月自動更新）`],
    cta: { label: 'サロンにログインする', url: loginUrl },
  }),
  paymentFailed: ({ email, displayName, loginUrl }) => sendMail({
    emailType: 'salon_payment_failed', to: email, subject: `【${LABEL}】お支払いが確認できませんでした`, greeting: hi(displayName), tone: 'alert',
    lines: [`${LABEL}の更新のお支払いが確認できませんでした。確認できるまで、サロンのご利用を一時的に停止しています。`, 'お支払い方法をご確認ください。ご不明な点は、このメールへの返信でお問い合わせください。'],
    cta: { label: 'ログイン画面を開く', url: loginUrl },
  }),
  cancelScheduled: ({ email, displayName, periodEndLabel }) => sendMail({
    emailType: 'salon_cancellation_scheduled', to: email, subject: `【${LABEL}】退会（解約）を受け付けました`, greeting: hi(displayName),
    lines: [`${LABEL}の退会（解約）を受け付けました。次回以降の自動更新は行われません。`, periodEndLabel ? `${periodEndLabel}まで、引き続きご利用いただけます。` : '現在のお支払い期間が終わるまで、引き続きご利用いただけます。'],
  }),
  ended: ({ email, displayName }) => sendMail({
    emailType: 'salon_membership_ended', to: email, subject: `【${LABEL}】ご利用期間が終了しました`, greeting: hi(displayName),
    lines: [`${LABEL}のご利用期間が終了しました。ご利用ありがとうございました。`],
  }),
  // 運営向け：二重決済・承認前決済など、人の確認が必要なとき
  adminAlert: ({ subject, lines }) => sendMail({ emailType: 'salon_admin_alert', to: adminRecipients(), subject: `【${LABEL}】${subject}`, greeting: '', lines, tone: 'alert' }),
};

// テストで差し替えられるようにする（本番コードは必ずここ経由で呼ぶ）
export const mail = { ...real };
export const realMail = real;

/**
 * lib/notify.js
 * Resend送信のヘルパー。既存 api/haku-stripe-webhook.js の送信方法（from/replyTo/ADMIN_EMAILS）を踏襲。
 *
 * すべての送信関数は sendAndLog() を経由し、
 *   - 失敗しても例外を投げない（呼び出し元の処理・DB状態を絶対に壊さない）
 *   - 成否をEmailLog（emailType/recipient/status/sentAt/relatedEntityId）へ記録する
 * という共通契約を持つ。戻り値は必ず { ok: boolean, id?, error? } の形。
 */
import { Resend } from 'resend';
import { escapeHtml } from './security.js';
import { logEmailSent } from './store.js';

const COMMUNITY_LABEL = { haku: 'HAKU Community', tomoshibi: '教育者のサロン 灯' };

function adminEmails(fromEmail) {
  return process.env.ADMIN_EMAILS
    ? process.env.ADMIN_EMAILS.split(',').map((e) => e.trim()).filter(Boolean)
    : [fromEmail];
}

// 全メール送信の共通契約：失敗を握りつぶし、EmailLogへ記録する。
// EmailLog書き込みは必ずawaitする（awaitしないと、呼び出し元がレスポンスを返した直後に
// Vercelのサーバーレス関数が実行を打ち切り、書き込みが完了しないことがある。
// community-auth.js の lastLoginAt で実際に踏んだのと同じ落とし穴のため、ここでは徹底する）。
async function sendAndLog({ emailType, recipient, relatedEntityId, send }) {
  try {
    const result = await send();
    await logEmailSent({ emailType, recipient, status: 'sent', relatedEntityId }).catch((e) => console.error('[notify] email log write failed:', e.message));
    return { ok: true, id: result?.data?.id };
  } catch (err) {
    console.error(`[notify] ${emailType} send failed:`, err.message);
    await logEmailSent({ emailType, recipient, status: 'failed', relatedEntityId }).catch(() => {});
    return { ok: false, error: err.message };
  }
}

export async function sendPasswordSetupEmail({ community, email, displayName, token, baseUrl, purpose = 'welcome' }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.FROM_EMAIL || 'info@antagaorana.com';
  const label = COMMUNITY_LABEL[community] || community;
  // HAKU Communityの案内メールは /haku-community/ 配下のURLを使う（灯は従来のURL）。
  const setupPath = community === 'haku' ? '/haku-community/set-password/' : '/salon/tomoshibi/set-password/';
  const setupUrl = `${baseUrl}${setupPath}?token=${encodeURIComponent(token)}&community=${encodeURIComponent(community)}`;
  const name = displayName || 'ご参加者';
  const isReset = purpose === 'reset';
  const heading = isReset ? 'パスワード再設定のご案内' : 'パスワード設定のご案内';
  const lead = isReset
    ? 'パスワード再設定のリクエストを受け付けました。以下のボタンより、新しいパスワードを設定してください。'
    : 'ご登録ありがとうございます。以下のボタンより、ログイン用のパスワードを設定してください。';
  const expiryLabel = isReset ? '1時間' : '48時間';
  const buttonLabel = isReset ? 'パスワードを再設定する' : 'パスワードを設定する';
  const subject = isReset ? `【テスト環境】${label} パスワード再設定のご案内` : `【テスト環境】${label} パスワード設定のご案内`;

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f7f3ec;font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif">
<div style="max-width:520px;margin:32px auto;background:#fffdf8;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)">
  <div style="background:#33472f;padding:24px 32px"><p style="color:#fff;font-size:16px;margin:0;letter-spacing:.06em">${escapeHtml(label)}｜${heading}</p></div>
  <div style="padding:32px">
    <p style="font-size:15px;color:#2f3a2f;margin:0 0 18px">${escapeHtml(name)} 様</p>
    <p style="font-size:14px;color:#5c5a4e;line-height:1.9;margin:0 0 24px">${lead}</p>
    <p style="text-align:center;margin:0 0 24px"><a href="${setupUrl}" style="display:inline-block;background:#8c692c;color:#fff;text-decoration:none;padding:14px 28px;font-size:14px;border-radius:4px">${buttonLabel}</a></p>
    <p style="font-size:12px;color:#9a9388;line-height:1.8;margin:0">このリンクの有効期限は${expiryLabel}です。心当たりのない場合は、このメールを破棄してください。<br>※これはテスト環境（Preview）からの送信です。</p>
  </div>
</div>
</body></html>`;

  const text = `${name} 様

${lead}

${setupUrl}

このリンクの有効期限は${expiryLabel}です。心当たりのない場合は、このメールを破棄してください。
※これはテスト環境（Preview）からの送信です。`;

  return sendAndLog({
    emailType: isReset ? 'password_reset' : 'password_setup',
    recipient: email,
    relatedEntityId: email,
    send: () => resend.emails.send({
      from: `${label} <${fromEmail}>`,
      to: [email],
      replyTo: fromEmail,
      subject,
      html,
      text,
    }),
  });
}

export async function sendRejectionEmail({ community, email, displayName }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.FROM_EMAIL || 'info@antagaorana.com';
  const label = COMMUNITY_LABEL[community] || community;
  const name = displayName || 'ご担当者';

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f7f3ec;font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif">
<div style="max-width:520px;margin:32px auto;background:#fffdf8;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)">
  <div style="background:#33472f;padding:24px 32px"><p style="color:#fff;font-size:16px;margin:0;letter-spacing:.06em">${escapeHtml(label)}｜審査結果のご案内</p></div>
  <div style="padding:32px">
    <p style="font-size:15px;color:#2f3a2f;margin:0 0 18px">${escapeHtml(name)} 様</p>
    <p style="font-size:14px;color:#5c5a4e;line-height:1.9;margin:0 0 18px">${escapeHtml(label)}へのお申し込みをいただき、ありがとうございました。慎重に検討させていただきました結果、今回は参加を見送らせていただくこととなりました。</p>
    <p style="font-size:14px;color:#5c5a4e;line-height:1.9;margin:0">ご期待に沿えず申し訳ございません。ご不明な点がございましたら、本メールへの返信にてお問い合わせください。</p>
    <p style="font-size:12px;color:#9a9388;line-height:1.8;margin:24px 0 0">※これはテスト環境（Preview）からの送信です。</p>
  </div>
</div>
</body></html>`;

  const text = `${name} 様

${label}へのお申し込みをいただき、ありがとうございました。
慎重に検討させていただきました結果、今回は参加を見送らせていただくこととなりました。

ご期待に沿えず申し訳ございません。ご不明な点がございましたら、本メールへの返信にてお問い合わせください。

※これはテスト環境（Preview）からの送信です。`;

  return sendAndLog({
    emailType: 'application_rejected',
    recipient: email,
    relatedEntityId: email,
    send: () => resend.emails.send({
      from: `${label} <${fromEmail}>`,
      to: [email],
      replyTo: fromEmail,
      subject: `【${label}】お申し込み結果のご案内`,
      html,
      text,
    }),
  });
}

// 承認通知メール。登録時に既にパスワードを設定済みの前提で、ログイン案内のみを送る
// （パスワード設定リンクは含まない。パスワード未設定のケースは呼び出し側で
// sendPasswordSetupEmail にフォールバックする）。
// ctaUrl/ctaLabel: 呼び出し側（api/admin.js の handleApprove）が、そのApplicationが
// 承認時点で決済済みかどうかで「お支払いへ進む」／「ログインする」のどちらを案内するか判断し、
// 明示的に渡す。省略時（灯など決済不要なコミュニティ）はログイン導線をデフォルトにする
// （後方互換：これまでの呼び出し元を壊さない）。
export async function sendApprovalEmail({ community, email, displayName, baseUrl, ctaUrl, ctaLabel }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.FROM_EMAIL || 'info@antagaorana.com';
  const label = COMMUNITY_LABEL[community] || community;
  const name = displayName || 'ご参加者';
  const finalCtaUrl = ctaUrl || `${baseUrl}${community === 'haku' ? '/haku-community/login/' : '/salon/tomoshibi/login/'}`;
  const finalCtaLabel = ctaLabel || 'ログインする';
  const isPaymentCta = finalCtaLabel !== 'ログインする';
  const lead = isPaymentCta
    ? `${escapeHtml(label)}への参加申請が承認されました。お待たせいたしました。下記より月額2,980円のお支払い手続きをお願いいたします。お支払い完了後、${escapeHtml(label)}をご利用いただけます。`
    : `${escapeHtml(label)}への参加申請が承認されました。ご登録いただいたメールアドレスとパスワードでログインしてください。`;

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f7f3ec;font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif">
<div style="max-width:520px;margin:32px auto;background:#fffdf8;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)">
  <div style="background:#33472f;padding:24px 32px"><p style="color:#fff;font-size:16px;margin:0;letter-spacing:.06em">${escapeHtml(label)}｜参加申請が承認されました</p></div>
  <div style="padding:32px">
    <p style="font-size:15px;color:#2f3a2f;margin:0 0 18px">${escapeHtml(name)} 様</p>
    <p style="font-size:14px;color:#5c5a4e;line-height:1.9;margin:0 0 24px">${lead}</p>
    <p style="text-align:center;margin:0 0 24px"><a href="${finalCtaUrl}" style="display:inline-block;background:#33472f;color:#fff;text-decoration:none;padding:14px 28px;font-size:14px;border-radius:4px">${escapeHtml(finalCtaLabel)}</a></p>
    <p style="font-size:12px;color:#9a9388;line-height:1.8;margin:0">※これはテスト環境（Preview）からの送信です。</p>
  </div>
</div>
</body></html>`;

  const text = `${name} 様

${lead.replace(/<[^>]+>/g, '')}

${finalCtaUrl}

※これはテスト環境（Preview）からの送信です。`;

  return sendAndLog({
    emailType: 'application_approved',
    recipient: email,
    relatedEntityId: email,
    send: () => resend.emails.send({
      from: `${label} <${fromEmail}>`,
      to: [email],
      replyTo: fromEmail,
      subject: `【${label}】参加申請が承認されました`,
      html,
      text,
    }),
  });
}

// HAKU Community管理者アカウントの初回パスワード設定リンク。平文パスワードは
// チャット・コード・ログのどこにも一切現れず、本人のメール受信箱だけに届く。
export async function sendAdminSetupEmail({ email, token, baseUrl }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.FROM_EMAIL || 'info@antagaorana.com';
  const setupUrl = `${baseUrl}/haku-community/admin/set-password/?token=${encodeURIComponent(token)}`;

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f7f3ec;font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif">
<div style="max-width:520px;margin:32px auto;background:#fffdf8;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)">
  <div style="background:#33472f;padding:24px 32px"><p style="color:#fff;font-size:16px;margin:0;letter-spacing:.06em">HAKU Community｜管理者アカウント設定</p></div>
  <div style="padding:32px">
    <p style="font-size:14px;color:#5c5a4e;line-height:1.9;margin:0 0 24px">HAKU Community管理画面の管理者アカウントが作成されました。以下のボタンより、ご自身のパスワードを設定してください。</p>
    <p style="text-align:center;margin:0 0 24px"><a href="${setupUrl}" style="display:inline-block;background:#8c692c;color:#fff;text-decoration:none;padding:14px 28px;font-size:14px;border-radius:4px">パスワードを設定する</a></p>
    <p style="font-size:12px;color:#9a9388;line-height:1.8;margin:0">このリンクの有効期限は48時間です。心当たりのない場合は、このメールを破棄してください。<br>※これはテスト環境（Preview）からの送信です。</p>
  </div>
</div>
</body></html>`;

  const text = `HAKU Community管理画面の管理者アカウントが作成されました。

以下のリンクより、ご自身のパスワードを設定してください。

${setupUrl}

このリンクの有効期限は48時間です。心当たりのない場合は、このメールを破棄してください。
※これはテスト環境（Preview）からの送信です。`;

  return sendAndLog({
    emailType: 'admin_setup',
    recipient: email,
    relatedEntityId: email,
    send: () => resend.emails.send({
      from: `HAKU Community <${fromEmail}>`,
      to: [email],
      replyTo: fromEmail,
      subject: '【テスト環境】HAKU Community 管理者アカウント設定のご案内',
      html,
      text,
    }),
  });
}

export async function notifyAdminOfApplication({ community, fullName, displayName, email, referrerName, reason, submittedAt, baseUrl }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.FROM_EMAIL || 'info@antagaorana.com';
  const label = COMMUNITY_LABEL[community] || community;
  const submittedLabel = submittedAt ? new Date(submittedAt).toLocaleString('ja-JP') : new Date().toLocaleString('ja-JP');
  const adminUrl = baseUrl ? `${baseUrl}/haku-community/admin/` : null;
  const recipients = adminEmails(fromEmail);

  return sendAndLog({
    emailType: 'admin_new_application',
    recipient: recipients[0],
    relatedEntityId: email,
    send: () => resend.emails.send({
      from: `${label} 申請通知 <${fromEmail}>`,
      to: recipients,
      subject: `【${label}】新しい参加申込があります`,
      text: [
        `${label}への新しい参加申込がありました（テスト環境）。`,
        '',
        `氏名: ${fullName}`,
        `表示名: ${displayName}`,
        `メールアドレス: ${email}`,
        `紹介者名: ${referrerName || '(未入力)'}`,
        `参加理由: ${reason || '(未入力)'}`,
        `申込日時: ${submittedLabel}`,
        '',
        '管理画面から内容をご確認ください。',
        adminUrl ? `\n［申込内容を確認する］\n${adminUrl}` : '',
      ].join('\n'),
    }),
  });
}

// ── 参加申請受付メール（Application作成直後、審査中であることを伝える） ──
export async function sendApplicationReceivedEmail({ community = 'haku', email, displayName }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.FROM_EMAIL || 'info@antagaorana.com';
  const label = COMMUNITY_LABEL[community] || community;
  const name = displayName || 'ご参加者';

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f7f3ec;font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif">
<div style="max-width:520px;margin:32px auto;background:#fffdf8;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)">
  <div style="background:#33472f;padding:24px 32px"><p style="color:#fff;font-size:16px;margin:0;letter-spacing:.06em">${escapeHtml(label)}｜参加申請を受け付けました</p></div>
  <div style="padding:32px">
    <p style="font-size:15px;color:#2f3a2f;margin:0 0 18px">${escapeHtml(name)} 様</p>
    <p style="font-size:14px;color:#5c5a4e;line-height:1.9;margin:0 0 18px">${escapeHtml(label)}への参加申請を受け付けました。</p>
    <p style="font-size:14px;color:#5c5a4e;line-height:1.9;margin:0 0 18px">${escapeHtml(label)}は完全紹介制のため、現在、運営にてお申し込み内容を確認しています。審査完了後、ご登録のメールアドレスへ改めてご連絡いたします。</p>
    <p style="font-size:13px;color:#8a5a1f;background:#fffaf0;border-left:3px solid #d8b15a;padding:12px 16px;margin:0 0 18px">※この時点では決済は発生していません。</p>
    <p style="font-size:12px;color:#9a9388;line-height:1.8;margin:0">※これはテスト環境（Preview）からの送信です。</p>
  </div>
</div>
</body></html>`;

  const text = `${name} 様

${label}への参加申請を受け付けました。

${label}は完全紹介制のため、現在、運営にてお申し込み内容を確認しています。
審査完了後、ご登録のメールアドレスへ改めてご連絡いたします。

※この時点では決済は発生していません。

※これはテスト環境（Preview）からの送信です。`;

  return sendAndLog({
    emailType: 'application_received',
    recipient: email,
    relatedEntityId: email,
    send: () => resend.emails.send({
      from: `${label} <${fromEmail}>`,
      to: [email],
      replyTo: fromEmail,
      subject: `【${label}】参加申請を受け付けました`,
      html,
      text,
    }),
  });
}

// ── 決済完了・利用開始メール（Webhookで Application=paid / Membership=active が
//    確定した後にのみ送る。setupUrl（パスワード未設定の旧フロー救済）を渡すと
//    ログインCTAの代わりにパスワード設定CTAを表示する） ──
export async function sendPaymentCompletedEmail({ community = 'haku', email, customerName, amountLabel, baseUrl, setupUrl }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.FROM_EMAIL || 'info@antagaorana.com';
  const label = COMMUNITY_LABEL[community] || community;
  const name = customerName || 'ご参加者';
  const loginUrl = `${baseUrl}/haku-community/login/`;
  const ctaUrl = setupUrl || loginUrl;
  const ctaLabel = setupUrl ? 'パスワードを設定する' : `${label}にログインする`;
  const finalAmountLabel = amountLabel || '2,980円';

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f7f3ec;font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif">
<div style="max-width:520px;margin:32px auto;background:#fffdf8;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)">
  <div style="background:#33472f;padding:24px 32px"><p style="color:#fff;font-size:16px;margin:0;letter-spacing:.06em">${escapeHtml(label)}｜お支払いが完了しました</p></div>
  <div style="padding:32px">
    <p style="font-size:15px;color:#2f3a2f;margin:0 0 18px">${escapeHtml(name)} 様</p>
    <p style="font-size:14px;color:#5c5a4e;line-height:1.9;margin:0 0 24px">${escapeHtml(label)}のお支払いが完了しました。</p>
    <div style="background:#f8f5f0;border-radius:8px;padding:18px 22px;margin-bottom:24px">
      <div style="font-size:12px;color:#8a8574;letter-spacing:.06em;margin-bottom:4px">月額料金</div>
      <div style="font-size:20px;color:#2f3a2f;font-weight:700">${escapeHtml(finalAmountLabel)}（税込）</div>
    </div>
    <p style="font-size:14px;color:#5c5a4e;line-height:1.9;margin:0 0 24px">${escapeHtml(label)}をご利用いただけるようになりました。</p>
    <p style="text-align:center;margin:0 0 24px"><a href="${ctaUrl}" style="display:inline-block;background:#33472f;color:#fff;text-decoration:none;padding:14px 28px;font-size:14px;border-radius:4px">${escapeHtml(ctaLabel)}</a></p>
    <p style="font-size:12px;color:#9a9388;line-height:1.8;margin:0">※このメールはテスト環境からの送信です。実際の請求は発生していません。</p>
  </div>
</div>
</body></html>`;

  const text = `${name} 様

${label}のお支払いが完了しました。

月額料金: ${finalAmountLabel}（税込）

${label}をご利用いただけるようになりました。

${ctaUrl}

※このメールはテスト環境からの送信です。実際の請求は発生していません。`;

  return sendAndLog({
    emailType: 'payment_completed',
    recipient: email,
    relatedEntityId: email,
    send: () => resend.emails.send({
      from: `${label} <${fromEmail}>`,
      to: [email],
      replyTo: fromEmail,
      subject: `【${label}】お支払いが完了しました`,
      html,
      text,
    }),
  });
}

// ── 決済失敗メール（更新決済＝invoice.payment_failed時） ──
export async function sendPaymentFailedEmail({ community = 'haku', email, displayName, baseUrl, portalUrl }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.FROM_EMAIL || 'info@antagaorana.com';
  const label = COMMUNITY_LABEL[community] || community;
  const name = displayName || 'ご参加者';
  const ctaUrl = portalUrl || `${baseUrl}/haku-community/login/`;
  const ctaLabel = 'お支払い方法を確認する';

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f7f3ec;font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif">
<div style="max-width:520px;margin:32px auto;background:#fffdf8;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)">
  <div style="background:#9A3B1F;padding:24px 32px"><p style="color:#fff;font-size:16px;margin:0;letter-spacing:.06em">${escapeHtml(label)}｜お支払い方法をご確認ください</p></div>
  <div style="padding:32px">
    <p style="font-size:15px;color:#2f3a2f;margin:0 0 18px">${escapeHtml(name)} 様</p>
    <p style="font-size:14px;color:#5c5a4e;line-height:1.9;margin:0 0 18px">${escapeHtml(label)}の月額料金について、お支払いを確認できませんでした。</p>
    <p style="font-size:14px;color:#5c5a4e;line-height:1.9;margin:0 0 24px">お手数ですが、お支払い方法をご確認ください。</p>
    <p style="text-align:center;margin:0 0 24px"><a href="${ctaUrl}" style="display:inline-block;background:#9A3B1F;color:#fff;text-decoration:none;padding:14px 28px;font-size:14px;border-radius:4px">${escapeHtml(ctaLabel)}</a></p>
    <p style="font-size:12px;color:#9a9388;line-height:1.8;margin:0">※これはテスト環境（Preview）からの送信です。</p>
  </div>
</div>
</body></html>`;

  const text = `${name} 様

${label}の月額料金について、お支払いを確認できませんでした。
お手数ですが、お支払い方法をご確認ください。

${ctaUrl}

※これはテスト環境（Preview）からの送信です。`;

  return sendAndLog({
    emailType: 'payment_failed',
    recipient: email,
    relatedEntityId: email,
    send: () => resend.emails.send({
      from: `${label} <${fromEmail}>`,
      to: [email],
      replyTo: fromEmail,
      subject: `【${label}】お支払い方法をご確認ください`,
      html,
      text,
    }),
  });
}

// ── 解約完了メール（cancel_at_period_end予約時、または即時解約時） ──
export async function sendCancellationScheduledEmail({ community = 'haku', email, displayName, periodEndLabel, immediate = false }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.FROM_EMAIL || 'info@antagaorana.com';
  const label = COMMUNITY_LABEL[community] || community;
  const name = displayName || 'ご参加者';
  const body = immediate
    ? `${escapeHtml(label)}の解約手続きが完了しました。本日をもってご利用終了となります。`
    : `${escapeHtml(label)}の解約手続きを受け付けました。<br><br>現在のご利用期間：<strong>${escapeHtml(periodEndLabel || '')}まで</strong><br><br>上記日付までは引き続き${escapeHtml(label)}をご利用いただけます。以降の月額料金は発生しません。`;
  const bodyText = immediate
    ? `${label}の解約手続きが完了しました。本日をもってご利用終了となります。`
    : `${label}の解約手続きを受け付けました。

現在のご利用期間: ${periodEndLabel || ''}まで

上記日付までは引き続き${label}をご利用いただけます。以降の月額料金は発生しません。`;

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f7f3ec;font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif">
<div style="max-width:520px;margin:32px auto;background:#fffdf8;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)">
  <div style="background:#33472f;padding:24px 32px"><p style="color:#fff;font-size:16px;margin:0;letter-spacing:.06em">${escapeHtml(label)}｜解約手続きが完了しました</p></div>
  <div style="padding:32px">
    <p style="font-size:15px;color:#2f3a2f;margin:0 0 18px">${escapeHtml(name)} 様</p>
    <p style="font-size:14px;color:#5c5a4e;line-height:1.9;margin:0 0 18px">${body}</p>
    <p style="font-size:12px;color:#9a9388;line-height:1.8;margin:0">※これはテスト環境（Preview）からの送信です。</p>
  </div>
</div>
</body></html>`;

  const text = `${name} 様

${bodyText}

※これはテスト環境（Preview）からの送信です。`;

  return sendAndLog({
    emailType: 'cancellation',
    recipient: email,
    relatedEntityId: email,
    send: () => resend.emails.send({
      from: `${label} <${fromEmail}>`,
      to: [email],
      replyTo: fromEmail,
      subject: `【${label}】解約手続きが完了しました`,
      html,
      text,
    }),
  });
}

// ── メールアドレス変更通知：セキュリティ上、旧アドレス宛に送る（本人以外が変更した場合に
//    気づけるようにするため。ログインIDは新アドレスへ既に切り替わっている） ──
export async function sendEmailChangedEmail({ community = 'haku', oldEmail, newEmail, displayName }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.FROM_EMAIL || 'info@antagaorana.com';
  const label = COMMUNITY_LABEL[community] || community;
  const name = displayName || 'ご参加者';
  const maskedNew = newEmail.replace(/^(.{2}).*(@.*)$/, '$1***$2');

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f7f3ec;font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif">
<div style="max-width:520px;margin:32px auto;background:#fffdf8;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)">
  <div style="background:#33472f;padding:24px 32px"><p style="color:#fff;font-size:16px;margin:0;letter-spacing:.06em">${escapeHtml(label)}｜メールアドレス変更のお知らせ</p></div>
  <div style="padding:32px">
    <p style="font-size:15px;color:#2f3a2f;margin:0 0 18px">${escapeHtml(name)} 様</p>
    <p style="font-size:14px;color:#5c5a4e;line-height:1.9;margin:0 0 18px">
      このメールアドレスに登録されていたログイン用メールアドレスが<br>
      <strong>${escapeHtml(maskedNew)}</strong> へ変更されました。<br><br>
      今後のログインは新しいメールアドレスでお願いいたします。
    </p>
    <p style="font-size:13px;color:#9A3B1F;line-height:1.8;margin:0 0 18px">
      ※このお心当たりがない場合は、第三者による変更の可能性がありますので、
      至急運営までご連絡ください。
    </p>
    <p style="font-size:12px;color:#9a9388;line-height:1.8;margin:0">※これはテスト環境（Preview）からの送信です。</p>
  </div>
</div>
</body></html>`;

  const text = `${name} 様

このメールアドレスに登録されていたログイン用メールアドレスが
${maskedNew} へ変更されました。

今後のログインは新しいメールアドレスでお願いいたします。

※このお心当たりがない場合は、第三者による変更の可能性がありますので、
至急運営までご連絡ください。

※これはテスト環境（Preview）からの送信です。`;

  return sendAndLog({
    emailType: 'email_changed',
    recipient: oldEmail,
    relatedEntityId: newEmail,
    send: () => resend.emails.send({
      from: `${label} <${fromEmail}>`,
      to: [oldEmail],
      replyTo: fromEmail,
      subject: `【${label}】メールアドレスが変更されました`,
      html,
      text,
    }),
  });
}

// ── 灯サロンの通知（メール）。本文には投稿の内容を入れない（リンクだけ）。失敗しても例外を投げない ──
const SALON_PREVIEW_NOTE = () => (process.env.VERCEL_ENV === 'production' ? '' : '※これはテスト環境（Preview）からの送信です。');
async function sendSalonMail({ emailType, email, subject, lines, url, urlLabel }) {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const fromEmail = process.env.FROM_EMAIL || 'info@antagaorana.com';
    const note = SALON_PREVIEW_NOTE();
    const text = [...lines, '', `${urlLabel}：${url}`, '', 'このメールの通知は、サロンの「設定」からいつでも止められます。', note].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
    const html = `<!DOCTYPE html><html lang="ja"><body style="margin:0;background:#F6F2E9;font-family:'Yu Gothic',sans-serif"><div style="max-width:520px;margin:0 auto;background:#FFFDF8;border:1px solid #DCD5C5"><div style="background:#1E3A2F;color:#fff;padding:18px 24px;font-size:14px;letter-spacing:.1em">教育者のサロン 灯</div><div style="padding:26px 24px;color:#2B2926;font-size:14px;line-height:1.9">${lines.map((l) => `<p style="margin:0 0 12px">${escapeHtml(l)}</p>`).join('')}<p style="margin:22px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#B4552F;color:#fff;text-decoration:none;padding:12px 24px;font-size:13px">${escapeHtml(urlLabel)}</a></p><p style="margin:0;color:#9A9388;font-size:12px">このメールの通知は、サロンの「設定」からいつでも止められます。${note ? '<br>' + escapeHtml(note) : ''}</p></div></div></body></html>`;
    return await sendAndLog({
      emailType, recipient: email, relatedEntityId: email,
      send: () => resend.emails.send({ from: `教育者のサロン 灯 <${fromEmail}>`, to: [email], replyTo: fromEmail, subject, html, text }),
    });
  } catch (err) {
    console.error(`[notify] ${emailType} setup failed:`, err.message);
    return { ok: false, error: err.message };
  }
}
export function sendSalonReplyEmail({ email, url }) {
  return sendSalonMail({ emailType: 'salon_reply', email, subject: '【灯】あなたの投稿に、運営から返信がつきました', lines: ['あなたの投稿に、運営から返信がつきました。'], url, urlLabel: 'サロンで読む' });
}
export function sendSalonReminderEmail({ email, eventTitle, whenLabel, url }) {
  return sendSalonMail({ emailType: 'salon_reminder', email, subject: `【灯】明日は「${eventTitle}」です`, lines: [`明日、「${eventTitle}」があります。`, whenLabel], url, urlLabel: 'サロンで確認する' });
}

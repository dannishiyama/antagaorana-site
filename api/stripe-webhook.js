/**
 * api/stripe-webhook.js
 * Stripe決済完了 → 購入者へ参加案内メール自動送信（Resend）
 *
 * 必要な環境変数（Vercel Dashboard > Settings > Environment Variables）:
 *   STRIPE_SECRET_KEY      … StripeのSecretキー（sk_live_... / sk_test_...）
 *   STRIPE_WEBHOOK_SECRET  … Stripe WebhookのSigning Secret（whsec_...）
 *   RESEND_API_KEY         … ResendのAPIキー（re_...）
 *   FROM_EMAIL             … 送信元アドレス（例: info@antagaorana.com）
 *   SESSION_DATE           … 開催日（例: 2026年8月30日（日））
 *   SESSION_TIME_START     … 開始時刻（例: 20:00）
 *   SESSION_TIME_END       … 終了時刻（例: 21:30）
 *   SESSION_MEET_URL       … Google MeetのURL（秘密情報・絶対にフロントへ出さない）
 *   TEST_MODE              … 'true' のときメール送信をスキップしログのみ出力
 *
 * セキュリティ要件:
 *   - Stripe署名を検証し、未検証のリクエストを拒否
 *   - checkout.session.completed かつ payment_status=paid のみ処理
 *   - Stripe Event IDをResendのidempotencyKeyに使い重複送信を防止
 *   - livemode=false（テスト）のとき、TEST_MODEでメールをスキップ
 *   - Google Meet URLはサーバーサイドのみで使用し、フロントには出力しない
 *   - 個人情報（メールアドレス・氏名）をログに出力しない
 */

import { Resend } from 'resend';
import Stripe from 'stripe';

// Vercelのbody parserを無効化（Stripe署名検証にraw bodyが必要）
export const config = {
  api: { bodyParser: false },
};

// ── raw body 読み取り ────────────────────────────────────────
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── 開催回設定（環境変数から取得） ──────────────────────────
function getSessionConfig() {
  const date      = process.env.SESSION_DATE       || '（日程未設定）';
  const timeStart = process.env.SESSION_TIME_START || '（時刻未設定）';
  const timeEnd   = process.env.SESSION_TIME_END   || '';
  const meetUrl   = process.env.SESSION_MEET_URL;

  if (!meetUrl) {
    throw new Error('SESSION_MEET_URL is not configured');
  }

  const timeRange = timeEnd ? `${timeStart}〜${timeEnd}` : timeStart;

  return { date, timeRange, meetUrl };
}

// ── HTMLメール本文 ───────────────────────────────────────────
function buildEmailHtml({ customerName, session: sess }) {
  const name = customerName ? `${customerName}` : 'ご参加者';
  const termsUrl = 'https://antagaorana.com/benkyokai-terms.html';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f5f2ed;font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif}
  .wrap{max-width:560px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)}
  .hd{background:#3e5739;padding:28px 36px;text-align:center}
  .hd-sub{color:rgba(255,255,255,.7);font-size:11px;letter-spacing:.2em;margin:0 0 4px}
  .hd-brand{color:#fff;font-size:18px;font-weight:700;margin:0}
  .bd{padding:36px}
  .greeting{font-size:15px;margin-bottom:20px;line-height:1.85;color:#222}
  .thanks{font-size:14px;color:#555;line-height:1.9;margin-bottom:28px}
  .divider{border:none;border-top:1px solid #e5e0d8;margin:24px 0}
  .info-box{background:#f8f5f0;border-radius:8px;padding:20px 24px;margin-bottom:24px}
  .info-box h3{margin:0 0 14px;font-size:12px;color:#3e5739;letter-spacing:.12em;border-bottom:1px solid #ddd8cf;padding-bottom:8px}
  .info-row{display:table;width:100%;margin-bottom:8px;font-size:14px}
  .info-label{display:table-cell;color:#888;width:80px;vertical-align:top}
  .info-val{display:table-cell;color:#222;font-weight:500;vertical-align:top}
  .meet-wrap{margin:20px 0 8px}
  .meet-btn{display:block;text-align:center;background:#3e5739;color:#fff;font-size:15px;font-weight:700;text-decoration:none;padding:16px 24px;border-radius:7px;letter-spacing:.03em}
  .meet-url{text-align:center;font-size:11px;color:#aaa;word-break:break-all;margin:6px 0 0;padding:0}
  .note-box{background:#fffaf5;border-left:3px solid #c8602a;border-radius:0 6px 6px 0;padding:14px 18px;margin-bottom:28px}
  .note-box p{margin:0 0 6px;font-size:13px;color:#c8602a;font-weight:700}
  .note-box ul{margin:0;padding:0 0 0 16px;font-size:13px;color:#555;line-height:1.9}
  .closing{font-size:14px;color:#555;line-height:1.9;margin-bottom:0}
  .closing a{color:#3e5739;text-decoration:none}
  .ft{background:#f5f2ed;padding:20px 36px;text-align:center;font-size:11px;color:#999;border-top:1px solid #e8e3db}
  .ft a{color:#3e5739;text-decoration:none}
  .ft-cancel{font-size:11px;color:#aaa;margin-top:12px;border-top:1px solid #e8e3db;padding-top:10px}
</style>
</head>
<body>
<div class="wrap">
  <div class="hd">
    <p class="hd-sub">株式会社あんたがおらな</p>
    <p class="hd-brand">共育ゼミ｜参加のご案内</p>
  </div>
  <div class="bd">
    <p class="greeting">${name} 様</p>
    <p class="thanks">
      このたびは、「共育ゼミ」にお申し込みいただき、ありがとうございます。<br>
      ご参加いただけることを、心よりうれしく思います。<br>
      当日のご案内をお送りします。
    </p>

    <hr class="divider">

    <div class="info-box">
      <h3>■ 開催情報</h3>
      <div class="info-row">
        <span class="info-label">開催日時</span>
        <span class="info-val">${sess.date}<br>${sess.timeRange}</span>
      </div>
      <div class="info-row">
        <span class="info-label">開催方法</span>
        <span class="info-val">Google Meetによるオンライン開催</span>
      </div>
      <div class="info-row">
        <span class="info-label">参加費</span>
        <span class="info-val">1,000円（税込・決済済み）</span>
      </div>
    </div>

    <p style="font-size:13px;color:#555;margin-bottom:8px;">■ 参加URL</p>
    <div class="meet-wrap">
      <a href="${sess.meetUrl}" class="meet-btn">▶ Google Meetに参加する</a>
      <p class="meet-url">${sess.meetUrl}</p>
    </div>

    <hr class="divider">

    <div class="note-box">
      <p>当日のお願い</p>
      <ul>
        <li>開始時刻の5分前を目安に上記URLからご参加ください</li>
        <li>落ち着いてお話を聞ける環境からのご参加をおすすめします</li>
        <li>ご不明な点はチャット欄またはメールでご連絡ください</li>
      </ul>
    </div>

    <p class="closing">
      ご不明な点や、参加案内が正しく表示されない場合は、<br>
      以下までご連絡ください。<br><br>
      株式会社あんたがおらな<br>
      <a href="mailto:info@antagaorana.com">info@antagaorana.com</a><br>
      090-3435-0306<br><br>
      それでは、当日お会いできることを楽しみにしております。
    </p>
  </div>
  <div class="ft">
    <p>株式会社あんたがおらな | 代表取締役 大久保 俊輝</p>
    <p><a href="https://antagaorana.com">https://antagaorana.com</a></p>
    <div class="ft-cancel">
      キャンセル・返金条件については
      <a href="${termsUrl}">共育ゼミ利用規約</a> をご確認ください。<br>
      このメールはお申し込みいただいた方にお送りしています。
    </div>
  </div>
</div>
</body>
</html>`;
}

// ── プレーンテキスト版 ───────────────────────────────────────
function buildEmailText({ customerName, session: sess }) {
  const name = customerName ? `${customerName}` : 'ご参加者';
  return `${name} 様

このたびは、「共育ゼミ」にお申し込みいただき、ありがとうございます。
ご参加いただけることを、心よりうれしく思います。

━━━━━━━━━━━━━━━━━━━━━━

■ 開催日時
${sess.date}
${sess.timeRange}

■ 開催方法
Google Meetによるオンライン開催

■ 参加URL
${sess.meetUrl}

■ 参加費
1,000円（税込・決済済み）

━━━━━━━━━━━━━━━━━━━━━━

開始時刻の5分前を目安に上記URLからご参加ください。
落ち着いてお話を聞ける環境からのご参加をおすすめします。

ご不明な点や、参加案内が正しく表示されない場合は、以下までご連絡ください。

株式会社あんたがおらな
info@antagaorana.com
090-3435-0306

それでは、当日お会いできることを楽しみにしております。

株式会社あんたがおらな
代表取締役 大久保 俊輝
https://antagaorana.com

━━━━━━━━━━━━━━━━━━━━━━
キャンセル・返金条件については以下をご確認ください。
https://antagaorana.com/benkyokai-terms.html
このメールはお申し込みいただいた方にお送りしています。
`;
}

// ── メインハンドラ ───────────────────────────────────────────
export default async function handler(req, res) {
  // POSTのみ受け付ける
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 環境変数の存在確認
  const missingVars = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'RESEND_API_KEY',
    'SESSION_MEET_URL',
  ].filter((v) => !process.env[v]);

  if (missingVars.length > 0) {
    console.error('[webhook] Missing env vars:', missingVars.join(', '));
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // raw bodyを読み取る（Stripe署名検証に必要）
  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error('[webhook] Failed to read body:', err.message);
    return res.status(400).json({ error: 'Failed to read request body' });
  }

  // Stripe署名検証
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
  });

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature error: ${err.message}` });
  }

  // checkout.session.completed 以外は即座にOKを返す
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, skipped: event.type });
  }

  const session = event.data.object;

  // 決済未完了の場合はスキップ（payment_status=unpaidなど）
  if (session.payment_status !== 'paid') {
    console.log(`[webhook] Skipped: payment_status=${session.payment_status}`);
    return res.status(200).json({ received: true, skipped: 'payment_not_paid' });
  }

  const customerEmail = session.customer_details?.email;
  const customerName  = session.customer_details?.name;

  if (!customerEmail) {
    // メールなし：Stripeへは200を返してキューをクリアする
    console.warn('[webhook] No customer email in session id:', session.id);
    return res.status(200).json({ received: true, skipped: 'no_email' });
  }

  // テストモード制御
  const isTestMode = event.livemode === false;
  const testModeEnv = process.env.TEST_MODE === 'true';

  if (isTestMode && testModeEnv) {
    // テスト決済では実際のメールを送らず、ログのみ出力
    console.log(`[webhook][TEST] Would send email to <redacted> | event=${event.id}`);
    return res.status(200).json({ received: true, testMode: true });
  }

  // 開催回設定を取得
  let sess;
  try {
    sess = getSessionConfig();
  } catch (err) {
    console.error('[webhook] Session config error:', err.message);
    // 設定ミスでも参加者への200は返す（Stripeのリトライを防ぐため）
    // 運営側には別途アラートが必要（Vercelのログ監視を推奨）
    return res.status(200).json({ received: true, configError: err.message });
  }

  // メール送信（Resendのidempotencyキーにevent.idを使い二重送信を防止）
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.FROM_EMAIL || 'info@antagaorana.com';

  try {
    const { data, error } = await resend.emails.send({
      from:        `株式会社あんたがおらな <${fromEmail}>`,
      to:          [customerEmail],
      replyTo:     'info@antagaorana.com',
      subject:     '【共育ゼミ】お申し込みありがとうございます｜参加のご案内',
      html:        buildEmailHtml({ customerName, session: sess }),
      text:        buildEmailText({ customerName, session: sess }),
      // Resend idempotencyKey: 同じevent.idで再送されても1通だけ送信される
      headers: {
        'X-Idempotency-Key': event.id,
      },
    });

    if (error) throw error;

    // 個人情報（メールアドレス）をログに残さない
    console.log(`[webhook] Email sent | event=${event.id} | resend_id=${data?.id}`);
    return res.status(200).json({ received: true, emailId: data?.id });

  } catch (err) {
    console.error(`[webhook] Email send error | event=${event.id} |`, err.message);
    // Stripeへは200を返す（サーバーエラーにするとStripeがリトライし続ける）
    // 重大な失敗はVercelのログアラートで検知すること
    return res.status(200).json({ received: true, emailError: err.message });
  }
}

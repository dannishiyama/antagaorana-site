// api/stripe-webhook.js
// Stripe 決済完了 → 購入者へ自動メール送信
//
// 必要な環境変数（Vercel Dashboard > Settings > Environment Variables）:
//   STRIPE_WEBHOOK_SECRET  … Stripe Webhook の署名シークレット
//   RESEND_API_KEY         … Resend の API キー

import { Resend } from 'resend';
import Stripe from 'stripe';

const resend = new Resend(process.env.RESEND_API_KEY);

// ── イベントごとの設定 ─────────────────────────────────────────
// 複数の勉強会を管理する場合はここに追加
const EVENTS = {
  // Stripe Price ID → イベント情報
  // ※ Stripe Dashboard > 商品 > 価格ID を確認してここに貼る
  default: {
    title: '共育ゼミ',
    date: '2026年8月30日（日）午後8:00〜9:30',
    meetUrl: 'https://meet.google.com/ktf-gvtt-sok',
  },
};

// ── メール本文（HTML） ────────────────────────────────────────
function buildEmailHtml({ customerName, event }) {
  const name = customerName || 'ご参加の皆様';
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { margin:0; padding:0; background:#f5f2ed; font-family: 'Hiragino Sans','Hiragino Kaku Gothic ProN',sans-serif; }
  .wrap { max-width:560px; margin:40px auto; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,.08); }
  .header { background:#3a5e3a; padding:32px 40px; text-align:center; }
  .header-title { color:#fff; font-size:13px; letter-spacing:.2em; margin:0 0 6px; }
  .header-brand { color:#fff; font-size:22px; font-weight:700; margin:0; }
  .body { padding:40px; color:#333; }
  .greeting { font-size:15px; margin-bottom:24px; line-height:1.8; }
  .thanks { font-size:14px; color:#555; line-height:1.9; margin-bottom:32px; }
  .info-box { background:#f5f2ed; border-radius:10px; padding:24px 28px; margin-bottom:32px; }
  .info-box h3 { margin:0 0 16px; font-size:13px; color:#3a5e3a; letter-spacing:.1em; border-bottom:1px solid #d4cfc9; padding-bottom:10px; }
  .info-row { display:flex; gap:12px; margin-bottom:10px; font-size:14px; }
  .info-label { color:#888; white-space:nowrap; min-width:56px; }
  .info-val { color:#333; font-weight:500; }
  .meet-btn { display:block; text-align:center; background:#3a5e3a; color:#fff; font-size:15px; font-weight:700; text-decoration:none; padding:18px 24px; border-radius:8px; margin:24px 0 8px; letter-spacing:.04em; }
  .meet-url { text-align:center; font-size:11px; color:#aaa; word-break:break-all; margin-bottom:0; }
  .notes { background:#fff8f4; border-left:3px solid #c8602a; border-radius:0 8px 8px 0; padding:16px 20px; margin-bottom:32px; }
  .notes h4 { margin:0 0 10px; font-size:13px; color:#c8602a; }
  .notes ul { margin:0; padding:0 0 0 18px; font-size:13px; color:#555; line-height:1.9; }
  .footer { background:#f5f2ed; padding:24px 40px; text-align:center; font-size:12px; color:#888; border-top:1px solid #e8e3db; }
  .footer a { color:#3a5e3a; text-decoration:none; }
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <p class="header-title">教育支援団体</p>
    <p class="header-brand">あんたがおらな</p>
  </div>
  <div class="body">
    <p class="greeting">${name} 様</p>
    <p class="thanks">
      このたびは「あんたがおらな｜${event.title}」にお申し込みいただき、<br>
      誠にありがとうございます。<br><br>
      当日の参加情報をお送りします。
    </p>

    <div class="info-box">
      <h3>■ 開催情報</h3>
      <div class="info-row">
        <span class="info-label">日　時</span>
        <span class="info-val">${event.date}</span>
      </div>
      <div class="info-row">
        <span class="info-label">参加方法</span>
        <span class="info-val">オンライン（Google Meet）</span>
      </div>
    </div>

    <a href="${event.meetUrl}" class="meet-btn">
      ▶ Google Meet に参加する
    </a>
    <p class="meet-url">${event.meetUrl}</p>

    <br>

    <div class="notes">
      <h4>当日のお願い</h4>
      <ul>
        <li>開始5分前を目安にリンクからご入室ください</li>
        <li>カメラ・マイクのご準備をお願いします（任意）</li>
        <li>ご質問はチャット欄でも受け付けます</li>
      </ul>
    </div>

    <p style="font-size:14px;color:#555;line-height:1.9;">
      ご不明な点は、このメールにご返信いただくか、<br>
      <a href="mailto:info@antagaorana.com" style="color:#3a5e3a;">info@antagaorana.com</a> までご連絡ください。<br><br>
      当日、ご一緒できることを楽しみにしております。
    </p>
  </div>
  <div class="footer">
    <p>教育支援団体 あんたがおらな｜代表 大久保 俊輝</p>
    <p><a href="https://antagaorana.com">antagaorana.com</a></p>
    <p style="margin-top:8px;font-size:11px;color:#bbb;">
      このメールはお申し込みいただいた方にお送りしています。
    </p>
  </div>
</div>
</body>
</html>`;
}

// ── メイン Webhook ハンドラ ──────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Stripe 署名検証
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // 決済完了イベントのみ処理
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;
  const customerEmail = session.customer_details?.email;
  const customerName  = session.customer_details?.name;

  if (!customerEmail) {
    console.warn('No customer email found in session:', session.id);
    return res.status(200).json({ received: true });
  }

  // イベント情報を取得（Price ID で判別、なければ default）
  const priceId = session.line_items?.data?.[0]?.price?.id;
  const eventInfo = EVENTS[priceId] ?? EVENTS.default;

  // メール送信
  try {
    const { data, error } = await resend.emails.send({
      from: 'あんたがおらな <info@antagaorana.com>',
      to:   [customerEmail],
      subject: `【${eventInfo.title}】ご参加ありがとうございます｜当日のGoogle Meetリンクをお送りします`,
      html: buildEmailHtml({ customerName, event: eventInfo }),
      replyTo: 'info@antagaorana.com',
    });

    if (error) throw error;

    console.log(`Email sent to ${customerEmail} (Resend ID: ${data.id})`);
    return res.status(200).json({ received: true, emailId: data.id });

  } catch (err) {
    console.error('Email send error:', err);
    // メール失敗でも Stripe には 200 を返す（再送防止）
    return res.status(200).json({ received: true, emailError: err.message });
  }
}

// raw body を読み取るユーティリティ（Stripe 署名検証に必要）
async function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Vercel がデフォルトで body を parse しないよう設定
export const config = {
  api: { bodyParser: false },
};

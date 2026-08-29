/**
 * api/stripe-webhook.js
 * Stripe決済完了 → Supabase申込登録 → Resend案内メール送信
 *
 * V1 設計方針:
 *   Stripe    = 決済情報の正本
 *   Supabase  = 申込・メール送信状態・返金・振替の正本
 *   Resend    = メール送信のみ
 *
 * 冪等性:
 *   - DB: stripe_event_id の UNIQUE 制約で二重登録を防ぐ
 *   - メール: email_status='sent' の確認で二重送信を防ぐ
 *   - Resend: X-Idempotency-Key: event.id でさらに保護
 *
 * エラー処理:
 *   - Supabaseエラー → 500 返却（Stripeが再試行）+ 管理者通知
 *   - Resend失敗    → DB に email_status='failed' を記録 + 管理者通知 + 500 返却
 *   - 再試行時      → email_status を確認し 'sent' なら絶対に再送しない
 *
 * 必要な環境変数（Vercel Dashboard > Settings > Environment Variables）:
 *   STRIPE_SECRET_KEY          sk_live_... / sk_test_...
 *   STRIPE_WEBHOOK_SECRET      whsec_...
 *   RESEND_API_KEY             re_...
 *   FROM_EMAIL                 info@antagaorana.com
 *   SUPABASE_URL               https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  service_role secret key（絶対にフロントへ出さない）
 *   SESSION_DATE               例: 2026年8月30日（日）
 *   SESSION_TIME_START         例: 20:00
 *   SESSION_TIME_END           例: 21:30
 *   SESSION_MEET_URL           Google Meet URL（絶対にGit・フロントへ出さない）
 *   TEST_MODE                  'true' でメール送信をスキップ
 *
 * セキュリティ要件:
 *   - Stripe署名を検証し、未検証リクエストを拒否
 *   - checkout.session.completed かつ payment_status=paid のみ処理
 *   - SUPABASE_SERVICE_ROLE_KEY はサーバーサイドのみで使用
 *   - Google Meet URL はサーバーサイドのみで使用
 *   - 個人情報（メール・氏名）をログに出力しない
 */

import { Resend } from 'resend';
import crypto from 'node:crypto';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Vercelのbody parserを無効化（Stripe署名検証にraw bodyが必要）
export const config = {
  api: { bodyParser: false },
};

// ── Supabase クライアント（サービスロールキー = サーバーサイド専用） ──
function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

// ── raw body 読み取り（Stripe署名検証に必要） ──────────────────────
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── 開催回設定（環境変数から取得） ────────────────────────────────
function getSessionConfig() {
  const date      = process.env.SESSION_DATE       || '（日程未設定）';
  const timeStart = process.env.SESSION_TIME_START || '（時刻未設定）';
  const timeEnd   = process.env.SESSION_TIME_END   || '';
  const meetUrl   = process.env.SESSION_MEET_URL;

  if (!meetUrl) {
    throw new Error('SESSION_MEET_URL is not configured');
  }

  const timeRange = timeEnd ? `${timeStart}〜${timeEnd}` : timeStart;

  // 前日リマインド送信日時を計算（SESSION_DATE_ISO: "2026-08-30" 形式）
  // 前日の朝9時JST = 前日の 00:00 UTC
  let reminderScheduledAt = null;
  const dateIso = process.env.SESSION_DATE_ISO; // 例: "2026-08-30"
  if (dateIso && /^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
    // イベント日の前日 09:00 JST = 前日 00:00 UTC
    const eventDate = new Date(`${dateIso}T00:00:00+09:00`);
    const reminderDate = new Date(eventDate.getTime() - 24 * 60 * 60 * 1000);
    reminderDate.setUTCHours(0, 0, 0, 0); // 前日00:00 UTC = 前日09:00 JST
    const now = new Date();
    // リマインド予定日時が未来の場合のみスケジュール
    if (reminderDate > now) {
      reminderScheduledAt = reminderDate.toISOString();
    }
  }

  return { date, timeRange, meetUrl, reminderScheduledAt };
}

// ── 管理者へのエラー通知（Resendでメール送信） ─────────────────────
// 失敗しても握りつぶす（通知失敗でメイン処理を止めない）
async function notifyAdmin(resend, fromEmail, subject, body) {
  try {
    await resend.emails.send({
      from:    `共育ゼミ自動通知 <${fromEmail}>`,
      to:      [fromEmail],
      subject: `【共育ゼミ決済処理エラー】${subject}`,
      text:    [
        'このメールは共育ゼミ決済処理の自動エラー通知です。',
        '',
        body,
        '',
        '---',
        'Supabase Dashboard > benkyokai_registrations テーブルを確認してください。',
        `https://supabase.com/dashboard`,
      ].join('\n'),
    });
  } catch (e) {
    // 管理者通知自体の失敗はログのみ（Vercelで確認する）
    console.error('[webhook] Admin notification failed:', e.message);
  }
}

// ── HTMLメール本文 ───────────────────────────────────────────────
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
  .greeting{font-size:16px;margin-bottom:20px;line-height:1.85;color:#222;font-weight:700}
  .thanks{font-size:15px;color:#444;line-height:2;margin-bottom:28px}
  .divider{border:none;border-top:1px solid #e5e0d8;margin:24px 0}
  .info-box{background:#f8f5f0;border-radius:8px;padding:20px 24px;margin-bottom:24px}
  .info-box h3{margin:0 0 14px;font-size:13px;color:#3e5739;letter-spacing:.1em;border-bottom:1px solid #ddd8cf;padding-bottom:8px;font-weight:700}
  .info-row{display:table;width:100%;margin-bottom:10px;font-size:15px}
  .info-label{display:table-cell;color:#888;width:90px;vertical-align:top}
  .info-val{display:table-cell;color:#222;font-weight:600;vertical-align:top}
  .steps-box{background:#f0f6f0;border-radius:8px;padding:20px 24px;margin-bottom:24px}
  .steps-box h3{margin:0 0 16px;font-size:13px;color:#3e5739;letter-spacing:.1em;border-bottom:1px solid #c8ddc8;padding-bottom:8px;font-weight:700}
  .step{display:flex;align-items:flex-start;margin-bottom:14px;font-size:14px;line-height:1.8}
  .step-num{flex-shrink:0;width:28px;height:28px;background:#3e5739;color:#fff;border-radius:50%;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-right:12px;margin-top:2px}
  .step-text{color:#333}
  .step-text strong{color:#3e5739;display:block;margin-bottom:2px}
  .meet-wrap{margin:20px 0 8px}
  .meet-btn{display:block;text-align:center;background:#3e5739;color:#fff !important;font-size:16px;font-weight:700;text-decoration:none;padding:18px 24px;border-radius:7px;letter-spacing:.03em}
  .meet-url{text-align:center;font-size:12px;color:#aaa;word-break:break-all;margin:8px 0 0;padding:0}
  .note-box{background:#fffaf5;border-left:3px solid #c8602a;border-radius:0 6px 6px 0;padding:16px 18px;margin-bottom:28px}
  .note-box p{margin:0 0 8px;font-size:14px;color:#c8602a;font-weight:700}
  .note-box ul{margin:0;padding:0 0 0 18px;font-size:14px;color:#555;line-height:2}
  .closing{font-size:14px;color:#555;line-height:2;margin-bottom:0}
  .closing a{color:#3e5739;text-decoration:none}
  .ft{background:#f5f2ed;padding:20px 36px;text-align:center;font-size:11px;color:#999;border-top:1px solid #e8e3db}
  .ft a{color:#3e5739;text-decoration:none}
  .ft-cancel{font-size:11px;color:#aaa;margin-top:12px;border-top:1px solid #e8e3db;padding-top:10px}
</style>
</head>
<body>
<div class="wrap">
  <div class="hd">
    <p class="hd-sub">教育支援団体 あんたがおらな</p>
    <p class="hd-brand">共育ゼミ｜参加のご案内</p>
  </div>
  <div class="bd">
    <p class="greeting">${name} 様</p>
    <p class="thanks">
      このたびは、「共育ゼミ」にお申し込みいただき、<br>
      ありがとうございます。<br><br>
      お支払いが完了しました。<br>
      当日のご参加方法をご案内いたします。<br>
      どうぞ最後までお読みください。
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
        <span class="info-val">オンライン（スマホ・パソコンから参加できます）</span>
      </div>
      <div class="info-row">
        <span class="info-label">参加費</span>
        <span class="info-val">1,000円（税込・お支払い済み）</span>
      </div>
    </div>

    <div class="steps-box">
      <h3>📱 当日の参加方法（3ステップ）</h3>
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-text">
          <strong>このメールを開く</strong>
          開催日に、このメールをもう一度開いてください。
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-text">
          <strong>下のボタンをタップ（クリック）する</strong>
          緑色の「Google Meetに参加する」ボタンを<br>
          タップするだけで入室できます。
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-text">
          <strong>「参加」または「今すぐ参加」をタップする</strong>
          画面が開いたらそのままお待ちください。<br>
          ※カメラ・マイクの使用許可を求められたら「許可」を選んでください。
        </div>
      </div>
    </div>

    <p style="font-size:14px;color:#555;font-weight:700;margin-bottom:8px;">▼ 参加ボタン（当日タップしてください）</p>
    <div class="meet-wrap">
      <a href="${sess.meetUrl}" class="meet-btn">▶ Google Meetに参加する</a>
      <p class="meet-url">※ボタンが押せない場合はこちらをコピーしてブラウザに貼り付けてください<br>${sess.meetUrl}</p>
    </div>

    <hr class="divider">

    <div class="note-box">
      <p>ご参加前にご確認ください</p>
      <ul>
        <li>開始時刻の<strong>5〜10分前</strong>にご参加いただくとスムーズです</li>
        <li>スマホの場合、「Google Meet」アプリが入っていなくてもブラウザから参加できます</li>
        <li>Wi-Fiや電波の安定した場所からご参加ください</li>
        <li>うまく入れない・音が聞こえないなどがあればすぐにご連絡ください</li>
      </ul>
    </div>

    <p class="closing">
      ご不明な点がございましたら、お気軽にご連絡ください。<br>
      当日お会いできることを楽しみにしております。<br><br>
      教育支援団体 あんたがおらな 事務局<br>
      <a href="mailto:info@antagaorana.com">info@antagaorana.com</a><br>
      090-3435-0306
    </p>
  </div>
  <div class="ft">
    <p>教育支援団体 あんたがおらな | 代表 大久保 俊輝</p>
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

// ── プレーンテキスト版 ────────────────────────────────────────────
function buildEmailText({ customerName, session: sess }) {
  const name = customerName ? `${customerName}` : 'ご参加者';
  return `${name} 様

このたびは、「共育ゼミ」にお申し込みいただき、ありがとうございます。
お支払いが完了しました。
当日のご参加方法をご案内いたします。

━━━━━━━━━━━━━━━━━━━━━━

■ 開催日時
${sess.date}
${sess.timeRange}

■ 開催方法
オンライン（スマホ・パソコンから参加できます）

■ 参加費
1,000円（税込・お支払い済み）

━━━━━━━━━━━━━━━━━━━━━━
■ 当日の参加方法（3ステップ）
━━━━━━━━━━━━━━━━━━━━━━

【STEP 1】このメールを開く
　開催日に、このメールをもう一度開いてください。

【STEP 2】下のURLをタップ（クリック）する
　タップするだけで入室できます。

${sess.meetUrl}

【STEP 3】「参加」または「今すぐ参加」をタップする
　画面が開いたらそのままお待ちください。
　※カメラ・マイクの使用許可を求められたら「許可」を選んでください。

━━━━━━━━━━━━━━━━━━━━━━
■ ご参加前にご確認ください
━━━━━━━━━━━━━━━━━━━━━━

・開始時刻の5〜10分前にご参加いただくとスムーズです
・スマホの場合、「Google Meet」アプリが入っていなくてもブラウザから参加できます
・Wi-Fiや電波の安定した場所からご参加ください
・うまく入れない・音が聞こえないなどがあればすぐにご連絡ください

━━━━━━━━━━━━━━━━━━━━━━

ご不明な点や、うまく参加できない場合は、お気軽にご連絡ください。

教育支援団体 あんたがおらな
info@antagaorana.com
090-3435-0306

それでは、当日お会いできることを楽しみにしております。

教育支援団体 あんたがおらな
代表 大久保 俊輝
https://antagaorana.com

━━━━━━━━━━━━━━━━━━━━━━
キャンセル・返金条件については以下をご確認ください。
https://antagaorana.com/benkyokai-terms.html
このメールはお申し込みいただいた方にお送りしています。
`;
}

// ── 前日リマインドメール HTML ──────────────────────────────────────
function buildReminderHtml({ customerName, session: sess }) {
  const name = customerName ? `${customerName}` : 'ご参加者';
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f5f2ed;font-family:'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif}
  .wrap{max-width:560px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)}
  .hd{background:#c8602a;padding:28px 36px;text-align:center}
  .hd-sub{color:rgba(255,255,255,.8);font-size:11px;letter-spacing:.2em;margin:0 0 4px}
  .hd-brand{color:#fff;font-size:18px;font-weight:700;margin:0}
  .bd{padding:36px}
  .remind-badge{background:#fff3ee;border:2px solid #c8602a;border-radius:8px;padding:14px 20px;text-align:center;margin-bottom:24px;font-size:15px;color:#c8602a;font-weight:700}
  .greeting{font-size:16px;margin-bottom:16px;color:#222;font-weight:700}
  .lead{font-size:15px;color:#444;line-height:2;margin-bottom:24px}
  .steps-box{background:#f0f6f0;border-radius:8px;padding:20px 24px;margin-bottom:24px}
  .steps-box h3{margin:0 0 16px;font-size:13px;color:#3e5739;letter-spacing:.1em;border-bottom:1px solid #c8ddc8;padding-bottom:8px;font-weight:700}
  .step{display:flex;align-items:flex-start;margin-bottom:14px;font-size:14px;line-height:1.8}
  .step-num{flex-shrink:0;width:28px;height:28px;background:#3e5739;color:#fff;border-radius:50%;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-right:12px;margin-top:2px}
  .step-text{color:#333}
  .step-text strong{color:#3e5739;display:block;margin-bottom:2px}
  .info-box{background:#f8f5f0;border-radius:8px;padding:16px 20px;margin-bottom:20px;font-size:14px;color:#333;line-height:2}
  .meet-btn{display:block;text-align:center;background:#c8602a;color:#fff !important;font-size:17px;font-weight:700;text-decoration:none;padding:20px 24px;border-radius:7px;letter-spacing:.03em}
  .meet-url{text-align:center;font-size:12px;color:#aaa;word-break:break-all;margin:8px 0 0}
  .note{background:#fffaf5;border-left:3px solid #c8602a;padding:14px 18px;border-radius:0 6px 6px 0;font-size:13px;color:#666;line-height:2;margin-bottom:24px}
  .closing{font-size:14px;color:#555;line-height:2}
  .ft{background:#f5f2ed;padding:16px 36px;text-align:center;font-size:11px;color:#999}
</style>
</head>
<body>
<div class="wrap">
  <div class="hd">
    <p class="hd-sub">教育支援団体 あんたがおらな</p>
    <p class="hd-brand">🔔 共育ゼミ｜明日開催のご案内</p>
  </div>
  <div class="bd">
    <div class="remind-badge">⏰ 明日開催です！ご準備をお忘れなく</div>
    <p class="greeting">${name} 様</p>
    <p class="lead">
      明日は「共育ゼミ」の開催日です。<br>
      お申し込みいただきありがとうございます。<br><br>
      当日の参加方法を改めてご案内します。<br>
      <strong>3ステップで簡単に参加できます。</strong>
    </p>

    <div class="info-box">
      📅 <strong>開催日時：</strong>${sess.date}　${sess.timeRange}<br>
      💻 <strong>開催方法：</strong>オンライン（スマホ・パソコン）
    </div>

    <div class="steps-box">
      <h3>📱 当日の参加方法（3ステップ）</h3>
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-text">
          <strong>このメールを開く</strong>
          開催時刻になったら、このメールをもう一度開いてください。
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-text">
          <strong>下のオレンジのボタンをタップする</strong>
          タップするだけで会議室に入れます。アプリは不要です。
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-text">
          <strong>「参加」または「今すぐ参加」をタップする</strong>
          画面が開いたらそのままお待ちください。<br>
          ※カメラ・マイクの許可を求められたら「許可」を選んでください。
        </div>
      </div>
    </div>

    <p style="font-size:14px;color:#333;font-weight:700;margin-bottom:8px;text-align:center">▼ 開始時刻になったらここをタップ！</p>
    <a href="${sess.meetUrl}" class="meet-btn">▶ Google Meetに参加する</a>
    <p class="meet-url">ボタンが押せない場合はこちらのURLをコピーして<br>ブラウザに貼り付けてください<br>${sess.meetUrl}</p>

    <br>
    <div class="note">
      ✅ 開始5〜10分前にアクセスするとスムーズです<br>
      ✅ Wi-Fiや電波の安定した場所からご参加ください<br>
      ✅ 入れない・音が聞こえないなどがあればすぐにご連絡ください
    </div>

    <p class="closing">
      教育支援団体 あんたがおらな 事務局<br>
      info@antagaorana.com　/ 090-3435-0306
    </p>
  </div>
  <div class="ft">
    教育支援団体 あんたがおらな | 代表 大久保 俊輝<br>
    このメールはお申し込みいただいた方にお送りしています。
  </div>
</div>
</body>
</html>`;
}

// ── 前日リマインドメール テキスト ───────────────────────────────────
function buildReminderText({ customerName, session: sess }) {
  const name = customerName ? `${customerName}` : 'ご参加者';
  return `${name} 様

⏰ 明日は「共育ゼミ」の開催日です！

━━━━━━━━━━━━━━━━━━━━━━
■ 開催日時
${sess.date}
${sess.timeRange}

■ 開催方法
オンライン（スマホ・パソコンから参加できます）
━━━━━━━━━━━━━━━━━━━━━━

■ 当日の参加方法（3ステップ）

【STEP 1】このメールを開く
　開催時刻になったら、このメールをもう一度開いてください。

【STEP 2】下のURLをタップ（クリック）する
　タップするだけで入室できます。アプリは不要です。

${sess.meetUrl}

【STEP 3】「参加」または「今すぐ参加」をタップする
　画面が開いたらそのままお待ちください。
　※カメラ・マイクの使用許可を求められたら「許可」を選んでください。

━━━━━━━━━━━━━━━━━━━━━━
■ ご参加前にご確認ください

・開始時刻の5〜10分前にご参加いただくとスムーズです
・スマホの場合、「Google Meet」アプリがなくてもブラウザから参加できます
・Wi-Fiや電波の安定した場所からご参加ください
・うまく入れない・音が聞こえないなどがあればすぐにご連絡ください

━━━━━━━━━━━━━━━━━━━━━━

ご不明な点がございましたら、お気軽にご連絡ください。
明日、お会いできることを楽しみにしております。

教育支援団体 あんたがおらな
info@antagaorana.com
090-3435-0306
https://antagaorana.com
`;
}

// ── メインハンドラ ───────────────────────────────────────────────
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
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
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

  // 決済未完了の場合はスキップ
  if (session.payment_status !== 'paid') {
    console.log(`[webhook] Skipped: payment_status=${session.payment_status}`);
    return res.status(200).json({ received: true, skipped: 'payment_not_paid' });
  }

  // メールアドレス確認
  const customerEmail = session.customer_details?.email;
  const customerName  = session.customer_details?.name;

  if (!customerEmail) {
    console.warn('[webhook] No customer email in session:', session.id);
    return res.status(200).json({ received: true, skipped: 'no_email' });
  }

  const isTestMode  = event.livemode === false;
  const testModeEnv = process.env.TEST_MODE === 'true';
  const resend      = new Resend(process.env.RESEND_API_KEY);
  const fromEmail   = process.env.FROM_EMAIL || 'info@antagaorana.com';
  const supabase    = getSupabase();

  // 開催回設定を取得
  let sess;
  try {
    sess = getSessionConfig();
  } catch (err) {
    console.error('[webhook] Session config error:', err.message);
    await notifyAdmin(resend, fromEmail, 'セッション設定エラー',
      `Stripe Event ID: ${event.id}\nエラー: ${err.message}\n\nSESSION_MEET_URL が Vercel 環境変数に設定されているか確認してください。`);
    return res.status(500).json({ error: 'Session config error' });
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 1: Supabaseに申込レコードを登録（冪等: stripe_event_id UNIQUE）
  // ──────────────────────────────────────────────────────────────────
  const insertData = {
    stripe_event_id:            event.id,
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id:   session.payment_intent  || null,
    stripe_customer_id:         session.customer         || null,
    customer_name:              customerName             || null,
    customer_email:             customerEmail,
    product_name:               '共育ゼミ',
    amount:                     session.amount_total     ?? 1000,
    currency:                   session.currency         || 'jpy',
    payment_status:             session.payment_status,
    event_date:                 sess.date,
    event_time:                 sess.timeRange,
    email_status:               'pending',
  };

  // INSERT を試みる。stripe_event_id が既に存在する場合は UNIQUE 制約で失敗（コード 23505）
  const { error: insertErr } = await supabase
    .from('benkyokai_registrations')
    .insert(insertData);

  if (insertErr && insertErr.code !== '23505') {
    // UNIQUE違反以外のエラーは障害 → 500でStripeに再試行させる
    console.error('[webhook] Supabase insert error:', insertErr.message, '| event:', event.id);
    await notifyAdmin(resend, fromEmail, 'Supabase登録エラー',
      `Stripe Event ID: ${event.id}\nエラーコード: ${insertErr.code}\nエラー: ${insertErr.message}`);
    return res.status(500).json({ error: 'Database insert error' });
  }

  // 現在の申込レコードを取得（新規 or 既存どちらも）
  const { data: registration, error: fetchErr } = await supabase
    .from('benkyokai_registrations')
    .select()
    .eq('stripe_event_id', event.id)
    .single();

  if (fetchErr || !registration) {
    console.error('[webhook] Supabase fetch error:', fetchErr?.message, '| event:', event.id);
    await notifyAdmin(resend, fromEmail, 'Supabase取得エラー',
      `Stripe Event ID: ${event.id}\nエラー: ${fetchErr?.message}`);
    return res.status(500).json({ error: 'Database fetch error' });
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 2: メール送信状態を確認（二重送信防止）
  // ──────────────────────────────────────────────────────────────────
  if (registration.email_status === 'sent') {
    // 既に送信済み → 絶対に再送しない（Stripeの再試行でも安全）
    console.log(`[webhook] Email already sent, skip | event=${event.id}`);
    return res.status(200).json({ received: true, emailAlreadySent: true });
  }

  if (registration.email_status === 'test_skipped') {
    console.log(`[webhook] Test-skipped registration, skip | event=${event.id}`);
    return res.status(200).json({ received: true, testSkipped: true });
  }

  // テストモードスキップ（livemode=false かつ TEST_MODE=true）
  if (isTestMode && testModeEnv) {
    console.log(`[webhook][TEST] Skip email | event=${event.id}`);
    const { error: tsErr } = await supabase
      .from('benkyokai_registrations')
      .update({ email_status: 'test_skipped' })
      .eq('stripe_event_id', event.id);
    if (tsErr) console.error('[webhook] Failed to update test_skipped status:', tsErr.message);
    return res.status(200).json({ received: true, testMode: true });
  }

  // 同じ参加者が同じ開催回を複数回決済しても、参加案内は1通だけ送る。
  // 決済レコードは registrations に全件残し、送信権だけを専用台帳で排他的に取得する。
  const normalizedEmail = customerEmail.trim().toLowerCase();
  const deliveryKey = crypto
    .createHash('sha256')
    .update(`${normalizedEmail}|${sess.date || ''}|共育ゼミ`)
    .digest('hex');

  const { error: claimErr } = await supabase
    .from('benkyokai_email_deliveries')
    .insert({
      delivery_key: deliveryKey,
      owner_event_id: event.id,
      customer_email: normalizedEmail,
      event_date: sess.date,
      product_name: '共育ゼミ',
      status: 'pending',
    });

  if (claimErr && claimErr.code !== '23505') {
    console.error('[webhook] Email delivery claim error:', claimErr.message, '| event:', event.id);
    return res.status(500).json({ error: 'Email delivery claim error' });
  }

  const { data: delivery, error: deliveryFetchErr } = await supabase
    .from('benkyokai_email_deliveries')
    .select('owner_event_id,status')
    .eq('delivery_key', deliveryKey)
    .single();

  if (deliveryFetchErr || !delivery) {
    console.error('[webhook] Email delivery fetch error:', deliveryFetchErr?.message, '| event:', event.id);
    return res.status(500).json({ error: 'Email delivery fetch error' });
  }

  if (delivery.owner_event_id !== event.id) {
    await supabase
      .from('benkyokai_registrations')
      .update({
        email_status: 'duplicate_skipped',
        email_error: '同一メールアドレス・同一開催回の案内メール送信済みまたは送信処理中',
      })
      .eq('stripe_event_id', event.id);
    console.log(`[webhook] Duplicate participant delivery skipped | event=${event.id}`);
    return res.status(200).json({ received: true, duplicateParticipantSkipped: true });
  }

  if (delivery.status === 'sent') {
    console.log(`[webhook] Delivery ledger already sent, skip | event=${event.id}`);
    return res.status(200).json({ received: true, emailAlreadySent: true });
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 3: メール送信
  // ──────────────────────────────────────────────────────────────────
  try {
    const { data: emailData, error: emailErr } = await resend.emails.send({
      from:    `教育支援団体 あんたがおらな <${fromEmail}>`,
      to:      [customerEmail],
      replyTo: fromEmail,
      subject: '【共育ゼミ】お申し込みありがとうございます｜参加のご案内',
      html:    buildEmailHtml({ customerName, session: sess }),
      text:    buildEmailText({ customerName, session: sess }),
      // 同一 event.id で何度リクエストしても Resend 側で重複送信を防ぐ
      headers: { 'X-Idempotency-Key': event.id },
    });

    if (emailErr) throw emailErr;

    // ── 前日リマインドメールのスケジュール送信 ──────────────────────
    if (sess.reminderScheduledAt) {
      try {
        const { error: reminderErr } = await resend.emails.send({
          from:        `教育支援団体 あんたがおらな <${fromEmail}>`,
          to:          [customerEmail],
          replyTo:     fromEmail,
          subject:     `【共育ゼミ】明日開催です！参加URLのご案内`,
          html:        buildReminderHtml({ customerName, session: sess }),
          text:        buildReminderText({ customerName, session: sess }),
          scheduledAt: sess.reminderScheduledAt,
          headers:     { 'X-Idempotency-Key': `${event.id}-reminder` },
        });
        if (reminderErr) {
          // リマインド失敗は致命的ではない → ログのみ
          console.warn(`[webhook] Reminder schedule failed | event=${event.id} |`, reminderErr.message);
        } else {
          console.log(`[webhook] Reminder scheduled at ${sess.reminderScheduledAt} | event=${event.id}`);
        }
      } catch (reminderEx) {
        console.warn(`[webhook] Reminder schedule error | event=${event.id} |`, reminderEx.message);
      }
    } else {
      console.log(`[webhook] Reminder not scheduled (no SESSION_DATE_ISO or date already past) | event=${event.id}`);
    }

    // ── 送信成功 → Supabase を更新 ──
    const { error: updateErr } = await supabase
      .from('benkyokai_registrations')
      .update({
        email_status:  'sent',
        email_sent_at: new Date().toISOString(),
        email_error:   null,
      })
      .eq('stripe_event_id', event.id);

    const { error: deliveryUpdateErr } = await supabase
      .from('benkyokai_email_deliveries')
      .update({
        status: 'sent',
        resend_email_id: emailData?.id || null,
        error_message: null,
      })
      .eq('delivery_key', deliveryKey)
      .eq('owner_event_id', event.id);

    if (deliveryUpdateErr) {
      console.error('[webhook] Delivery ledger update failed:', deliveryUpdateErr.message, '| event:', event.id);
    }

    if (updateErr) {
      // メールは送れているが DB 更新失敗 → ログだけ（200を返す）
      console.error('[webhook] DB update after email success failed:', updateErr.message, '| event:', event.id);
    }

    // 個人情報（メールアドレス）をログに残さない
    console.log(`[webhook] Email sent | event=${event.id} | resend_id=${emailData?.id}`);
    return res.status(200).json({ received: true, emailId: emailData?.id });

  } catch (err) {
    console.error(`[webhook] Email send error | event=${event.id} |`, err.message);

    // ── 送信失敗 → Supabase に記録 ──
    const { error: failErr } = await supabase
      .from('benkyokai_registrations')
      .update({
        email_status: 'failed',
        email_error:  err.message,
      })
      .eq('stripe_event_id', event.id);

    await supabase
      .from('benkyokai_email_deliveries')
      .update({ status: 'failed', error_message: err.message })
      .eq('delivery_key', deliveryKey)
      .eq('owner_event_id', event.id);

    if (failErr) {
      console.error('[webhook] DB update after email failure failed:', failErr.message);
    }

    // ── Phase 4: 管理者通知 ──
    await notifyAdmin(resend, fromEmail, 'メール送信失敗',
      [
        `Stripe Event ID: ${event.id}`,
        `Registration ID: ${registration.id}`,
        `エラー: ${err.message}`,
        '',
        'Stripe が自動再試行します。',
        'Supabase で email_status を確認してください。',
        '次回の再試行時、email_status が "failed" であれば再送を試みます。',
        '再試行が尽きた場合は、手動でメールを送信してください。',
      ].join('\n'));

    // 500 を返して Stripe に再試行させる
    // 再試行時: INSERT は 23505 で失敗 → SELECT で既存レコード取得 → email_status='failed' → 再送試行
    return res.status(500).json({ error: 'Email send failed, Stripe will retry' });
  }
}

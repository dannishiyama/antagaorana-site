/**
 * api/monthly-setup-reminder.js
 * 毎月1日 09:00 JST (00:00 UTC) に自動実行
 * 共育ゼミ次回開催の環境変数設定をdanさんにリマインド
 *
 * Vercel Cron: vercel.json で設定済み
 *   "crons": [{ "path": "/api/monthly-setup-reminder", "schedule": "0 0 1 * *" }]
 *
 * 必要な環境変数:
 *   RESEND_API_KEY
 *   FROM_EMAIL
 *   ADMIN_EMAIL  (通知先。未設定なら FROM_EMAIL へ)
 *   CRON_SECRET  (不正アクセス防止)
 */

import { Resend } from 'resend';

export default async function handler(req, res) {
  // Vercel Cron からの呼び出し検証
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const resend     = new Resend(process.env.RESEND_API_KEY);
  const fromEmail  = process.env.FROM_EMAIL  || 'info@antagaorana.com';
  const adminEmail = process.env.ADMIN_EMAIL || fromEmail;

  // 今月・来月の情報を計算
  const now       = new Date();
  const thisMonth = now.getMonth() + 1;   // 1-12
  const thisYear  = now.getFullYear();
  const nextMonth = thisMonth === 12 ? 1 : thisMonth + 1;
  const nextYear  = thisMonth === 12 ? thisYear + 1 : thisYear;

  // 来月の「最終土曜日」を計算
  const lastDayOfNextMonth = new Date(nextYear, nextMonth, 0); // 月末日
  const dayOfWeek = lastDayOfNextMonth.getDay(); // 0=日, 6=土
  const daysToSubtract = (dayOfWeek >= 6) ? (dayOfWeek - 6) : (dayOfWeek + 1);
  const lastSaturday = new Date(lastDayOfNextMonth);
  lastSaturday.setDate(lastDayOfNextMonth.getDate() - daysToSubtract);

  const dateDisplay = `${nextYear}年${nextMonth}月${lastSaturday.getDate()}日（土）`;
  const dateIso = `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(lastSaturday.getDate()).padStart(2, '0')}`;

  const vercelEnvUrl = 'https://vercel.com/dannishiyamas-projects/antagaorana-site/settings/environment-variables';
  const gcalUrl = 'https://calendar.google.com/calendar/r/settings/appointment';

  const subject = `【共育ゼミ】${nextMonth}月の設定をしましょう | 自動リマインド`;

  const text = `
西山 弾 さん

今月の共育ゼミ、お疲れ様でした！
来月（${nextMonth}月）開催の設定をお願いします。

━━━━━━━━━━━━━━━━━━━━━
■ STEP 1：Google Meetを作成する
━━━━━━━━━━━━━━━━━━━━━
Googleカレンダーで${nextMonth}月の共育ゼミ用のMeet URLを作成してください。

Googleカレンダー →
${gcalUrl}

━━━━━━━━━━━━━━━━━━━━━
■ STEP 2：Vercelの環境変数を更新する
━━━━━━━━━━━━━━━━━━━━━
${vercelEnvUrl}

更新する5項目（おすすめ設定）：

SESSION_DATE       → ${dateDisplay}
SESSION_DATE_ISO   → ${dateIso}
SESSION_TIME_START → 20:00
SESSION_TIME_END   → 21:30
SESSION_MEET_URL   → ← STEP 1で作成したURLを貼る

━━━━━━━━━━━━━━━━━━━━━
■ 完了したら

申し込みページを公開すればOKです。
申し込みがあった方には自動で：
・確認メール（即時）
・前日リマインドメール（${nextMonth}月${lastSaturday.getDate() - 1}日 朝9時）

が自動送信されます。

━━━━━━━━━━━━━━━━━━━━━

教育支援団体 あんたがおらな 自動通知
（このメールは毎月1日に自動送信されています）
`.trim();

  try {
    const { error } = await resend.emails.send({
      from:    `共育ゼミ自動通知 <${fromEmail}>`,
      to:      [adminEmail],
      subject,
      text,
    });

    if (error) throw error;

    console.log(`[monthly-reminder] Sent to ${adminEmail} for ${nextMonth}月`);
    return res.status(200).json({ ok: true, month: nextMonth, suggestedDate: dateDisplay });
  } catch (err) {
    console.error('[monthly-reminder] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

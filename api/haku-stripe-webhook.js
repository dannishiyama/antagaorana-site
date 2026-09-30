/**
 * api/haku-stripe-webhook.js
 * HAKU Community 決済完了（Stripe Checkout） → Resendで申込み完了メールを送信
 *
 * これは既存の api/stripe-webhook.js（共育ゼミ）とは完全に独立したファイルです。
 * 既存ファイル・既存テンプレート・既存Supabaseテーブルには一切触れません。
 *
 * 設計方針（api/haku-checkout.js と同じ安全思想を踏襲）:
 *   - サンドボックス（テストモード）専用。本番では絶対に動かさない
 *       安全装置1: VERCEL_ENV === 'production' なら即座に何もせず200を返す
 *       安全装置2: event.livemode !== false（つまり本番決済）なら即座に何もせず200を返す
 *       安全装置3: STRIPE_SECRET_KEY が sk_test_ / rk_test_ 以外なら処理を拒否する
 *       安全装置4: session.metadata.product === 'haku_community' 以外は無視する
 *         （同じエンドポイントに将来ほかのイベントが来ても誤動作しないため）
 *   - この4つのうちどれか1つでも「本番っぽい」と判定したら、メールは絶対に送らない
 *
 * 再利用しているもの（共育ゼミの仕組みをそのまま流用）:
 *   - Resend でのメール送信方法・fromの組み立て方
 *   - Stripe署名検証（raw body + stripe.webhooks.constructEvent）の書き方
 *   - 個人情報（メールアドレス・氏名）をログに出力しないという方針
 *   - エラー時に管理者へ通知するという方針
 *
 * 追加実装（Preview用 会員基盤との連携）:
 *   - 完全紹介制：決済前に Application(status:'approved'、管理者が承認済み) であることが
 *     前提（api/haku-checkout.js がCheckout Session作成時点で既に検証しているが、Webhookの
 *     再送・リプレイ等に備えてここでも再確認する＝多層防御）。approved/paid 以外の場合は
 *     Membershipを絶対に有効化せず、管理者へ異常通知メールを送るだけに留める。
 *     決済完了時、承認済みのApplicationをstatus:'paid'にし、store.js の
 *     Membership（community: 'haku'）を active にする。
 *   - 万一パスワード未設定のまま決済まで到達したケース（旧フローの名残・不整合）に限り、
 *     フォールバックとしてパスワード設定リンクを発行しメールに追記する。通常はパスワードは
 *     登録時に既に設定済みのため、その場合はログイン案内のみのメールになる。
 *   - このDB連携が失敗しても、既存の「お申し込み完了メール」自体は必ず送る
 *     （try/catchで分離し、既存の決済確認メール機能を壊さない）。
 *   - checkout.session.completed: Membershipをactiveにし、Application を'paid'にしたうえで
 *     決済完了・利用開始メール（sendPaymentCompletedEmail）を送る。
 *   - customer.subscription.deleted: Membershipを status='canceled' にする（即時アクセス停止）。
 *     解約予約(cancel_at_period_end)を経た自然終了・支払い失敗による自動キャンセルの場合は、
 *     既に別のメールを送信済みのため再送しない。それ以外の即時解約の場合のみ
 *     「本日をもって利用終了」メール（sendCancellationScheduledEmail, immediate:true）を送る。
 *   - customer.subscription.updated: cancel_at_period_end / current_period_end / Stripe側の
 *     subscription.statusをMembershipへ同期する。アプリ内の解約操作（community-auth.js の
 *     handleCancelMembership）は自分で先にMembershipをcancelingにしてメールも送るため、
 *     ここでの送信はそれより前にcanceling化されていない場合（＝Stripeダッシュボード等
 *     アプリ外からの変更）に限る安全網として機能する。
 *   - invoice.payment_failed: Membershipを status='past_due' にする（即時アクセス停止。
 *     猶予期間は現時点では設けていない。理由・変更方法は関数コメント参照）。あわせて
 *     決済失敗メール（sendPaymentFailedEmail）を送る。
 *   - 上記いずれもStripe event.idベースのidempotency ledgerで二重処理を防止する。
 *   - すべてのメール送信は api/_lib/notify.js の sendAndLog() 経由で行われ、成否に関わらず
 *     EmailLogへ記録される。メール送信の失敗がMembership/Application更新自体を巻き戻すことは
 *     ない（更新は先に完了させ、メールはその後で試みる）。
 *
 * ※ Stripeダッシュボード（テストモード）のWebhookエンドポイント設定で、
 *    checkout.session.completed に加えて customer.subscription.deleted、
 *    customer.subscription.updated、invoice.payment_failed もイベント購読に
 *    追加する必要がある（このファイルのデプロイだけでは有効化されない。
 *    Stripe側の設定操作が別途必要）。
 *
 * 必要な環境変数（Vercel Dashboard > Settings > Environment Variables、Preview環境のみ推奨）:
 *   STRIPE_SECRET_KEY        sk_test_...（api/haku-checkout.js と共通）
 *   HAKU_STRIPE_WEBHOOK_SECRET  whsec_...（このエンドポイント専用。Stripe Webhook登録時に発行される）
 *   RESEND_API_KEY           re_...（既存と共通のサービス）
 *   FROM_EMAIL               info@antagaorana.com（既存と共通）
 *   ADMIN_EMAILS             省略可。カンマ区切り（既存と共通）
 *   REDIS_URL                Preview限定のUpstash Redis接続文字列（lib/store.js が使用）
 */

import { Resend } from 'resend';
import Stripe from 'stripe';
import { resolveBaseUrl } from './_lib/http.js';
import {
  getUser, setMembership, getMembership, createPasswordSetupToken, getApplication, resolveApplication,
  setStripeCustomerEmail, getEmailByStripeCustomer,
  isEventProcessed, markEventProcessed, logAudit,
} from './_lib/store.js';
import { randomToken } from './_lib/security.js';
import { sendPaymentCompletedEmail, sendPaymentFailedEmail, sendCancellationScheduledEmail } from './_lib/notify.js';

// Vercelのbody parserを無効化（Stripe署名検証にraw bodyが必要）
export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 失敗しても握りつぶす（通知失敗でメイン処理を止めない。既存 notifyAdmin と同じ考え方）
async function notifyAdmin(resend, fromEmail, subject, body, adminEmails) {
  const to = adminEmails?.length ? adminEmails : [fromEmail];
  try {
    await resend.emails.send({
      from: `HAKU Community 自動通知 <${fromEmail}>`,
      to,
      subject: `【HAKU Community テスト決済処理エラー】${subject}`,
      text: ['このメールはHAKU Community（テスト環境）決済処理の自動エラー通知です。', '', body].join('\n'),
    });
  } catch (e) {
    console.error('[haku-webhook] Admin notification failed:', e.message);
  }
}

// ── customer.subscription.deleted: Stripe側で実際にSubscriptionが終了したらMembershipを
//    無効化する。ここに来る経路は3通りある:
//      (a) cancel_at_period_endで解約予約していた期間が終了した（解約メールは既にrequest時に送信済み→再送しない）
//      (b) 即時解約（cancel_at_period_endを経ずに直接ここへ来る）→「本日をもって利用終了」メールを送る
//      (c) 支払い失敗が続きStripe側が自動キャンセルした（cancellation_details.reason==='payment_failed'）
//          → 決済失敗メールは既に送信済みのため、ここでは追加のメールを送らない ──
async function handleSubscriptionDeleted(event, res) {
  const subscription = event.data.object;
  const email = await getEmailByStripeCustomer(subscription.customer);
  if (!email) {
    console.warn(`[haku-webhook] subscription.deleted: no email index for customer=${subscription.customer}`);
    return res.status(200).json({ received: true, skipped: 'no_email_index' });
  }
  try {
    const membershipBefore = await getMembership('haku', email);
    const wasCancelingScheduled = membershipBefore?.cancelAtPeriodEnd === true;
    const cancellationReason = subscription.cancellation_details?.reason || null;

    await setMembership('haku', email, { status: 'canceled', canceledAt: Date.now(), cancelAtPeriodEnd: false });
    await logAudit({ actorId: 'stripe-webhook', action: 'membership_canceled', targetId: email, metadata: { community: 'haku', event: event.id, reason: cancellationReason || 'subscription_deleted' } });
    console.log(`[haku-webhook] Membership canceled | event=${event.id}`);

    // (a) 解約予約が既にあった＝期間満了による自然終了 → 予約時に送信済みのため再送しない。
    // (c) 支払い失敗による自動キャンセル → 決済失敗メールを既に送っているため送らない。
    // (b) それ以外（予約を経ない即時解約）のみ「本日をもって利用終了」を送る。
    if (!wasCancelingScheduled && cancellationReason !== 'payment_failed') {
      const user = await getUser(email);
      await sendCancellationScheduledEmail({ email, displayName: user?.displayName, immediate: true });
    }

    await markEventProcessed(event.id);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error(`[haku-webhook] subscription.deleted handling failed | event=${event.id} |`, err.message);
    return res.status(500).json({ error: 'Membership update failed, Stripe will retry' });
  }
}

// ── customer.subscription.updated: StripeのSubscription状態（source of truth）を
//    Membershipへ同期する。主な用途:
//      - cancel_at_period_endがfalse→trueへ変化した ＝ 解約が予約された
//        （通常はapi/community-auth.jsのhandleCancelMembershipが自分でMembershipを
//        'canceling'にしてメールも送るため、ここでの送信はそれより前に既にcanceling済みなら
//        スキップする＝アプリ外（Stripeダッシュボード等）からの解約に対する安全網としてのみ機能）
//      - current_period_end / Stripe側のsubscription.statusをMembershipへ反映する ──
async function handleSubscriptionUpdated(event, res) {
  const subscription = event.data.object;
  const email = await getEmailByStripeCustomer(subscription.customer);
  if (!email) {
    console.warn(`[haku-webhook] subscription.updated: no email index for customer=${subscription.customer}`);
    return res.status(200).json({ received: true, skipped: 'no_email_index' });
  }
  try {
    const membershipBefore = await getMembership('haku', email);
    if (!membershipBefore) {
      return res.status(200).json({ received: true, skipped: 'no_membership' });
    }
    const wasCanceling = membershipBefore.cancelAtPeriodEnd === true;
    const cancelAtPeriodEnd = !!subscription.cancel_at_period_end;
    // Stripeの新しいAPIバージョンではcurrent_period_endがsubscription直下ではなく
    // items配下に移動しているため、両方を見て取得する（どちらもなければnull）。
    const rawPeriodEnd = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
    const currentPeriodEnd = rawPeriodEnd ? rawPeriodEnd * 1000 : null;
    const stripeStatus = subscription.status;

    let newStatus = membershipBefore.status;
    if (stripeStatus === 'active' || stripeStatus === 'trialing') {
      newStatus = cancelAtPeriodEnd ? 'canceling' : 'active';
    } else if (stripeStatus === 'past_due') {
      newStatus = 'past_due';
    } else if (stripeStatus === 'canceled' || stripeStatus === 'unpaid') {
      newStatus = 'canceled';
    }

    await setMembership('haku', email, { status: newStatus, cancelAtPeriodEnd, currentPeriodEnd });
    await logAudit({ actorId: 'stripe-webhook', action: 'membership_synced', targetId: email, metadata: { community: 'haku', event: event.id, stripeStatus, cancelAtPeriodEnd, newStatus } });

    // 安全網メール：アプリ内の解約操作（handleCancelMembership）は自分で先にcancelAtPeriodEnd
    // をtrueにしてからメールを送るため、ここに来る時点で既にwasCanceling===trueとなり重複しない。
    // Stripeダッシュボード等、アプリを経由しない解約のみここでメールを送る。
    if (cancelAtPeriodEnd && newStatus === 'canceling' && !wasCanceling) {
      const user = await getUser(email);
      const periodEndLabel = currentPeriodEnd ? new Date(currentPeriodEnd).toLocaleDateString('ja-JP') : null;
      await sendCancellationScheduledEmail({ email, displayName: user?.displayName, periodEndLabel, immediate: false });
    }

    await markEventProcessed(event.id);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error(`[haku-webhook] subscription.updated handling failed | event=${event.id} |`, err.message);
    return res.status(500).json({ error: 'Membership update failed, Stripe will retry' });
  }
}

// ── invoice.payment_failed: 支払い失敗時はいったんアクセスを止める（past_due）。
//    現時点では猶予期間を設けず即時停止する採用方針（既存/community に決済連動の
//    前例が無いため、安全側＝即時停止をデフォルトに採用。将来的な猶予期間の導入は
//    membership.status='past_due' を見て許容ロジックを足すだけで対応可能な設計にしてある）。
async function handlePaymentFailed(event, res, req) {
  const invoice = event.data.object;
  const customerId = invoice.customer;
  const email = await getEmailByStripeCustomer(customerId);
  if (!email) {
    console.warn(`[haku-webhook] invoice.payment_failed: no email index for customer=${customerId}`);
    return res.status(200).json({ received: true, skipped: 'no_email_index' });
  }
  try {
    await setMembership('haku', email, { status: 'past_due' });
    await logAudit({ actorId: 'stripe-webhook', action: 'membership_past_due', targetId: email, metadata: { community: 'haku', event: event.id } });
    console.log(`[haku-webhook] Membership marked past_due | event=${event.id}`);
    const user = await getUser(email);
    const baseUrlForEmail = resolveBaseUrl(req) || 'https://antagaorana-haku-tomoshibi-preview.vercel.app';
    await sendPaymentFailedEmail({ email, displayName: user?.displayName, baseUrl: baseUrlForEmail });
    await markEventProcessed(event.id);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error(`[haku-webhook] invoice.payment_failed handling failed | event=${event.id} |`, err.message);
    return res.status(500).json({ error: 'Membership update failed, Stripe will retry' });
  }
}

// ── メインハンドラ ───────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const missingVars = ['STRIPE_SECRET_KEY', 'HAKU_STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY']
    .filter((v) => !process.env[v]);
  if (missingVars.length > 0) {
    console.error('[haku-webhook] Missing env vars:', missingVars.join(', '));
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // ── 安全装置: 本物のStripe鍵（test/liveいずれか）以外は拒否 ──────
  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const secretKeyIsLive = /^(sk|rk)_live_/.test(secretKey);
  if (!secretKeyIsLive && !/^(sk|rk)_test_/.test(secretKey)) {
    console.error('[haku-webhook] STRIPE_SECRET_KEY is not a valid Stripe key — refusing to process');
    return res.status(500).json({ error: 'Valid Stripe key required' });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error('[haku-webhook] Failed to read body:', err.message);
    return res.status(400).json({ error: 'Failed to read request body' });
  }

  const stripe = new Stripe(secretKey, { apiVersion: '2024-06-20' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      req.headers['stripe-signature'],
      process.env.HAKU_STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error('[haku-webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature error: ${err.message}` });
  }

  // ── 安全装置: STRIPE_SECRET_KEYのmode（test/live）と、実際に届いたeventの
  // livemodeが一致しない場合は処理しない。Preview（test鍵）でlive決済が誤って
  // 処理されることも、Production（live鍵）でtest決済が誤って処理されることも、
  // どちらもこの一行で防ぐ（今回のアカウント取り違え調査で得た教訓を反映）。
  if (event.livemode !== secretKeyIsLive) {
    console.log(`[haku-webhook] Skipped: event.livemode=${event.livemode} does not match key mode (live=${secretKeyIsLive}) | event=${event.id}`);
    return res.status(200).json({ received: true, skipped: 'livemode_key_mismatch' });
  }

  // ── idempotency: 同一event.idの再送を二重処理しない（Membership二重作成・
  //    パスワード設定token再発行・メール二重送信・subscription情報二重更新の防止） ──
  try {
    if (await isEventProcessed(event.id)) {
      console.log(`[haku-webhook] Skipped: already processed | event=${event.id}`);
      return res.status(200).json({ received: true, skipped: 'duplicate_event' });
    }
  } catch (err) {
    console.error('[haku-webhook] idempotency check failed (continuing):', err.message);
  }

  if (event.type === 'customer.subscription.deleted') {
    return await handleSubscriptionDeleted(event, res);
  }
  if (event.type === 'customer.subscription.updated') {
    return await handleSubscriptionUpdated(event, res);
  }
  if (event.type === 'invoice.payment_failed') {
    return await handlePaymentFailed(event, res, req);
  }
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, skipped: event.type });
  }

  const session = event.data.object;

  // ── 安全装置4: HAKU Community のセッション以外は無視 ────────────
  if (session.metadata?.product !== 'haku_community') {
    return res.status(200).json({ received: true, skipped: 'not_haku_community' });
  }

  if (session.payment_status !== 'paid') {
    console.log(`[haku-webhook] Skipped: payment_status=${session.payment_status} | event=${event.id}`);
    return res.status(200).json({ received: true, skipped: 'payment_not_paid' });
  }

  // metadata.email が本人確認済みの登録済みメールアドレス（api/haku-checkout.js が
  // Applicationの存在を検証したうえで設定）。customer_details.emailはStripe Checkout画面で
  // 編集され得るため、あくまでフォールバックとして扱う。
  const customerEmail = session.metadata?.email || session.customer_details?.email;
  const customerName = session.customer_details?.name;

  if (!customerEmail) {
    console.warn('[haku-webhook] No customer email in session:', session.id);
    return res.status(200).json({ received: true, skipped: 'no_email' });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.FROM_EMAIL || 'info@antagaorana.com';
  const adminEmails = process.env.ADMIN_EMAILS
    ? process.env.ADMIN_EMAILS.split(',').map((e) => e.trim()).filter(Boolean)
    : [fromEmail];

  const amountLabel = typeof session.amount_total === 'number'
    ? `${session.amount_total.toLocaleString('ja-JP')}円`
    : '2,980円';

  // ── Redis会員基盤への反映（失敗しても既存の完了メール送信は止めない） ──
  let setupUrl = null;
  const baseUrlForEmail = resolveBaseUrl(req);
  // 完全紹介制の最終防衛線：api/haku-checkout.js が「承認済み」でなければCheckout Sessionを
  // 作らないため通常ここに来る時点でApplicationはapprovedのはずだが、Webhookの再送・リプレイや
  // 何らかの不整合で万一そうでない場合に備え、ここでも確認してから初めてMembershipを有効化する。
  // 承認されていないApplicationに対して、決済が完了したという理由だけでMembershipをactiveに
  // してしまうことは絶対に避ける。
  const application = await getApplication('haku', customerEmail);
  if (!application || (application.status !== 'approved' && application.status !== 'paid')) {
    console.error(`[haku-webhook] Payment completed for a non-approved application | event=${event.id} | status=${application?.status || 'not_found'}`);
    await notifyAdmin(
      resend,
      fromEmail,
      '承認前決済の検知（要確認）',
      [
        `Stripe Event ID: ${event.id}`,
        `Application status: ${application?.status || '(Application not found)'}`,
        '',
        '決済は完了していますが、このApplicationは管理者承認（approved）済みではないため、',
        'Membershipを有効化していません。手動で状況をご確認のうえ、必要であれば',
        '管理画面から個別に対応してください（Stripeダッシュボードでの返金判断含む）。',
      ].join('\n'),
      adminEmails,
    );
    await markEventProcessed(event.id);
    return res.status(200).json({ received: true, skipped: 'application_not_approved' });
  }

  try {
    const existingUser = await getUser(customerEmail);
    await setMembership('haku', customerEmail, {
      status: 'active',
      activatedAt: Date.now(),
      source: 'stripe',
      stripeCustomerId: session.customer || null,
      stripeSubscriptionId: session.subscription || null,
    });
    if (session.customer) await setStripeCustomerEmail(session.customer, customerEmail);
    // 承認済み（approved）のApplicationを、決済完了を表す'paid'にする。
    await resolveApplication('haku', customerEmail, 'paid', 'stripe-webhook');
    if (!existingUser || !existingUser.passwordHash) {
      // フォールバック: 通常は登録時に既にパスワード設定済みのため、ここに来るのは
      // 登録を経由しない旧フロー・不整合ケースのみ。
      const token = randomToken(32);
      await createPasswordSetupToken(token, { email: customerEmail, community: 'haku', displayName: customerName });
      if (baseUrlForEmail) setupUrl = `${baseUrlForEmail}/community-set-password.html?token=${token}&community=haku`;
    }
    await logAudit({ actorId: 'stripe-webhook', action: 'membership_activated', targetId: customerEmail, metadata: { community: 'haku', event: event.id } });
  } catch (err) {
    console.error(`[haku-webhook] Membership/token creation failed | event=${event.id} |`, err.message);
  }

  // 決済完了・利用開始メール：Webhookがpaid/active確定させた直後にのみ送る
  // （sendAndLog内部でtry/catch・EmailLog記録済みのため、ここでは結果だけ見て分岐する）
  const emailResult = await sendPaymentCompletedEmail({
    community: 'haku',
    email: customerEmail,
    customerName,
    amountLabel,
    baseUrl: baseUrlForEmail,
    setupUrl,
  });

  if (!emailResult.ok) {
    await notifyAdmin(
      resend,
      fromEmail,
      'メール送信失敗',
      `Stripe Event ID: ${event.id}\nエラー: ${emailResult.error}\n\n（Membership自体は既にactiveへ更新済みです。EmailLogにも失敗として記録されています）`,
      adminEmails,
    );
  } else {
    console.log(`[haku-webhook] Email sent | event=${event.id} | resend_id=${emailResult.id}`);
  }

  await markEventProcessed(event.id);
  return res.status(200).json({ received: true, emailId: emailResult.id });
}

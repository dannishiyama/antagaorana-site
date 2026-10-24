#!/usr/bin/env node
/**
 * 共育ゼミの申込ボタン（Stripe Payment Link）の設定を、読み取りだけで確認する。何も作らない・変えない。
 *
 *   node scripts/inspect-benkyokai-payment-link.mjs
 *
 * 確認するのは、「決済の件数に上限（Limit the number of payments）が設定されているか」と、いまの決済件数、商品の価格。
 * 使うのは、Stripeの「一覧・取得」（GET）だけ。キーは、画面に表示されない入力欄で受け取り、ファイル・ログ・Gitには残さない。
 * 読み取り専用の制限付きキー（rk_live_…。権限：Payment Links 読み取り、Prices 読み取り）で十分です。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(REPO + 'package.json');
const Stripe = require('stripe');
const LINK_CODE = 'fZu28sgpN72kc8fgkvafS01'; // benkyokai.html の申込ボタンのURL末尾

function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk) => {
      for (const c of chunk) {
        const code = c.charCodeAt(0);
        if (code === 13 || code === 10 || code === 4) { if (stdin.setRawMode) stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); return resolve(buf.trim()); }
        if (code === 3) { process.stdout.write('\n中止しました。\n'); process.exit(1); }
        if (code === 127 || code === 8) buf = buf.slice(0, -1); else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

const key = await askHidden('Stripeのキー（読み取り専用の rk_live_… を推奨。入力は表示されません）: ');
if (!/^(sk|rk)_(live|test)_[A-Za-z0-9_]+$/.test(key)) { console.error('Stripeのキーの形式ではありません。'); process.exit(1); }
const stripe = new Stripe(key, { apiVersion: '2024-06-20' });
try {
  const links = [];
  for await (const l of stripe.paymentLinks.list({ limit: 100 })) links.push(l);
  const link = links.find((l) => String(l.url || '').endsWith(LINK_CODE));
  console.log(`\nモード：${key.includes('_live_') ? '本番（live）' : 'テスト'}｜Payment Link の総数：${links.length}`);
  if (!link) { console.log('申込ボタンのURLに一致する Payment Link が見つかりませんでした（キーのモードが違う可能性があります）。'); process.exit(2); }
  const items = await stripe.paymentLinks.listLineItems(link.id, { limit: 10 });
  const lim = link.restrictions?.completed_sessions;
  console.log(`\nPayment Link：${link.id}（${link.active ? '有効' : '無効'}）`);
  console.log(`決済件数の上限（Limit the number of payments）：${lim ? `設定あり：上限 ${lim.limit} 件（現在 ${lim.count} 件）` : '設定なし（上限なし）'}`);
  console.log('商品：' + items.data.map((i) => `${i.description}｜${i.price?.unit_amount} ${String(i.price?.currency).toUpperCase()}｜数量 ${i.quantity}`).join(' ／ '));
  console.log(`数量の変更：${items.data.some((i) => i.adjustable_quantity?.enabled) ? '購入者が変更できる' : '変更できない'}`);
  console.log(`決済後の動作：${link.after_completion?.type}${link.after_completion?.redirect?.url ? '（' + link.after_completion.redirect.url + '）' : ''}`);
  console.log('\n※ 読み取りだけを行いました。何も変更していません。キーは保存していません。');
} catch (err) {
  console.error('エラー：', err?.raw?.message || err?.message || err);
  process.exitCode = 1;
}

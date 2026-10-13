#!/usr/bin/env node
/**
 * 依頼主本人（1つのメールアドレス）に、最高管理者・HAKU会員・灯会員・灯の運営ロール・会費免除を付与する。
 *
 *   node scripts/grant-owner-access.mjs --email=dan.nishiyama@antagaorana.com --label=本番(Production)            確認だけ（何も書き込まない）
 *   node scripts/grant-owner-access.mjs --email=… --label=本番(Production) --apply --confirm=dan.nishiyama@antagaorana.com   実際に付与
 *
 * 決まり
 *   - 既定は「確認だけ」。--apply と、--confirm=（メールアドレスをもう一度）の両方があるときだけ書き込む
 *   - 既存のアカウントは作り直さない。足りない権限・資格だけを足す。何度実行しても同じ結果（冪等）
 *   - Stripeの契約が有効な会員資格には触れない。Stripeにはアクセスしない
 *   - 却下済みの申請など、勝手に変えてはいけない状態があれば、書き込まずに止まる
 *   - RedisのURL・パスワードは、画面に表示されない入力欄に入力する。ファイル・ログ・Gitには残さない。結果はこの画面にだけ表示される
 *   - テスト環境(Preview)と本番(Production)は別のRedis。接続先のホスト名だけが表示されるので、取り違えていないか確認してから進める
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { planOwnerAccess, applyOwnerAccess, formatPlan } from './lib/owner-access.mjs';
import { hashPassword } from '../api/_lib/security.js';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(REPO + 'package.json');
const Redis = require('ioredis');
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const email = arg('email').trim().toLowerCase();
const label = arg('label') || '（名前なし）';
const APPLY = process.argv.includes('--apply');
if (!email) { console.error('--email= を指定してください。'); process.exit(1); }
if (APPLY && arg('confirm').trim().toLowerCase() !== email) { console.error('書き込むには、--confirm= に同じメールアドレスを指定してください。'); process.exit(1); }

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
        if (code === 13 || code === 10 || code === 4) { if (stdin.setRawMode) stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); return resolve(buf); }
        if (code === 3) { process.stdout.write('\n中止しました。\n'); process.exit(1); }
        if (code === 127 || code === 8) buf = buf.slice(0, -1); else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

const url = (await askHidden(`${label} のRedis接続URL（rediss://… 入力は表示されません）: `)).trim();
if (!/^rediss?:\/\//.test(url)) { console.error('Redisの接続URLではありません。'); process.exit(1); }
let host = '(不明)'; try { host = new URL(url).hostname; } catch { /* ignore */ }
const redis = new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 10000, lazyConnect: true });
try {
  await redis.connect();
  console.log(`\n接続先：${host}（${label}）${APPLY ? '【書き込みモード】' : '（確認のみ）'}\n`);
  const plan = await planOwnerAccess(redis, email);
  console.log(formatPlan(plan, { apply: APPLY }));
  if (plan.blockers.length) { console.log('\n停止しました（何も書き込んでいません）。'); process.exitCode = 2; }
  else if (!APPLY) console.log('\n確認のみです。問題なければ、--apply --confirm= を付けて再実行してください。');
  else if (plan.steps.length) {
    let passwordHash = null;
    if (plan.needsPassword) {
      const p1 = await askHidden('新しく使うパスワード（12文字以上。入力は表示されません）: ');
      const p2 = await askHidden('もう一度: ');
      if (p1 !== p2 || p1.length < 12) { console.error('パスワードが一致しないか、12文字未満です。何も書き込んでいません。'); process.exit(1); }
      passwordHash = await hashPassword(p1);
    }
    const r = await applyOwnerAccess(redis, email, { passwordHash });
    if (!r.applied) { console.error(`書き込めませんでした（${r.reason}）。`); process.exitCode = 2; }
    else { console.log('\n付与しました：'); r.done.forEach((d) => console.log(`  ✔ ${d}`)); console.log('\n結果を確認するには、--apply を外して再実行してください（「変更はありません」と出れば完了です）。'); }
  } else console.log('\n書き込みは不要でした。');
} catch (err) {
  console.error('エラー：', err.message);
  process.exitCode = 1;
} finally { redis.disconnect(); }

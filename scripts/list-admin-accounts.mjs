#!/usr/bin/env node
/**
 * 管理画面に入れるアカウントと、その権限の一覧（読み取り専用。何も書き込まない）。
 *
 *   node scripts/list-admin-accounts.mjs --label=テスト環境(Preview)
 *   node scripts/list-admin-accounts.mjs --label=本番(Production)
 *
 * RedisのURL（rediss://…）は、画面に表示されない入力欄に貼る。ファイル・ログ・Gitには残さない。
 *   テスト環境(Preview)と本番(Production)は、別のRedisです。それぞれ、そのRedisのURLを貼って、2回実行してください。
 * パスワードのハッシュは取り出さない。結果は、この画面にだけ表示される（Claudeには送られない）。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { collectAccounts, formatReport } from './lib/admin-accounts.mjs';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(REPO + 'package.json');
const Redis = require('ioredis');
const label = (process.argv.find((a) => a.startsWith('--label=')) || '--label=（名前なし）').slice(8);

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

const url = await askHidden(`${label} のRedis接続URL（rediss://… 入力は表示されません）: `);
if (!/^rediss?:\/\//.test(url)) { console.error('Redisの接続URLではありません。'); process.exit(1); }
let host = '(不明)'; try { host = new URL(url).hostname; } catch { /* ignore */ }
const redis = new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 10000, lazyConnect: true });
try {
  await redis.connect();
  console.log(`\n接続先：${host}（読み取りのみ）\n`);
  console.log(formatReport(label, await collectAccounts(redis)));
} catch (err) {
  console.error('エラー：', err.message);
  process.exitCode = 1;
} finally { redis.disconnect(); }

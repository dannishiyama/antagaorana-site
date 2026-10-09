# ローカルE2E（本物の画面 × 本物のAPI × メモリ上のRedis）

管理画面（`/haku-community/admin/`）と会員ホームを、本物のAPI（`api/admin.js` `api/community-auth.js` `api/haku-home.js`）につないで、
ブラウザ（Chromium）で実際に操作して確認します。保存先はメモリ上のRedis（ioredis-mock）で、
**本物のRedis（Preview / Production）には一切接続しません**。管理者・会員のIDとパスワードは、このテスト内で作る使い捨ての値です。

## 実行方法

```bash
npm install --no-save --legacy-peer-deps ioredis@5 ioredis-mock react@18 react-dom@18   # package.json は変更されません
npx playwright install chromium                                                          # 初回のみ
node tests-e2e-local/admin-points.e2e.mjs
```

## 確認している内容（`admin-points.e2e.mjs`）

- 管理者ログイン → 会員一覧（既定はHAKU Community）
- 会員検索：氏名・氏名の一部・ふりがな（ひらがな／カタカナ）・表示名・メールアドレス・大文字小文字・前後空白・0件・解除・既存フィルターとの組み合わせ
- 検索 → 対象会員 → HAKUポイント 付与（+100, +50）→ 調整（-20）→ 最終130pt、履歴
- 入力バリデーション、連打・二重送信、通信が切れた場合の自動再送、取消（元の履歴は消えない）
- 会員資格がない人への付与の拒否、一般会員・未ログインからの操作の拒否、管理者ロール
- 「HAKUポイント」タブの全会員履歴、会員側 `#point` が同じ残高になること

## 朝の集まり・プロフィール画像（`morning-profile.e2e.mjs`）

```bash
node tests-e2e-local/morning-profile.e2e.mjs
```

- 2人の会員（別々のブラウザ）で、朝の集まりカレンダー：誰もいない日＝開催予定なし → Aが参加で開催予定 → Bから見える → Bも参加 → Aが取消がBに反映 → 全員取消で開催予定なし
- 連打しても二重参加にならない／過去日は参加・取消できない／月の移動／氏名・メールが他の会員に出ない
- マイページ →「設定とサポート」→ プロフィール設定：不正ファイルの拒否・正方形プレビュー・保存・再読み込み後も維持・PC左下／マイページ／朝の集まり参加者／ホームのカードへの反映・削除で頭文字に戻る・表示名の変更
- スマホ幅（390px）で横スクロールがないこと、既存の「集う」（通常イベント）の参加・取消に影響がないこと


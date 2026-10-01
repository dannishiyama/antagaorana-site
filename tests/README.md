# E2Eテスト（Playwright）

HAKU Community / 教育者のサロン 灯 の主要フローを、固定Preview URL
(`https://antagaorana-haku-tomoshibi-preview.vercel.app`) に対して検証する。

## 実行方法

```bash
npm install
npx playwright install --with-deps chromium
npx playwright test
```

## 必要な環境変数（`.env.local` などGit管理外のファイルに置くこと。絶対にコミットしない）

| 変数名 | 用途 | 省略時の挙動 |
|---|---|---|
| `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` | 管理者API系テスト用の個別管理者アカウント（テスト専用アカウントを別途作成すること） | 未設定だとそのテストが失敗する |
| `HAKU_STRIPE_WEBHOOK_SECRET` | Stripe Webhook fixtureイベントの自前署名に使用（Vercelに設定済みの値と同じもの） | 未設定だと該当テストはskipされる |
| `PLAYWRIGHT_BASE_URL` | 対象URLを変更したい場合のみ | 固定Preview URL |

## カバーしている項目

- 灯: 申請 → 管理者ログイン → 承認（`tomoshibi-flow.spec.js`）
- HAKU: Stripe Webhookの3イベント（`checkout.session.completed` / 冪等性 / `customer.subscription.deleted` / livemode遮断）を fixture で検証（`haku-webhook-fixture.spec.js`）
- 誤パスワード・未登録ユーザー・未ログイン直アクセス拒否・テンプレート非公開・パスワードリセットのユーザー列挙耐性・管理API未認証拒否・Origin検証・レート制限（`security.spec.js`）
- 390px/768px幅での横スクロール有無（`mobile.spec.js`）

## 自動化できていない項目（手動確認が必要）

- **メールを実際に受信してのパスワード設定/リセット完了まで**: ResendはテストのToアドレスとして
  `@example.com` 等のプレースホルダードメインを拒否するため、実在するメールアドレスでしか
  最後まで自動化できない。実施する場合は、実メールアドレスを使い、受信したメール内のリンクから
  `token` パラメータを手動で取得してテストコードに渡す必要がある。
- **Stripe Checkoutの実UI操作（カード入力〜決済完了）**: Stripe Checkoutのカード入力欄は
  クロスオリジンiframe内にあり、自動化が壊れやすいため、今回は意図的に対象外とし、
  Webhook側をfixtureイベントで検証する方式を採用した（ユーザー指示に基づく）。
- **community別アクセス制御・表示名動的反映・ログアウトの完全なUI経由確認**: ロジックはAPI
  レベルで検証済み（開発中の手動テストでも確認済み）だが、実際にログイン済みセッションを
  作るには「本物のメールで登録 → 承認 → パスワード設定」を経由する必要があり、CI上で
  毎回それを行うのは非現実的。将来的にはテスト専用のシード用DBスナップショットや、
  テスト専用メール受信サービス（Mailosaur等）の導入を検討。

-- =====================================================================
-- 共育ゼミ 申込・決済管理テーブル
-- 作成日: 2026-08-27
--
-- 実行方法:
--   Supabase Dashboard > SQL Editor にこのファイルの内容をコピーして実行
--
-- 冪等性設計:
--   stripe_event_id に UNIQUE 制約を付け、同一イベントの二重登録を防ぐ。
--   Webhook ハンドラは ON CONFLICT 時に既存レコードを参照し、
--   email_status が 'sent' なら再送しない。
-- =====================================================================

-- updated_at 自動更新関数（他テーブルでも共有可能）
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 共育ゼミ申込テーブル
CREATE TABLE IF NOT EXISTS benkyokai_registrations (
  id                          UUID            DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Stripe 識別子（冪等性の基準）
  stripe_event_id             TEXT            NOT NULL UNIQUE,  -- Webhook Event ID
  stripe_checkout_session_id  TEXT            NOT NULL UNIQUE,  -- Checkout Session ID
  stripe_payment_intent_id    TEXT,                             -- Payment Intent ID（任意）
  stripe_customer_id          TEXT,                             -- Stripe Customer ID（任意）

  -- 参加者情報
  customer_name               TEXT,                             -- 氏名（Stripe customer_details.name）
  customer_email              TEXT            NOT NULL,          -- メールアドレス

  -- 商品・決済情報
  product_name                TEXT            NOT NULL DEFAULT '共育ゼミ',
  amount                      INTEGER         NOT NULL,          -- 金額（円）
  currency                    TEXT            NOT NULL DEFAULT 'jpy',
  payment_status              TEXT            NOT NULL,          -- 'paid' | 'unpaid' など

  -- 開催回情報（申込時点の環境変数値を保存）
  event_date                  TEXT,                             -- 例: 2026年8月30日（日）
  event_time                  TEXT,                             -- 例: 20:00〜21:30

  -- 申込日時
  application_date            TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  -- メール送信状態
  -- 'pending'      = 未送信（新規登録直後）
  -- 'sent'         = 送信済み（この状態では絶対に再送しない）
  -- 'failed'       = 送信失敗（Stripe再試行時に再送を試みる）
  -- 'test_skipped' = テストモードでスキップ
  email_status                TEXT            NOT NULL DEFAULT 'pending',
  email_sent_at               TIMESTAMPTZ,                      -- 送信成功日時
  email_error                 TEXT,                             -- 最後のエラーメッセージ

  -- 返金・振替管理（V1: 手動管理。Supabase上で直接更新）
  -- 'none'         = なし
  -- 'requested'    = 依頼中
  -- 'refunded'     = 返金完了
  -- 'transferred'  = 振替完了
  refund_status               TEXT            NOT NULL DEFAULT 'none',
  transfer_status             TEXT            NOT NULL DEFAULT 'none',

  -- 運営メモ（手動記入用。返金・振替の経緯など）
  notes                       TEXT,

  -- タイムスタンプ
  created_at                  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_benkyokai_email
  ON benkyokai_registrations (customer_email);

CREATE INDEX IF NOT EXISTS idx_benkyokai_email_status
  ON benkyokai_registrations (email_status);

CREATE INDEX IF NOT EXISTS idx_benkyokai_event_date
  ON benkyokai_registrations (event_date);

CREATE INDEX IF NOT EXISTS idx_benkyokai_created_at
  ON benkyokai_registrations (created_at DESC);

-- updated_at 自動更新トリガー
CREATE TRIGGER trigger_benkyokai_updated_at
  BEFORE UPDATE ON benkyokai_registrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- テーブルコメント
COMMENT ON TABLE benkyokai_registrations IS '共育ゼミ（オンライン勉強会）申込・決済管理テーブル。Stripe Webhookから自動登録。';
COMMENT ON COLUMN benkyokai_registrations.stripe_event_id IS 'Stripe Webhook イベントID。UNIQUE制約で二重登録を防ぐ冪等性の基準。';
COMMENT ON COLUMN benkyokai_registrations.email_status IS 'メール送信状態: pending=未送信 / sent=送信済み（再送禁止） / failed=失敗（再試行対象） / test_skipped=テストスキップ';
COMMENT ON COLUMN benkyokai_registrations.refund_status IS '返金状態: none=なし / requested=依頼中 / refunded=完了 ※V1は手動管理';
COMMENT ON COLUMN benkyokai_registrations.transfer_status IS '振替状態: none=なし / requested=依頼中 / transferred=完了 ※V1は手動管理';
COMMENT ON COLUMN benkyokai_registrations.notes IS '運営メモ（手動記入）。返金・振替の経緯、特記事項など。';

-- =====================================================================
-- Row Level Security (RLS) 設定
-- Webhook は SERVICE ROLE KEY を使うため RLS の影響を受けない。
-- 将来の管理者ダッシュボード用に RLS を有効化しておく。
-- =====================================================================
ALTER TABLE benkyokai_registrations ENABLE ROW LEVEL SECURITY;

-- anon / authenticated ユーザーはアクセス不可（サービスロールのみ）
-- 将来、管理者ロールを追加する場合はここにポリシーを追記する。
-- 例: CREATE POLICY "admin_all" ON benkyokai_registrations
--       FOR ALL TO authenticated
--       USING (auth.jwt() ->> 'role' = 'admin');

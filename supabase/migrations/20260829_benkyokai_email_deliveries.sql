-- 同一参加者・同一開催回への案内メールを1通に制限する送信台帳。
-- 決済レコード自体は benkyokai_registrations に全件保存する。
CREATE TABLE IF NOT EXISTS benkyokai_email_deliveries (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  delivery_key      TEXT        NOT NULL UNIQUE,
  owner_event_id    TEXT        NOT NULL,
  customer_email    TEXT        NOT NULL,
  event_date        TEXT,
  product_name      TEXT        NOT NULL DEFAULT '共育ゼミ',
  status            TEXT        NOT NULL DEFAULT 'pending',
  resend_email_id   TEXT,
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_benkyokai_email_deliveries_owner
  ON benkyokai_email_deliveries (owner_event_id);

CREATE TRIGGER trigger_benkyokai_email_deliveries_updated_at
  BEFORE UPDATE ON benkyokai_email_deliveries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE benkyokai_email_deliveries ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE benkyokai_email_deliveries IS
  '同一メールアドレス・同一開催回への参加案内を1通に制限する送信台帳。サービスロールのみアクセス可能。';

-- supabase/schema.sql
-- HAKU Community / 教育者のサロン 灯 専用スキーマ。
--
-- 重要: これは既存本番Supabase（api/stripe-webhook.js が使う既存プロジェクト）とは
-- 別の、新規作成する専用Supabaseプロジェクトに対して適用することを想定している。
-- 既存本番プロジェクトのSQL Editorでは絶対に実行しないこと。
--
-- 適用後、Vercel Preview環境変数に以下を追加すると api/_lib/store.js が自動的にこちらを
-- 使うようになる（DB_BACKEND=postgres も併せて設定すること。詳細は api/_lib/store.js 参照）:
--   HT_SUPABASE_URL
--   HT_SUPABASE_SERVICE_ROLE_KEY
--   DB_BACKEND=postgres
--
-- Session・パスワード設定/再設定トークン・レート制限・Stripe顧客ID索引・Webhook idempotency
-- ledgerはこのスキーマに含まれない（Redisに残す設計。api/_lib/store.redis.js 参照）。

create table if not exists ht_users (
  email           text primary key,
  full_name       text not null default '',
  full_name_kana  text not null default '',
  display_name    text not null default '',
  password_hash   text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists ht_applications (
  id              bigint generated always as identity primary key,
  email           text not null,
  community       text not null check (community in ('haku', 'tomoshibi')),
  full_name       text not null default '',
  full_name_kana  text not null default '',
  display_name    text not null default '',
  reason          text default '',
  referrer_name   text default '',
  status          text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'paid')),
  applied_at      timestamptz not null default now(),
  reviewed_at     timestamptz,
  reviewed_by     text,
  terms_version   text,
  terms_accepted_at timestamptz
);
create index if not exists ht_applications_pending_idx on ht_applications (community, status) where status = 'pending';
create index if not exists ht_applications_email_idx on ht_applications (email);

create table if not exists ht_memberships (
  id                     bigint generated always as identity primary key,
  email                  text not null,
  community              text not null check (community in ('haku', 'tomoshibi')),
  -- 'canceling': 解約予約済み（cancel_at_period_end=true）だが、現在の請求期間はまだ
  -- 終了していない状態。アクセス制御上は'active'と同様に扱う（api/_lib/store.js参照）。
  status                 text not null default 'active' check (status in ('active', 'past_due', 'canceling', 'canceled', 'inactive')),
  role                   text not null default 'member',
  plan                   text,
  source                 text,                    -- 'admin' | 'stripe' | 'debug' 等
  stripe_customer_id     text,
  stripe_subscription_id text,
  -- 解約予約（cancel_at_period_end）関連。Stripeのcustomer.subscription.updated/deleted
  -- Webhookと、会員自身の解約操作（api/community-auth.js handleCancelMembership）の
  -- 両方から書き込まれる。
  cancel_at_period_end   boolean not null default false,
  current_period_end     timestamptz,
  canceled_at            timestamptz,
  joined_at              timestamptz not null default now(),
  activated_at           timestamptz,
  updated_at             timestamptz not null default now(),
  unique (community, email)
);
create index if not exists ht_memberships_stripe_customer_idx on ht_memberships (stripe_customer_id);

create table if not exists ht_admin_users (
  email         text primary key,
  password_hash text not null,
  role          text not null default 'super_admin' check (role in ('super_admin', 'community_moderator')),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists ht_audit_log (
  id          bigint generated always as identity primary key,
  actor_id    text not null,
  action      text not null,
  target_id   text,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists ht_audit_log_created_idx on ht_audit_log (created_at desc);

-- Row Level Security: このテーブル群はサーバー（service_role key）からのみ操作する想定。
-- クライアントから直接叩かせないため、RLSを有効化した上でポリシーは追加しない
-- （service_role keyはRLSをバイパスするため、サーバーサイドの操作には影響しない）。
alter table ht_users enable row level security;
alter table ht_applications enable row level security;
alter table ht_memberships enable row level security;
alter table ht_admin_users enable row level security;
alter table ht_audit_log enable row level security;

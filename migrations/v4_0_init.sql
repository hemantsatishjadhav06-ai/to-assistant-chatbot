-- TO Assistant v4.0 — initial schema.
-- Apply once, in order, against the v4 Supabase project.
-- Safe to re-run (uses IF NOT EXISTS).

create extension if not exists "pgcrypto";

-- ========== customers ==========
create table if not exists customers (
  id                   uuid primary key default gen_random_uuid(),
  magento_customer_id  int  unique,
  email                text unique not null,
  phone                text,
  first_name           text,
  last_name            text,
  -- learned preferences
  shoe_size            numeric,
  grip                 text,
  preferred_brand      text,
  skill_level          text,
  preferred_sport      text,
  last_max_price       int,
  -- consent: OPT-IN. false until the user explicitly says "remember me".
  consent_personalise  boolean default false,
  consent_at           timestamptz,
  -- housekeeping
  created_at           timestamptz default now(),
  updated_at           timestamptz default now(),
  last_seen_at         timestamptz
);

create index if not exists customers_email_idx on customers (lower(email));
create index if not exists customers_phone_idx on customers (phone);
create index if not exists customers_magento_idx on customers (magento_customer_id);

-- ========== sessions ==========
create table if not exists sessions (
  id            text primary key,
  customer_id   uuid references customers(id) on delete set null,
  slots         jsonb default '{}'::jsonb,
  last_shown    jsonb default '[]'::jsonb,
  turns         int  default 0,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists sessions_customer_idx on sessions (customer_id);
create index if not exists sessions_updated_idx on sessions (updated_at);

-- ========== messages ==========
create table if not exists messages (
  id           bigserial primary key,
  session_id   text references sessions(id) on delete cascade,
  customer_id  uuid references customers(id) on delete set null,
  role         text check (role in ('user','assistant','tool','system')) not null,
  content      text,
  intent       text,
  slots        jsonb,
  tool_name    text,
  tool_args    jsonb,
  tool_result  jsonb,
  created_at   timestamptz default now()
);
create index if not exists messages_session_idx on messages (session_id, created_at);
create index if not exists messages_customer_idx on messages (customer_id, created_at desc);

-- ========== purchases ==========
create table if not exists purchases (
  id                bigserial primary key,
  customer_id       uuid references customers(id) on delete cascade,
  magento_order_id  text,
  sku               text,
  name              text,
  qty               int,
  price             numeric,
  ordered_at        timestamptz,
  status            text,
  awb               text
);
create unique index if not exists purchases_uniq on purchases (magento_order_id, sku);
create index if not exists purchases_customer_idx on purchases (customer_id, ordered_at desc);

-- ========== actions (audit) ==========
create table if not exists actions (
  id                  bigserial primary key,
  session_id          text,
  customer_id         uuid references customers(id),
  action              text not null,
  params              jsonb,
  result              jsonb,
  status              text check (status in ('proposed','confirmed','executed','failed','cancelled')) default 'proposed',
  confirmation_token  text unique,
  created_at          timestamptz default now(),
  confirmed_at        timestamptz,
  executed_at         timestamptz,
  failed_reason       text
);
create index if not exists actions_session_idx on actions (session_id, created_at desc);
create index if not exists actions_customer_idx on actions (customer_id, created_at desc);
create index if not exists actions_pending_idx on actions (status) where status in ('proposed','confirmed');

-- ========== stringing_bookings ==========
create table if not exists stringing_bookings (
  id               bigserial primary key,
  customer_id      uuid references customers(id),
  racquet          text,
  string_sku       text,
  tension_main     int,
  tension_cross    int,
  slot_start       timestamptz,
  slot_end         timestamptz,
  status           text default 'pending',
  notes            text,
  created_at       timestamptz default now()
);

-- keep updated_at current on customers + sessions
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end $$ language plpgsql;

drop trigger if exists t_customers_touch on customers;
create trigger t_customers_touch before update on customers
  for each row execute function touch_updated_at();

drop trigger if exists t_sessions_touch on sessions;
create trigger t_sessions_touch before update on sessions
  for each row execute function touch_updated_at();

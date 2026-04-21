-- BankBot Vision — canonical schema.
-- Apply via Supabase SQL editor (or `psql` against a local Postgres).
-- Run `policies.sql` after this file.

-- Extensions -----------------------------------------------------------------
create extension if not exists "pgcrypto";

-- accounts -------------------------------------------------------------------
-- One row per authenticated user. user_id references auth.users on Supabase.
-- On a plain Postgres (docker-compose), auth.users won't exist; the FK is
-- wrapped so it's only added when the auth schema is present.
create table if not exists accounts (
  user_id          uuid primary key,
  first_name       text not null,
  last_name        text not null,
  address          text,
  date_of_birth    date,
  chequing_balance numeric(12,2) not null default 0,
  savings_balance  numeric(12,2) not null default 0,
  credit_balance   numeric(12,2) not null default 0,
  credit_limit     numeric(12,2) not null default 0,
  credit_score     int check (credit_score is null or credit_score between 300 and 900),
  last_login_at    timestamptz,
  last_login_loc   text,
  face_descriptor  real[],          -- populated in Phase 2 (128-dim face-api.js vector)
  face_image_path  text,            -- Supabase Storage path, populated in Phase 2
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'auth')
     and not exists (
       select 1 from pg_constraint where conname = 'accounts_user_id_fkey'
     )
  then
    alter table accounts
      add constraint accounts_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- expenses -------------------------------------------------------------------
create table if not exists expenses (
  id          bigserial primary key,
  user_id     uuid not null references accounts(user_id) on delete cascade,
  category    text not null,        -- food | rent | transport | subscriptions | ...
  amount      numeric(12,2) not null check (amount >= 0),
  occurred_at date not null,
  created_at  timestamptz not null default now()
);

create index if not exists expenses_user_occurred_idx
  on expenses (user_id, occurred_at desc);

-- updated_at trigger ---------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists accounts_set_updated_at on accounts;
create trigger accounts_set_updated_at
  before update on accounts
  for each row execute function set_updated_at();

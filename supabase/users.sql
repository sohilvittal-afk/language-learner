-- Run this once in the Supabase SQL Editor, BEFORE supabase/profiles.sql
-- (profiles.id references this table).
--
-- This app no longer uses Supabase Auth — it owns its own accounts here.
-- Passwords are hashed with bcrypt in server.js before they ever reach this
-- table; password_hash never holds a plaintext or reversibly-encrypted value.

create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

alter table public.users enable row level security;

-- No policies, intentionally: there is no Supabase Auth session for these
-- users, so auth.uid() is always null and RLS would deny anon/authenticated
-- access anyway. This table is only ever touched server-side through the
-- Supabase service role key (see getServiceRoleClient in lib/supabaseClient.js),
-- which bypasses RLS entirely.

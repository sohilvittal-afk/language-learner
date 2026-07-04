-- Run this once in the Supabase SQL Editor, AFTER supabase/profiles.sql.
--
-- Stores lesson/education posts (title, body, optional image) that super
-- admins publish from the dashboard's Content Management panel. Every
-- logged-in user, regardless of role, can read these — see GET
-- /api/education in server.js, which only requires being logged in.

create table if not exists public.education_content (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  image_url text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.education_content enable row level security;

-- No policies, intentionally: same reasoning as users.sql/profiles.sql --
-- there is no Supabase Auth session for RLS to key off of, so this table is
-- only ever touched server-side via the service role key, which bypasses
-- RLS. Authorization (super_admin only for writes) is enforced in
-- server.js's requireRole('super_admin') middleware.

-- Public storage bucket for the images/screenshots attached to posts above.
-- Marked public so the browser can load images directly from the returned
-- URL without a Supabase Auth session (same reasoning as the table itself:
-- there isn't one). Uploads still only ever happen server-side, through the
-- service role key, after the POST /api/education super_admin check.
insert into storage.buckets (id, name, public)
values ('education-content', 'education-content', true)
on conflict (id) do nothing;

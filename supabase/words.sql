-- Run this once in the Supabase SQL Editor, AFTER supabase/users.sql.
--
-- The master vocabulary bank. Every word a learner can encounter — in
-- flashcard review or in a generated Side Quest story — lives here.
-- Admins and super admins add/remove words (see requireRole('admin') on the
-- write routes in server.js); every logged-in user can read the list.

create table if not exists public.words (
  id uuid primary key default gen_random_uuid(),
  term text not null,
  definition text not null,
  example_sentence text,
  part_of_speech text,
  difficulty text not null default 'medium' check (difficulty in ('easy', 'medium', 'hard')),
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Case-insensitive uniqueness so "Serendipity" and "serendipity" aren't both addable.
create unique index if not exists words_term_lower_idx on public.words (lower(term));

alter table public.words enable row level security;

-- No policies, intentionally: same reasoning as users.sql — no Supabase Auth
-- session exists, so this table is only ever touched via the service role key.

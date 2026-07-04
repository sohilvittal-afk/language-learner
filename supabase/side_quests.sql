-- Run this once in the Supabase SQL Editor, AFTER supabase/words.sql.
--
-- One row per generated Side Quest: an AI-written short story/conversation
-- that weaves in up to 5 words from a learner's word bank, plus a short
-- comprehension quiz used to grade it. `sequence_number` is per-user
-- (1, 2, 3, ...) and drives the journey-map order on side-quests.html.
--
-- `quiz` holds the correct answers (`correctIndex`) — server.js strips those
-- out of the JSON sent to the browser until the quest is completed, so the
-- gate is enforced server-side, not just by hiding it in the UI.

create table if not exists public.side_quests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  sequence_number integer not null,
  title text not null,
  setting text,
  lines jsonb not null,
  quiz jsonb not null,
  word_ids uuid[] not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  score integer,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists side_quests_user_idx on public.side_quests (user_id, sequence_number);

alter table public.side_quests enable row level security;

-- No policies, intentionally: same reasoning as users.sql — this table is
-- only ever touched server-side via the service role key.

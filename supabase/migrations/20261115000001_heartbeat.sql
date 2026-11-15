-- Keep-alive heartbeat.
--
-- The free tier pauses projects it considers idle, and a read-only ping
-- (an anon SELECT that RLS turns into an empty list) did not prevent that:
-- the project paused within 3 days of a successful ping twice in Oct 2026.
-- The keep-alive workflow now calls public.heartbeat(), which performs a real
-- write, so each ping is genuine database activity.
--
-- The table holds one row. Clients cannot touch it directly; the only access
-- is the security-definer function below, which bumps a counter and returns
-- the new values.

create table public.heartbeat (
  id        smallint primary key default 1 check (id = 1),
  beats     bigint      not null default 0,
  last_beat timestamptz not null default now()
);

insert into public.heartbeat (id) values (1);

alter table public.heartbeat enable row level security;
-- No policies: direct reads and writes are denied to anon/authenticated.

create or replace function public.heartbeat()
returns table (beats bigint, last_beat timestamptz)
language sql
security definer
set search_path = ''
as $$
  update public.heartbeat h
     set beats = h.beats + 1,
         last_beat = now()
   where h.id = 1
  returning h.beats, h.last_beat;
$$;

revoke all on function public.heartbeat() from public;
grant execute on function public.heartbeat() to anon, authenticated;

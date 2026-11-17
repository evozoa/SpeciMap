-- Location checks: every rescan of a specimen or subsample tag after
-- collection logs where and when it was scanned, so the object's last known
-- location can be traced (e.g. after a collection is moved or reorganized).
-- These are not captures: they never change the specimen's collection date
-- or place, and are never flagged as tag reuse.

create table public.tag_scans (
  id             uuid primary key,  -- client-generated (idempotent offline sync)
  tag_id         text not null references public.tags (id),
  scanned_by     uuid not null references public.profiles (id),
  scanned_at     timestamptz not null,
  lat            double precision check (lat between -90 and 90),
  lng            double precision check (lng between -180 and 180),
  gps_accuracy_m real,
  place          text,              -- what the collector typed, e.g. "Range 4, shelf B"
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check ((lat is null) = (lng is null))
);

create index tag_scans_tag_idx on public.tag_scans (tag_id, scanned_at desc);

alter table public.tag_scans enable row level security;

create policy "scans: select own" on public.tag_scans
  for select to authenticated using (scanned_by = auth.uid());
create policy "scans: insert own" on public.tag_scans
  for insert to authenticated with check (scanned_by = auth.uid());
create policy "scans: update own" on public.tag_scans
  for update to authenticated using (scanned_by = auth.uid());
create policy "scans: delete own" on public.tag_scans
  for delete to authenticated using (scanned_by = auth.uid());

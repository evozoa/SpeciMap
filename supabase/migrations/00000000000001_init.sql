-- SpeciMap initial schema: profiles, tag batches, tags, specimens, photos,
-- row-level security, and the specimen-photos storage bucket.

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "own profile: select" on public.profiles
  for select using (auth.uid() = id);
create policy "own profile: update" on public.profiles
  for update using (auth.uid() = id);

-- Auto-create a profile row on signup.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ------------------------------------------------------------- tag batches
create table public.tag_batches (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references public.profiles (id),
  label text,
  prefix text,
  tag_count int not null check (tag_count between 1 and 10000),
  format text not null check (format in ('insert', 'punch', 'both')),
  page_size text not null check (page_size in ('letter', 'a4')),
  created_at timestamptz not null default now()
);

alter table public.tag_batches enable row level security;

-- Any signed-in user can resolve batches (teams share printed sheets).
create policy "batches: select" on public.tag_batches
  for select to authenticated using (true);
create policy "batches: insert own" on public.tag_batches
  for insert to authenticated with check (created_by = auth.uid());

-- -------------------------------------------------------------------- tags
-- id is the printed, checksummed Crockford Base32 identifier (9 chars).
create table public.tags (
  id text primary key check (id ~ '^[0-9A-HJKMNP-TV-Z]{8}[0-9A-HJKMNP-TV-Z*~$=U]$'),
  batch_id uuid references public.tag_batches (id),
  seq int,
  created_at timestamptz not null default now()
);

create index tags_batch_idx on public.tags (batch_id, seq);

alter table public.tags enable row level security;

create policy "tags: select" on public.tags
  for select to authenticated using (true);
-- batch_id may be null: the orphan-tag path lets offline captures of
-- unregistered tags sync without foreign-key failures.
create policy "tags: insert" on public.tags
  for insert to authenticated with check (true);

-- --------------------------------------------------------------- specimens
create table public.specimens (
  id uuid primary key, -- client-generated (idempotent offline sync)
  tag_id text not null references public.tags (id),
  collector_id uuid not null references public.profiles (id),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  gps_accuracy_m real,
  location_adjusted boolean not null default false,
  captured_at timestamptz not null,
  notes text,
  focus_score real,
  client_meta jsonb,
  created_at timestamptz not null default now(),
  unique (tag_id, collector_id, captured_at)
);

create index specimens_collector_idx on public.specimens (collector_id, captured_at desc);
create index specimens_tag_idx on public.specimens (tag_id);

alter table public.specimens enable row level security;

create policy "specimens: select own" on public.specimens
  for select to authenticated using (collector_id = auth.uid());
create policy "specimens: insert own" on public.specimens
  for insert to authenticated with check (collector_id = auth.uid());
create policy "specimens: update own" on public.specimens
  for update to authenticated using (collector_id = auth.uid());
create policy "specimens: delete own" on public.specimens
  for delete to authenticated using (collector_id = auth.uid());

-- ---------------------------------------------------------- specimen photos
create table public.specimen_photos (
  id uuid primary key, -- client-generated
  specimen_id uuid not null references public.specimens (id) on delete cascade,
  storage_path text not null,
  width int,
  height int,
  bytes int,
  created_at timestamptz not null default now()
);

create index specimen_photos_specimen_idx on public.specimen_photos (specimen_id);

alter table public.specimen_photos enable row level security;

create policy "photos: select own" on public.specimen_photos
  for select to authenticated using (
    exists (
      select 1 from public.specimens s
      where s.id = specimen_id and s.collector_id = auth.uid()
    )
  );
create policy "photos: insert own" on public.specimen_photos
  for insert to authenticated with check (
    exists (
      select 1 from public.specimens s
      where s.id = specimen_id and s.collector_id = auth.uid()
    )
  );
create policy "photos: delete own" on public.specimen_photos
  for delete to authenticated using (
    exists (
      select 1 from public.specimens s
      where s.id = specimen_id and s.collector_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------- storage
insert into storage.buckets (id, name, public)
values ('specimen-photos', 'specimen-photos', false);

-- Path convention: {collector uid}/{specimen id}/{photo id}.jpg
create policy "photo objects: insert own folder" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'specimen-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "photo objects: update own folder" on storage.objects
  for update to authenticated using (
    bucket_id = 'specimen-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "photo objects: select own folder" on storage.objects
  for select to authenticated using (
    bucket_id = 'specimen-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

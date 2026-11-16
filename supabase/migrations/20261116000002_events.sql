-- Collecting events (dwc:Event), started by scanning a pre-printed field sheet.
--
-- A field sheet's QR tag is its eventID, so two phones that scan the same
-- sheet offline write the same event. Parent events (field sheets linked at
-- one site, dwc:parentEventID) will use generated IDs and have no tag.
-- Column names follow Darwin Core terms in snake_case.

alter table public.tag_batches drop constraint tag_batches_format_check;
alter table public.tag_batches add constraint tag_batches_format_check
  check (format in ('insert', 'punch', 'both', 'insert_2ml', 'fieldsheet'));

create table public.events (
  id                               text primary key,             -- dwc:eventID
  tag_id                           text unique references public.tags (id),
  parent_event_id                  text references public.events (id),
  created_by                       uuid not null references public.profiles (id),
  field_number                     text,                         -- dwc:fieldNumber
  recorded_by                      text,                         -- dwc:recordedBy
  event_date                       timestamptz not null,         -- start
  event_end                        timestamptz,                  -- end (dwc:eventDate interval)
  decimal_latitude                 double precision check (decimal_latitude between -90 and 90),
  decimal_longitude                double precision check (decimal_longitude between -180 and 180),
  coordinate_uncertainty_in_meters real,
  locality                         text,
  water_body                       text,
  county                           text,
  state_province                   text,
  country_code                     text,
  sampling_protocol                text,
  sampling_effort                  text,
  habitat                          text,
  event_remarks                    text,
  created_at                       timestamptz not null default now(),
  updated_at                       timestamptz not null default now()
);

create index events_created_by_idx on public.events (created_by, event_date desc);

alter table public.events enable row level security;

create policy "events: select own" on public.events
  for select to authenticated using (created_by = auth.uid());
create policy "events: insert own" on public.events
  for insert to authenticated with check (created_by = auth.uid());
create policy "events: update own" on public.events
  for update to authenticated using (created_by = auth.uid());
create policy "events: delete own" on public.events
  for delete to authenticated using (created_by = auth.uid());

-- Photos of the completed field sheet (dwc:fieldNotes points at these).
create table public.event_photos (
  id           uuid primary key,  -- client-generated
  event_id     text not null references public.events (id) on delete cascade,
  storage_path text not null,
  width        int,
  height       int,
  bytes        int,
  created_at   timestamptz not null default now()
);

create index event_photos_event_idx on public.event_photos (event_id);

alter table public.event_photos enable row level security;

create policy "event photos: select own" on public.event_photos
  for select to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.created_by = auth.uid())
  );
create policy "event photos: insert own" on public.event_photos
  for insert to authenticated with check (
    exists (select 1 from public.events e where e.id = event_id and e.created_by = auth.uid())
  );
create policy "event photos: update own" on public.event_photos
  for update to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.created_by = auth.uid())
  );
create policy "event photos: delete own" on public.event_photos
  for delete to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.created_by = auth.uid())
  );

-- The event a capture was made during.
alter table public.specimens add column event_id text references public.events (id);
create index specimens_event_idx on public.specimens (event_id);

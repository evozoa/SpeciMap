-- Subsamples (dwc:MaterialSample derived from a specimen), e.g. a fin clip
-- in a 2 mL tube. Any SpeciMap tag can be a subsample: its rank is chosen
-- when the tag is first scanned, not when it is printed.
--
-- The parent is the specimen's tag (dwc:materialEntityID of the specimen).
-- It references tags, not material_entities: a subsample recorded offline
-- may upload before its parent's first capture does.

create table public.material_samples (
  tag_id        text primary key references public.tags (id),  -- dwc:materialSampleID
  parent_tag_id text not null references public.tags (id),     -- the specimen
  created_by    uuid not null references public.profiles (id),
  event_id      text references public.events (id),
  sample_type   text,       -- e.g. fin clip, muscle, liver
  preservation  text,       -- e.g. 95% ethanol, RNAlater, frozen -80 C
  remarks       text,
  collected_at  timestamptz not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (tag_id <> parent_tag_id)
);

create index material_samples_parent_idx on public.material_samples (parent_tag_id);

alter table public.material_samples enable row level security;

create policy "samples: select own" on public.material_samples
  for select to authenticated using (created_by = auth.uid());
create policy "samples: insert own" on public.material_samples
  for insert to authenticated with check (created_by = auth.uid());
create policy "samples: update own" on public.material_samples
  for update to authenticated using (created_by = auth.uid());
create policy "samples: delete own" on public.material_samples
  for delete to authenticated using (created_by = auth.uid());

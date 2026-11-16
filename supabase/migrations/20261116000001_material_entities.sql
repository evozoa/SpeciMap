-- One physical specimen per vial tag (dwc:MaterialEntity).
--
-- A tag ID is unique, so the specimen is keyed by it: two phones that record
-- the same fish offline both write to the same specimen, with no duplicate to
-- merge later. Each phone's record stays a separate capture (a row in
-- public.specimens: who, when, GPS fix, photos, identification), and captures
-- are only ever added.
--
-- Rows are created by a trigger whenever a capture is inserted or moved to
-- another tag, so every client (including older app versions) gets one.

create table public.material_entities (
  tag_id           text primary key references public.tags (id),
  created_by       uuid references public.profiles (id),
  -- dwc:individualCount: >1 when the tag is on a lot (a jar of one species).
  individual_count int not null default 1 check (individual_count >= 1),
  -- Captures the collector reviewed and confirmed are the same specimen
  -- (clears a "possible tag reuse" flag for exactly those captures).
  confirmed_capture_ids uuid[] not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

insert into public.material_entities (tag_id, created_by, created_at)
select distinct on (tag_id) tag_id, collector_id, captured_at
  from public.specimens
 order by tag_id, captured_at;

create or replace function public.ensure_material_entity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.material_entities (tag_id, created_by)
  values (new.tag_id, new.collector_id)
  on conflict (tag_id) do nothing;
  return new;
end;
$$;

create trigger specimens_ensure_material_entity
  before insert or update of tag_id on public.specimens
  for each row execute function public.ensure_material_entity();

alter table public.specimens
  add constraint specimens_material_entity_fk
  foreign key (tag_id) references public.material_entities (tag_id);

alter table public.material_entities enable row level security;

-- A collector sees and edits the specimens they have captured.
create policy "material entities: select captured" on public.material_entities
  for select to authenticated using (
    exists (select 1 from public.specimens s
             where s.tag_id = material_entities.tag_id and s.collector_id = auth.uid())
  );
create policy "material entities: update captured" on public.material_entities
  for update to authenticated using (
    exists (select 1 from public.specimens s
             where s.tag_id = material_entities.tag_id and s.collector_id = auth.uid())
  );

-- dwc:dateIdentified for the capture's identification (species), so the
-- most recent identification of a specimen can be found across captures.
alter table public.specimens add column identified_at timestamptz;
update public.specimens set identified_at = captured_at where species is not null;

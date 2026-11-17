-- Storage containers, each with its own QR tag:
--   2ml / 20ml   tube or vial box: items at A1-J10 (up to 100)
--   carton       cardboard box of fixed specimens (jars): items, numbered
--   rack         freezer rack: 2 mL / 20 mL boxes in numbered slots (12)
--   shelf        museum shelf: cartons, boxes and racks, numbered
-- Items are specimens, mixed lots, species lots or subsamples. Everything
-- is in at most one place at a time.
-- A box has custody and privacy like any specimen, so it can be shared and
-- transferred; its contents keep their own custody.

create table public.containers (
  tag_id            text primary key references public.tags (id),
  size              text not null check (size in ('20ml', '2ml', 'carton', 'rack', 'shelf')),
  label             text,                       -- e.g. "Season 2026, box 3"
  capacity          int not null default 100 check (capacity between 1 and 100),
  created_by        uuid not null references public.profiles (id),
  custodian_user    uuid references public.profiles (id),
  custodian_org     uuid references public.organizations (id),
  visibility        text not null default 'private' check (visibility in ('private', 'shared', 'public')),
  generalize_public boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table public.container_items (
  item_tag   text primary key references public.tags (id),   -- one box at a time
  box_tag    text not null references public.containers (tag_id),
  -- A1-J10 in a box; a slot number in a rack (checked against the container).
  position   text not null check (position ~ '^([A-J]([1-9]|10)|[1-9][0-9]?|100)$'),
  placed_by  uuid not null references public.profiles (id),
  placed_at  timestamptz not null,
  updated_at timestamptz not null default now(),
  unique (box_tag, position),
  check (item_tag <> box_tag)
);
create index container_items_box_idx on public.container_items (box_tag);

-- Custody covers boxes too, so privacy, sharing and transfers work on them.
create or replace function public.tag_custody(p_tag text)
returns table (custodian_user uuid, custodian_org uuid, visibility text)
language sql stable security definer set search_path = '' as $$
  select e.custodian_user, e.custodian_org, e.visibility from public.material_entities e where e.tag_id = p_tag
  union all
  select s.custodian_user, s.custodian_org, s.visibility from public.material_samples s where s.tag_id = p_tag
  union all
  select c.custodian_user, c.custodian_org, c.visibility from public.containers c where c.tag_id = p_tag
  limit 1
$$;
revoke execute on function public.tag_custody(text) from public, anon, authenticated;

-- The box's creator can always read it (like a collector).
create or replace function public.collected_tag(p_tag text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.specimens c where c.tag_id = p_tag and c.collector_id = auth.uid())
      or exists (select 1 from public.material_samples s where s.tag_id = p_tag and s.created_by = auth.uid())
      or exists (select 1 from public.containers b where b.tag_id = p_tag and b.created_by = auth.uid())
$$;

-- One rank per tag: a box tag can't become a specimen or subsample, and
-- the reverse.
create or replace function public.ensure_material_entity()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.containers b where b.tag_id = new.tag_id)
     or exists (select 1 from public.material_samples s where s.tag_id = new.tag_id) then
    raise exception 'Tag % is already used for something else', new.tag_id using errcode = '23514';
  end if;
  insert into public.material_entities (tag_id, created_by)
  values (new.tag_id, new.collector_id)
  on conflict (tag_id) do nothing;
  return new;
end;
$$;

create or replace function public.material_sample_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.custodian_user := new.created_by;
    new.custodian_org := null;
    new.visibility := 'private';
    new.catalog_number := null;
    if exists (select 1 from public.material_entities e where e.tag_id = new.tag_id)
       or exists (select 1 from public.events ev where ev.tag_id = new.tag_id)
       or exists (select 1 from public.containers b where b.tag_id = new.tag_id) then
      raise exception 'Tag % is already used for something else', new.tag_id using errcode = '23514';
    end if;
  else
    new.created_by := old.created_by;
    new.collected_at := old.collected_at;
  end if;
  return new;
end;
$$;

create or replace function public.container_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.custodian_user := new.created_by;
    new.custodian_org := null;
    new.visibility := 'private';
    if exists (select 1 from public.material_entities e where e.tag_id = new.tag_id)
       or exists (select 1 from public.material_samples s where s.tag_id = new.tag_id)
       or exists (select 1 from public.events ev where ev.tag_id = new.tag_id) then
      raise exception 'Tag % is already used for something else', new.tag_id using errcode = '23514';
    end if;
  else
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;
create trigger containers_guard before insert or update on public.containers
  for each row execute function public.container_guard();

/**
 * Boxes hold specimens, lots and subsamples at A1-J10; racks hold boxes in
 * slots 1..capacity. Within capacity.
 */
create or replace function public.container_item_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_cap int; v_n int; v_size text; v_item_size text;
begin
  select capacity, size into v_cap, v_size from public.containers where tag_id = new.box_tag for update;
  select size into v_item_size from public.containers where tag_id = new.item_tag;
  if exists (select 1 from public.events ev where ev.tag_id = new.item_tag) then
    raise exception 'A collecting event cannot be stored' using errcode = '23514';
  end if;
  -- What each kind of container holds.
  if v_size in ('2ml', '20ml', 'carton') and v_item_size is not null then
    raise exception 'Boxes hold specimens and subsamples, not other containers' using errcode = '23514';
  elsif v_size = 'rack' and coalesce(v_item_size, '') not in ('2ml', '20ml') then
    raise exception 'A rack holds 2 mL and 20 mL boxes' using errcode = '23514';
  elsif v_size = 'shelf' and coalesce(v_item_size, '') not in ('2ml', '20ml', 'carton', 'rack') then
    raise exception 'A shelf holds boxes and racks' using errcode = '23514';
  end if;
  -- Positions: a grid in tube and vial boxes, numbers elsewhere.
  if v_size in ('2ml', '20ml') then
    if new.position !~ '^[A-J]([1-9]|10)$' then
      raise exception 'Box positions are A1 to J10' using errcode = '23514';
    end if;
  elsif new.position !~ '^[0-9]+$' or new.position::int not between 1 and v_cap then
    raise exception 'Positions here are 1 to %', v_cap using errcode = '23514';
  end if;
  select count(*) into v_n from public.container_items
   where box_tag = new.box_tag and item_tag <> new.item_tag;
  if v_n >= v_cap then
    raise exception 'Box % is full (% items)', new.box_tag, v_cap using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then new.placed_by := coalesce(new.placed_by, old.placed_by); end if;
  return new;
end;
$$;
create trigger container_items_guard before insert or update on public.container_items
  for each row execute function public.container_item_guard();

-- Column privileges: custody columns only through the custody functions.
revoke update on public.containers from authenticated, anon;
grant update (tag_id, size, label, capacity, created_by, updated_at, created_at) on public.containers to authenticated;

alter table public.containers enable row level security;
alter table public.container_items enable row level security;

create policy "boxes: select readable" on public.containers
  for select to authenticated using (created_by = auth.uid() or public.can_read_tag(tag_id));
create policy "boxes: insert" on public.containers
  for insert to authenticated with check (
    created_by = auth.uid() and (public.tag_unclaimed(tag_id) or public.collected_tag(tag_id))
  );
create policy "boxes: update editable" on public.containers
  for update to authenticated using (public.can_edit_tag(tag_id));

-- Who sees a placement: anyone who can read the box or the item.
-- Who places or removes: someone who can edit both (or collected the item).
create policy "box items: select" on public.container_items
  for select to authenticated using (public.can_read_tag(box_tag) or public.can_read_tag(item_tag));
create policy "box items: insert" on public.container_items
  for insert to authenticated with check (
    placed_by = auth.uid()
    and public.can_edit_tag(box_tag)
    and (public.can_edit_tag(item_tag) or public.collected_tag(item_tag) or public.tag_unclaimed(item_tag))
  );
create policy "box items: update" on public.container_items
  for update to authenticated using (
    public.can_edit_tag(box_tag) or public.can_edit_tag(item_tag) or public.collected_tag(item_tag)
  ) with check (
    public.can_edit_tag(box_tag)
    and (public.can_edit_tag(item_tag) or public.collected_tag(item_tag) or public.tag_unclaimed(item_tag))
  );
create policy "box items: delete" on public.container_items
  for delete to authenticated using (
    public.can_edit_tag(box_tag) or public.can_edit_tag(item_tag) or public.collected_tag(item_tag)
  );

-- Privacy, sharing and transfer functions already act through tag_custody;
-- these updates make them reach boxes too.
create or replace function public.set_privacy(p_tag text, p_visibility text, p_generalize boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_curate_tag(p_tag) then
    raise exception 'Only the custodian can change who sees this' using errcode = '42501';
  end if;
  if p_visibility not in ('private', 'shared', 'public') then
    raise exception 'Unknown visibility %', p_visibility using errcode = '22023';
  end if;
  update public.material_entities set visibility = p_visibility, generalize_public = p_generalize, updated_at = now() where tag_id = p_tag;
  update public.material_samples set visibility = p_visibility, generalize_public = p_generalize, updated_at = now() where tag_id = p_tag;
  update public.containers set visibility = p_visibility, generalize_public = p_generalize, updated_at = now() where tag_id = p_tag;
end;
$$;

create or replace function public.respond_transfer(p_id uuid, p_accept boolean, p_catalog_number text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_t record;
begin
  select * into v_t from public.custody_transfers where id = p_id for update;
  if not found or v_t.status <> 'pending' then
    raise exception 'This transfer is no longer waiting' using errcode = '22023';
  end if;
  -- coalesce: with a collection as recipient, to_user is null and the
  -- comparison is null, which must count as "not the recipient".
  if not coalesce(v_t.to_user = auth.uid() or (v_t.to_org is not null and public.is_member(v_t.to_org, array['curator'])), false) then
    raise exception 'Only the recipient can accept this' using errcode = '42501';
  end if;
  update public.custody_transfers
     set status = case when p_accept then 'accepted' else 'declined' end,
         catalog_number = case when p_accept then nullif(trim(coalesce(p_catalog_number, '')), '') end,
         responded_by = auth.uid(), responded_at = now()
   where id = p_id;
  if p_accept then
    update public.material_entities
       set custodian_user = v_t.to_user, custodian_org = v_t.to_org, visibility = 'private',
           catalog_number = coalesce(nullif(trim(coalesce(p_catalog_number, '')), ''), catalog_number),
           updated_at = now()
     where tag_id = v_t.tag_id;
    update public.material_samples
       set custodian_user = v_t.to_user, custodian_org = v_t.to_org, visibility = 'private',
           catalog_number = coalesce(nullif(trim(coalesce(p_catalog_number, '')), ''), catalog_number),
           updated_at = now()
     where tag_id = v_t.tag_id;
    update public.containers
       set custodian_user = v_t.to_user, custodian_org = v_t.to_org, visibility = 'private', updated_at = now()
     where tag_id = v_t.tag_id;
    delete from public.object_shares where tag_id = v_t.tag_id;
  end if;
end;
$$;

-- Public view of a public box: its size, label, holder and item count.
create or replace function public.public_tag_info(p_tag text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_e record; v_s record; v_b record; v_first record; v_ev record; v_round boolean;
begin
  select * into v_e from public.material_entities where tag_id = p_tag;
  -- FOUND, not "v_e is not null": a row with any null column isn't "not null".
  if found then
    if v_e.visibility <> 'public' then return null; end if;
    v_round := v_e.generalize_public;
    select * into v_first from public.specimens where tag_id = p_tag order by captured_at limit 1;
    select * into v_ev from public.events where id = v_first.event_id;
    return jsonb_build_object(
      'rank', case when v_e.kind = 'mixed_lot' then 'mixed_lot' else 'specimen' end,
      'species', (select c.species from public.specimens c where c.tag_id = p_tag and c.species is not null
                   order by coalesce(c.identified_at, c.captured_at) desc limit 1),
      'composition', v_e.composition,
      'individualCount', v_e.individual_count,
      'catalogNumber', v_e.catalog_number,
      'custodian', public.party_label(v_e.custodian_user, v_e.custodian_org),
      'year', extract(year from v_first.captured_at),
      'lat', case when v_round then round(v_first.lat::numeric, 1) else v_first.lat end,
      'lng', case when v_round then round(v_first.lng::numeric, 1) else v_first.lng end,
      'generalized', v_round,
      'county', v_ev.county, 'stateProvince', v_ev.state_province, 'countryCode', v_ev.country_code,
      'waterBody', v_ev.water_body);
  end if;
  select * into v_s from public.material_samples where tag_id = p_tag;
  if found then
    if v_s.visibility <> 'public' then return null; end if;
    return jsonb_build_object(
      'rank', 'subsample',
      'sampleType', v_s.sample_type, 'preservation', v_s.preservation,
      'catalogNumber', v_s.catalog_number,
      'custodian', public.party_label(v_s.custodian_user, v_s.custodian_org),
      'year', extract(year from v_s.collected_at),
      'parent', v_s.parent_tag_id);
  end if;
  select * into v_b from public.containers where tag_id = p_tag;
  if not found or v_b.visibility <> 'public' then return null; end if;
  return jsonb_build_object(
    'rank', 'container', 'size', v_b.size, 'label', v_b.label,
    'custodian', public.party_label(v_b.custodian_user, v_b.custodian_org),
    'itemCount', (select count(*) from public.container_items i where i.box_tag = p_tag),
    'capacity', v_b.capacity);
end;
$$;

-- Chain of custody, collections, privacy, and mixed lots.
--
-- Every specimen (material_entities) and subsample (material_samples) has
-- one custodian: a person (at first, the collector) or a collection
-- (an organization, e.g. a museum's fish collection). The custodian controls
-- who can see the record. Custody changes only by a transfer that the
-- recipient accepts; transfers are logged permanently, and the donor logs
-- the object's location when starting one. A specimen and its subsamples
-- are transferred independently.
--
-- Who can read a tag's data (can_read_tag):
--   - the collector: whoever captured the specimen or created the subsample,
--     always, including its later location checks;
--   - the custodian, or any member of the custodian collection;
--   - people and collections the custodian shared it with;
--   - any signed-in user, if the custodian made it public (and anyone, via
--     public_tag_info, with coordinates generalized unless allowed).
-- Who can edit it (can_edit_tag): the custodian person, or curators and
-- staff of the custodian collection. Privacy, sharing, catalog numbers and
-- transfers (can_curate_tag): the custodian person or the collection's
-- curators.
--
-- Mixed lots: a tag on a jar holding several species (e.g. a seine haul).
-- Its contents are listed in `composition`; lots later sorted out of it
-- (species lots, individuals) point back to it with parent_tag_id.

-- ------------------------------------------------------------ collections
create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  code        text not null unique check (code ~ '^[A-Za-z0-9_-]{2,20}$'), -- e.g. AUM, MSST
  created_by  uuid not null references public.profiles (id),
  created_at  timestamptz not null default now()
);

create table public.org_members (
  org_id     uuid not null references public.organizations (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null check (role in ('curator', 'staff', 'viewer')),
  added_by   uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- Invitations for people who don't have a SpeciMap account yet.
create table public.org_invites (
  org_id     uuid not null references public.organizations (id) on delete cascade,
  email      text not null check (email = lower(email)),
  role       text not null check (role in ('curator', 'staff', 'viewer')),
  invited_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  primary key (org_id, email)
);

-- Names of people are visible to signed-in users (to show who holds or
-- sent something); emails are never exposed.
create policy "profiles: select names" on public.profiles
  for select to authenticated using (true);

-- --------------------------------------------------------------- custody
alter table public.material_entities
  add column kind text not null default 'specimen' check (kind in ('specimen', 'mixed_lot')),
  add column composition jsonb not null default '[]'::jsonb,
  add column parent_tag_id text references public.tags (id),
  add column catalog_number text,
  add column custodian_user uuid references public.profiles (id),
  add column custodian_org uuid references public.organizations (id),
  add column visibility text not null default 'private' check (visibility in ('private', 'shared', 'public')),
  add column generalize_public boolean not null default true,
  add constraint material_entities_parent_check check (parent_tag_id is null or parent_tag_id <> tag_id);

alter table public.material_samples
  add column catalog_number text,
  add column custodian_user uuid references public.profiles (id),
  add column custodian_org uuid references public.organizations (id),
  add column visibility text not null default 'private' check (visibility in ('private', 'shared', 'public')),
  add column generalize_public boolean not null default true;

update public.material_entities set custodian_user = created_by where custodian_user is null;
update public.material_samples set custodian_user = created_by where custodian_user is null;

create index material_entities_custodian_user_idx on public.material_entities (custodian_user);
create index material_entities_custodian_org_idx on public.material_entities (custodian_org);
create index material_entities_parent_idx on public.material_entities (parent_tag_id);
create index material_samples_custodian_user_idx on public.material_samples (custodian_user);
create index material_samples_custodian_org_idx on public.material_samples (custodian_org);

-- Shares made by a custodian: named people or collections can read.
create table public.object_shares (
  id         uuid primary key default gen_random_uuid(),
  tag_id     text not null references public.tags (id),
  user_id    uuid references public.profiles (id) on delete cascade,
  org_id     uuid references public.organizations (id) on delete cascade,
  label      text not null,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  check ((user_id is null) <> (org_id is null))
);
create unique index object_shares_user_uq on public.object_shares (tag_id, user_id) where user_id is not null;
create unique index object_shares_org_uq on public.object_shares (tag_id, org_id) where org_id is not null;

-- The chain of custody. Rows are written only by the functions below.
create table public.custody_transfers (
  id            uuid primary key default gen_random_uuid(),
  tag_id        text not null references public.tags (id),
  from_user     uuid references public.profiles (id),
  from_org      uuid references public.organizations (id),
  from_label    text not null,
  to_user       uuid references public.profiles (id),
  to_org        uuid references public.organizations (id),
  to_label      text not null,
  purpose       text not null check (purpose in ('accession', 'loan', 'gift', 'return', 'other')),
  note          text,
  scan_id       uuid references public.tag_scans (id), -- the donor's location log
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  catalog_number text,
  created_by    uuid not null references public.profiles (id),
  created_at    timestamptz not null default now(),
  responded_by  uuid references public.profiles (id),
  responded_at  timestamptz,
  check ((to_user is null) <> (to_org is null))
);
create index custody_transfers_tag_idx on public.custody_transfers (tag_id, created_at);
create unique index custody_transfers_one_pending on public.custody_transfers (tag_id) where status = 'pending';

-- ------------------------------------------------------- access functions
-- security definer: they read the custody tables without row-level
-- security, so policies that call them can't recurse.

create or replace function public.is_member(p_org uuid, p_roles text[] default array['curator', 'staff', 'viewer'])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.org_members m
                  where m.org_id = p_org and m.user_id = auth.uid() and m.role = any (p_roles))
$$;

/** The tag's custody row: its specimen or subsample (null if neither). */
create or replace function public.tag_custody(p_tag text)
returns table (custodian_user uuid, custodian_org uuid, visibility text)
language sql stable security definer set search_path = '' as $$
  select e.custodian_user, e.custodian_org, e.visibility from public.material_entities e where e.tag_id = p_tag
  union all
  select s.custodian_user, s.custodian_org, s.visibility from public.material_samples s where s.tag_id = p_tag
  limit 1
$$;

create or replace function public.collected_tag(p_tag text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.specimens c where c.tag_id = p_tag and c.collector_id = auth.uid())
      or exists (select 1 from public.material_samples s where s.tag_id = p_tag and s.created_by = auth.uid())
$$;

create or replace function public.can_read_tag(p_tag text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.collected_tag(p_tag)
      or exists (
        select 1 from public.tag_custody(p_tag) c
         where c.custodian_user = auth.uid()
            or (c.custodian_org is not null and public.is_member(c.custodian_org))
            or c.visibility = 'public'
            or (c.visibility = 'shared' and exists (
                  select 1 from public.object_shares sh
                   where sh.tag_id = p_tag
                     and (sh.user_id = auth.uid() or (sh.org_id is not null and public.is_member(sh.org_id)))))
      )
$$;

create or replace function public.can_edit_tag(p_tag text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tag_custody(p_tag) c
     where c.custodian_user = auth.uid()
        or (c.custodian_org is not null and public.is_member(c.custodian_org, array['curator', 'staff']))
  )
$$;

create or replace function public.can_curate_tag(p_tag text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tag_custody(p_tag) c
     where c.custodian_user = auth.uid()
        or (c.custodian_org is not null and public.is_member(c.custodian_org, array['curator']))
  )
$$;

/** True if the tag is not yet a specimen, subsample or event (anyone may start it). */
create or replace function public.tag_unclaimed(p_tag text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.tag_custody(p_tag))
     and not exists (select 1 from public.events e where e.tag_id = p_tag)
$$;

grant execute on function public.is_member(uuid, text[]), public.can_read_tag(text), public.can_edit_tag(text),
  public.can_curate_tag(text) to authenticated;

-- New specimens and subsamples start in their creator's custody, private;
-- custody columns can't be set or changed except by the functions below.
create or replace function public.material_entity_custody_defaults()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.custodian_user := coalesce(new.custodian_user, new.created_by);
  end if;
  return new;
end;
$$;
create trigger material_entities_custody_defaults
  before insert on public.material_entities
  for each row execute function public.material_entity_custody_defaults();

create or replace function public.material_sample_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.custodian_user := new.created_by;
    new.custodian_org := null;
    new.visibility := 'private';
    new.catalog_number := null;
    if exists (select 1 from public.material_entities e where e.tag_id = new.tag_id)
       or exists (select 1 from public.events ev where ev.tag_id = new.tag_id) then
      raise exception 'Tag % is already used for something else', new.tag_id using errcode = '23514';
    end if;
  else
    new.created_by := old.created_by;
    new.collected_at := old.collected_at;
  end if;
  return new;
end;
$$;
create trigger material_samples_guard
  before insert or update on public.material_samples
  for each row execute function public.material_sample_guard();

-- Column privileges: custody, privacy and catalog numbers are only written
-- by the functions below.
revoke insert, update on public.material_entities from authenticated, anon;
grant update (individual_count, confirmed_capture_ids, kind, composition, parent_tag_id, updated_at)
  on public.material_entities to authenticated;
revoke update on public.material_samples from authenticated, anon;
grant update (tag_id, parent_tag_id, created_by, event_id, sample_type, preservation, remarks, collected_at, updated_at)
  on public.material_samples to authenticated;
revoke insert, update, delete on public.custody_transfers from authenticated, anon;

-- ------------------------------------------------------------- policies
-- Captures: the collector's own, plus captures of tags the user may read.
drop policy "specimens: select own" on public.specimens;
create policy "specimens: select readable" on public.specimens
  for select to authenticated using (collector_id = auth.uid() or public.can_read_tag(tag_id));
drop policy "specimens: insert own" on public.specimens;
-- Upserts check this even when the row exists, so a collector re-sending
-- their own capture (e.g. an edited identification) after a transfer must
-- pass: collectors may keep adding to what they collected.
create policy "specimens: insert own" on public.specimens
  for insert to authenticated with check (
    collector_id = auth.uid()
    and (public.tag_unclaimed(tag_id) or public.can_edit_tag(tag_id) or public.collected_tag(tag_id))
  );

drop policy "photos: select own" on public.specimen_photos;
create policy "photos: select readable" on public.specimen_photos
  for select to authenticated using (
    exists (select 1 from public.specimens s where s.id = specimen_id)
  );

create index if not exists specimen_photos_storage_path_idx on public.specimen_photos (storage_path);
create index if not exists event_photos_storage_path_idx on public.event_photos (storage_path);
drop policy "photo objects: select own folder" on storage.objects;
create policy "photo objects: select readable" on storage.objects
  for select to authenticated using (
    bucket_id = 'specimen-photos'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.specimen_photos p where p.storage_path = name)
      or exists (select 1 from public.event_photos p where p.storage_path = name)
    )
  );

drop policy "material entities: select captured" on public.material_entities;
drop policy "material entities: update captured" on public.material_entities;
create policy "material entities: select readable" on public.material_entities
  for select to authenticated using (public.can_read_tag(tag_id));
create policy "material entities: update editable" on public.material_entities
  for update to authenticated using (public.can_edit_tag(tag_id));

drop policy "samples: select own" on public.material_samples;
drop policy "samples: insert own" on public.material_samples;
drop policy "samples: update own" on public.material_samples;
drop policy "samples: delete own" on public.material_samples;
create policy "samples: select readable" on public.material_samples
  for select to authenticated using (created_by = auth.uid() or public.can_read_tag(tag_id));
create policy "samples: insert" on public.material_samples
  for insert to authenticated with check (
    created_by = auth.uid()
    and (public.tag_unclaimed(parent_tag_id) or public.can_edit_tag(parent_tag_id) or public.collected_tag(parent_tag_id))
  );
create policy "samples: update editable" on public.material_samples
  for update to authenticated using (public.can_edit_tag(tag_id));

-- Location checks: by the custodian side or the collector; readable by
-- anyone who can read the tag (so the collector always sees where it is).
drop policy "scans: select own" on public.tag_scans;
drop policy "scans: insert own" on public.tag_scans;
create policy "scans: select readable" on public.tag_scans
  for select to authenticated using (scanned_by = auth.uid() or public.can_read_tag(tag_id));
create policy "scans: insert" on public.tag_scans
  for insert to authenticated with check (
    scanned_by = auth.uid()
    and (public.can_edit_tag(tag_id) or public.collected_tag(tag_id) or public.tag_unclaimed(tag_id))
  );

-- Events: their creator's, plus events of specimens or subsamples the user
-- can read (a museum needs the locality of what it holds).
drop policy "events: select own" on public.events;
create policy "events: select readable" on public.events
  for select to authenticated using (
    created_by = auth.uid()
    or exists (select 1 from public.specimens s where s.event_id = events.id)
    or exists (select 1 from public.material_samples m where m.event_id = events.id)
  );
drop policy "event photos: select own" on public.event_photos;
create policy "event photos: select readable" on public.event_photos
  for select to authenticated using (exists (select 1 from public.events e where e.id = event_id));

alter table public.organizations enable row level security;
alter table public.org_members enable row level security;
alter table public.org_invites enable row level security;
alter table public.object_shares enable row level security;
alter table public.custody_transfers enable row level security;

create policy "orgs: select" on public.organizations for select to authenticated using (true);
create policy "orgs: update curators" on public.organizations
  for update to authenticated using (public.is_member(id, array['curator']));

create policy "members: select" on public.org_members
  for select to authenticated using (user_id = auth.uid() or public.is_member(org_id));
create policy "members: update curators" on public.org_members
  for update to authenticated using (public.is_member(org_id, array['curator']));
create policy "members: delete" on public.org_members
  for delete to authenticated using (user_id = auth.uid() or public.is_member(org_id, array['curator']));
revoke insert on public.org_members from authenticated, anon;

create policy "invites: select" on public.org_invites
  for select to authenticated using (public.is_member(org_id, array['curator']));
create policy "invites: delete curators" on public.org_invites
  for delete to authenticated using (public.is_member(org_id, array['curator']));
revoke insert, update on public.org_invites from authenticated, anon;

create policy "shares: select" on public.object_shares
  for select to authenticated using (public.can_read_tag(tag_id));
revoke insert, update, delete on public.object_shares from authenticated, anon;

create policy "transfers: select" on public.custody_transfers
  for select to authenticated using (
    public.can_read_tag(tag_id)
    or to_user = auth.uid()
    or (to_org is not null and public.is_member(to_org))
    or created_by = auth.uid()
  );

-- -------------------------------------------------------------- functions
create or replace function public.party_label(p_user uuid, p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select o.name || ' (' || o.code || ')' from public.organizations o where o.id = p_org),
    (select coalesce(nullif(trim(p.display_name), ''), split_part(u.email, '@', 1))
       from public.profiles p join auth.users u on u.id = p.id where p.id = p_user),
    'Unknown')
$$;

/** Create a collection; the creator becomes its first curator. */
create or replace function public.create_organization(p_name text, p_code text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  insert into public.organizations (name, code, created_by)
  values (trim(p_name), upper(trim(p_code)), auth.uid()) returning id into v_id;
  insert into public.org_members (org_id, user_id, role, added_by) values (v_id, auth.uid(), 'curator', auth.uid());
  return v_id;
end;
$$;

/**
 * Add someone to a collection (curators only). Someone without an account
 * yet gets an invitation, applied when they first sign in.
 */
create or replace function public.add_member(p_org uuid, p_email text, p_role text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  if not public.is_member(p_org, array['curator']) then
    raise exception 'Only curators can add members' using errcode = '42501';
  end if;
  if p_role not in ('curator', 'staff', 'viewer') then raise exception 'Unknown role %', p_role using errcode = '22023'; end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    insert into public.org_invites (org_id, email, role, invited_by)
    values (p_org, lower(trim(p_email)), p_role, auth.uid())
    on conflict (org_id, email) do update set role = excluded.role;
    return 'invited';
  end if;
  insert into public.org_members (org_id, user_id, role, added_by) values (p_org, v_user, p_role, auth.uid())
  on conflict (org_id, user_id) do update set role = excluded.role;
  return 'added';
end;
$$;

/** Join the collections that invited this user's email. */
create or replace function public.accept_invites()
returns int language plpgsql security definer set search_path = '' as $$
declare v_email text; v_n int;
begin
  select lower(email) into v_email from auth.users where id = auth.uid();
  if v_email is null then return 0; end if;
  insert into public.org_members (org_id, user_id, role, added_by)
  select i.org_id, auth.uid(), i.role, i.invited_by from public.org_invites i where i.email = v_email
  on conflict (org_id, user_id) do nothing;
  get diagnostics v_n = row_count;
  delete from public.org_invites where email = v_email;
  return v_n;
end;
$$;

/** Who would receive a transfer or share: a collection by id, or a person by email. */
create or replace function public.resolve_party(p_org uuid, p_email text, out o_user uuid, out o_org uuid, out o_label text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_org is not null then
    select id into o_org from public.organizations where id = p_org;
    if o_org is null then raise exception 'No such collection' using errcode = '22023'; end if;
  else
    select id into o_user from auth.users where lower(email) = lower(trim(coalesce(p_email, '')));
    if o_user is null then
      raise exception 'No SpeciMap account uses that email. Ask them to sign in once first.' using errcode = '22023';
    end if;
  end if;
  o_label := public.party_label(o_user, o_org);
end;
$$;

/**
 * Start a transfer of a specimen or subsample (custodian or curator). The
 * donor logs where the object is now; custody changes only on acceptance.
 */
create or replace function public.start_transfer(
  p_tag text, p_to_org uuid, p_to_email text, p_purpose text, p_note text,
  p_lat double precision, p_lng double precision, p_accuracy real, p_place text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_c record; v_to record; v_scan uuid := gen_random_uuid(); v_id uuid;
begin
  if not public.can_curate_tag(p_tag) then
    raise exception 'Only the custodian can transfer this' using errcode = '42501';
  end if;
  if exists (select 1 from public.custody_transfers t where t.tag_id = p_tag and t.status = 'pending') then
    raise exception 'A transfer of this tag is already waiting to be accepted' using errcode = '23505';
  end if;
  select * into v_c from public.tag_custody(p_tag);
  select * into v_to from public.resolve_party(p_to_org, p_to_email);
  if v_to.o_user is not distinct from v_c.custodian_user and v_to.o_org is not distinct from v_c.custodian_org then
    raise exception 'They already hold it' using errcode = '22023';
  end if;
  if coalesce(trim(p_place), '') = '' and p_lat is null then
    raise exception 'Log where it is: a place or a GPS position' using errcode = '22023';
  end if;
  insert into public.tag_scans (id, tag_id, scanned_by, scanned_at, lat, lng, gps_accuracy_m, place)
  values (v_scan, p_tag, auth.uid(), now(), p_lat, p_lng, p_accuracy,
          nullif(trim(coalesce(p_place, '')), ''));
  insert into public.custody_transfers (tag_id, from_user, from_org, from_label, to_user, to_org, to_label,
                                        purpose, note, scan_id, created_by)
  values (p_tag, v_c.custodian_user, v_c.custodian_org, public.party_label(v_c.custodian_user, v_c.custodian_org),
          v_to.o_user, v_to.o_org, v_to.o_label, p_purpose, nullif(trim(coalesce(p_note, '')), ''), v_scan, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

/**
 * Accept or decline a transfer (the recipient person, or a curator of the
 * recipient collection). On acceptance the recipient becomes custodian, the
 * record becomes private to them, and earlier shares end.
 */
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
    delete from public.object_shares where tag_id = v_t.tag_id;
  end if;
end;
$$;

/** Withdraw a transfer that hasn't been accepted (the donor side). */
create or replace function public.cancel_transfer(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_t record;
begin
  select * into v_t from public.custody_transfers where id = p_id for update;
  if not found or v_t.status <> 'pending' then
    raise exception 'This transfer is no longer waiting' using errcode = '22023';
  end if;
  if not coalesce(v_t.created_by = auth.uid() or public.can_curate_tag(v_t.tag_id), false) then
    raise exception 'Only the donor can cancel this' using errcode = '42501';
  end if;
  update public.custody_transfers set status = 'cancelled', responded_by = auth.uid(), responded_at = now()
   where id = p_id;
end;
$$;

/** Privacy: private, shared (with named people/collections) or public. */
create or replace function public.set_privacy(p_tag text, p_visibility text, p_generalize boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_curate_tag(p_tag) then
    raise exception 'Only the custodian can change who sees this' using errcode = '42501';
  end if;
  if p_visibility not in ('private', 'shared', 'public') then
    raise exception 'Unknown visibility %', p_visibility using errcode = '22023';
  end if;
  update public.material_entities set visibility = p_visibility, generalize_public = p_generalize, updated_at = now()
   where tag_id = p_tag;
  update public.material_samples set visibility = p_visibility, generalize_public = p_generalize, updated_at = now()
   where tag_id = p_tag;
end;
$$;

create or replace function public.share_tag(p_tag text, p_org uuid, p_email text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_to record;
begin
  if not public.can_curate_tag(p_tag) then
    raise exception 'Only the custodian can share this' using errcode = '42501';
  end if;
  select * into v_to from public.resolve_party(p_org, p_email);
  insert into public.object_shares (tag_id, user_id, org_id, label, created_by)
  values (p_tag, v_to.o_user, v_to.o_org, v_to.o_label, auth.uid())
  on conflict do nothing;
end;
$$;

create or replace function public.unshare_tag(p_share uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_tag text;
begin
  select tag_id into v_tag from public.object_shares where id = p_share;
  if v_tag is null then return; end if;
  if not public.can_curate_tag(v_tag) then
    raise exception 'Only the custodian can change who sees this' using errcode = '42501';
  end if;
  delete from public.object_shares where id = p_share;
end;
$$;

create or replace function public.set_catalog_number(p_tag text, p_catalog_number text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_curate_tag(p_tag) then
    raise exception 'Only the custodian can set the catalog number' using errcode = '42501';
  end if;
  update public.material_entities set catalog_number = nullif(trim(p_catalog_number), ''), updated_at = now() where tag_id = p_tag;
  update public.material_samples set catalog_number = nullif(trim(p_catalog_number), ''), updated_at = now() where tag_id = p_tag;
end;
$$;

/**
 * What anyone (even signed out) sees when scanning a public tag. Null if the
 * tag isn't public. Coordinates are rounded to 0.1 degree (about 10 km)
 * unless the custodian allows exact ones.
 */
create or replace function public.public_tag_info(p_tag text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_e record; v_s record; v_first record; v_ev record; v_round boolean; v_out jsonb;
begin
  select * into v_e from public.material_entities where tag_id = p_tag;
  -- FOUND, not "v_e is not null": a row with any null column isn't "not null".
  if found then
    if v_e.visibility <> 'public' then return null; end if;
    v_round := v_e.generalize_public;
    select * into v_first from public.specimens where tag_id = p_tag order by captured_at limit 1;
    select * into v_ev from public.events where id = v_first.event_id;
    v_out := jsonb_build_object(
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
    return v_out;
  end if;
  select * into v_s from public.material_samples where tag_id = p_tag;
  if not found or v_s.visibility <> 'public' then return null; end if;
  return jsonb_build_object(
    'rank', 'subsample',
    'sampleType', v_s.sample_type, 'preservation', v_s.preservation,
    'catalogNumber', v_s.catalog_number,
    'custodian', public.party_label(v_s.custodian_user, v_s.custodian_org),
    'year', extract(year from v_s.collected_at),
    'parent', v_s.parent_tag_id);
end;
$$;

grant execute on function public.public_tag_info(text) to anon, authenticated;
grant execute on function public.create_organization(text, text), public.add_member(uuid, text, text),
  public.accept_invites(), public.start_transfer(text, uuid, text, text, text, double precision, double precision, real, text),
  public.respond_transfer(uuid, boolean, text), public.cancel_transfer(uuid), public.set_privacy(text, text, boolean),
  public.share_tag(text, uuid, text), public.unshare_tag(uuid), public.set_catalog_number(text, text)
  to authenticated;
-- Internal helpers: only callable through the functions above (which run as
-- their owner). resolve_party would otherwise reveal whether an email has
-- an account, and tag_custody who holds any tag.
revoke execute on function public.resolve_party(uuid, text), public.party_label(uuid, uuid),
  public.tag_custody(text) from public, anon, authenticated;
-- Used directly in policies, so signed-in users need them; they reveal
-- only whether a tag is unclaimed or collected by the caller.
revoke execute on function public.collected_tag(text), public.tag_unclaimed(text) from public, anon;
grant execute on function public.collected_tag(text), public.tag_unclaimed(text) to authenticated;
revoke execute on function public.is_member(uuid, text[]), public.can_read_tag(text), public.can_edit_tag(text),
  public.can_curate_tag(text) from public, anon;
-- Everything that changes custody or membership needs a signed-in user.
revoke execute on function public.create_organization(text, text), public.add_member(uuid, text, text),
  public.accept_invites(), public.start_transfer(text, uuid, text, text, text, double precision, double precision, real, text),
  public.respond_transfer(uuid, boolean, text), public.cancel_transfer(uuid), public.set_privacy(text, text, boolean),
  public.share_tag(text, uuid, text), public.unshare_tag(uuid), public.set_catalog_number(text, text)
  from public, anon;

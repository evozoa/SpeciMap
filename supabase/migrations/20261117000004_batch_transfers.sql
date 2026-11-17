-- Batch transfers: many specimens and subsamples sent together (e.g. a
-- field season accessioned at once). Each item still has its own transfer
-- row in the chain of custody; batch_id groups them. Starting, accepting
-- and withdrawing a batch are all-or-nothing, and errors name the tag.

alter table public.custody_transfers add column batch_id uuid;
create index custody_transfers_batch_idx on public.custody_transfers (batch_id) where batch_id is not null;

create or replace function public.start_transfers(
  p_tags text[], p_to_org uuid, p_to_email text, p_purpose text, p_note text,
  p_lat double precision, p_lng double precision, p_accuracy real, p_place text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_batch uuid := gen_random_uuid(); v_tag text; v_id uuid;
begin
  if coalesce(array_length(p_tags, 1), 0) = 0 then
    raise exception 'Choose at least one item' using errcode = '22023';
  end if;
  if array_length(p_tags, 1) > 1000 then
    raise exception 'At most 1000 items per transfer' using errcode = '22023';
  end if;
  foreach v_tag in array p_tags loop
    begin
      v_id := public.start_transfer(v_tag, p_to_org, p_to_email, p_purpose, p_note, p_lat, p_lng, p_accuracy, p_place);
    exception when others then
      raise exception 'Tag %: %', v_tag, sqlerrm using errcode = sqlstate;
    end;
    update public.custody_transfers set batch_id = v_batch where id = v_id;
  end loop;
  return v_batch;
end;
$$;

/**
 * Accept or decline every waiting transfer in a batch. Catalog numbers are
 * optional, given as {"<tag>": "<catalog number>"}.
 */
create or replace function public.respond_transfers(p_batch uuid, p_accept boolean, p_catalog jsonb default '{}'::jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare v_t record; v_n int := 0;
begin
  for v_t in select id, tag_id from public.custody_transfers
              where batch_id = p_batch and status = 'pending' order by created_at, tag_id loop
    begin
      perform public.respond_transfer(v_t.id, p_accept, coalesce(p_catalog, '{}'::jsonb) ->> v_t.tag_id);
    exception when others then
      raise exception 'Tag %: %', v_t.tag_id, sqlerrm using errcode = sqlstate;
    end;
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'Nothing in this batch is waiting' using errcode = '22023'; end if;
  return v_n;
end;
$$;

create or replace function public.cancel_transfers(p_batch uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare v_t record; v_n int := 0;
begin
  for v_t in select id, tag_id from public.custody_transfers where batch_id = p_batch and status = 'pending' loop
    begin
      perform public.cancel_transfer(v_t.id);
    exception when others then
      raise exception 'Tag %: %', v_t.tag_id, sqlerrm using errcode = sqlstate;
    end;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke execute on function public.start_transfers(text[], uuid, text, text, text, double precision, double precision, real, text),
  public.respond_transfers(uuid, boolean, jsonb), public.cancel_transfers(uuid) from public, anon;
grant execute on function public.start_transfers(text[], uuid, text, text, text, double precision, double precision, real, text),
  public.respond_transfers(uuid, boolean, jsonb), public.cancel_transfers(uuid) to authenticated;

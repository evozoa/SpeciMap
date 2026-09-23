-- Allow the 2mL screw-cap tube insert tag format.
alter table public.tag_batches drop constraint tag_batches_format_check;
alter table public.tag_batches add constraint tag_batches_format_check
  check (format in ('insert', 'punch', 'both', 'insert_2ml'));

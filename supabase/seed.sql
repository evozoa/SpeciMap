-- Dev-only seed: a small unowned tag batch so /s/:tagId resolves locally.
-- IDs must satisfy the checksum; these were generated with src/lib/tagid.ts
-- (see scripts in docs/development.md to regenerate).
insert into public.tag_batches (id, created_by, label, prefix, tag_count, format, page_size)
values ('00000000-0000-0000-0000-000000000001', null, 'Dev seed batch', 'DEV', 3, 'insert', 'letter');

insert into public.tags (id, batch_id, seq) values
  ('DEV00001H', '00000000-0000-0000-0000-000000000001', 1),
  ('DEV00002J', '00000000-0000-0000-0000-000000000001', 2),
  ('DEV00003K', '00000000-0000-0000-0000-000000000001', 3);

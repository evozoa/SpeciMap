-- Species name for a specimen, as entered by the collector (free text,
-- typically a scientific name). Nullable: most records are identified after
-- capture, in the lab.
alter table public.specimens add column species text;

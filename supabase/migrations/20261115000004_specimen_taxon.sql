-- The iNaturalist taxon a specimen's species name is linked to.
--
-- `species` stays the collector's own text (it may follow a different
-- taxonomy, e.g. a museum's). These columns hold the matching iNaturalist
-- taxon when the collector picked one from the lookup or confirmed a match;
-- all three are null for names that were never matched.
alter table public.specimens
  add column taxon_id   integer,
  add column taxon_name text,
  add column taxon_rank text;

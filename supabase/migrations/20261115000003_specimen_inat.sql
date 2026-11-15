-- iNaturalist observation a specimen was shared to (optional), so every
-- device of the collector shows it as shared and links to it.
alter table public.specimens add column inat_observation_id bigint;

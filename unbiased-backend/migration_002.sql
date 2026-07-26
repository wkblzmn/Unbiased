-- =====================================================================
-- Unbiased — migration 002
--
-- Fixes the correctness hole in 001: a "story" was gated on
-- article_count >= 2, which counts ARTICLES, not OUTLETS. Two Daily Star
-- pieces about the same event merged into one cluster, hit
-- article_count = 2, got summarized, and surfaced in the feed as a
-- multi-source story showing the same outlet twice under the same bias
-- label. The entire product claim ("here is how DIFFERENT outlets covered
-- this") was structurally unenforced.
--
-- Genuinely idempotent this time. Run in the Supabase SQL editor.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Repair of 001: `add constraint` is not idempotent and would throw on
--    a re-run. A unique INDEX is, and PostgREST/`onConflict: "name"`
--    accepts either.
-- ---------------------------------------------------------------------
create unique index if not exists sources_name_uidx on sources (name);

-- ---------------------------------------------------------------------
-- 1. source_count — the number that actually decides whether a cluster is
--    a story. article_count stays (it is still what the summarizer
--    watermark compares against, and "3 articles from 2 outlets" is a
--    true and useful thing to render).
-- ---------------------------------------------------------------------
alter table story_clusters
  add column if not exists source_count int not null default 0;

-- ---------------------------------------------------------------------
-- 2. body_source — was the body a real page fetch, or a ~48-word RSS
--    teaser? The summarizer needs to know: telling Gemini "only state
--    facts corroborated by two sources" while silently handing it one
--    800-word article and one 48-word teaser makes the rule unsatisfiable
--    on exactly the clusters where it matters most.
--
--    NULL = unknown (rows that predate this migration). Treated as
--    'page' by the prompt builder; those rows age out of the 72h window
--    within days anyway.
-- ---------------------------------------------------------------------
alter table articles
  add column if not exists body_source text
  check (body_source in ('page', 'rss_snippet'));

-- ---------------------------------------------------------------------
-- 3. Backfill source_count for existing clusters from the source of truth
-- ---------------------------------------------------------------------
update story_clusters c
set source_count = sub.n
from (
  select ca.cluster_id, count(distinct a.source_id) as n
  from cluster_articles ca
  join articles a on a.id = ca.article_id
  group by ca.cluster_id
) sub
where sub.cluster_id = c.id;

-- ---------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------
create index if not exists articles_status_idx
  on articles (status);

create index if not exists story_clusters_last_article_at_idx
  on story_clusters (last_article_at);

create index if not exists cluster_articles_cluster_id_idx
  on cluster_articles (cluster_id);

create index if not exists story_clusters_surfaceable_idx
  on story_clusters (source_count, last_article_at desc);

-- =====================================================================
-- 5. THE READ PATH — rebuilt.
--
--    Base tables keep RLS on with ZERO policies. These views are owned by
--    `postgres` and run with owner rights, so they legitimately see
--    through RLS. `anon` gets SELECT on the views and nothing else.
--    body_text appears in NEITHER view.
--
--    Supabase's linter flags these as SECURITY DEFINER views. That is not
--    an accident, it IS the mechanism. Say so in the report.
-- =====================================================================

drop view if exists feed_cluster_sources;
drop view if exists feed_clusters;

-- A story is a story iff TWO OR MORE DISTINCT OUTLETS covered it AND a
-- neutral summary exists. source_count, never article_count.
--
-- source_count is also exposed so the client renders "2 sources" from the
-- number that is actually true, rather than from article_count (which can
-- legitimately be higher when one outlet filed a follow-up).
create view feed_clusters as
select
  c.id,
  c.headline,
  c.summary,
  c.category,
  c.source_count,
  c.article_count,
  c.first_article_at,
  c.last_article_at
from story_clusters c
where c.source_count >= 2
  and c.summary is not null;

create view feed_cluster_sources as
select
  ca.cluster_id,
  a.id as article_id,
  a.title,
  a.url,
  a.published_at,
  s.name       as source_name,
  s.bias_label as bias_label
from cluster_articles ca
join articles a on a.id = ca.article_id
join sources  s on s.id = a.source_id
where ca.cluster_id in (select id from feed_clusters);

grant select on feed_clusters        to anon;
grant select on feed_cluster_sources to anon;

revoke all on articles         from anon;
revoke all on story_clusters   from anon;
revoke all on cluster_articles from anon;
revoke all on sources          from anon;

-- ---------------------------------------------------------------------
-- 6. Sanity check — run this after deploying and paste the output into
--    the report. `single_outlet` is the number of clusters that WOULD
--    have been served as multi-source stories under migration 001.
-- ---------------------------------------------------------------------
-- select
--   count(*) filter (where source_count >= 2 and summary is not null) as surfaceable,
--   count(*) filter (where article_count >= 2 and source_count < 2)   as single_outlet,
--   count(*) filter (where source_count < 2)                          as below_bar
-- from story_clusters;

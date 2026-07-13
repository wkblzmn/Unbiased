-- =====================================================================
-- Unbiased — migration 001
--
-- HISTORICAL. Already applied to the live database. Kept in the repo so
-- the schema's history is reconstructible, not because it needs re-running.
-- Its views are REPLACED by migration_002 (they gated the feed on
-- article_count, which counts articles rather than outlets — the bug that
-- let two Daily Star pieces surface as a "multi-source" story).
--
-- One repair vs. the original: the `add constraint sources_name_key`
-- line was not idempotent despite the header claiming the file was.
-- It is now a unique index, which is.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. sources.name becomes the real join key (poller.ts upserts on it)
-- ---------------------------------------------------------------------
create unique index if not exists sources_name_uidx on sources (name);

-- ---------------------------------------------------------------------
-- 2. New columns
-- ---------------------------------------------------------------------

-- BUG-6: stops backfillArticleBodies() from re-fetching dead URLs forever
alter table articles
  add column if not exists body_fetch_attempts int not null default 0;

-- BUG-1: lets runSummarizer detect a cluster that GREW after being summarized
alter table story_clusters
  add column if not exists summarized_at_count int not null default 0;

-- ---------------------------------------------------------------------
-- 3. articles.status: give the dead column a real job
--
--    pending   - polled from RSS, body not fetched yet
--    ready     - has a body, not yet clustered
--    clustered - linked into a story_cluster
--    failed    - body permanently unavailable (attempts exhausted, no
--                usable RSS fallback). This is the Dhaka Tribune hole.
--    stale     - became ready too late to be honestly clustered
-- ---------------------------------------------------------------------
alter table articles alter column status set default 'pending';

update articles set status = 'pending' where body_text is null;
update articles set status = 'ready'   where body_text is not null;
update articles a set status = 'clustered'
  where exists (select 1 from cluster_articles ca where ca.article_id = a.id);

-- Existing summaries were generated from the current article_count.
update story_clusters
  set summarized_at_count = article_count
  where summary is not null;

-- ---------------------------------------------------------------------
-- 4. Indexes the pipeline now leans on (these replace the full scans)
-- ---------------------------------------------------------------------
create index if not exists articles_status_idx
  on articles (status);

create index if not exists story_clusters_last_article_at_idx
  on story_clusters (last_article_at);

create index if not exists cluster_articles_cluster_id_idx
  on cluster_articles (cluster_id);

-- =====================================================================
-- 5. THE READ PATH
--
--    Base tables keep RLS on with ZERO policies, so `anon` still cannot
--    touch them. These two views are owned by `postgres`, which means
--    they run with the owner's rights and legitimately see through RLS.
--    `anon` gets SELECT on the views and nothing else.
--
--    body_text appears in NEITHER view. It never leaves the server.
--    Supabase's linter will flag these as "SECURITY DEFINER views" —
--    that is not a mistake, it IS the mechanism. Say so in the report.
--
--    *** SUPERSEDED BY migration_002. ***
--    `article_count >= 2` was the wrong gate: it counts ARTICLES, not
--    OUTLETS. Five clusters were surfaced showing a single outlet twice
--    under a single bias label. 002 replaces these views with a
--    source_count gate.
-- =====================================================================

create or replace view feed_clusters as
select
  c.id,
  c.headline,
  c.summary,
  c.category,
  c.article_count,
  c.first_article_at,
  c.last_article_at
from story_clusters c
where c.article_count >= 2
  and c.summary is not null;

create or replace view feed_cluster_sources as
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

-- Belt and braces: Supabase grants ALL on public tables to anon by
-- default and relies on RLS alone. Remove the grants too.
revoke all on articles         from anon;
revoke all on story_clusters   from anon;
revoke all on cluster_articles from anon;
revoke all on sources          from anon;

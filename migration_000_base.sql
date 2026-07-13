-- =====================================================================
-- Unbiased — migration 000: BASE SCHEMA
--
-- RECONSTRUCTED. The original CREATE TABLE statements were typed into the
-- Supabase SQL editor and never saved to a file, so the repository could
-- not rebuild its own database. This file closes that hole.
--
-- It is derived from what the code actually reads and writes:
--   poller.ts        sources(name, rss_url, bias_label)
--                    articles(source_id, title, url, published_at,
--                             rss_snippet, status, body_text,
--                             body_fetch_attempts, body_source)
--   runClusterer.ts  story_clusters(headline, article_count, source_count,
--                                   first_article_at, last_article_at)
--                    cluster_articles(cluster_id, article_id, merge_via)
--   runSummarizer.ts story_clusters(summary, category, summarized_at_count)
--
-- Every statement is `if not exists`. Running this against the LIVE
-- database is a no-op — it will not drop, alter, or overwrite anything.
-- It only does work on an empty project.
--
-- VERIFY IT ANYWAY. Run the query at the bottom of this file against the
-- live DB and compare. A reconstruction is a claim, not a fact.
-- =====================================================================

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- sources — the outlet list. sources.ts is the single source of truth;
-- this table follows it via upsert on `name`.
-- ---------------------------------------------------------------------
create table if not exists sources (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  rss_url     text not null,
  bias_label  text,
  created_at  timestamptz not null default now()
);

create unique index if not exists sources_name_uidx on sources (name);

-- ---------------------------------------------------------------------
-- articles — one row per article fetched from RSS.
--
-- url is UNIQUE. That constraint IS the deduplication strategy: the
-- poller upserts with onConflict:"url", ignoreDuplicates:true and lets
-- Postgres decide what is new. Dedup is not implemented in JS anywhere.
--
-- status vocabulary:
--   pending   - polled from RSS, body not fetched yet
--   ready     - has a body, not yet clustered
--   clustered - linked into a story_cluster
--   failed    - body permanently unavailable (attempts exhausted, no
--               usable RSS fallback). This is the Dhaka Tribune hole.
--   stale     - became ready too late to be honestly clustered
--
-- body_source:
--   page        - real page fetch via Readability (~800 words)
--   rss_snippet - RSS teaser fallback (~48 words). NOT equivalent evidence;
--                 the summarizer is told so explicitly.
-- ---------------------------------------------------------------------
create table if not exists articles (
  id                  uuid primary key default gen_random_uuid(),
  source_id           uuid not null references sources(id) on delete cascade,
  title               text not null,
  url                 text not null,
  body_text           text,
  rss_snippet         text,
  published_at        timestamptz,
  status              text not null default 'pending',
  body_fetch_attempts int  not null default 0,
  body_source         text,
  fetched_at          timestamptz not null default now()
);

create unique index if not exists articles_url_uidx    on articles (url);
create index        if not exists articles_status_idx  on articles (status);
create index        if not exists articles_source_idx  on articles (source_id);

do $$ begin
  alter table articles add constraint articles_status_check
    check (status in ('pending','ready','clustered','failed','stale'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table articles add constraint articles_body_source_check
    check (body_source in ('page','rss_snippet'));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- story_clusters — one row per real-world event.
--
-- article_count vs source_count is THE distinction the product rests on.
--   article_count - how many articles are linked
--   source_count  - how many DISTINCT OUTLETS those articles come from
-- A cluster is only a story when source_count >= 2. Two Daily Star pieces
-- about the same event are article_count 2, source_count 1, and are
-- correctly invisible. See migration_002.
--
-- summarized_at_count is the watermark: the article_count at the moment
-- the current summary was generated. When the cluster grows past it, the
-- summary is stale and gets regenerated.
-- ---------------------------------------------------------------------
create table if not exists story_clusters (
  id                  uuid primary key default gen_random_uuid(),
  headline            text,
  summary             text,
  category            text,
  article_count       int not null default 0,
  source_count        int not null default 0,
  summarized_at_count int not null default 0,
  first_article_at    timestamptz,
  last_article_at     timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists story_clusters_last_article_at_idx
  on story_clusters (last_article_at);

create index if not exists story_clusters_surfaceable_idx
  on story_clusters (source_count, last_article_at desc);

-- ---------------------------------------------------------------------
-- cluster_articles — the many-to-many link.
--
-- The composite PK is load-bearing: runClusterer upserts links with
-- ignoreDuplicates, so a failed status update on a previous run simply
-- re-links the same article next run instead of deadlocking the cluster.
--
-- merge_via is instrumentation, not data the app reads: which signal
-- caused this article to join?
--   founder  - first member; joined nothing
--   title    - title Dice >= 0.4 alone
--   body_fwd - candidate's body covered a member's title
--   body_bwd - a member's body covered the candidate's title
-- ---------------------------------------------------------------------
create table if not exists cluster_articles (
  cluster_id uuid not null references story_clusters(id) on delete cascade,
  article_id uuid not null references articles(id)       on delete cascade,
  merge_via  text,
  created_at timestamptz not null default now(),
  primary key (cluster_id, article_id)
);

create index if not exists cluster_articles_cluster_id_idx
  on cluster_articles (cluster_id);

create index if not exists cluster_articles_article_id_idx
  on cluster_articles (article_id);

-- ---------------------------------------------------------------------
-- RLS: ON, with ZERO policies, on every base table.
--
-- This is deliberate and it is the whole security model. `anon` (the key
-- shipped inside the Android APK, which is trivially extractable) can
-- read NOTHING here. The client reads only the two views in migration_002,
-- which are owned by `postgres` and therefore see through RLS.
--
-- articles.body_text is exposed by NEITHER view. It never leaves the
-- server. This app aggregates and links; it does not republish.
-- ---------------------------------------------------------------------
alter table sources          enable row level security;
alter table articles         enable row level security;
alter table story_clusters   enable row level security;
alter table cluster_articles enable row level security;

revoke all on sources          from anon;
revoke all on articles         from anon;
revoke all on story_clusters   from anon;
revoke all on cluster_articles from anon;

-- =====================================================================
-- VERIFY THIS RECONSTRUCTION against the live database.
-- Run it in the Supabase SQL editor and check the columns match.
-- =====================================================================
-- select table_name, column_name, data_type, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name in ('sources','articles','story_clusters','cluster_articles')
-- order by table_name, ordinal_position;

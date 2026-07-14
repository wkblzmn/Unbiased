-- =====================================================================
-- Unbiased — migration 003: LINK-ONLY SOURCES
--
-- THE PROBLEM THIS SOLVES
--
-- Dhaka Tribune's article pages return 403 to datacenter IPs (GitHub
-- Actions runs on Azure), and 61 of 96 of its RSS items carry no
-- <description> to fall back on. Measured result: 62% of DT articles were
-- marked 'failed' and deleted from the product entirely.
--
-- Deleted. Not just body-less — GONE. No link, no headline, no bias label,
-- no contribution to the source list. Because the pipeline treated
-- "body_text is null" as "this article does not exist."
--
-- But the product makes three claims, and only ONE of them needs a body:
--
--   "these outlets covered this event"  -> title + url + bias label
--   "here is how each one framed it"    -> TITLE ONLY. the headline IS the framing.
--   "here is a neutral summary"         -> body
--
-- So a 403 on the body was silently deleting the evidence for the first two
-- claims in order to protect the third. And because DT is the only
-- left-of-centre outlet in the source list, the pipeline was quietly
-- narrowing the exact political spectrum the product exists to widen.
--
-- THE SPLIT
--
--   source_count          - DISTINCT OUTLETS THAT COVERED THE EVENT.
--                           Drives the story detail screen. A link-only
--                           article counts. This is the honest answer to
--                           "who reported this?"
--
--   summary_source_count  - DISTINCT OUTLETS WHOSE TEXT FED THE SUMMARY.
--                           Drives the feed gate and the two-source
--                           corroboration rule. A link-only article does
--                           NOT count. This is the honest answer to
--                           "what is this summary actually based on?"
--
-- The feed gate does NOT move: summary_source_count >= 2. Summaries are
-- still synthesized from two real bodies. Nothing about the summary's
-- honesty is weakened. The ONLY change is that outlets which covered an
-- event now appear on the detail screen even when we could not read their
-- text — with their own headline, which is the framing, which is the point.
--
-- Idempotent. Run in the Supabase SQL editor.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. articles.status gains 'linkonly'
--
--    pending   - polled, body not fetched yet
--    ready     - has a real body, not yet clustered
--    linkonly  - body permanently unavailable, but title+url+outlet are
--                real and usable. CLUSTERS. Appears in the source list.
--                Never feeds a summary.
--    clustered - linked into a story_cluster
--    failed    - unusable even as a link (no title, or no url)
--    stale     - surfaced too late to be honestly clustered
--
--    'failed' now means something much narrower, and should be near-zero.
-- ---------------------------------------------------------------------
do $$ begin
  alter table articles drop constraint if exists articles_status_check;
  alter table articles add constraint articles_status_check
    check (status in ('pending','ready','linkonly','clustered','failed','stale'));
end $$;

-- ---------------------------------------------------------------------
-- 2. articles.body_source gains 'none'
--
--    page        - real page fetch via Readability (~800 words)
--    rss_snippet - RSS teaser fallback (~48 words). Weak evidence; the
--                  summarizer is told so explicitly.
--    none        - no body at all. Link-only. NEVER sent to the model.
-- ---------------------------------------------------------------------
do $$ begin
  alter table articles drop constraint if exists articles_body_source_check;
  alter table articles add constraint articles_body_source_check
    check (body_source in ('page','rss_snippet','none'));
end $$;

-- ---------------------------------------------------------------------
-- 3. summary_source_count
-- ---------------------------------------------------------------------
alter table story_clusters
  add column if not exists summary_source_count int not null default 0;

-- ---------------------------------------------------------------------
-- 4. RESURRECT the articles we deleted.
--
--    Every 'failed' row that has a title and a url was never actually
--    unusable — we just could not read its body. Give them back.
--    On the next run the clusterer will pick them up and try to place them.
-- ---------------------------------------------------------------------
update articles
set status      = 'linkonly',
    body_source = 'none'
where status = 'failed'
  and title is not null
  and btrim(title) <> ''
  and url   is not null;

-- ---------------------------------------------------------------------
-- 5. Backfill the two counts from the source of truth.
--    A body counts toward summary_source_count only if it exists AND is
--    not a link-only placeholder.
-- ---------------------------------------------------------------------
update story_clusters c
set source_count         = coalesce(sub.sources, 0),
    summary_source_count = coalesce(sub.summary_sources, 0)
from (
  select
    ca.cluster_id,
    count(distinct a.source_id)                                    as sources,
    count(distinct a.source_id) filter (
      where a.body_text is not null
        and coalesce(a.body_source, 'page') <> 'none'
    )                                                              as summary_sources
  from cluster_articles ca
  join articles a on a.id = ca.article_id
  group by ca.cluster_id
) sub
where sub.cluster_id = c.id;

-- ---------------------------------------------------------------------
-- 6. merge_via gains 'title_nobody' — a link-only article that joined on
--    title Dice alone, at the raised threshold. This is the riskiest link
--    type in the system (no body to confirm forward with), so every one of
--    them is tagged and countable. If false merges ever appear, this is the
--    column that will show it.
-- ---------------------------------------------------------------------
-- (no DDL needed; merge_via is free text. documented here on purpose.)

create index if not exists cluster_articles_merge_via_idx
  on cluster_articles (merge_via);

create index if not exists story_clusters_feed_idx
  on story_clusters (summary_source_count, last_article_at desc);

-- =====================================================================
-- 7. THE READ PATH — rebuilt.
-- =====================================================================

drop view if exists feed_cluster_sources;
drop view if exists feed_clusters;

-- The feed gate is UNCHANGED in strictness: two distinct outlets must have
-- supplied real text, and a summary must exist. source_count is exposed
-- alongside so the client can honestly render "3 outlets covered this,
-- 2 of them fed the summary."
create view feed_clusters as
select
  c.id,
  c.headline,
  c.summary,
  c.category,
  c.source_count,          -- outlets that COVERED it (incl. link-only)
  c.summary_source_count,  -- outlets whose TEXT fed the summary
  c.article_count,
  c.first_article_at,
  c.last_article_at
from story_clusters c
where c.summary_source_count >= 2
  and c.summary is not null;

-- The source list. `has_body` tells the client whether this outlet's text
-- actually informed the summary. The Android detail screen should render a
-- quiet marker on link-only rows — "headline and link only; full text not
-- retrievable" — because claiming an outlet corroborated something when we
-- never read a word of its article would be the exact dishonesty this
-- product exists to oppose.
create view feed_cluster_sources as
select
  ca.cluster_id,
  a.id as article_id,
  a.title,
  a.url,
  a.published_at,
  s.name       as source_name,
  s.bias_label as bias_label,
  (a.body_text is not null and coalesce(a.body_source,'page') <> 'none') as has_body,
  ca.merge_via
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

-- =====================================================================
-- 8. AFTER THE NEXT RUN — audit the risky links.
--
-- Every link-only merge, with the headline it matched against. Read 20 of
-- these by eye. If DT headlines are landing under the wrong events, raise
-- TITLE_MERGE_NOBODY in clusterer.ts. This is the check that protects the
-- zero-false-merge record.
-- =====================================================================
-- select
--   sc.headline                        as cluster_headline,
--   s.name                             as outlet,
--   a.title                            as linked_headline,
--   ca.merge_via
-- from cluster_articles ca
-- join story_clusters sc on sc.id = ca.cluster_id
-- join articles a        on a.id  = ca.article_id
-- join sources s         on s.id  = a.source_id
-- where ca.merge_via = 'title_nobody'
-- order by sc.last_article_at desc
-- limit 30;

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  clusterArticles,
  titleKeywords,
  bodyTokens,
  RawArticle,
  Cluster,
  MergeVia,
} from "./clusterer";
import { ClustererStats } from "./stats";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// These two must be DERIVED from the algorithm's own windows, not guessed.
// The algorithm (clusterer.ts) admits a candidate if it is within
// RECENCY_H = 48h of the cluster's last member and the resulting span
// stays inside MAX_SPAN_H = 72h.
//
// An article is worth processing if it could still participate in anything.
// Past MAX_SPAN_H it cannot join a live cluster and any cluster it founds
// can only be joined by articles that are themselves already stale.
const STALE_H = 72;

// The DB seed cutoff must be a strict SUPERSET of what the algorithm will
// accept, or the DB hides a cluster the algorithm would have matched and
// the article founds a duplicate for an event that already has a cluster —
// invisible in the feed, invisible in the logs (this was BUG-3).
//
// Worst case: an article STALE_H old joining a cluster whose last member is
// RECENCY_H older still. So the cutoff is exactly STALE_H + RECENCY_H,
// derived rather than a magic 96.
const RECENCY_H = 48;
const SEED_LOOKBACK_H = STALE_H + RECENCY_H; // 120

// PostgREST caps a response at 1000 rows by default and TRUNCATES SILENTLY.
// For readyRows that means articles quietly never getting clustered. Ask
// for a bounded page explicitly and shout if we hit the bound.
const MAX_READY_PER_RUN = 500;
const MAX_SEED_CLUSTERS = 500;

function hoursAgo(d: Date): number {
  return (Date.now() - d.getTime()) / (1000 * 60 * 60);
}

export async function runClusterer(): Promise<ClustererStats> {
  const stats: ClustererStats = {
    readyArticles: 0,
    staleArticles: 0,
    seedClusters: 0,
    joinedExisting: 0,
    createdNew: 0,
    mergeVia: {},
    belowSourceBar: 0,
    readQueryTruncated: false,
  };

  // ------------------------------------------------------------------
  // 1. Seed state: clusters that could still accept a member.
  //
  //    first_article_at / last_article_at are now READ FROM THE DB rather
  //    than recomputed as min/max of the loaded members. They are the same
  //    value in the normal case — but recomputing them meant the DB columns
  //    and the in-memory state could disagree, and it was the mechanism by
  //    which the (supposedly frozen) firstAt slid backward across runs.
  //    One representation, persisted, trusted.
  // ------------------------------------------------------------------
  const cutoff = new Date(
    Date.now() - SEED_LOOKBACK_H * 60 * 60 * 1000
  ).toISOString();

  const { data: activeClusterRows, error: loadError } = await supabase
    .from("story_clusters")
    .select(
      "id, first_article_at, last_article_at, " +
        "cluster_articles(article_id, articles(id, source_id, title, body_text, published_at))"
    )
    .gte("last_article_at", cutoff)
    .limit(MAX_SEED_CLUSTERS);
  if (loadError) throw loadError;

  if (activeClusterRows.length === MAX_SEED_CLUSTERS) {
    stats.readQueryTruncated = true;
  }

  const seedClusters: Cluster[] = [];
  for (const row of activeClusterRows as any[]) {
    const members = (row.cluster_articles ?? [])
      .filter((ca: any) => ca.articles)
      .map((ca: any) => ({
        id: ca.articles.id as string,
        sourceId: ca.articles.source_id as string,
        publishedAt: new Date(ca.articles.published_at),
        titleKw: titleKeywords(ca.articles.title),
        bodyKw: bodyTokens(ca.articles.body_text ?? ""),
        isNew: false,
      }));

    // A cluster row with zero surviving links is corrupt state, not a
    // cluster. Skip rather than produce Invalid Date / -Infinity.
    if (members.length === 0) {
      console.error(`Cluster ${row.id} has no linked articles — skipping.`);
      continue;
    }

    seedClusters.push({
      id: row.id as string,
      members,
      firstAt: new Date(row.first_article_at),
      lastAt: new Date(row.last_article_at),
      mergeVia: new Map<string, MergeVia>(),
    });
  }
  stats.seedClusters = seedClusters.length;

  // ------------------------------------------------------------------
  // 2. Work queue: articles with a body, not yet clustered.
  //    articles.status does this job (it was in the schema for months and
  //    had never been read or written by a single line of code).
  // ------------------------------------------------------------------
  const { data: readyRows, error: readyError } = await supabase
    .from("articles")
    .select("id, source_id, title, published_at, body_text")
    .eq("status", "ready")
    .order("published_at", { ascending: true })
    .limit(MAX_READY_PER_RUN);
  if (readyError) throw readyError;

  if (readyRows.length === MAX_READY_PER_RUN) {
    stats.readQueryTruncated = true;
  }

  const fresh: RawArticle[] = [];
  const staleIds: string[] = [];

  for (const a of readyRows as any[]) {
    const publishedAt = new Date(a.published_at);
    if (hoursAgo(publishedAt) > STALE_H) {
      staleIds.push(a.id);
      continue;
    }
    fresh.push({
      id: a.id,
      sourceId: a.source_id,
      publishedAt,
      title: a.title,
      bodyText: a.body_text ?? "",
    });
  }

  if (staleIds.length > 0) {
    stats.staleArticles = staleIds.length;
    await supabase
      .from("articles")
      .update({ status: "stale" })
      .in("id", staleIds);
    console.log(
      `Marked ${staleIds.length} article(s) stale (older than ${STALE_H}h).`
    );
  }

  stats.readyArticles = fresh.length;
  console.log(
    `\n${fresh.length} new article(s) to process against ${seedClusters.length} active cluster(s).\n`
  );

  if (fresh.length === 0) {
    console.log("Nothing new. Done.");
    return stats;
  }

  const titleById = new Map(fresh.map((a) => [a.id, a.title]));
  const resultClusters = clusterArticles(fresh, seedClusters);

  // ------------------------------------------------------------------
  // 3. Persist the delta.
  //
  //    Links are written FIRST as a single multi-row upsert (one statement
  //    = atomic), and the counts are then derived from a real read of
  //    cluster_articles rather than from the in-memory member list.
  //
  //    BUG-11 FIX: article_count was the ONLY count persisted, and the feed
  //    view gated on `article_count >= 2`. article_count counts ARTICLES.
  //    Two Daily Star pieces on one event merge legitimately, hit
  //    article_count = 2, get summarized, and surface as a "multi-source"
  //    story showing one outlet twice with one bias label. The entire
  //    product thesis was unenforced. source_count is now derived from
  //    count(distinct source_id) and is what the feed and the summarizer
  //    gate on. article_count is retained for the re-summarize watermark
  //    and for the honest "3 articles from 2 outlets" case.
  // ------------------------------------------------------------------
  for (const cluster of resultClusters) {
    const newMembers = cluster.members.filter((m) => m.isNew);
    if (newMembers.length === 0) continue; // untouched existing cluster

    let clusterId: string;

    if (cluster.id) {
      clusterId = cluster.id;
      stats.joinedExisting += newMembers.length;
    } else {
      const earliest = [...cluster.members].sort(
        (a, b) => a.publishedAt.getTime() - b.publishedAt.getTime()
      )[0];
      if (!earliest) continue;

      // Placeholder headline = the founding outlet's own framed headline.
      // That is exactly the framing this product exists to counteract, so
      // the feed_clusters view refuses to surface a cluster until it has
      // 2+ DISTINCT OUTLETS and a neutral summary. See migration_002.sql.
      const originalTitle = titleById.get(earliest.id) ?? "Untitled";

      const { data: newRow, error: insertError } = await supabase
        .from("story_clusters")
        .insert({
          headline: originalTitle,
          article_count: 0, // reconciled below, after links land
          source_count: 0, // ditto
          first_article_at: cluster.firstAt.toISOString(),
          last_article_at: cluster.lastAt.toISOString(),
        })
        .select("id")
        .single();
      if (insertError || !newRow) {
        console.error("Failed to insert new cluster:", insertError?.message);
        continue;
      }

      clusterId = newRow.id as string;
      stats.createdNew++;
    }

    const membersToLink = cluster.id ? newMembers : cluster.members;

    const linkRows = membersToLink.map((m) => {
      const via: MergeVia =
        cluster.mergeVia.get(m.id) ?? (cluster.id ? "title" : "founder");
      stats.mergeVia[via] = (stats.mergeVia[via] ?? 0) + 1;
      return { cluster_id: clusterId, article_id: m.id, merge_via: via };
    });

    // upsert, not insert: if the status update below fails, the article
    // stays 'ready' and gets re-clustered next run. A plain insert would
    // then hit the (cluster_id, article_id) PK and fail the whole
    // statement, deadlocking the cluster forever.
    const { error: linkError } = await supabase
      .from("cluster_articles")
      .upsert(linkRows, {
        onConflict: "cluster_id,article_id",
        ignoreDuplicates: true,
      });
    if (linkError) {
      console.error("Failed to link articles:", linkError.message);
      continue; // counts stay honest; the run retries next time
    }

    // Both counts from the source of truth, not from memory. PostgREST
    // cannot do count(distinct ...), so we pull the (small) id pairs and
    // do it here. No bodies are transferred.
    const { data: linked, error: countError } = await supabase
      .from("cluster_articles")
      .select("article_id, articles(source_id)")
      .eq("cluster_id", clusterId);
    if (countError) {
      console.error("Failed to count cluster members:", countError.message);
      continue;
    }

    const articleCount = linked.length;
    const sourceCount = new Set(
      (linked as any[])
        .map((l) =>
          Array.isArray(l.articles) ? l.articles[0]?.source_id : l.articles?.source_id
        )
        .filter(Boolean)
    ).size;

    if (sourceCount < 2) stats.belowSourceBar++;

    const { error: updateError } = await supabase
      .from("story_clusters")
      .update({
        article_count: articleCount,
        source_count: sourceCount,
        // BOTH ends are persisted now. first_article_at used to be written
        // once at insert and never again, while the algorithm allowed an
        // older article to join — so the value served to the Android client
        // was simply wrong. clusterer.ts bounds the span, so widening
        // either end is safe.
        first_article_at: cluster.firstAt.toISOString(),
        last_article_at: cluster.lastAt.toISOString(),
      })
      .eq("id", clusterId);
    if (updateError) {
      console.error("Failed to update cluster:", updateError.message);
      continue;
    }

    const { error: statusError } = await supabase
      .from("articles")
      .update({ status: "clustered" })
      .in(
        "id",
        membersToLink.map((m) => m.id)
      );
    if (statusError) {
      // Non-fatal: the article stays 'ready', gets picked up next run, and
      // the link upsert is idempotent. Noisy but not corrupting.
      console.error("Failed to mark articles clustered:", statusError.message);
    }

    console.log(
      `Cluster ${clusterId}: +${membersToLink.length} article(s), now ${articleCount} article(s) from ${sourceCount} outlet(s).`
    );
  }

  console.log("Done.");
  return stats;
}

if (require.main === module) {
  runClusterer();
}
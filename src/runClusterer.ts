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

// DERIVED from the algorithm's own windows, not guessed. The clusterer
// admits a candidate within RECENCY_H=48h of the cluster's last member, and
// only if the resulting span stays inside MAX_SPAN_H=72h.
const STALE_H = 72;
const RECENCY_H = 48;
const SEED_LOOKBACK_H = STALE_H + RECENCY_H; // 120

// PostgREST caps a response at 1000 rows and TRUNCATES SILENTLY. For the
// ready queue that means articles quietly never getting clustered.
const MAX_READY_PER_RUN = 500;
const MAX_SEED_CLUSTERS = 500;

// Both statuses enter the clusterer. A 'linkonly' article has a real title,
// a real URL, and a real outlet — only the body is missing. It is not a
// failure, it is an article we could not read.
const CLUSTERABLE = ["ready", "linkonly"];

function hoursAgo(d: Date): number {
  return (Date.now() - d.getTime()) / (1000 * 60 * 60);
}

// Does this article's text count as evidence for a summary?
// A link-only placeholder does not. body_source NULL = a row that predates
// migration 002; those all came from outlets whose pages we can fetch.
function hasRealBody(bodyText: string | null, bodySource: string | null): boolean {
  if (!bodyText || bodyText.trim().length === 0) return false;
  return (bodySource ?? "page") !== "none";
}

export async function runClusterer(): Promise<ClustererStats> {
  const stats: ClustererStats = {
    readyArticles: 0,
    linkOnlyArticles: 0,
    staleArticles: 0,
    seedClusters: 0,
    joinedExisting: 0,
    createdNew: 0,
    mergeVia: {},
    belowSourceBar: 0,
    belowSummaryBar: 0,
    readQueryTruncated: false,
  };

  // ------------------------------------------------------------------
  // 1. Seed state: clusters that could still accept a member.
  //    first_article_at / last_article_at are READ FROM THE DB, not
  //    recomputed from members — recomputing was the mechanism by which the
  //    supposedly-frozen firstAt slid backward across runs.
  // ------------------------------------------------------------------
  const cutoff = new Date(
    Date.now() - SEED_LOOKBACK_H * 60 * 60 * 1000
  ).toISOString();

  const { data: activeClusterRows, error: loadError } = await supabase
    .from("story_clusters")
    .select(
      "id, first_article_at, last_article_at, " +
        "cluster_articles(article_id, articles(id, source_id, title, body_text, body_source, published_at))"
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
      .map((ca: any) => {
        const a = ca.articles;
        const real = hasRealBody(a.body_text, a.body_source);
        return {
          id: a.id as string,
          sourceId: a.source_id as string,
          publishedAt: new Date(a.published_at),
          titleKw: titleKeywords(a.title),
          // A link-only member contributes an EMPTY body set. It therefore
          // cannot confirm anyone else backward — which is correct, since we
          // never read its text.
          bodyKw: real ? bodyTokens(a.body_text) : new Set<string>(),
          hasBody: real,
          isNew: false,
        };
      });

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
  // 2. Work queue: 'ready' (has a body) AND 'linkonly' (has none).
  // ------------------------------------------------------------------
  const { data: readyRows, error: readyError } = await supabase
    .from("articles")
    .select("id, source_id, title, published_at, body_text, body_source, status")
    .in("status", CLUSTERABLE)
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
    const real = hasRealBody(a.body_text, a.body_source);
    if (real) stats.readyArticles++;
    else stats.linkOnlyArticles++;

    fresh.push({
      id: a.id,
      sourceId: a.source_id,
      publishedAt,
      title: a.title,
      bodyText: real ? a.body_text : "",
      hasBody: real,
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

  console.log(
    `\n${fresh.length} article(s) to process ` +
      `(${stats.readyArticles} with body, ${stats.linkOnlyArticles} link-only) ` +
      `against ${seedClusters.length} active cluster(s).\n`
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
  //    TWO counts, and the difference between them is the whole point:
  //
  //      source_count         - outlets that COVERED the event, link-only
  //                             included. Drives the detail screen. The
  //                             honest answer to "who reported this?"
  //
  //      summary_source_count - outlets whose TEXT fed the summary. Drives
  //                             the feed gate and the corroboration rule.
  //                             The honest answer to "what is this summary
  //                             actually based on?"
  //
  //    Conflating these is what deleted 62% of Dhaka Tribune.
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

      const originalTitle = titleById.get(earliest.id) ?? "Untitled";

      const { data: newRow, error: insertError } = await supabase
        .from("story_clusters")
        .insert({
          headline: originalTitle,
          article_count: 0,
          source_count: 0,
          summary_source_count: 0,
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
        cluster.mergeVia.get(m.id) ??
        (cluster.id ? (m.hasBody ? "title" : "title_nobody") : "founder");
      stats.mergeVia[via] = (stats.mergeVia[via] ?? 0) + 1;
      return { cluster_id: clusterId, article_id: m.id, merge_via: via };
    });

    const { error: linkError } = await supabase
      .from("cluster_articles")
      .upsert(linkRows, {
        onConflict: "cluster_id,article_id",
        ignoreDuplicates: true,
      });
    if (linkError) {
      console.error("Failed to link articles:", linkError.message);
      continue;
    }

    // Both counts from the source of truth. PostgREST cannot do
    // count(distinct ...), so pull the (small) id pairs and do it here.
    // No bodies are transferred — only source_id and body_source.
    const { data: linked, error: countError } = await supabase
      .from("cluster_articles")
      .select("article_id, articles(source_id, body_source, body_text)")
      .eq("cluster_id", clusterId);
    if (countError) {
      console.error("Failed to count cluster members:", countError.message);
      continue;
    }

    const rows = (linked as any[]).map((l) =>
      Array.isArray(l.articles) ? l.articles[0] : l.articles
    ).filter(Boolean);

    const articleCount = linked.length;
    const sourceCount = new Set(rows.map((r) => r.source_id)).size;
    const summarySourceCount = new Set(
      rows
        .filter((r) => hasRealBody(r.body_text, r.body_source))
        .map((r) => r.source_id)
    ).size;

    if (sourceCount < 2) stats.belowSourceBar++;
    if (summarySourceCount < 2) stats.belowSummaryBar++;

    const { error: updateError } = await supabase
      .from("story_clusters")
      .update({
        article_count: articleCount,
        source_count: sourceCount,
        summary_source_count: summarySourceCount,
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
      console.error("Failed to mark articles clustered:", statusError.message);
    }

    const linkOnlyHere = rows.length - rows.filter((r) => hasRealBody(r.body_text, r.body_source)).length;
    console.log(
      `Cluster ${clusterId}: +${membersToLink.length} → ` +
        `${articleCount} article(s), ${sourceCount} outlet(s), ` +
        `${summarySourceCount} with text` +
        `${linkOnlyHere > 0 ? ` (${linkOnlyHere} link-only)` : ""}.`
    );
  }

  console.log("Done.");
  return stats;
}

if (require.main === module) {
  runClusterer();
}
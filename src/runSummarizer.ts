import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { summarizeCluster, SourceArticle } from "./summarizer";
import { SummarizerStats } from "./stats";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Gemini 3.1 Flash Lite free tier: 15 RPM / 500 RPD (verified in AI Studio).
// 5s spacing = 12 req/min, under the 15 RPM ceiling with margin.
const REQUEST_SPACING_MS = 5_000;

// 500 RPD / 48 cron runs ≈ 10 calls per run sustainable. 30 is the ceiling for
// a catch-up run; 30 × 5s = 2.5 min, comfortable inside the 25-min job timeout.
const MAX_SUMMARIES_PER_RUN = 30;
const RATE_LIMIT_BACKOFF_MS = 65_000;
const MAX_CANDIDATE_ROWS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hasRealBody(bodyText: string | null, bodySource: string | null): boolean {
  if (!bodyText || bodyText.trim().length === 0) return false;
  return (bodySource ?? "page") !== "none";
}

export async function runSummarizer(): Promise<SummarizerStats> {
  const stats: SummarizerStats = {
    candidates: 0,
    summarizedFirstTime: 0,
    reSummarized: 0,
    rateLimited: 0,
    parseFailed: 0,
    apiFailed: 0,
    deferredOverCap: 0,
    skippedInsufficientBodies: 0,
  };

  // THE GATE: summary_source_count, not source_count and not article_count.
  //
  //   article_count        - counts ARTICLES. Two Daily Star pieces satisfied
  //                          it. Wrong; fixed in 002.
  //   source_count         - counts OUTLETS, including link-only ones whose
  //                          text we never read. Also wrong here: a link-only
  //                          outlet corroborates nothing, because there is
  //                          nothing to corroborate WITH.
  //   summary_source_count - counts outlets whose TEXT is in the prompt.
  //                          This is the only number that makes the
  //                          two-source corroboration rule mean anything.
  //
  // Link-only articles still appear in the source list (feed_cluster_sources)
  // with their headline, link and bias label. They just never reach the model.
  const { data: rows, error } = await supabase
    .from("story_clusters")
    .select(
      "id, headline, summary, article_count, source_count, summary_source_count, summarized_at_count"
    )
    .gte("summary_source_count", 2)
    .order("last_article_at", { ascending: false })
    .limit(MAX_CANDIDATE_ROWS);
  if (error) throw error;

  const candidates = (rows as any[]).filter(
    (c) => c.summary === null || c.article_count > c.summarized_at_count
  );
  stats.candidates = candidates.length;

  const batch = candidates.slice(0, MAX_SUMMARIES_PER_RUN);
  stats.deferredOverCap = candidates.length - batch.length;

  console.log(
    `\n${candidates.length} cluster(s) need a summary (${batch.length} this run).\n`
  );

  let first = true;

  for (const cluster of batch) {
    const isRefresh = cluster.summary !== null;

    const { data: links, error: linkError } = await supabase
      .from("cluster_articles")
      .select("article_id")
      .eq("cluster_id", cluster.id);
    if (linkError) {
      console.error(`Failed to load links for ${cluster.id}:`, linkError.message);
      continue;
    }

    const articleIds = links.map((l) => l.article_id);
    const { data: articles, error: articleError } = await supabase
      .from("articles")
      .select("title, body_text, body_source, source_id")
      .in("id", articleIds);
    if (articleError) {
      console.error(`Failed to load articles for ${cluster.id}:`, articleError.message);
      continue;
    }

    // ONLY articles with real text go into the prompt. A link-only article is
    // in the cluster and on the detail screen, but the model never sees it —
    // we did not read a word of it, and asking a model to corroborate against
    // a headline it has no article for is asking it to make something up.
    const withText = (articles as any[]).filter((a) =>
      hasRealBody(a.body_text, a.body_source)
    );

    const summarySourceIds = [...new Set(withText.map((a) => a.source_id))];

    // Defence in depth. summary_source_count is a denormalized column, and a
    // denormalized column is a claim, not a fact. Re-derive it from the rows
    // we are ACTUALLY about to put in the prompt — because the prompt is about
    // to assert two-outlet corroboration to the model, and that assertion must
    // be true at the moment it is made.
    if (summarySourceIds.length < 2) {
      console.error(
        `Cluster ${cluster.id} claims summary_source_count=${cluster.summary_source_count} ` +
          `but only ${summarySourceIds.length} outlet(s) have usable text. Repairing and skipping.`
      );
      await supabase
        .from("story_clusters")
        .update({ summary_source_count: summarySourceIds.length })
        .eq("id", cluster.id);
      stats.skippedInsufficientBodies++;
      continue;
    }

    const { data: sources, error: sourceError } = await supabase
      .from("sources")
      .select("id, name")
      .in("id", summarySourceIds);
    if (sourceError) {
      console.error(`Failed to load sources for ${cluster.id}:`, sourceError.message);
      continue;
    }
    const sourceNameById = new Map((sources as any[]).map((s) => [s.id, s.name]));

    const sourceArticles: SourceArticle[] = withText.map((a) => ({
      sourceName: sourceNameById.get(a.source_id) ?? "Unknown source",
      title: a.title,
      bodyText: a.body_text ?? "",
      isTeaser: a.body_source === "rss_snippet",
    }));

    if (!first) await sleep(REQUEST_SPACING_MS);
    first = false;

    const linkOnlyCount = (articles as any[]).length - withText.length;
    const teaserCount = sourceArticles.filter((a) => a.isTeaser).length;
    console.log(
      `--- ${isRefresh ? "RE-summarizing" : "Summarizing"}: "${cluster.headline}" ` +
        `(${withText.length} with text / ${summarySourceIds.length} outlets` +
        `${teaserCount > 0 ? `, ${teaserCount} teaser` : ""}` +
        `${linkOnlyCount > 0 ? `; ${linkOnlyCount} link-only excluded` : ""}) ---`
    );

    let result = await summarizeCluster(sourceArticles);

    if (!result.ok && result.kind === "rate_limit") {
      stats.rateLimited++;
      // PRINT THE QUOTA NAME. The old code logged "429 — backing off" and
      // threw away result.detail, which is where Google names the exact quota
      // that was violated. A PER-MINUTE quota can be cleared by waiting. A
      // PER-DAY quota cannot, and the 65s backoff is then pure waste. Without
      // this line you cannot tell which one you are hitting.
      console.error(`  429 — quota detail: ${result.detail}`);
      console.error(`  backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s and retrying once.`);
      await sleep(RATE_LIMIT_BACKOFF_MS);
      result = await summarizeCluster(sourceArticles);

      if (!result.ok && result.kind === "rate_limit") {
        console.error(
          "  Still rate limited after backoff. If the quota above says PerDay, " +
            "no amount of waiting inside this run will help."
        );
        break;
      }
    }

    if (!result.ok) {
      if (result.kind === "parse") stats.parseFailed++;
      else stats.apiFailed++;
      console.error(`  Skipped — ${result.kind}: ${result.detail}`);
      continue;
    }

    const { headline, summary, category } = result.value;
    console.log(`  Headline: ${headline}`);
    console.log(`  Category: ${category}`);
    console.log(`  Summary : ${summary}\n`);

    const { error: updateError } = await supabase
      .from("story_clusters")
      .update({
        headline,
        summary,
        category,
        summarized_at_count: cluster.article_count,
      })
      .eq("id", cluster.id);

    if (updateError) {
      console.error("  Failed to save:", updateError.message);
      continue;
    }

    if (isRefresh) stats.reSummarized++;
    else stats.summarizedFirstTime++;
  }

  console.log("Done.");
  return stats;
}

if (require.main === module) {
  runSummarizer();
}
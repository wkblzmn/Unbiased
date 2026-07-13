import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { summarizeCluster, SourceArticle } from "./summarizer";
import { SummarizerStats } from "./stats";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Gemini free tier is 5 req/min (not 15, as the original plan assumed).
// The old loop fired requests back-to-back with zero delay, so any run
// with 6+ clusters started 429-ing at request six — and the bare catch
// logged it identically to a broken prompt. 13s spacing keeps us under
// the real ceiling with margin.
const REQUEST_SPACING_MS = 13_000;

// Bound the job. 20 * 13s ≈ 4.5 min, comfortably inside a 30-min cron.
// Anything over the cap is simply picked up on the next run.
const MAX_SUMMARIES_PER_RUN = 20;

// If we get rate limited anyway, back off once and then give up on the
// run rather than grinding through 429s.
const RATE_LIMIT_BACKOFF_MS = 65_000;

const MAX_CANDIDATE_ROWS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  // BUG-1 FIX (kept): the old query was `.is("summary", null)`. A cluster
  // gets summarized the moment it qualifies, and the clusterer keeps ADDING
  // to it for up to 72h. Under the old query none of those later articles
  // ever reached the summary — the app showed "4 sources" above a paragraph
  // synthesized from 2 of them.
  //
  // BUG-11 FIX (new): the gate was `.gte("article_count", 2)`. article_count
  // counts ARTICLES. A cluster of two Daily Star pieces satisfied it and got
  // a summary whose prompt claimed two-source corroboration. The gate is now
  // source_count — DISTINCT OUTLETS. A cluster that never attracts a second
  // outlet is never summarized and never surfaced, which is also a
  // meaningful saving of the 5 req/min free tier.
  //
  // PostgREST cannot compare two columns in a filter, so the growth check
  // happens in JS. The columns are tiny (no bodies), so this is cheap.
  const { data: rows, error } = await supabase
    .from("story_clusters")
    .select(
      "id, headline, summary, article_count, source_count, summarized_at_count"
    )
    .gte("source_count", 2)
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

    const sourceIds = [...new Set((articles as any[]).map((a) => a.source_id))];

    // Defence in depth. source_count is a denormalized column and a
    // denormalized column is a claim, not a fact. Re-derive the invariant
    // from the rows we are ACTUALLY about to put in the prompt — because the
    // prompt is about to assert two-outlet corroboration to the model, and
    // that assertion must be true at the moment it is made.
    if (sourceIds.length < 2) {
      console.error(
        `Cluster ${cluster.id} claims source_count=${cluster.source_count} but ` +
          `its articles span ${sourceIds.length} outlet(s). Skipping and repairing.`
      );
      await supabase
        .from("story_clusters")
        .update({ source_count: sourceIds.length })
        .eq("id", cluster.id);
      stats.skippedInsufficientBodies++;
      continue;
    }

    const { data: sources, error: sourceError } = await supabase
      .from("sources")
      .select("id, name")
      .in("id", sourceIds);
    if (sourceError) {
      console.error(`Failed to load sources for ${cluster.id}:`, sourceError.message);
      continue;
    }
    const sourceNameById = new Map(
      (sources as any[]).map((s) => [s.id, s.name])
    );

    const sourceArticles: SourceArticle[] = (articles as any[]).map((a) => ({
      sourceName: sourceNameById.get(a.source_id) ?? "Unknown source",
      title: a.title,
      bodyText: a.body_text ?? "",
      // NULL body_source = a row that predates the migration. Treat as a
      // real page fetch: those rows all came from the two outlets whose
      // pages we can actually fetch, and they age out of the window in days.
      isTeaser: a.body_source === "rss_snippet",
    }));

    const realBodies = sourceArticles.filter((a) => !a.isTeaser).length;
    if (realBodies === 0) {
      // Every body in this cluster is a ~48-word teaser. There is nothing to
      // summarize that is not already the teaser. Do not spend a Gemini call
      // producing a confident paragraph out of two feed blurbs.
      console.error(
        `Cluster ${cluster.id}: all ${sourceArticles.length} bodies are teasers. Skipping.`
      );
      stats.skippedInsufficientBodies++;
      continue;
    }

    // Spacing, not rate limiting after the fact.
    if (!first) await sleep(REQUEST_SPACING_MS);
    first = false;

    const teaserCount = sourceArticles.length - realBodies;
    console.log(
      `--- ${isRefresh ? "RE-summarizing" : "Summarizing"}: "${cluster.headline}" ` +
        `(${sourceArticles.length} articles / ${sourceIds.length} outlets` +
        `${teaserCount > 0 ? `, ${teaserCount} teaser-only` : ""}) ---`
    );

    let result = await summarizeCluster(sourceArticles);

    if (!result.ok && result.kind === "rate_limit") {
      stats.rateLimited++;
      console.error(`  429 — backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s and retrying once.`);
      await sleep(RATE_LIMIT_BACKOFF_MS);
      result = await summarizeCluster(sourceArticles);

      if (!result.ok && result.kind === "rate_limit") {
        console.error("  Still rate limited. Abandoning this run; next cron picks it up.");
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
        // The watermark. Without it, the next run would re-summarize this
        // cluster forever and burn the whole Gemini quota on no-op calls.
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
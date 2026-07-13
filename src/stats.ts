// Run counters.
//
// Before this file existed, the pipeline had four separate silent-drop
// paths (no body, no pubDate, source name mismatch, article too old) and
// zero visibility into any of them. That is not acceptable for a product
// whose entire claim is "we show you all the sources" — you cannot claim
// balanced coverage while not measuring which source you are dropping.
//
// The per-source body table below is the evidence for the Dhaka Tribune
// 403 limitation, and it is a table you can paste straight into the report.
//
// BUG-7 FIX: `inserted` used to count EVERY item seen, not every new item.
// `.upsert(..., { ignoreDuplicates: true })` without `.select()` returns
// data: null and error: null whether the row landed or was skipped, so the
// old `if (insertError) ... else counters.inserted++` fired on all 25 items
// of every feed on every run. The NEW column was identical to SEEN by
// construction. Every number in this report was a lie, including the ones
// intended as report evidence. The poller now asks for the representation
// back and counts what actually landed.

export interface SourceCounters {
  feedError: boolean;
  itemsSeen: number;
  inserted: number;      // genuinely new rows
  alreadySeen: number;   // dedup hits — the number `inserted` used to claim
  malformedTitle: number;
  missingPubDate: number;
  bodyFromPage: number;
  bodyFromRssFallback: number;
  bodyRetryPending: number;
  bodyFailedPermanently: number;
}

export function emptySourceCounters(): SourceCounters {
  return {
    feedError: false,
    itemsSeen: 0,
    inserted: 0,
    alreadySeen: 0,
    malformedTitle: 0,
    missingPubDate: 0,
    bodyFromPage: 0,
    bodyFromRssFallback: 0,
    bodyRetryPending: 0,
    bodyFailedPermanently: 0,
  };
}

export interface PollerStats {
  perSource: Map<string, SourceCounters>;
}

export interface ClustererStats {
  readyArticles: number;
  staleArticles: number;
  seedClusters: number;
  joinedExisting: number;
  createdNew: number;
  mergeVia: Record<string, number>;
  // How many clusters touched this run are still below the two-outlet bar.
  // These are invisible to the feed by design. Counting them is what makes
  // the recall-biased-fragmentation claim in the report measurable.
  belowSourceBar: number;
  // PostgREST caps a request at 1000 rows by default. If either query comes
  // back at the cap, the result was silently truncated and articles are
  // quietly not being clustered. That must never fail silently.
  readQueryTruncated: boolean;
}

export interface SummarizerStats {
  candidates: number;
  summarizedFirstTime: number;
  reSummarized: number;
  rateLimited: number;
  parseFailed: number;
  apiFailed: number;
  deferredOverCap: number;
  // Clusters skipped because the only "second source" was a teaser-only
  // body and there was no real second outlet body to corroborate against.
  skippedInsufficientBodies: number;
}

function pad(s: string | number, width: number): string {
  return String(s).padEnd(width);
}

function padLeft(s: string | number, width: number): string {
  return String(s).padStart(width);
}

export function printRunReport(
  poll: PollerStats,
  cluster: ClustererStats,
  summary: SummarizerStats
): void {
  console.log("\n================ RUN REPORT ================\n");

  console.log("Per source:");
  console.log(
    pad("SOURCE", 24) +
      padLeft("SEEN", 6) +
      padLeft("NEW", 6) +
      padLeft("DUP", 6) +
      padLeft("PAGE", 7) +
      padLeft("RSS-FB", 8) +
      padLeft("RETRY", 7) +
      padLeft("FAILED", 8) +
      padLeft("NO-DATE", 9) +
      padLeft("BAD-TTL", 9)
  );
  for (const [name, c] of poll.perSource) {
    console.log(
      pad(c.feedError ? `${name} (FEED ERROR)` : name, 24) +
        padLeft(c.itemsSeen, 6) +
        padLeft(c.inserted, 6) +
        padLeft(c.alreadySeen, 6) +
        padLeft(c.bodyFromPage, 7) +
        padLeft(c.bodyFromRssFallback, 8) +
        padLeft(c.bodyRetryPending, 7) +
        padLeft(c.bodyFailedPermanently, 8) +
        padLeft(c.missingPubDate, 9) +
        padLeft(c.malformedTitle, 9)
    );
  }

  console.log("\nClustering:");
  console.log(`  ready articles processed : ${cluster.readyArticles}`);
  console.log(`  stale (too old, skipped) : ${cluster.staleArticles}`);
  console.log(`  open clusters seeded     : ${cluster.seedClusters}`);
  console.log(`  joined existing cluster  : ${cluster.joinedExisting}`);
  console.log(`  founded new cluster      : ${cluster.createdNew}`);
  console.log(`  below 2-outlet bar       : ${cluster.belowSourceBar}`);
  console.log(`  merge_via                : ${JSON.stringify(cluster.mergeVia)}`);
  if (cluster.readQueryTruncated) {
    console.error(
      "  *** READ QUERY HIT THE POSTGREST ROW CAP — results were truncated. " +
        "Articles are NOT being clustered. Raise the limit or paginate. ***"
    );
  }

  console.log("\nSummarization:");
  console.log(`  candidates               : ${summary.candidates}`);
  console.log(`  summarized (first time)  : ${summary.summarizedFirstTime}`);
  console.log(`  re-summarized (grew)     : ${summary.reSummarized}`);
  console.log(`  skipped (thin bodies)    : ${summary.skippedInsufficientBodies}`);
  console.log(`  rate limited             : ${summary.rateLimited}`);
  console.log(`  API errors               : ${summary.apiFailed}`);
  console.log(`  JSON parse failures      : ${summary.parseFailed}`);
  console.log(`  deferred (over run cap)  : ${summary.deferredOverCap}`);

  console.log("\n===========================================\n");
}
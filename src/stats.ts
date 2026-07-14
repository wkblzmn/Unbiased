// Run counters.
//
// The pipeline used to have four silent-drop paths (no body, no pubDate,
// source name mismatch, article too old) and zero visibility into any of
// them. That is not acceptable for a product whose entire claim is "we show
// you all the sources" — you cannot claim balanced coverage while not
// measuring which source you are dropping.
//
// The per-source table below is the evidence for the Dhaka Tribune 403
// limitation, and it is a table you can paste straight into the report.

export interface SourceCounters {
  feedError: boolean;
  itemsSeen: number;
  inserted: number;      // genuinely new rows
  alreadySeen: number;   // dedup hits
  malformedTitle: number;
  missingPubDate: number;
  bodyFromPage: number;
  bodyFromRssFallback: number;
  bodyRetryPending: number;
  // Body unavailable, but title + url + outlet are real. Clusters, appears
  // in the source list, never feeds a summary. This is the number that used
  // to be bodyFailedPermanently — i.e. deleted.
  linkOnly: number;
  // Genuinely unusable (no title or no url). Should be ~0. If this is not
  // ~0, something is wrong with the feed, not with the fetcher.
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
    linkOnly: 0,
    bodyFailedPermanently: 0,
  };
}

export interface PollerStats {
  perSource: Map<string, SourceCounters>;
}

export interface ClustererStats {
  readyArticles: number;      // with a real body
  linkOnlyArticles: number;   // title + url only
  staleArticles: number;
  seedClusters: number;
  joinedExisting: number;
  createdNew: number;
  mergeVia: Record<string, number>;
  belowSourceBar: number;   // < 2 outlets covered it at all
  belowSummaryBar: number;  // < 2 outlets supplied usable text
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
      padLeft("LINKONLY", 10) +
      padLeft("RETRY", 7) +
      padLeft("DEAD", 6) +
      padLeft("NO-DATE", 9)
  );
  for (const [name, c] of poll.perSource) {
    console.log(
      pad(c.feedError ? `${name} (FEED ERROR)` : name, 24) +
        padLeft(c.itemsSeen, 6) +
        padLeft(c.inserted, 6) +
        padLeft(c.alreadySeen, 6) +
        padLeft(c.bodyFromPage, 7) +
        padLeft(c.bodyFromRssFallback, 8) +
        padLeft(c.linkOnly, 10) +
        padLeft(c.bodyRetryPending, 7) +
        padLeft(c.bodyFailedPermanently, 6) +
        padLeft(c.missingPubDate, 9)
    );
  }

  console.log("\nClustering:");
  console.log(`  articles with body       : ${cluster.readyArticles}`);
  console.log(`  articles link-only       : ${cluster.linkOnlyArticles}`);
  console.log(`  stale (too old, skipped) : ${cluster.staleArticles}`);
  console.log(`  open clusters seeded     : ${cluster.seedClusters}`);
  console.log(`  joined existing cluster  : ${cluster.joinedExisting}`);
  console.log(`  founded new cluster      : ${cluster.createdNew}`);
  console.log(`  < 2 outlets covered      : ${cluster.belowSourceBar}`);
  console.log(`  < 2 outlets with text    : ${cluster.belowSummaryBar}`);
  console.log(`  merge_via                : ${JSON.stringify(cluster.mergeVia)}`);
  if (cluster.mergeVia["title_nobody"]) {
    console.log(
      `  ^ ${cluster.mergeVia["title_nobody"]} link-only merge(s) this run. These are the ` +
        `riskiest links in the system (no body to confirm with). Audit them: ` +
        `see the query at the bottom of migration_003.sql.`
    );
  }
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
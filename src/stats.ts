// Run counters.
//
// The pipeline used to have four silent-drop paths and zero visibility into any
// of them. That is not acceptable for a product whose entire claim is "we show
// you all the sources" — you cannot claim balanced coverage while not measuring
// which source you are dropping.

export interface SourceCounters {
  feedError: boolean;
  itemsSeen: number;
  inserted: number;
  alreadySeen: number;
  malformedTitle: number;
  missingPubDate: number;
  bodyFromPage: number;
  bodyFromRssFallback: number;
  bodyRetryPending: number;
  linkOnly: number;
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

export interface VetoRecord {
  articleTitle: string;
  wouldHaveMergedVia: string;
  sharedTerms: string[];
}

export interface ClustererStats {
  readyArticles: number;
  linkOnlyArticles: number;
  staleArticles: number;
  seedClusters: number;
  joinedExisting: number;
  createdNew: number;
  mergeVia: Record<string, number>;
  belowSourceBar: number;
  belowSummaryBar: number;
  readQueryTruncated: boolean;

  // THE VETO, INSTRUMENTED.
  //
  // GENERIC_TERMS is a hand-curated list, not a statistic. Two attempts to
  // derive it from document frequency failed on this corpus for the same
  // measured reason: at ~230 titles, DF cannot separate `death` (3.1%) from
  // `iran` (3.1%), and ranks the place name `ctg` (4.4%) above both. See the
  // header of clusterer.ts for the full DF table.
  //
  // So the list is an editorial input, like the bias labels are, and it is
  // audited the same way — by reading what it did.
  //
  // WHAT TO WATCH: every blocked merge is logged with the exact terms that were
  // shared. If a blocked pair is genuinely the same event, a word is in
  // GENERIC_TERMS that should not be.
  vetoed: number;
  vetoLog: VetoRecord[];
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

  console.log("\nGeneric-term veto:");
  console.log(`  merges blocked           : ${cluster.vetoed}`);

  if (cluster.vetoLog.length > 0) {
    console.log("\n  Blocked merges:");
    for (const v of cluster.vetoLog) {
      console.log(`    - "${v.articleTitle}"`);
      console.log(
        `      would have merged via ${v.wouldHaveMergedVia} on: ${v.sharedTerms.join(", ")}`
      );
      console.log(
        `      (every one of those is generic -> no event-identifying evidence)`
      );
    }
    console.log(
      "\n  Each of these founded its own cluster instead. That is fragmentation,"
    );
    console.log(
      "  which is the accepted trade (§4.4): a missing link is recoverable, a"
    );
    console.log("  wrong link is a lie. But CHECK them — a veto on a genuinely");
    console.log("  same-event merge means the constant is wrong.");
  }

  if (cluster.readQueryTruncated) {
    console.error(
      "\n  *** READ QUERY HIT THE POSTGREST ROW CAP — results were truncated. " +
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
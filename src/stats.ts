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
  // GENERIC_DF_RATIO is a guess verified by hand against 8 merges from one run.
  // That is a real check on a tiny sample, and the small-corpus problem that
  // killed the IDF experiment (v3) has not gone away. So the veto reports
  // everything it does and is judged on the evidence, not believed on the
  // argument.
  //
  // WHAT TO WATCH:
  //   genericTerms - if an EVENT-IDENTIFYING word shows up in here (a place, a
  //                  person, a specific noun), the ratio is too low and the veto
  //                  will start rejecting good merges. Raise GENERIC_DF_RATIO.
  //   vetoLog      - every merge blocked, with the terms that were shared. Read
  //                  these. If they look like the same event, the veto is wrong.
  vetoed: number;
  genericTerms: string[];
  corpusTitles: number;
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
  console.log(`  corpus titles            : ${cluster.corpusTitles}`);
  console.log(`  merges blocked           : ${cluster.vetoed}`);
  console.log(
    `  generic terms (${cluster.genericTerms.length}) : ${
      cluster.genericTerms.length > 0 ? cluster.genericTerms.join(", ") : "(none)"
    }`
  );
  console.log(
    "  ^ READ THIS LIST. These words can no longer justify a merge on their own."
  );
  console.log(
    "    If an event-identifying word (a place, a person, a specific noun) is in"
  );
  console.log(
    "    it, GENERIC_DF_RATIO is too low and good merges are being rejected."
  );

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
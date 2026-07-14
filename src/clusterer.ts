// Job 2: group articles covering the same real-world event.
//
// Design history (9 iterations, every one driven by a bug found in real
// production data, never by speculation):
//
//   v1 union-centroid Dice        - structural bug: growing denominator locked
//                                   well-covered stories out of their own cluster
//   v2 max-pairwise linkage       - fixed it
//   v3 IDF weighting              - TESTED AND REJECTED. At ~45 documents, DF
//                                   measures single-story coverage, not
//                                   genericness. `case` and `filed` scored rarer
//                                   than `savar`. Inverted.
//   v4 body coverage (one-way)    - missed reaction-piece-first stories
//   v5 bidirectional, per-member  - fixed it
//   v6 incremental                - seed from DB, persist only the delta
//   v7 span-bounded window        - firstAt drift eliminated by construction
//   v8 link-only articles         - a 403 no longer deletes an outlet's coverage
//   v9 generic-term veto          - see below
//
// v9 — THE GENERIC-TERM VETO
//
// Observed, in production, one false merge:
//
//   cluster: "BGB deployed in 11 flood-hit districts"        (12 Jul)
//   joined : "Flood death toll rises to 54; 6 lakh affected" (13 Jul, body_fwd)
//
// Different events. A troop deployment is not a casualty report. The body of
// the death-toll article was READ (1,200 chars) and mentions BGB exactly zero
// times. So how did it merge?
//
//   BGB headline keywords: {bgb, deployed, flood, hit, districts}   (5 terms)
//   Found in the death-toll body: flood ✓  districts ✓  hit ✓
//                                 deployed ✗  bgb ✗
//   coverage = 3/5 = 0.60 = exactly BODY_COVERAGE_THRESHOLD. Merged.
//
// It cleared the bar on `flood`, `districts` and `hit` — three of the most
// common words in the Bangladeshi monsoon news cycle — while missing BOTH
// terms that actually identify the event. coverage() is a bare fraction with
// no notion of which terms carry information. A short headline built from
// common words is trivially "covered" by any article on the same broad topic.
//
// THE VETO: on the WEAK paths only, at least one of the terms doing the
// merging must be non-generic. A term is generic if it appears in more than
// GENERIC_DF_RATIO of the titles in this run's corpus.
//
// WHY THIS IS NOT v3 REPEATING ITSELF. Three differences, and they matter:
//
//   1. It is a BINARY VETO, not a weight. v3 multiplied Dice by IDF and let a
//      distorted score decide the merge. This does not touch the score at all.
//      It asks one question after the fact: "was ANY of the evidence specific?"
//
//   2. It applies ONLY to the weak paths (body_fwd, body_bwd, title_nobody) —
//      the ones where the title signal was too weak to merge on its own and
//      something else had to rescue it. The strong path (title Dice >= 0.4 with
//      a real body) is untouched. v3 poisoned every merge; this touches only the
//      merges that were already operating on thin evidence.
//
//   3. It only ever REJECTS. v3's failure mode was promoting boilerplate terms
//      like `case` and `filed` above event terms like `savar`, which changed
//      which cluster won. This cannot promote anything. Worst case it rejects a
//      good merge, which produces fragmentation — the failure mode this project
//      has already accepted and documented (proposal §4.4).
//
// HONESTY ABOUT THE CONSTANTS: GENERIC_DF_RATIO is a guess. It was verified by
// hand against exactly 8 merges from one run — it blocks the BGB drift and
// preserves all 7 correct link-only merges. That is a real check but a tiny
// sample, and the small-corpus problem that killed v3 has not gone away.
//
// So the veto is INSTRUMENTED, not trusted. Every run prints the generic term
// list it computed and every merge it blocked, with the terms involved. If it
// starts rejecting good merges, the log will show it and the constant moves.
// Do not raise this to a claim the data does not support.

const STOPWORDS = new Set([
  "a", "an", "the", "in", "on", "at", "of", "for", "to", "and", "or",
  "is", "was", "are", "were", "with", "by", "from", "as", "over",
  "after", "before", "amid", "into", "out", "up", "down",
  "said", "says",
]);

const KEEP_SHORT = new Set(["us", "un", "uk", "eu", "bd", "bb", "ec"]);

const SYNONYMS: Record<string, string> = {
  explosion: "blast",
  explosions: "blast",
  blasts: "blast",
};

function truncateWords(text: string, maxWords: number): string {
  return text.split(/\s+/).slice(0, maxWords).join(" ");
}

function normalize(text: string, dropStopwords: boolean): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => {
      if (w.length === 0) return false;
      if (w.length <= 2 && !KEEP_SHORT.has(w)) return false;
      if (dropStopwords && STOPWORDS.has(w)) return false;
      return true;
    });

  return new Set(words.map((w) => SYNONYMS[w] ?? w));
}

export const titleKeywords = (title: string) => normalize(title, true);

export const bodyTokens = (body: string) =>
  normalize(truncateWords(body, 300), false);

export function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return (2 * shared) / (a.size + b.size);
}

// Which terms are shared / covered — not just how many. The veto needs the
// terms themselves, and so does the log line that lets you audit it.
function intersect(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const t of a) if (b.has(t)) out.push(t);
  return out;
}

// What fraction of `target` appears in `source`.
function coverageOf(source: Set<string>, target: Set<string>): {
  score: number;
  terms: string[];
} {
  if (target.size === 0) return { score: 0, terms: [] };
  const terms = intersect(target, source);
  return { score: terms.length / target.size, terms };
}

// ---------------------------------------------------------------------
// THE GENERIC TERM SET
//
// Document frequency over TITLES ONLY (bodies would drown everything in
// boilerplate), computed fresh every run over the whole corpus in scope:
// the new articles plus every member of every open cluster.
//
// GENERIC_MIN_DF exists because of the v3 lesson. At small n, a term appearing
// in 2 of 20 titles is 10% — but 2 occurrences is noise, not evidence of
// genericness. Requiring an absolute floor as well as a ratio stops the veto
// from inventing "generic" terms out of a handful of documents. This is the
// guard v3 did not have.
// ---------------------------------------------------------------------
const GENERIC_DF_RATIO = 0.1; // >10% of titles in the corpus
const GENERIC_MIN_DF = 3; // ...and at least 3 titles, absolutely

export function buildGenericTerms(titleSets: Set<string>[]): Set<string> {
  const generic = new Set<string>();
  const n = titleSets.length;
  if (n === 0) return generic;

  const df = new Map<string, number>();
  for (const s of titleSets) {
    for (const t of s) df.set(t, (df.get(t) ?? 0) + 1);
  }

  for (const [term, count] of df) {
    if (count >= GENERIC_MIN_DF && count / n > GENERIC_DF_RATIO) {
      generic.add(term);
    }
  }
  return generic;
}

function hasSpecificTerm(terms: string[], generic: Set<string>): boolean {
  return terms.some((t) => !generic.has(t));
}

export interface RawArticle {
  id: string;
  sourceId: string;
  publishedAt: Date;
  title: string;
  bodyText: string;
  hasBody: boolean;
}

export interface ClusterMember {
  id: string;
  sourceId: string;
  publishedAt: Date;
  titleKw: Set<string>;
  bodyKw: Set<string>;
  hasBody: boolean;
  isNew: boolean;
}

export type MergeVia =
  | "title"
  | "title_nobody"
  | "body_fwd"
  | "body_bwd"
  | "founder";

export interface Cluster {
  id?: string;
  members: ClusterMember[];
  firstAt: Date;
  lastAt: Date;
  mergeVia: Map<string, MergeVia>;
}

// Everything the veto did this run, so it can be audited instead of believed.
export interface ClusterDiagnostics {
  genericTerms: string[];
  corpusTitles: number;
  vetoed: number;
  vetoLog: Array<{
    articleTitle: string;
    wouldHaveMergedVia: MergeVia;
    sharedTerms: string[];
    allGeneric: true;
  }>;
}

const TITLE_MERGE = 0.4;
const TITLE_GATE = 0.2;
const BODY_COVERAGE_THRESHOLD = 0.6;
const RECENCY_H = 48;
const MAX_SPAN_H = 72;

// A link-only article has no body, so it can never confirm FORWARD. On the
// title-alone path it is genuinely unconfirmed, so it gets a raised bar.
// Asymmetry of harm: a missing source link is a documented limitation; a WRONG
// source link is a visible lie in a product whose entire pitch is trust.
const TITLE_MERGE_NOBODY = 0.55;

const MS_PER_H = 1000 * 60 * 60;

function hoursBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / MS_PER_H;
}

function spanHoursIfAdded(c: Cluster, t: Date): number {
  const first = Math.min(c.firstAt.getTime(), t.getTime());
  const last = Math.max(c.lastAt.getTime(), t.getTime());
  return (last - first) / MS_PER_H;
}

export function clusterArticles(
  newArticles: RawArticle[],
  existingClusters: Cluster[] = [],
  diag?: ClusterDiagnostics
): Cluster[] {
  const sorted = [...newArticles].sort(
    (a, b) => a.publishedAt.getTime() - b.publishedAt.getTime()
  );

  const clusters: Cluster[] = [...existingClusters];

  // The corpus for DF: every title in play this run. New articles AND every
  // member of every open cluster — because the merge decision is between a new
  // article and an existing member, so both populations define what "common"
  // means right now.
  const corpus: Set<string>[] = [
    ...sorted.map((a) => titleKeywords(a.title)),
    ...clusters.flatMap((c) => c.members.map((m) => m.titleKw)),
  ];
  const generic = buildGenericTerms(corpus);

  if (diag) {
    diag.genericTerms = [...generic].sort();
    diag.corpusTitles = corpus.length;
  }

  for (const article of sorted) {
    const kw = titleKeywords(article.title);
    const body = article.hasBody
      ? bodyTokens(article.bodyText)
      : new Set<string>();

    const candidates = clusters.filter(
      (c) =>
        c.members.length > 0 &&
        hoursBetween(article.publishedAt, c.lastAt) <= RECENCY_H &&
        spanHoursIfAdded(c, article.publishedAt) <= MAX_SPAN_H
    );

    const titleBar = article.hasBody ? TITLE_MERGE : TITLE_MERGE_NOBODY;

    let best: Cluster | null = null;
    let bestTier = 0; // 0 = none, 1 = body-confirmed, 2 = title-strong
    let bestTitleScore = 0;
    let bestVia: MergeVia = "title";
    let bestEvidence: string[] = [];

    // Track the strongest merge the VETO rejected, purely so it can be logged.
    let vetoedVia: MergeVia | null = null;
    let vetoedTerms: string[] = [];

    for (const c of candidates) {
      let titleScore = 0;
      let titleTerms: string[] = [];
      for (const m of c.members) {
        const s = dice(kw, m.titleKw);
        if (s > titleScore) {
          titleScore = s;
          titleTerms = intersect(kw, m.titleKw);
        }
      }

      let tier = 0;
      let via: MergeVia = article.hasBody ? "title" : "title_nobody";
      let evidence: string[] = [];

      if (titleScore >= titleBar) {
        tier = 2;
        via = article.hasBody ? "title" : "title_nobody";
        evidence = titleTerms;

        // The STRONG path (real body, Dice >= 0.4) is NOT vetoed. A 0.4+ title
        // match is substantial evidence on its own and the veto has no business
        // second-guessing it. Only title_nobody — which has no body behind it —
        // is checked here.
        if (via === "title_nobody" && !hasSpecificTerm(evidence, generic)) {
          if (tier > bestTier || vetoedVia === null) {
            vetoedVia = via;
            vetoedTerms = evidence;
          }
          tier = 0;
        }
      } else if (titleScore >= TITLE_GATE) {
        // FORWARD: this article's body covers a member's title.
        // Structurally impossible for a link-only article — empty body set.
        let forward = 0;
        let forwardTerms: string[] = [];
        if (article.hasBody) {
          for (const m of c.members) {
            const cov = coverageOf(body, m.titleKw);
            if (cov.score > forward) {
              forward = cov.score;
              forwardTerms = cov.terms;
            }
          }
        }

        // BACKWARD: a member's body covers THIS article's title. This is the
        // path that rescues Dhaka Tribune honestly — another outlet's full text
        // containing this headline's terms is independent confirmation. Only
        // members that HAVE a body can confirm; a link-only member has an empty
        // body set and contributes no false signal.
        let backward = 0;
        let backwardTerms: string[] = [];
        for (const m of c.members) {
          if (!m.hasBody) continue;
          const cov = coverageOf(m.bodyKw, kw);
          if (cov.score > backward) {
            backward = cov.score;
            backwardTerms = cov.terms;
          }
        }

        const useForward = forward >= backward;
        const bestCoverage = useForward ? forward : backward;

        if (bestCoverage >= BODY_COVERAGE_THRESHOLD) {
          tier = 1;
          via = useForward ? "body_fwd" : "body_bwd";
          evidence = useForward ? forwardTerms : backwardTerms;

          // THE VETO. This is the line that would have blocked the BGB drift:
          // covered terms were {flood, districts, hit}, all three generic,
          // while `bgb` and `deployed` — the terms that identify the event —
          // were absent from the body entirely.
          if (!hasSpecificTerm(evidence, generic)) {
            if (tier > bestTier || vetoedVia === null) {
              vetoedVia = via;
              vetoedTerms = evidence;
            }
            tier = 0;
          }
        }
      }

      if (
        tier > bestTier ||
        (tier === bestTier && tier > 0 && titleScore > bestTitleScore)
      ) {
        best = c;
        bestTier = tier;
        bestTitleScore = titleScore;
        bestVia = via;
        bestEvidence = evidence;
      }
    }

    // Log the veto ONLY if it actually changed the outcome — i.e. nothing else
    // took the article. A veto on one candidate while the article merged
    // correctly into another is the system working, not a rejection.
    if (bestTier === 0 && vetoedVia && diag) {
      diag.vetoed++;
      diag.vetoLog.push({
        articleTitle: article.title,
        wouldHaveMergedVia: vetoedVia,
        sharedTerms: vetoedTerms,
        allGeneric: true,
      });
    }

    const newMember: ClusterMember = {
      id: article.id,
      sourceId: article.sourceId,
      publishedAt: article.publishedAt,
      titleKw: kw,
      bodyKw: body,
      hasBody: article.hasBody,
      isNew: true,
    };

    if (best && bestTier > 0) {
      void bestEvidence; // kept for future audit logging
      best.members.push(newMember);

      if (article.publishedAt.getTime() > best.lastAt.getTime()) {
        best.lastAt = article.publishedAt;
      }
      if (article.publishedAt.getTime() < best.firstAt.getTime()) {
        best.firstAt = article.publishedAt;
      }

      best.mergeVia.set(article.id, bestVia);
    } else {
      // A vetoed article founds its own cluster. That is fragmentation, and
      // fragmentation is the failure mode this project accepted up front
      // (§4.4). A missing link is recoverable; a wrong link is a lie.
      clusters.push({
        members: [newMember],
        firstAt: article.publishedAt,
        lastAt: article.publishedAt,
        mergeVia: new Map(),
      });
    }
  }

  return clusters;
}

export function emptyDiagnostics(): ClusterDiagnostics {
  return { genericTerms: [], corpusTitles: 0, vetoed: 0, vetoLog: [] };
}

// Outlets that COVERED the event. Drives the story detail screen.
export function distinctSourceCount(c: Cluster): number {
  return new Set(c.members.map((m) => m.sourceId)).size;
}

// Outlets whose TEXT fed the summary. Drives the feed gate and the two-source
// corroboration rule. A link-only outlet does not count — we never read a word
// of its article, so it corroborates nothing.
export function distinctSummarySourceCount(c: Cluster): number {
  return new Set(c.members.filter((m) => m.hasBody).map((m) => m.sourceId)).size;
}
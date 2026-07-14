// Job 2: group articles covering the same real-world event.
//
// Design history (9 iterations, every one driven by a bug found in real
// production data, never by speculation):
//
//   v1 union-centroid Dice        - structural bug: growing denominator locked
//                                   well-covered stories out of their own cluster
//   v2 max-pairwise linkage       - fixed it
//   v3 IDF weighting              - TESTED AND REJECTED (see v9)
//   v4 body coverage (one-way)    - missed reaction-piece-first stories
//   v5 bidirectional, per-member  - fixed it
//   v6 incremental                - seed from DB, persist only the delta
//   v7 span-bounded window        - firstAt drift eliminated by construction
//   v8 link-only articles         - a 403 no longer deletes an outlet's coverage
//   v9 generic-term veto          - see below
//
// ---------------------------------------------------------------------------
// v9 — THE GENERIC-TERM VETO
//
// One false merge, observed in production:
//
//   cluster: "BGB deployed in 11 flood-hit districts"        (12 Jul)
//   joined : "Flood death toll rises to 54; 6 lakh affected" (13 Jul, body_fwd)
//
// Different events. A troop deployment is not a casualty report. The body of
// the death-toll article was READ in full; it mentions BGB exactly zero times.
// So how did it merge?
//
//   BGB title keywords: {bgb, deployed, flood, hit, districts}
//   Found in the death-toll body: flood ✓  districts ✓  hit ✓  (via "worst-hit")
//                                 deployed ✗  bgb ✗
//   coverage = 3/5 = 0.60 = exactly BODY_COVERAGE_THRESHOLD. Merged.
//
// It cleared the bar on three of the most common words in the Bangladeshi
// monsoon news cycle while missing BOTH terms that identify the event.
// coverage() is a bare fraction with no notion of which terms carry
// information. A short headline built from common words is trivially "covered"
// by any article on the same broad topic.
//
// THE RULE: on the WEAK paths only, at least one of the terms doing the merging
// must be non-generic.
//
// ---------------------------------------------------------------------------
// WHY THE LIST IS CURATED AND NOT DERIVED FROM DOCUMENT FREQUENCY
//
// The obvious implementation is IDF: call a term generic if it appears in more
// than X% of the corpus. That was tried. TWICE. It fails, and the measured
// reason is the same both times.
//
// v3 tried DF as a WEIGHT on the Dice score and it inverted: at ~45 documents,
// boilerplate like `case` and `filed` scored RARER than event-identifying terms
// like `savar`, because DF at that scale measures how many outlets covered ONE
// story, not how generic a word is across topics.
//
// v9 first tried DF as a RATIO-BASED VETO, on the theory that scoping it
// narrowly rescued it. It did not. Here is the actual document frequency of the
// live 226-title corpus:
//
//     for           25   11.1%       ctg            10    4.4%
//     bangladesh    22    9.7%       heavy          10    4.4%
//     govt          21    9.3%       death           7    3.1%
//     minister      20    8.8%       iran            7    3.1%
//     flood         16    7.1%       waterlogging    5    2.2%
//     rain          15    6.6%       hsc             5    2.2%
//     dhaka         15    6.6%       trump           5    2.2%
//     parliament    12    5.3%
//
// Read `death` (3.1%) against `iran` (3.1%). Identical frequency. One is pure
// boilerplate; the other is the single most event-identifying word in its
// headline. And `ctg` — Chittagong, a PLACE NAME — outranks both at 4.4%.
//
// There is no threshold that separates these. Any cut low enough to catch
// `death` also catches `iran` and `ctg`, and vetoing on a place name rejects
// good merges. `iran` is at 3.1% not because Iran is generic but because there
// were 7 Iran stories this week; next week it is zero. DF at this corpus size
// measures THIS WEEK'S NEWS CYCLE, not the language.
//
// So: a curated list. Small, static, stable across news cycles, and defensible.
// It is an editorial input, exactly like the per-source bias labels are — and
// it should be declared as one in the report rather than dressed up as
// statistics it cannot support. Claiming "IDF-weighted clustering" for a
// mechanism that demonstrably inverts on this corpus would be the same kind of
// unearned authority this product exists to push back on.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// GENERIC TERMS — high-frequency, low-information words in the Bangladeshi
// news corpus. These can still CONTRIBUTE to a Dice or coverage score. What
// they cannot do is be the ONLY evidence behind a weak-path merge.
//
// Curated by hand, from the observed DF table above plus the obvious
// institutional vocabulary. Deliberately does NOT contain:
//   - place names (dhaka is here as a modifier, but not chittagong/sylhet/ctg)
//   - person names
//   - numbers
//   - any term that identifies WHICH event, only terms that identify WHICH TOPIC
//
// If a merge's only shared evidence is drawn entirely from this set, the two
// articles are about the same TOPIC, not demonstrably the same EVENT.
// ---------------------------------------------------------------------------
const GENERIC_TERMS = new Set([
  // Nation / geography as topic markers
  "bangladesh", "bangladeshi", "dhaka", "country", "national", "nationwide",

  // Government and recurring institutions
  "govt", "government", "minister", "ministry", "parliament", "police",
  "court", "committee", "authorities", "official", "officials", "adviser",

  // The dominant weather / disaster vocabulary. This is the cluster of words
  // that produced the BGB false merge.
  "flood", "floods", "flooded", "flooding", "rain", "rains", "rainfall",
  "monsoon", "heavy", "water", "weather", "district", "districts",
  "affected", "hit", "situation", "danger", "level", "relief",

  // Generic event nouns and reporting verbs that survive the stopword filter
  "death", "deaths", "dead", "toll", "people", "report", "reports",
  "case", "cases", "new", "day", "days", "year", "years",
  "may", "will", "continue", "continues", "amid",
]);

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

// Which terms are shared — not just how many. The veto needs the terms
// themselves, and so does the log line that lets you audit it.
function intersect(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const t of a) if (b.has(t)) out.push(t);
  return out;
}

function coverageOf(
  source: Set<string>,
  target: Set<string>
): { score: number; terms: string[] } {
  if (target.size === 0) return { score: 0, terms: [] };
  const terms = intersect(target, source);
  return { score: terms.length / target.size, terms };
}

export function isGeneric(term: string): boolean {
  return GENERIC_TERMS.has(term);
}

// The whole veto, in one line: was ANY of the evidence event-identifying?
function hasSpecificTerm(terms: string[]): boolean {
  return terms.some((t) => !GENERIC_TERMS.has(t));
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

// Everything the veto did this run, so it can be audited rather than believed.
export interface ClusterDiagnostics {
  vetoed: number;
  vetoLog: Array<{
    articleTitle: string;
    wouldHaveMergedVia: MergeVia;
    sharedTerms: string[];
  }>;
}

export function emptyDiagnostics(): ClusterDiagnostics {
  return { vetoed: 0, vetoLog: [] };
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

    // Track the merge the veto rejected, purely so it can be logged.
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

      if (titleScore >= titleBar) {
        tier = 2;
        via = article.hasBody ? "title" : "title_nobody";

        // The STRONG path (real body, Dice >= 0.4) is NOT vetoed. A 0.4+ title
        // match against a member is substantial evidence in its own right and
        // the veto has no business second-guessing it. Only title_nobody —
        // which has no body behind it at all — is checked here.
        if (via === "title_nobody" && !hasSpecificTerm(titleTerms)) {
          if (vetoedVia === null) {
            vetoedVia = via;
            vetoedTerms = titleTerms;
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
          const evidence = useForward ? forwardTerms : backwardTerms;

          // THE VETO. This is the line that blocks the BGB drift: covered terms
          // were {flood, hit, districts} — all three generic — while `bgb` and
          // `deployed`, the terms that identify the event, were absent from the
          // body entirely.
          if (!hasSpecificTerm(evidence)) {
            if (vetoedVia === null) {
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
      }
    }

    // Log the veto ONLY if it changed the outcome. A veto on one candidate
    // while the article merged correctly into another is the system working.
    if (bestTier === 0 && vetoedVia && diag) {
      diag.vetoed++;
      diag.vetoLog.push({
        articleTitle: article.title,
        wouldHaveMergedVia: vetoedVia,
        sharedTerms: vetoedTerms,
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
      best.members.push(newMember);

      if (article.publishedAt.getTime() > best.lastAt.getTime()) {
        best.lastAt = article.publishedAt;
      }
      if (article.publishedAt.getTime() < best.firstAt.getTime()) {
        best.firstAt = article.publishedAt;
      }

      best.mergeVia.set(article.id, bestVia);
    } else {
      // A vetoed article founds its own cluster. That is fragmentation, which
      // is the failure mode this project accepted up front (§4.4): a missing
      // link is recoverable, a wrong link is a lie.
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
// Job 2: group articles covering the same real-world event.
//
// Design history (8 iterations, each driven by a real bug in production
// data): v1 union-centroid (bug: growing-denominator lockout) -> v2
// max-pairwise -> v3 IDF tested and rejected (inverted at small corpus
// size) -> v4 one-directional body coverage (bug: missed reaction-piece-
// first stories) -> v5 bidirectional, per-member -> v6 incremental (seed
// from DB, persist delta) -> v7 span-bounded window -> v8 link-only
// articles (see LINK-ONLY below).
//
// WHAT THIS FILE DOES NOT DO: it does not refuse to merge two articles from
// the same outlet. That is correct — a Daily Star story and its own follow-up
// ARE the same event, and both links belong on the detail screen. The
// two-outlet requirement is a SURFACING rule, not a merging rule, and it
// lives in the feed view and the summarizer's candidate query.

const STOPWORDS = new Set([
  "a", "an", "the", "in", "on", "at", "of", "for", "to", "and", "or",
  "is", "was", "are", "were", "with", "by", "from", "as", "over",
  "after", "before", "amid", "into", "out", "up", "down",
  "said", "says",
]);

// normalize() drops tokens of length <= 2, which threw away some of the
// highest-signal tokens in the corpus. "UN", "US", "EU", "BD" identify an
// event; "of" and "to" do not. The length filter was a crude proxy for
// stopword-ness; this buys back the false negatives.
const KEEP_SHORT = new Set(["us", "un", "uk", "eu", "bd", "bb", "ec"]);

// KEY = variant found in text. VALUE = canonical form.
// HARD CAP: <= 10 entries. Event nouns only. Never entity names, never
// verbs whose factual or legal meaning differs.
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

// Capped to ~300 words. News is inverted-pyramid; without a cap, a long
// piece could incidentally cover an unrelated title deep in later
// paragraphs and cause a false positive.
export const bodyTokens = (body: string) =>
  normalize(truncateWords(body, 300), false);

export function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return (2 * shared) / (a.size + b.size);
}

function coverage(source: Set<string>, target: Set<string>): number {
  if (target.size === 0) return 0;
  let found = 0;
  for (const term of target) if (source.has(term)) found++;
  return found / target.size;
}

export interface RawArticle {
  id: string;
  sourceId: string;
  publishedAt: Date;
  title: string;
  bodyText: string;
  // LINK-ONLY: true when the body could not be retrieved at all (Dhaka
  // Tribune's 403 wall + an empty RSS description). The article is still
  // real: the headline is real, the URL is real, the outlet's lean is real.
  // Only the text is missing.
  hasBody: boolean;
}

export interface ClusterMember {
  id: string;
  sourceId: string;
  publishedAt: Date;
  titleKw: Set<string>;
  bodyKw: Set<string>;
  hasBody: boolean;
  isNew: boolean; // true only if added during THIS run
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
  mergeVia: Map<string, MergeVia>; // only tracks NEW merges made this run
}

const TITLE_MERGE = 0.4; // title alone is strong enough to merge
const TITLE_GATE = 0.2; // minimum title score before body confirmation applies
const BODY_COVERAGE_THRESHOLD = 0.6;
const RECENCY_H = 48;
const MAX_SPAN_H = 72;

// LINK-ONLY THRESHOLD — deliberately higher than TITLE_MERGE.
//
// A link-only article has no body. That costs it two of the three merge
// paths: it can never confirm FORWARD (its body covering a member's title,
// because it has no body). It can still merge on a strong title match, and
// it can still be caught BACKWARD (an existing member's body covering ITS
// title) — which is actually the strongest available evidence for it, since
// someone else's full text mentioning its headline terms is independent
// confirmation.
//
// So the only path where it is genuinely unconfirmed is title-alone. That
// path gets a raised bar: 0.55 instead of 0.4.
//
// The reason is asymmetry of harm. Right now the observed false-merge rate
// is ZERO. A missing source link is a known, documented limitation. A WRONG
// source link — "Dhaka Tribune covered this event", with a headline about a
// different event underneath it — is a visible lie in a product whose entire
// pitch is trustworthiness. Recall-biased, as per proposal §4.4, and as per
// every previous decision in this file.
//
// Every link that comes in this way is tagged 'title_nobody' so it can be
// counted and eyeballed. If the audit query in migration_003 shows drift,
// raise this number. It is the one dial that trades DT coverage against
// the zero-false-merge record.
const TITLE_MERGE_NOBODY = 0.55;

const MS_PER_H = 1000 * 60 * 60;

function hoursBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / MS_PER_H;
}

// The cluster's total span, if this timestamp were admitted. Bounding the
// SPAN (rather than freezing firstAt, which never worked across runs) makes
// MAX_SPAN_H hold by construction, in both directions, on every run.
function spanHoursIfAdded(c: Cluster, t: Date): number {
  const first = Math.min(c.firstAt.getTime(), t.getTime());
  const last = Math.max(c.lastAt.getTime(), t.getTime());
  return (last - first) / MS_PER_H;
}

export function clusterArticles(
  newArticles: RawArticle[],
  existingClusters: Cluster[] = []
): Cluster[] {
  // Deterministic order — greedy single-assignment clustering is
  // order-dependent otherwise.
  const sorted = [...newArticles].sort(
    (a, b) => a.publishedAt.getTime() - b.publishedAt.getTime()
  );

  const clusters: Cluster[] = [...existingClusters];

  for (const article of sorted) {
    const kw = titleKeywords(article.title);
    const body = article.hasBody ? bodyTokens(article.bodyText) : new Set<string>();

    const candidates = clusters.filter(
      (c) =>
        c.members.length > 0 && // guard: Math.max(...[]) is -Infinity
        hoursBetween(article.publishedAt, c.lastAt) <= RECENCY_H &&
        spanHoursIfAdded(c, article.publishedAt) <= MAX_SPAN_H
    );

    // A link-only article needs a STRONGER title match to merge on title
    // alone, because it has no body to corroborate with.
    const titleBar = article.hasBody ? TITLE_MERGE : TITLE_MERGE_NOBODY;

    let best: Cluster | null = null;
    let bestTier = 0; // 0 = no match, 1 = body-confirmed, 2 = title-strong
    let bestTitleScore = 0;
    let bestVia: MergeVia = "title";

    for (const c of candidates) {
      // Max-pairwise: compare against individual members, never a union.
      const titleScore = Math.max(...c.members.map((m) => dice(kw, m.titleKw)));

      let tier = 0;
      let via: MergeVia = article.hasBody ? "title" : "title_nobody";

      if (titleScore >= titleBar) {
        tier = 2;
        via = article.hasBody ? "title" : "title_nobody";
      } else if (titleScore >= TITLE_GATE) {
        // FORWARD: this article's body covers an existing member's title.
        // Structurally impossible for a link-only article — `body` is empty,
        // coverage() returns 0. Correct: it has nothing to confirm WITH.
        const forward = article.hasBody
          ? Math.max(...c.members.map((m) => coverage(body, m.titleKw)))
          : 0;

        // BACKWARD: an existing member's body covers THIS article's title.
        // This one DOES work for a link-only article, and it is the best
        // evidence available for it — another outlet's full text containing
        // this headline's terms is independent confirmation that they are
        // about the same event. This is the path that rescues Dhaka Tribune
        // honestly rather than on a title coin-flip.
        //
        // Only members that actually HAVE a body can confirm. A link-only
        // member has an empty bodyKw, coverage() returns 0, no false signal.
        const backward = Math.max(
          ...c.members.map((m) => (m.hasBody ? coverage(m.bodyKw, kw) : 0))
        );

        const bestCoverage = Math.max(forward, backward);

        if (bestCoverage >= BODY_COVERAGE_THRESHOLD) {
          tier = 1;
          via = forward >= backward ? "body_fwd" : "body_bwd";
        }
      }

      if (tier > bestTier || (tier === bestTier && titleScore > bestTitleScore)) {
        best = c;
        bestTier = tier;
        bestTitleScore = titleScore;
        bestVia = via;
      }
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

      // Both ends move honestly. The span check above already guaranteed the
      // result stays inside MAX_SPAN_H, so widening either end is safe.
      if (article.publishedAt.getTime() > best.lastAt.getTime()) {
        best.lastAt = article.publishedAt;
      }
      if (article.publishedAt.getTime() < best.firstAt.getTime()) {
        best.firstAt = article.publishedAt;
      }

      best.mergeVia.set(article.id, bestVia);
    } else {
      // A link-only article CAN found a cluster. It will sit at
      // summary_source_count = 0 and never surface on its own — which is
      // right, since we have no text for it. If two real-bodied articles
      // later join it, it becomes a story and DT is already in the source
      // list. That is the whole point.
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

// The two invariants the product rests on, expressed once, here, so they can
// be unit-tested and so nobody has to re-derive them from a SQL view.

// Outlets that COVERED the event. Drives the story detail screen.
export function distinctSourceCount(c: Cluster): number {
  return new Set(c.members.map((m) => m.sourceId)).size;
}

// Outlets whose TEXT fed the summary. Drives the feed gate and the
// two-source corroboration rule. A link-only outlet does not count here —
// we never read a word of its article, so it corroborates nothing.
export function distinctSummarySourceCount(c: Cluster): number {
  return new Set(c.members.filter((m) => m.hasBody).map((m) => m.sourceId)).size;
}
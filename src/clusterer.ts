// Job 2: group articles covering the same real-world event.
//
// Design history (7 iterations, each driven by a real bug in production
// data): v1 union-centroid (bug: growing-denominator lockout) -> v2
// max-pairwise -> v3 IDF tested and rejected (inverted at small corpus
// size) -> v4 one-directional body coverage (bug: missed reaction-piece-
// first stories) -> v5 bidirectional, per-member -> v6 incremental
// (accepts existing clusters as seed state, persists only the delta) ->
// v7 span-bounded window (see BUG-10 below).
//
// NOTE ON WHAT THIS FILE DOES NOT DO: it does not refuse to merge two
// articles from the same outlet. That is correct — a Daily Star story and
// its own Daily Star follow-up ARE the same event, and both links belong
// on the detail screen. The two-outlet requirement is a SURFACING rule,
// not a merging rule, and it lives in the feed_clusters view and the
// summarizer's candidate query. sourceId is carried here only so the
// invariant is testable at this layer.

const STOPWORDS = new Set([
  "a", "an", "the", "in", "on", "at", "of", "for", "to", "and", "or",
  "is", "was", "are", "were", "with", "by", "from", "as", "over",
  "after", "before", "amid", "into", "out", "up", "down",
  "said", "says",
]);

// normalize() drops tokens of length <= 2, which silently threw away some
// of the highest-signal tokens in the corpus. "UN", "US", "EU", "BD" are
// exactly the terms that identify an event; "of" and "to" are not. The
// length filter was a crude proxy for stopword-ness and this is the small
// allowlist that buys back the false negatives.
const KEEP_SHORT = new Set(["us", "un", "uk", "eu", "bd", "bb", "ec"]);

// KEY = the variant found in text.  VALUE = the canonical form it
// collapses to.  normalize() does `SYNONYMS[word] ?? word`, i.e. it looks
// the word up as a KEY and substitutes the VALUE.
//
// HARD CAP: <= 10 entries. Event-noun synonyms only. Never entity names,
// never verbs whose factual or legal meaning differs.
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
}

export interface ClusterMember {
  id: string;
  sourceId: string;
  publishedAt: Date;
  titleKw: Set<string>;
  bodyKw: Set<string>;
  isNew: boolean; // true only if added during THIS run
}

export type MergeVia = "title" | "body_fwd" | "body_bwd" | "founder";

export interface Cluster {
  id?: string; // Supabase story_clusters.id — set if it existed before this run
  members: ClusterMember[];
  firstAt: Date;
  lastAt: Date;
  mergeVia: Map<string, MergeVia>; // only tracks NEW merges made this run
}

const TITLE_MERGE = 0.4; // title alone is strong enough to merge
const TITLE_GATE = 0.2; // minimum title score before body confirmation applies
const BODY_COVERAGE_THRESHOLD = 0.6;
const RECENCY_H = 48; // candidate must be within this of the cluster's LAST article
const MAX_SPAN_H = 72; // ...and the cluster's TOTAL span may never exceed this

const MS_PER_H = 1000 * 60 * 60;

function hoursBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / MS_PER_H;
}

// BUG-10 FIX. The old code had two half-measures that cancelled out.
//
// The candidate filter was `hoursBetween(article, firstAt) <= MAX_CLUSTER_AGE`
// using Math.abs — so an article published up to 72h BEFORE the cluster's
// first member could join it. And `firstAt` was then frozen on purpose
// ("if it slid backward the span could creep past MAX_CLUSTER_AGE"),
// which meant the true span of the resulting cluster could reach 144h
// while the code believed it was enforcing 72h.
//
// Worse, the freeze didn't even hold: runClusterer reloaded seed clusters
// with `firstAt = min(published_at of members)`, so on the very next run
// firstAt slid backward anyway. The freeze protected exactly one batch and
// was then undone by the reload. Meanwhile first_article_at in the DB was
// never updated at all, so the client was served a stale value.
//
// The fix is to stop trying to freeze a derived value and instead bound the
// thing we actually care about: the SPAN. firstAt and lastAt are now both
// honest min/max of the members, and a candidate is only admissible if the
// span AFTER admitting it still fits inside MAX_SPAN_H. The bound now holds
// by construction, on every run, in both directions, and the DB columns can
// be trusted.
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
    const body = bodyTokens(article.bodyText);

    const candidates = clusters.filter(
      (c) =>
        c.members.length > 0 && // guard: Math.max(...[]) is -Infinity
        hoursBetween(article.publishedAt, c.lastAt) <= RECENCY_H &&
        spanHoursIfAdded(c, article.publishedAt) <= MAX_SPAN_H
    );

    let best: Cluster | null = null;
    let bestTier = 0; // 0 = no match, 1 = body-confirmed, 2 = title-strong
    let bestTitleScore = 0;
    let bestVia: MergeVia = "title";

    for (const c of candidates) {
      // Max-pairwise: compare against individual members, never a union.
      const titleScore = Math.max(...c.members.map((m) => dice(kw, m.titleKw)));

      let tier = 0;
      let via: MergeVia = "title";

      if (titleScore >= TITLE_MERGE) {
        tier = 2;
        via = "title";
      } else if (titleScore >= TITLE_GATE) {
        // Bidirectional, per-member — either the new article's body covers
        // an existing member's title, or an existing member's body covers
        // the new article's title. No frozen "founder" bottleneck.
        const forward = Math.max(
          ...c.members.map((m) => coverage(body, m.titleKw))
        );
        const backward = Math.max(
          ...c.members.map((m) => coverage(m.bodyKw, kw))
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
      isNew: true,
    };

    if (best && bestTier > 0) {
      best.members.push(newMember);

      // Both ends move honestly now. The span check above already
      // guaranteed the result stays inside MAX_SPAN_H, so widening is safe.
      if (article.publishedAt.getTime() > best.lastAt.getTime()) {
        best.lastAt = article.publishedAt;
      }
      if (article.publishedAt.getTime() < best.firstAt.getTime()) {
        best.firstAt = article.publishedAt;
      }

      best.mergeVia.set(article.id, bestVia);
    } else {
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

// The invariant the product is actually built on, expressed once, here, so
// it can be unit-tested and so nobody has to re-derive it from a SQL view.
export function distinctSourceCount(c: Cluster): number {
  return new Set(c.members.map((m) => m.sourceId)).size;
}
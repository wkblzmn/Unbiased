// Job 2: group articles covering the same real-world event.
//
// v6 (current) — made incremental. Previously ran from empty state every
// time, reclustering the full article history on every invocation
// (known issue #2). Now accepts an optional array of EXISTING clusters
// (loaded from Supabase, rebuilt into the same in-memory shape) as seed
// state — only NEW articles get passed in, matched against that seed
// plus any brand-new clusters formed within this run. Each cluster now
// carries an optional `id` (its Supabase story_clusters id, if it
// existed before this run) and each member carries `isNew` (true only
// for articles processed this run), so the caller can persist just the
// delta instead of rewriting everything.
//
// (v1-v5: union-centroid growing-denominator bug -> max-pairwise; single
// time clock -> two-clock window; raw shared-word count -> Dice; IDF
// tried and killed by real small-corpus evidence -> body-text coverage;
// one-directional body check -> bidirectional. See prior commits.)

const STOPWORDS = new Set([
  "a", "an", "the", "in", "on", "at", "of", "for", "to", "and", "or",
  "is", "was", "are", "were", "with", "by", "from", "as", "over",
  "after", "before", "amid", "into", "out", "up", "down",
  "said", "says",
]);

const SYNONYMS: Record<string, string> = {
  explosion: "blast",
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
    .filter((w) => w.length > 2 && (!dropStopwords || !STOPWORDS.has(w)));

  return new Set(words.map((w) => SYNONYMS[w] ?? w));
}

export const titleKeywords = (title: string) => normalize(title, true);
export const bodyTokens = (body: string) => normalize(truncateWords(body, 300), false);

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
  publishedAt: Date;
  title: string;
  bodyText: string;
}

export interface ClusterMember {
  id: string;
  publishedAt: Date;
  titleKw: Set<string>;
  bodyKw: Set<string>;
  isNew: boolean; // true only if added during THIS run
}

export type MergeVia = "title" | "body_fwd" | "body_bwd" | "founder";

export interface Cluster {
  id?: string; // Supabase story_clusters.id — present if this cluster existed before this run
  members: ClusterMember[];
  firstAt: Date;
  lastAt: Date;
  mergeVia: Map<string, MergeVia>; // only tracks NEW merges made this run
}

const TITLE_MERGE = 0.4;
const TITLE_GATE = 0.2;
const BODY_COVERAGE_THRESHOLD = 0.6;
const RECENCY_H = 48;
const MAX_CLUSTER_AGE = 72;

function hoursBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60);
}

export function clusterArticles(newArticles: RawArticle[], existingClusters: Cluster[] = []): Cluster[] {
  const sorted = [...newArticles].sort(
    (a, b) => a.publishedAt.getTime() - b.publishedAt.getTime()
  );

  const clusters: Cluster[] = [...existingClusters];

  for (const article of sorted) {
    const kw = titleKeywords(article.title);
    const body = bodyTokens(article.bodyText);

    const candidates = clusters.filter(
      (c) =>
        hoursBetween(article.publishedAt, c.lastAt) <= RECENCY_H &&
        hoursBetween(article.publishedAt, c.firstAt) <= MAX_CLUSTER_AGE
    );

    let best: Cluster | null = null;
    let bestTier = 0;
    let bestTitleScore = 0;
    let bestVia: MergeVia = "title";

    for (const c of candidates) {
      const titleScore = Math.max(...c.members.map((m) => dice(kw, m.titleKw)));

      let tier = 0;
      let via: MergeVia = "title";

      if (titleScore >= TITLE_MERGE) {
        tier = 2;
        via = "title";
      } else if (titleScore >= TITLE_GATE) {
        const forward = Math.max(...c.members.map((m) => coverage(body, m.titleKw)));
        const backward = Math.max(...c.members.map((m) => coverage(m.bodyKw, kw)));
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
      publishedAt: article.publishedAt,
      titleKw: kw,
      bodyKw: body,
      isNew: true,
    };

    if (best && bestTier > 0) {
      best.members.push(newMember);
      best.lastAt = article.publishedAt;
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
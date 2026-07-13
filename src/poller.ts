import Parser from "rss-parser";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { SOURCES } from "./sources";
import { fetchArticleBody, extractFallbackBody } from "./articleFetcher";
import {
  PollerStats,
  SourceCounters,
  emptySourceCounters,
} from "./stats";

const parser = new Parser();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Raised from 10. GitHub Actions cron is best-effort — a delayed or
// dropped run means more than 10 items may have accumulated since the
// last poll. Dedup is enforced by the `url unique` constraint, so a
// bigger slice costs nothing but a few no-op upserts.
const ITEMS_PER_FEED = 25;

// BUG-6: articles that permanently fail (404, DT 403 with a too-short
// snippet) used to be retried on EVERY run, forever, building an
// unbounded queue of dead URLs.
const MAX_BODY_ATTEMPTS = 3;

// PostgREST caps a response at 1000 rows by default. Being explicit means
// hitting the cap is visible rather than silent.
const MAX_PENDING_PER_RUN = 200;

// Daily Star wraps its headline in a nested <a> element inside <title>;
// the other two put plain text directly in the tag. rss-parser (xml2js)
// returns a string for plain text but a parsed object subtree when it
// hits nested elements — this normalizes both.
//
// BUG-9 FIX: the old version's last line was `return String(raw)`, which
// on any unhandled shape produces the literal string "[object Object]".
// That normalizes to the keyword set {object} and would cheerfully cluster
// with every other broken title in the batch. Silently. It now returns
// null and the caller counts and skips it.
export function extractTitle(raw: unknown): string | null {
  if (typeof raw === "string") {
    const t = raw.trim();
    return t.length > 0 ? t : null;
  }
  const obj = raw as any;
  if (typeof obj?.a?.[0]?._ === "string") return obj.a[0]._.trim() || null;
  if (typeof obj?._ === "string") return obj._.trim() || null;
  return null;
}

// ROT fix: the poller used to look up source ids by exact name match and
// `continue` with a console.error on a miss — one typo in sources.ts and
// an entire outlet vanished from the product while the run still exited 0.
// sources.ts is now the single source of truth; the table follows it.
async function syncSources(): Promise<Map<string, string>> {
  const { error: upsertError } = await supabase.from("sources").upsert(
    SOURCES.map((s) => ({
      name: s.name,
      rss_url: s.url,
      bias_label: s.bias,
    })),
    { onConflict: "name" }
  );
  if (upsertError) throw upsertError;

  const { data, error } = await supabase.from("sources").select("id, name");
  if (error) throw error;

  const idByName = new Map<string, string>(
    data.map((s) => [s.name as string, s.id as string])
  );

  for (const s of SOURCES) {
    if (!idByName.has(s.name)) {
      // Now a hard failure, not a shrug.
      throw new Error(`Source "${s.name}" missing from DB after upsert.`);
    }
  }
  return idByName;
}

async function pollAll(stats: PollerStats, idByName: Map<string, string>) {
  for (const source of SOURCES) {
    const counters = stats.perSource.get(source.name) as SourceCounters;
    console.log(`\n--- ${source.name} ---`);
    const sourceId = idByName.get(source.name)!;

    try {
      const feed = await parser.parseURL(source.url);

      for (const item of feed.items.slice(0, ITEMS_PER_FEED)) {
        counters.itemsSeen++;

        if (!item.link) {
          console.error("Skipping item with no link:", item.title);
          continue;
        }

        const title = extractTitle(item.title);
        if (!title) {
          counters.malformedTitle++;
          console.error(`Skipping item with unparseable title: ${item.link}`);
          continue;
        }

        // Articles with no pubDate used to be inserted with published_at
        // = null and then silently filtered out by the clusterer forever.
        // Fall back to poll time and COUNT it instead of losing it.
        let publishedAt: string;
        if (item.pubDate) {
          publishedAt = new Date(item.pubDate).toISOString();
        } else {
          publishedAt = new Date().toISOString();
          counters.missingPubDate++;
        }

        // BUG-7 FIX. Dedup is still the DB's job (`url unique` +
        // ignoreDuplicates), but WITHOUT `.select()` PostgREST returns
        // data: null / error: null for both a fresh insert and a skipped
        // duplicate — so the old `else counters.inserted++` counted every
        // item on every run and NEW was always equal to SEEN.
        //
        // `resolution=ignore-duplicates` + `return=representation` returns
        // ONLY the rows that actually landed. An empty array means "we
        // already had it".
        const { data: insertedRows, error: insertError } = await supabase
          .from("articles")
          .upsert(
            {
              source_id: sourceId,
              title,
              url: item.link,
              published_at: publishedAt,
              rss_snippet: item.contentSnippet ?? null,
              status: "pending",
            },
            { onConflict: "url", ignoreDuplicates: true }
          )
          .select("id");

        if (insertError) {
          console.error("Insert failed:", insertError.message);
        } else if (insertedRows && insertedRows.length > 0) {
          counters.inserted++;
          console.log("NEW:", title);
        } else {
          counters.alreadySeen++;
        }
      }
    } catch (err) {
      counters.feedError = true;
      console.error(`FAILED: ${source.name}`, err);
    }
  }
}

// Supabase returns an embedded relation as either an object or a
// single-element array depending on how it infers the relationship.
function embeddedSourceName(row: any): string {
  const s = row?.sources;
  if (Array.isArray(s)) return s[0]?.name ?? "Unknown";
  return s?.name ?? "Unknown";
}

async function backfillArticleBodies(stats: PollerStats) {
  const { data: pending, error } = await supabase
    .from("articles")
    .select("id, url, rss_snippet, body_fetch_attempts, sources(name)")
    .eq("status", "pending")
    .lt("body_fetch_attempts", MAX_BODY_ATTEMPTS)
    .order("published_at", { ascending: false })
    .limit(MAX_PENDING_PER_RUN);
  if (error) throw error;

  if (pending.length === MAX_PENDING_PER_RUN) {
    console.warn(
      `*** Pending backlog hit the ${MAX_PENDING_PER_RUN} cap. Older pending ` +
        `articles are deferred to the next run. If this persists, the fetcher ` +
        `is not keeping up with the feeds. ***`
    );
  }

  console.log(`\n--- Backfilling ${pending.length} article bodies ---`);

  for (const row of pending as any[]) {
    const sourceName = embeddedSourceName(row);
    const counters =
      stats.perSource.get(sourceName) ?? emptySourceCounters();
    stats.perSource.set(sourceName, counters);

    const attemptsSoFar: number = row.body_fetch_attempts ?? 0;
    const outcome = await fetchArticleBody(row.url);

    if (outcome.ok) {
      const { error: updateError } = await supabase
        .from("articles")
        .update({
          body_text: outcome.body,
          body_source: "page",
          status: "ready",
        })
        .eq("id", row.id);
      if (updateError) console.error("Update failed:", updateError.message);
      else {
        counters.bodyFromPage++;
        console.log(`Body via page: ${row.url}`);
      }
      continue;
    }

    const attempts = attemptsSoFar + 1;
    // A permanent failure is worth exactly one attempt. A transient one
    // gets MAX_BODY_ATTEMPTS before we give up on it.
    const exhausted = outcome.permanent || attempts >= MAX_BODY_ATTEMPTS;

    if (!exhausted) {
      await supabase
        .from("articles")
        .update({ body_fetch_attempts: attempts })
        .eq("id", row.id);
      counters.bodyRetryPending++;
      console.log(
        `Transient failure (${outcome.reason}), attempt ${attempts}/${MAX_BODY_ATTEMPTS}: ${row.url}`
      );
      continue;
    }

    const fallback = extractFallbackBody(row.rss_snippet ?? undefined);

    if (fallback) {
      const { error: updateError } = await supabase
        .from("articles")
        .update({
          body_text: fallback,
          // The summarizer MUST know this is a teaser, not an article.
          body_source: "rss_snippet",
          status: "ready",
          body_fetch_attempts: attempts,
        })
        .eq("id", row.id);
      if (updateError) console.error("Update failed:", updateError.message);
      else {
        counters.bodyFromRssFallback++;
        console.log(`Body via RSS fallback (${outcome.reason}): ${row.url}`);
      }
      continue;
    }

    // Dead end. This article will never appear in the product. It is now
    // counted rather than silently dropped, and it is the number that
    // proves how much of Dhaka Tribune's coverage the 403 costs us.
    await supabase
      .from("articles")
      .update({ status: "failed", body_fetch_attempts: attempts })
      .eq("id", row.id);
    counters.bodyFailedPermanently++;
    console.error(
      `PERMANENTLY DROPPED (${outcome.reason}, no usable snippet): ${row.url}`
    );
  }
}

export async function runPoller(): Promise<PollerStats> {
  const stats: PollerStats = { perSource: new Map() };
  for (const s of SOURCES) {
    stats.perSource.set(s.name, emptySourceCounters());
  }

  const idByName = await syncSources();
  await pollAll(stats, idByName);
  await backfillArticleBodies(stats);
  return stats;
}

if (require.main === module) {
  runPoller();
}
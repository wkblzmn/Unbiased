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

// Raised from 10. GitHub Actions cron is best-effort — a delayed or dropped
// run means more than 10 items may have accumulated since the last poll.
// Dedup is enforced by the `url unique` constraint, so a bigger slice costs
// nothing but a few no-op upserts.
//
// NOTE: The Daily Star's feed only ever returns 10 items regardless of this
// number. It is our best body source and it is the narrowest intake. Worth
// revisiting.
const ITEMS_PER_FEED = 25;

const MAX_BODY_ATTEMPTS = 3;
const MAX_PENDING_PER_RUN = 200;

// Daily Star wraps its headline in a nested <a> element inside <title>; the
// other two put plain text directly in the tag. rss-parser (xml2js) returns a
// string for plain text but a parsed object subtree when it hits nested
// elements — this normalizes both. Returns null on any unhandled shape rather
// than the literal "[object Object]", which used to normalize to the keyword
// set {object} and cluster with every other broken title in the batch.
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

        let publishedAt: string;
        if (item.pubDate) {
          publishedAt = new Date(item.pubDate).toISOString();
        } else {
          publishedAt = new Date().toISOString();
          counters.missingPubDate++;
        }

        // `resolution=ignore-duplicates` + `return=representation` returns
        // ONLY the rows that actually landed. An empty array means "already
        // had it". Without the .select(), PostgREST returns data:null for
        // both cases and the NEW counter was always equal to SEEN.
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

function embeddedSourceName(row: any): string {
  const s = row?.sources;
  if (Array.isArray(s)) return s[0]?.name ?? "Unknown";
  return s?.name ?? "Unknown";
}

async function backfillArticleBodies(stats: PollerStats) {
  const { data: pending, error } = await supabase
    .from("articles")
    .select("id, url, title, rss_snippet, body_fetch_attempts, sources(name)")
    .eq("status", "pending")
    .lt("body_fetch_attempts", MAX_BODY_ATTEMPTS)
    .order("published_at", { ascending: false })
    .limit(MAX_PENDING_PER_RUN);
  if (error) throw error;

  if (pending.length === MAX_PENDING_PER_RUN) {
    console.warn(
      `*** Pending backlog hit the ${MAX_PENDING_PER_RUN} cap. Older pending ` +
        `articles are deferred. If this persists, the fetcher is not keeping up. ***`
    );
  }

  console.log(`\n--- Backfilling ${pending.length} article bodies ---`);

  for (const row of pending as any[]) {
    const sourceName = embeddedSourceName(row);
    const counters = stats.perSource.get(sourceName) ?? emptySourceCounters();
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

    // ------------------------------------------------------------------
    // LINK-ONLY. This used to be `status = 'failed'` — and 'failed' meant
    // DELETED. No link, no headline, no bias label, no place in the source
    // list. 62% of Dhaka Tribune's coverage was disappearing here, including
    // political stories where DT's framing is the entire reason DT is in the
    // product.
    //
    // But we HAVE the headline. We HAVE the URL. We HAVE the outlet and its
    // lean. The headline IS the framing — it is the thing the app exists to
    // show the reader. Only the body is missing, and the body is needed for
    // exactly one of the product's three claims (the summary), not for the
    // other two (who covered it, how they framed it).
    //
    // So: keep it. It clusters (on title, at a raised bar). It appears in the
    // source list with its own headline. It counts toward source_count.
    // It does NOT count toward summary_source_count and it is NEVER sent to
    // the model, because we did not read a word of it and it corroborates
    // nothing.
    //
    // 'failed' now means genuinely unusable — and should be ~0.
    // ------------------------------------------------------------------
    const usableAsLink = !!row.title && String(row.title).trim().length > 0 && !!row.url;

    if (usableAsLink) {
      const { error: updateError } = await supabase
        .from("articles")
        .update({
          status: "linkonly",
          body_source: "none",
          body_fetch_attempts: attempts,
        })
        .eq("id", row.id);
      if (updateError) console.error("Update failed:", updateError.message);
      else {
        counters.linkOnly++;
        console.log(`LINK-ONLY (${outcome.reason}, no body): ${row.url}`);
      }
      continue;
    }

    await supabase
      .from("articles")
      .update({ status: "failed", body_fetch_attempts: attempts })
      .eq("id", row.id);
    counters.bodyFailedPermanently++;
    console.error(
      `PERMANENTLY DROPPED (${outcome.reason}, no title or url): ${row.url}`
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
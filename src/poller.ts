import Parser from "rss-parser";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { SOURCES } from "./sources";
import { fetchArticleBody } from "./articleFetcher";

const parser = new Parser();
console.log("DEBUG: SUPABASE_URL raw value =", JSON.stringify(process.env.SUPABASE_URL));
console.log("DEBUG: SUPABASE_URL length =", process.env.SUPABASE_URL?.length ?? 0);

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function extractTitle(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const obj = raw as any;
  if (obj?.a?.[0]?._) return obj.a[0]._;
  if (obj?._) return obj._;
  return String(raw);
}

async function pollAll() {
  const { data: dbSources, error } = await supabase
    .from("sources")
    .select("id, name");
  if (error) throw error;

  const idByName = new Map(dbSources.map((s) => [s.name, s.id]));

  for (const source of SOURCES) {
    console.log(`\n--- ${source.name} ---`);
    const sourceId = idByName.get(source.name);
    if (!sourceId) {
      console.error(`No matching Supabase row for "${source.name}"`);
      continue;
    }

    try {
      const feed = await parser.parseURL(source.url);
      for (const item of feed.items.slice(0, 10)) {
        const title = extractTitle(item.title);
        const { error: insertError } = await supabase
          .from("articles")
          .upsert(
            {
              source_id: sourceId,
              title,
              url: item.link,
              published_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
            },
            { onConflict: "url", ignoreDuplicates: true }
          );
        if (insertError) console.error("Insert failed:", insertError.message);
        else console.log("OK:", title);
      }
    } catch (err) {
      console.error(`FAILED: ${source.name}`, err);
    }
  }
}

async function backfillArticleBodies() {
  const { data: pending, error } = await supabase
    .from("articles")
    .select("id, url")
    .is("body_text", null);
  if (error) throw error;

  console.log(`\n--- Backfilling ${pending.length} article bodies ---`);
  for (const row of pending) {
    const body = await fetchArticleBody(row.url);
    if (!body) continue;
    const { error: updateError } = await supabase
      .from("articles")
      .update({ body_text: body })
      .eq("id", row.id);
    if (updateError) console.error("Update failed:", updateError.message);
    else console.log(`Filled body for: ${row.url}`);
  }
}

export async function runPoller() {
  await pollAll();
  await backfillArticleBodies();
}

// Still runnable standalone for manual testing: npx ts-node src/poller.ts
if (require.main === module) {
  runPoller();
}
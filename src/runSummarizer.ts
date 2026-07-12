import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { summarizeCluster, SourceArticle } from "./summarizer";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function runSummarizer() {
  const { data: clusters, error } = await supabase
    .from("story_clusters")
    .select("id, headline")
    .is("summary", null)
    .gte("article_count", 2);
  if (error) throw error;

  console.log(`\nFound ${clusters.length} clusters needing summaries.\n`);

  for (const cluster of clusters) {
    const { data: links, error: linkError } = await supabase
      .from("cluster_articles")
      .select("article_id")
      .eq("cluster_id", cluster.id);
    if (linkError) {
      console.error(`Failed to load links for cluster ${cluster.id}:`, linkError.message);
      continue;
    }

    const articleIds = links.map((l) => l.article_id);
    const { data: articles, error: articleError } = await supabase
      .from("articles")
      .select("title, body_text, source_id")
      .in("id", articleIds);
    if (articleError) {
      console.error(`Failed to load articles for cluster ${cluster.id}:`, articleError.message);
      continue;
    }

    const sourceIds = [...new Set(articles.map((a) => a.source_id))];
    const { data: sources, error: sourceError } = await supabase
      .from("sources")
      .select("id, name")
      .in("id", sourceIds);
    if (sourceError) {
      console.error(`Failed to load sources for cluster ${cluster.id}:`, sourceError.message);
      continue;
    }
    const sourceNameById = new Map(sources.map((s) => [s.id, s.name]));

    const sourceArticles: SourceArticle[] = articles.map((a) => ({
      sourceName: sourceNameById.get(a.source_id) ?? "Unknown source",
      title: a.title,
      bodyText: a.body_text ?? "",
    }));

    console.log(`--- Summarizing: "${cluster.headline}" (${sourceArticles.length} sources) ---`);
    const result = await summarizeCluster(sourceArticles);

    if (!result) {
      console.error("  Skipped — Gemini call or parsing failed.");
      continue;
    }

    console.log(`  New headline: ${result.headline}`);
    console.log(`  Summary: ${result.summary}\n`);

    const { error: updateError } = await supabase
      .from("story_clusters")
      .update({ headline: result.headline, summary: result.summary })
      .eq("id", cluster.id);
    if (updateError) console.error("  Failed to save:", updateError.message);
  }

  console.log("Done.");
}

if (require.main === module) {
  runSummarizer();
}
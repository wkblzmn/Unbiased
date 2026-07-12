import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { clusterArticles, titleKeywords, bodyTokens, RawArticle, Cluster } from "./clusterer";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const RECENCY_H = 48; // must match clusterer.ts

export async function runClusterer() {
  const cutoff = new Date(Date.now() - RECENCY_H * 60 * 60 * 1000).toISOString();

  const { data: activeClusterRows, error: loadError } = await supabase
    .from("story_clusters")
    .select("id, cluster_articles(article_id, articles(id, title, body_text, published_at))")
    .gte("last_article_at", cutoff);
  if (loadError) throw loadError;

  const seedClusters: Cluster[] = activeClusterRows.map((row: any) => {
    const members = row.cluster_articles.map((ca: any) => ({
      id: ca.articles.id,
      publishedAt: new Date(ca.articles.published_at),
      titleKw: titleKeywords(ca.articles.title),
      bodyKw: bodyTokens(ca.articles.body_text ?? ""),
      isNew: false,
    }));
    const pubTimes = members.map((m: any) => m.publishedAt.getTime());
    return {
      id: row.id,
      members,
      firstAt: new Date(Math.min(...pubTimes)),
      lastAt: new Date(Math.max(...pubTimes)),
      mergeVia: new Map(),
    };
  });

  const { data: clusteredLinks, error: linksError } = await supabase
    .from("cluster_articles")
    .select("article_id");
  if (linksError) throw linksError;
  const alreadyClustered = new Set(clusteredLinks.map((l) => l.article_id));

  const { data: allArticles, error: articlesError } = await supabase
    .from("articles")
    .select("id, title, published_at, body_text")
    .not("published_at", "is", null)
    .not("body_text", "is", null);
  if (articlesError) throw articlesError;

  const newArticles = allArticles.filter((a) => !alreadyClustered.has(a.id));

  console.log(
    `\n${newArticles.length} new article(s) to process against ${seedClusters.length} active existing cluster(s).\n`
  );

  if (newArticles.length === 0) {
    console.log("Nothing new. Done.");
    return;
  }

  const raw: RawArticle[] = newArticles.map((a) => ({
    id: a.id,
    publishedAt: new Date(a.published_at),
    title: a.title,
    bodyText: a.body_text ?? "",
  }));

  const resultClusters = clusterArticles(raw, seedClusters);

  for (const cluster of resultClusters) {
    const newMembers = cluster.members.filter((m) => m.isNew);
    if (newMembers.length === 0) continue;

    if (cluster.id) {
      const { error: updateError } = await supabase
        .from("story_clusters")
        .update({
          last_article_at: cluster.lastAt.toISOString(),
          article_count: cluster.members.length,
        })
        .eq("id", cluster.id);
      if (updateError) {
        console.error("Failed to update cluster:", updateError.message);
        continue;
      }

      for (const m of newMembers) {
        const { error: linkError } = await supabase.from("cluster_articles").insert({
          cluster_id: cluster.id,
          article_id: m.id,
          merge_via: cluster.mergeVia.get(m.id) ?? "title",
        });
        if (linkError) console.error("Failed to link article:", linkError.message);
      }
      console.log(`Added ${newMembers.length} article(s) to existing cluster ${cluster.id}.`);
    } else {
      const earliest = [...cluster.members].sort(
        (a, b) => a.publishedAt.getTime() - b.publishedAt.getTime()
      )[0];
      if (!earliest) continue;

      const originalTitle = newArticles.find((a) => a.id === earliest.id)?.title ?? "Untitled";

      const { data: newRow, error: insertError } = await supabase
        .from("story_clusters")
        .insert({
          headline: originalTitle,
          article_count: cluster.members.length,
          first_article_at: cluster.firstAt.toISOString(),
          last_article_at: cluster.lastAt.toISOString(),
        })
        .select("id")
        .single();
      if (insertError) {
        console.error("Failed to insert new cluster:", insertError.message);
        continue;
      }

      for (const m of cluster.members) {
        const { error: linkError } = await supabase.from("cluster_articles").insert({
          cluster_id: newRow.id,
          article_id: m.id,
          merge_via: cluster.mergeVia.get(m.id) ?? "founder",
        });
        if (linkError) console.error("Failed to link article:", linkError.message);
      }
      console.log(`Created new cluster ${newRow.id} with ${cluster.members.length} article(s).`);
    }
  }

  console.log("Done.");
}

if (require.main === module) {
  runClusterer();
}
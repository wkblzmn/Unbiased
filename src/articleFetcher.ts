import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export async function fetchArticleBody(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; UnbiasedBot/0.1)" },
    });
    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    return article?.textContent?.trim() ?? null;
  } catch (err) {
    console.error(`Failed to fetch/parse ${url}:`, err);
    return null;
  }
}
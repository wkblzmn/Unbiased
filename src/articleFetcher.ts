import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export async function fetchArticleBody(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; UnbiasedBot/0.1)" },
    });

    if (!res.ok) {
      console.error(`Fetch returned ${res.status} ${res.statusText} for ${url}`);
      return null;
    }

    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();

    if (!article?.textContent?.trim()) {
      console.error(`Readability found no extractable content for ${url} (response length: ${html.length} chars)`);
      return null;
    }

    return article.textContent.trim();
  } catch (err) {
    console.error(`Failed to fetch/parse ${url}:`, err);
    return null;
  }
}
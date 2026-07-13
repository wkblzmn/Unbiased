import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export async function fetchArticleBody(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  },
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

const MIN_FALLBACK_WORDS = 20;

export function extractFallbackBody(contentSnippet: string | undefined): string | null {
  if (!contentSnippet) return null;
  // Strip the trailing "Details" link text every Dhaka Tribune entry carries.
  const cleaned = contentSnippet.replace(/\s*Details\s*$/i, "").trim();
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  return wordCount >= MIN_FALLBACK_WORDS ? cleaned : null;
}
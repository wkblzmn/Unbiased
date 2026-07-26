import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

// LANDMINE fix: bare fetch() has no timeout. One hanging news server
// would stall the whole run until GitHub's job limit killed it.
const FETCH_TIMEOUT_MS = 10_000;

// The caller needs to know WHY a fetch failed, not just that it did.
// `permanent: true`  -> this URL is never coming back (404, 403 bot wall,
//                       Readability found nothing). Do not retry. Go
//                       straight to the RSS fallback.
// `permanent: false` -> transient (timeout, DNS, 5xx, 429). Worth another go.
export type FetchOutcome =
  | { ok: true; body: string }
  | { ok: false; permanent: boolean; reason: string };

// BUG-8 FIX: `permanent = status >= 400 && status < 500` swept 429 and 408
// into the permanent bucket. Both are explicitly temporary — 429 is the
// server saying "slow down", 408 is "you were too slow". Under the old
// rule, a news site that rate-limited us once marked the article
// permanently dead on attempt 1 and short-circuited to the ~48-word RSS
// teaser (or dropped it entirely). We were amputating on a sprained ankle.
const TRANSIENT_4XX = new Set([408, 425, 429]);

function isPermanentStatus(status: number): boolean {
  if (status >= 500) return false;          // server-side, retry
  if (TRANSIENT_4XX.has(status)) return false;
  return status >= 400;                      // 403 bot wall, 404 gone, etc.
}

export async function fetchArticleBody(url: string): Promise<FetchOutcome> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!res.ok) {
      return {
        ok: false,
        permanent: isPermanentStatus(res.status),
        reason: `HTTP ${res.status} ${res.statusText}`,
      };
    }

    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    const text = article?.textContent?.trim();

    if (!text) {
      return {
        ok: false,
        permanent: true,
        reason: `Readability found no content (${html.length} chars of HTML)`,
      };
    }

    return { ok: true, body: text };
  } catch (err) {
    // AbortError (timeout), DNS, socket reset — all worth retrying.
    return {
      ok: false,
      permanent: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// Fallback for sources that block article-page fetches from cloud IPs
// (confirmed: Dhaka Tribune, IP-range-based bot detection). Uses the RSS
// feed's own contentSnippet when the real page fetch fails, but only if
// it is substantial enough to be useful — short fragments are rejected
// rather than stored as a misleadingly thin "body."
//
// A body stored this way is ~48 words against ~800 for a real page fetch.
// That asymmetry is NOT cosmetic: it silently breaks the summarizer's
// two-source corroboration rule, because almost nothing in an 800-word
// article can be corroborated by 48 words of teaser. articles.body_source
// now records which kind of body this is, and the prompt builder tells
// Gemini so it stops treating "the teaser didn't mention it" as
// "the second outlet contradicts it".
const MIN_FALLBACK_WORDS = 20;

export function extractFallbackBody(
  contentSnippet: string | undefined
): string | null {
  if (!contentSnippet) return null;
  const cleaned = contentSnippet.replace(/\s*Details\s*$/i, "").trim();
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  return wordCount >= MIN_FALLBACK_WORDS ? cleaned : null;
}
// =====================================================================
// Candidate source checker.
//
// RUN THIS FROM GITHUB ACTIONS, NOT FROM YOUR LAPTOP.
//
// That is the entire point of this script and it is not a stylistic
// preference. Dhaka Tribune passes every check you can run locally: the feed
// parses, it returns 25 items, the headlines are clean. Then it 403s from
// Azure, because its bot wall blocks DATACENTER IPs, and we lost 62% of its
// coverage before anyone noticed. Your machine in Dhaka can fetch Dhaka
// Tribune. GitHub's runner cannot. Testing locally does not just give a weaker
// answer — it gives the WRONG answer, confidently.
//
// So this runs as a workflow_dispatch job, from the same IP space as the
// pipeline, and answers the only four questions that matter:
//
//   1. Does a feed exist at all? (we do not know the URLs; we probe)
//   2. How many items does it carry?
//   3. Do those items have a usable <description>? (DT: 61 of 96 had NONE)
//   4. CAN WE ACTUALLY FETCH AN ARTICLE BODY FROM HERE?
//
// VERDICT:
//   FULL   - real page bodies. Add it.
//   TEASER - 403 on the page, but the RSS description is long enough to use.
//            This is what Dhaka Tribune is. A second one of these does not
//            widen the spectrum, it widens the hole.
//   DEAD   - no feed, or no body and no usable snippet. Do not add.
// =====================================================================

import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const parser = new Parser({ timeout: 15_000 });

const FETCH_TIMEOUT_MS = 12_000;
const ARTICLES_TO_PROBE = 3;
const MIN_FALLBACK_WORDS = 20; // must match articleFetcher.ts

interface Candidate {
  name: string;
  // We do NOT know the feed URLs. Probe the common patterns rather than
  // guessing one into sources.ts and finding out in production.
  urls: string[];
  note: string;
}

const CANDIDATES: Candidate[] = [
  {
    name: "bdnews24",
    note: "Largest social reach (~10.6M FB). Wire-style 24/7 service, so it covers the SAME events as the others — ideal for clustering. Previously dropped for 'no discoverable feed'; this is the retry.",
    urls: [
      "https://bdnews24.com/feed",
      "https://bdnews24.com/rss.xml",
      "https://bdnews24.com/?widgetName=rssfeed&widgetId=1150&getXmlFeed=true",
      "https://bdnews24.com/bangladesh/feed",
      "https://bdnews24.com/rss/",
    ],
  },
  {
    name: "The Financial Express",
    note: "Second-largest English daily. Business/economics focus — overlaps TBS, but higher circulation.",
    urls: [
      "https://thefinancialexpress.com.bd/feed",
      "https://thefinancialexpress.com.bd/rss.xml",
      "https://thefinancialexpress.com.bd/feed/rss",
      "https://today.thefinancialexpress.com.bd/rss.xml",
    ],
  },
  {
    name: "Daily Sun",
    note: "Owned by East West Media Group, a Bashundhara Group concern. The bias label can cite OWNERSHIP rather than vibes — a far stronger position to defend.",
    urls: [
      "https://www.daily-sun.com/feed",
      "https://www.daily-sun.com/rss.xml",
      "https://www.daily-sun.com/rss/rss.xml",
      "https://www.daily-sun.com/feed/rss",
    ],
  },
  {
    name: "New Age",
    note: "Anti-establishment editorial policy. Smaller circulation, outsized influence. This is the outlet that makes the product SHOW something: four mainstream papers agreeing is not a spectrum, it is an echo.",
    urls: [
      "https://www.newagebd.net/feed",
      "https://www.newagebd.net/rss.xml",
      "https://www.newagebd.net/feed/rss",
      "https://www.newagebd.net/rss/",
    ],
  },
];

// Identical headers to articleFetcher.ts. If we probe with different headers
// than the pipeline uses, the probe is measuring the wrong thing.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function words(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// Same shape as extractTitle() in poller.ts — Daily Star wraps its headline in
// a nested <a>, and any new source may do something equally cursed.
function extractTitle(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim() || null;
  const o = raw as any;
  if (typeof o?.a?.[0]?._ === "string") return o.a[0]._.trim() || null;
  if (typeof o?._ === "string") return o._.trim() || null;
  return null;
}

async function probeBody(
  url: string
): Promise<{ ok: boolean; status: string; words: number }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: HEADERS,
    });
    if (!res.ok) {
      return { ok: false, status: `HTTP ${res.status}`, words: 0 };
    }
    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const text = new Readability(dom.window.document).parse()?.textContent?.trim();
    if (!text) {
      return { ok: false, status: "Readability: no content", words: 0 };
    }
    return { ok: true, status: "OK", words: words(text) };
  } catch (e) {
    return {
      ok: false,
      status: e instanceof Error ? e.message.slice(0, 60) : String(e),
      words: 0,
    };
  }
}

async function checkCandidate(c: Candidate) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`${c.name}`);
  console.log(`${"=".repeat(70)}`);
  console.log(`${c.note}\n`);

  // ---- 1. Find a feed --------------------------------------------------
  let feed: any = null;
  let feedUrl = "";

  for (const url of c.urls) {
    try {
      const f = await parser.parseURL(url);
      if (f.items && f.items.length > 0) {
        feed = f;
        feedUrl = url;
        console.log(`  FEED FOUND: ${url}`);
        break;
      }
      console.log(`  (empty)     ${url}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 50) : String(e);
      console.log(`  (failed)    ${url}  — ${msg}`);
    }
  }

  if (!feed) {
    console.log(`\n  VERDICT: DEAD — no working feed at any probed URL.`);
    console.log(`  If you believe a feed exists, find it by hand (view-source on the`);
    console.log(`  homepage, look for application/rss+xml) and add the URL above.`);
    return;
  }

  // ---- 2. Items and titles --------------------------------------------
  const items = feed.items.slice(0, 25);
  const badTitles = items.filter((i: any) => !extractTitle(i.title)).length;
  const noPubDate = items.filter((i: any) => !i.pubDate).length;

  console.log(`\n  items returned      : ${feed.items.length}`);
  console.log(`  unparseable titles  : ${badTitles}${badTitles ? "  <-- extractTitle() needs a new case" : ""}`);
  console.log(`  missing pubDate     : ${noPubDate}`);

  // ---- 3. Descriptions — the fallback lifeline -------------------------
  const snippets = items.map((i: any) =>
    (i.contentSnippet ?? i.content ?? "").trim()
  );
  const withSnippet = snippets.filter((s: string) => s.length > 0);
  const usable = snippets.filter((s: string) => words(s) >= MIN_FALLBACK_WORDS);
  const avgWords = withSnippet.length
    ? Math.round(
        withSnippet.reduce((a: number, s: string) => a + words(s), 0) /
          withSnippet.length
      )
    : 0;

  console.log(`\n  with <description>  : ${withSnippet.length}/${items.length}`);
  console.log(`  usable as fallback  : ${usable.length}/${items.length}  (>= ${MIN_FALLBACK_WORDS} words)`);
  console.log(`  avg snippet words   : ${avgWords}`);

  // ---- 4. THE ONE THAT MATTERS: can we fetch a body FROM HERE? ---------
  console.log(`\n  Probing ${ARTICLES_TO_PROBE} article page(s) from this runner's IP:`);

  const links: string[] = items
    .map((i: any) => i.link)
    .filter(Boolean)
    .slice(0, ARTICLES_TO_PROBE);

  let bodiesOk = 0;
  let totalWords = 0;

  for (const link of links) {
    const r = await probeBody(link);
    if (r.ok) {
      bodiesOk++;
      totalWords += r.words;
      console.log(`    OK    ${r.words} words   ${link.slice(0, 60)}`);
    } else {
      console.log(`    FAIL  ${r.status.padEnd(22)}  ${link.slice(0, 60)}`);
    }
  }

  const avgBody = bodiesOk ? Math.round(totalWords / bodiesOk) : 0;

  // ---- VERDICT ---------------------------------------------------------
  console.log("");
  if (bodiesOk === links.length && avgBody > 150) {
    console.log(`  VERDICT: FULL — page bodies fetch cleanly (~${avgBody} words avg).`);
    console.log(`  ADD IT. Use this feed URL: ${feedUrl}`);
  } else if (bodiesOk > 0) {
    console.log(`  VERDICT: PARTIAL — ${bodiesOk}/${links.length} bodies fetched (~${avgBody} words).`);
    console.log(`  Some pages work, some do not. Probe more articles before trusting this.`);
    console.log(`  Feed URL: ${feedUrl}`);
  } else if (usable.length >= items.length * 0.7) {
    console.log(`  VERDICT: TEASER — every page fetch failed, but ${usable.length}/${items.length} snippets`);
    console.log(`  clear the ${MIN_FALLBACK_WORDS}-word bar, so link-only + fallback would work.`);
    console.log(`  THIS IS DHAKA TRIBUNE. You already have one of these and it costs you`);
    console.log(`  62% of that outlet's usable coverage. A second one widens the hole`);
    console.log(`  rather than the spectrum. Add only with your eyes open.`);
    console.log(`  Feed URL: ${feedUrl}`);
  } else {
    console.log(`  VERDICT: DEAD — no page bodies AND no usable snippets.`);
    console.log(`  Every article would be link-only with no text. It would appear in the`);
    console.log(`  source list and never feed a single summary. Not worth the slot.`);
  }
}

async function main() {
  console.log("\nCandidate source check — running from this runner's IP.");
  console.log("A feed that works is NOT an outlet that works. See header.\n");

  for (const c of CANDIDATES) {
    await checkCandidate(c);
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("Only add FULL sources. TEASER sources give you a name in the source");
  console.log("list and no text in the summary — which is a bias label attached to an");
  console.log("article you never read.");
  console.log(`${"=".repeat(70)}\n`);
}

main();
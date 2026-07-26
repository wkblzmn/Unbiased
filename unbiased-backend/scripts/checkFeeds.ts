// =====================================================================
// Candidate source checker.
//
// RUN THIS FROM GITHUB ACTIONS, NOT FROM YOUR LAPTOP.
//
// That is the entire point and it is not a stylistic preference. Dhaka Tribune
// passes every check you can run locally: the feed parses, 25 items, clean
// headlines. Then it 403s from Azure, because its bot wall blocks DATACENTER
// IPs, and we lost 62% of its coverage before anyone noticed. Your machine in
// Dhaka can fetch Dhaka Tribune. GitHub's runner cannot. Testing locally does
// not give a weaker answer — it gives the WRONG answer, confidently.
//
// v2 FIXES TWO FLAWS IN v1:
//
//   1. v1 used parser.parseURL(), which sends rss-parser's OWN User-Agent and
//      accepts no headers. That made the probe a WEAKER test than the pipeline,
//      which sends browser headers. So v1's 403s could have been artifacts of
//      the probe rather than real blocks — three of four candidates "failed"
//      and we could not tell whether that was the outlet or the tool. Now the
//      feed is fetched by hand with the EXACT headers articleFetcher.ts uses,
//      and the XML handed to parseString().
//
//   2. v1 guessed feed URLs. The Financial Express returned a clean 404 on all
//      of them, which proves the guesses were simply wrong. Now, if every
//      guessed URL fails, we fetch the HOMEPAGE and read the feed URL out of
//      its <link rel="alternate" type="application/rss+xml"> tag — which is
//      what every CMS emits, and which is authoritative rather than a guess.
//
// Answers the only four questions that matter:
//   1. Does a feed exist? (probe, then autodiscover)
//   2. How many items?
//   3. Do items carry a usable <description>? (DT: 61 of 96 had NONE)
//   4. CAN WE ACTUALLY FETCH AN ARTICLE BODY FROM HERE?
//
// VERDICT:
//   FULL   - real page bodies. Add it.
//   TEASER - 403 on the page, but the RSS description is usable. This is what
//            Dhaka Tribune is. A second one widens the hole, not the spectrum.
//   DEAD   - no feed, or no body and no usable snippet. Do not add.
// =====================================================================

import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const parser = new Parser({ timeout: 15_000 });

const FETCH_TIMEOUT_MS = 12_000;
const ARTICLES_TO_PROBE = 3;
const MIN_FALLBACK_WORDS = 20; // must match articleFetcher.ts

// Identical to articleFetcher.ts. If we probe with different headers than the
// pipeline uses, the probe is measuring the wrong thing.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

interface Candidate {
  name: string;
  home: string; // for autodiscovery when the guesses miss
  urls: string[];
  note: string;
}

const CANDIDATES: Candidate[] = [
  {
    name: "bdnews24",
    home: "https://bdnews24.com/",
    note: "Largest social reach (~10.6M FB). Wire-style 24/7 service — covers the SAME events as the others, which is exactly what clustering needs. Previously dropped for 'no discoverable feed'; this is the retry.",
    urls: [
      "https://bdnews24.com/feed",
      "https://bdnews24.com/rss.xml",
      "https://bdnews24.com/feed/",
      "https://bdnews24.com/bangladesh/feed",
      "https://bdnews24.com/?widgetName=rssfeed&widgetId=1150&getXmlFeed=true",
    ],
  },
  {
    name: "The Financial Express",
    home: "https://thefinancialexpress.com.bd/",
    note: "Second-largest English daily. Business/economics focus — overlaps TBS but higher circulation.",
    urls: [
      "https://thefinancialexpress.com.bd/feed",
      "https://thefinancialexpress.com.bd/rss.xml",
      "https://thefinancialexpress.com.bd/feed/",
      "https://thefinancialexpress.com.bd/rss/",
      "https://thefinancialexpress.com.bd/national/rss",
    ],
  },
  {
    name: "Daily Sun",
    home: "https://www.daily-sun.com/",
    note: "Owned by East West Media Group, a Bashundhara Group concern. The bias label can cite OWNERSHIP rather than vibes — a far stronger position to defend in a viva.",
    urls: [
      "https://www.daily-sun.com/feed",
      "https://www.daily-sun.com/rss.xml",
      "https://www.daily-sun.com/feed/",
      "https://www.daily-sun.com/rss/rss.xml",
      "https://www.daily-sun.com/post/rss",
    ],
  },
  {
    name: "New Age",
    home: "https://www.newagebd.net/",
    note: "Anti-establishment editorial policy. Smaller circulation, outsized influence. This is the outlet that makes the product SHOW something — four mainstream papers agreeing is an echo, not a spectrum.",
    urls: [
      "https://www.newagebd.net/feed",
      "https://www.newagebd.net/rss.xml",
      "https://www.newagebd.net/feed/",
      "https://www.newagebd.net/rss/",
      "https://www.newagebd.net/online/rss",
    ],
  },
];

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

// FIX 1: fetch the feed OURSELVES, with the pipeline's headers. rss-parser's
// parseURL() cannot take headers and sends its own UA — which is precisely the
// thing these bot walls are looking at.
async function fetchFeed(url: string) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: HEADERS,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parser.parseString(xml);
}

// FIX 2: stop guessing. Every CMS emits
//   <link rel="alternate" type="application/rss+xml" href="...">
// in the homepage <head>. Read it.
async function autodiscover(home: string): Promise<string[]> {
  try {
    const res = await fetch(home, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: HEADERS,
    });
    if (!res.ok) {
      console.log(`  autodiscovery: homepage returned HTTP ${res.status}`);
      return [];
    }
    const html = await res.text();
    const doc = new JSDOM(html, { url: home }).window.document;

    const found = new Set<string>();

    doc
      .querySelectorAll(
        'link[type="application/rss+xml"], link[type="application/atom+xml"]'
      )
      .forEach((el) => {
        const href = el.getAttribute("href");
        if (href) found.add(new URL(href, home).toString());
      });

    // Fallback: some sites only link the feed from the footer as a plain <a>.
    doc.querySelectorAll("a[href]").forEach((el) => {
      const href = el.getAttribute("href") ?? "";
      if (/\/(rss|feed)(\.xml|\/)?$/i.test(href)) {
        found.add(new URL(href, home).toString());
      }
    });

    return [...found];
  } catch (e) {
    console.log(
      `  autodiscovery failed: ${e instanceof Error ? e.message.slice(0, 60) : e}`
    );
    return [];
  }
}

async function probeBody(
  url: string
): Promise<{ ok: boolean; status: string; words: number }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: HEADERS,
    });
    if (!res.ok) return { ok: false, status: `HTTP ${res.status}`, words: 0 };

    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const text = new Readability(dom.window.document).parse()?.textContent?.trim();
    if (!text) return { ok: false, status: "Readability: no content", words: 0 };

    return { ok: true, status: "OK", words: words(text) };
  } catch (e) {
    return {
      ok: false,
      status: e instanceof Error ? e.message.slice(0, 40) : String(e),
      words: 0,
    };
  }
}

async function tryUrls(urls: string[]): Promise<{ feed: any; url: string } | null> {
  for (const url of urls) {
    try {
      const f = await fetchFeed(url);
      if (f.items && f.items.length > 0) {
        console.log(`  FEED FOUND: ${url}  (${f.items.length} items)`);
        return { feed: f, url };
      }
      console.log(`  (empty)     ${url}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 45) : String(e);
      console.log(`  (failed)    ${url}  — ${msg}`);
    }
  }
  return null;
}

async function checkCandidate(c: Candidate) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(c.name);
  console.log("=".repeat(72));
  console.log(`${c.note}\n`);

  // ---- 1. Guessed URLs, WITH browser headers this time -----------------
  let hit = await tryUrls(c.urls);

  // ---- 2. If they all missed, ask the site where its feed is -----------
  if (!hit) {
    console.log(`\n  No luck guessing. Reading ${c.home} for a feed <link> tag...`);
    const discovered = await autodiscover(c.home);

    if (discovered.length === 0) {
      console.log(`  No feed <link> found in the homepage HTML either.`);
    } else {
      console.log(`  Autodiscovered ${discovered.length} candidate URL(s):`);
      discovered.forEach((u) => console.log(`    ${u}`));
      console.log("");
      hit = await tryUrls(discovered);
    }
  }

  if (!hit) {
    console.log(`\n  VERDICT: DEAD — no working feed found, guessed or autodiscovered.`);
    console.log(`  NOTE: if the failures above are 403 (not 404), the feed likely EXISTS`);
    console.log(`  and is blocking this datacenter IP. That is a real, citable finding:`);
    console.log(`  the outlet is unreachable from free CI hosting, not feedless.`);
    return;
  }

  const { feed, url: feedUrl } = hit;

  // ---- 3. Items and titles ---------------------------------------------
  const items = feed.items.slice(0, 25);
  const badTitles = items.filter((i: any) => !extractTitle(i.title)).length;
  const noPubDate = items.filter((i: any) => !i.pubDate).length;

  console.log(`\n  items returned      : ${feed.items.length}`);
  console.log(
    `  unparseable titles  : ${badTitles}${badTitles ? "  <-- extractTitle() needs a new case" : ""}`
  );
  console.log(`  missing pubDate     : ${noPubDate}`);

  // ---- 4. Descriptions — the fallback lifeline --------------------------
  const snippets: string[] = items.map((i: any) =>
    (i.contentSnippet ?? i.content ?? "").trim()
  );
  const withSnippet = snippets.filter((s) => s.length > 0);
  const usable = snippets.filter((s) => words(s) >= MIN_FALLBACK_WORDS);
  const avgWords = withSnippet.length
    ? Math.round(withSnippet.reduce((a, s) => a + words(s), 0) / withSnippet.length)
    : 0;

  console.log(`\n  with <description>  : ${withSnippet.length}/${items.length}`);
  console.log(
    `  usable as fallback  : ${usable.length}/${items.length}  (>= ${MIN_FALLBACK_WORDS} words)`
  );
  console.log(`  avg snippet words   : ${avgWords}`);

  // ---- 5. THE ONE THAT MATTERS -----------------------------------------
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
      console.log(`    OK    ${String(r.words).padStart(5)} words   ${link.slice(0, 58)}`);
    } else {
      console.log(`    FAIL  ${r.status.padEnd(24)}  ${link.slice(0, 58)}`);
    }
  }

  const avgBody = bodiesOk ? Math.round(totalWords / bodiesOk) : 0;

  // ---- VERDICT ----------------------------------------------------------
  console.log("");
  if (bodiesOk === links.length && avgBody > 150) {
    console.log(`  VERDICT: FULL — page bodies fetch cleanly (~${avgBody} words avg).`);
    console.log(`  ADD IT.  sources.ts url: ${feedUrl}`);
  } else if (bodiesOk > 0) {
    console.log(`  VERDICT: PARTIAL — ${bodiesOk}/${links.length} bodies fetched (~${avgBody} words).`);
    console.log(`  Some pages work, some do not. Probe more before trusting it.`);
    console.log(`  Feed: ${feedUrl}`);
  } else if (usable.length >= items.length * 0.7) {
    console.log(`  VERDICT: TEASER — every page fetch failed, but ${usable.length}/${items.length} snippets`);
    console.log(`  clear the ${MIN_FALLBACK_WORDS}-word bar. Link-only + RSS fallback would work.`);
    console.log(`  THIS IS DHAKA TRIBUNE. You have one already and it costs 62% of that`);
    console.log(`  outlet's usable coverage. A second one widens the hole, not the`);
    console.log(`  spectrum — and puts a bias label on an article you never read.`);
    console.log(`  Feed: ${feedUrl}`);
  } else {
    console.log(`  VERDICT: DEAD — no page bodies AND no usable snippets.`);
    console.log(`  Every article would be link-only with no text: a name in the source`);
    console.log(`  list that never feeds a summary. Not worth the slot.`);
  }
}

async function main() {
  console.log("\nCandidate source check — running from THIS RUNNER'S IP.");
  console.log("A feed that works is not an outlet that works. See file header.\n");

  for (const c of CANDIDATES) {
    await checkCandidate(c);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("Only add FULL sources.");
  console.log("A 403 is not 'no feed'. It is 'this outlet refuses datacenter IPs' —");
  console.log("which is a measurable constraint on building a free-hosted aggregator,");
  console.log("and belongs in the report rather than in the bin.");
  console.log("=".repeat(72) + "\n");
}

main();
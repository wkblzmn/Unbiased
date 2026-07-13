import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export interface SourceArticle {
  sourceName: string;
  title: string;
  bodyText: string;
  // TRUE when body_text is a ~48-word RSS teaser rather than a real page
  // fetch (Dhaka Tribune's 403 wall). See articleFetcher.ts.
  isTeaser: boolean;
}

export const CATEGORIES = [
  "Politics",
  "Economics",
  "International",
  "Sports",
  "Technology",
  "Crime",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface ClusterSummary {
  headline: string;
  summary: string;
  category: Category;
}

// One bare catch used to swallow rate limits, bad model strings, network
// errors and malformed JSON into a single log line reading "Gemini
// summarization failed" — which made an ACTIVE rate-limit problem
// indistinguishable from a broken prompt. The caller now gets the kind.
export type SummarizeResult =
  | { ok: true; value: ClusterSummary }
  | { ok: false; kind: "rate_limit" | "api" | "parse"; detail: string };

const MAX_BODY_WORDS = 800;

function truncate(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  return words.length <= maxWords
    ? text
    : words.slice(0, maxWords).join(" ") + "...";
}

// BUG-12 FIX — the corroboration rule was quietly unsatisfiable.
//
// The old prompt said "only state facts corroborated by at least two of the
// sources below" and then handed the model N article blocks with no notion
// of which OUTLET each came from in the rule, and no notion that one of the
// bodies might be a 48-word teaser.
//
// Two consequences, both real:
//
//   1. "Two of the sources" was read as "two of the blocks". Two Daily Star
//      articles about the same event satisfied it. (The pipeline now refuses
//      to summarize a cluster below two distinct outlets at all, but the
//      prompt should say what it means regardless.)
//
//   2. A cluster of one 800-word Daily Star article + one 48-word Dhaka
//      Tribune teaser has almost nothing that two bodies both contain. The
//      model either produced an anaemic summary or — far more likely —
//      silently ignored the rule, which made the single strongest safeguard
//      in the whole product decorative on exactly the clusters that needed
//      it. It also had no way to know the teaser's SILENCE on a fact was an
//      artifact of a 403, not the second outlet declining to confirm it.
function buildPrompt(articles: SourceArticle[]): string {
  const outlets = [...new Set(articles.map((a) => a.sourceName))];

  const articleBlocks = articles
    .map((a, i) => {
      const teaserNote = a.isTeaser
        ? ` [TEASER ONLY — this outlet's full text could not be retrieved; ` +
          `what follows is the short feed summary. Its SILENCE on a detail ` +
          `is missing evidence, not disagreement.]`
        : "";
      return `Article ${i + 1} — outlet: ${a.sourceName}${teaserNote}\nHeadline as published: "${a.title}"\nBody:\n${truncate(a.bodyText, MAX_BODY_WORDS)}`;
    })
    .join("\n\n---\n\n");

  return `The following articles from Bangladeshi news outlets all cover the same real news event. Write a neutral, factual, 3-4 sentence summary of what happened, plus a short neutral headline (under 12 words) describing the event itself.

There are ${articles.length} article(s) from ${outlets.length} distinct outlet(s): ${outlets.join(", ")}.

Rules:
- Do not take any political position or side with any party, individual, or outlet.
- Corroboration means TWO DIFFERENT OUTLETS, not two articles. Two pieces from the same outlet corroborate nothing. State a fact only if at least two DIFFERENT outlets in the list above report it. If a fact appears in only one outlet, either omit it or attribute it explicitly ("according to <outlet>, ...").
- An article marked TEASER ONLY is a truncated feed summary, not that outlet's full reporting. Do not treat its omission of a detail as that outlet failing to corroborate. If the only other outlet is a teaser, prefer explicit attribution over confident assertion.
- Avoid characterizing a party's or individual's statement as an agreement, denial, confirmation, or dismissal unless they used words to that effect themselves — report what they actually said, not your interpretation of what it implies.
- Pay attention to how each outlet's HEADLINE frames the event, not just the body text — outlets sometimes frame the same event differently at the headline level even when the underlying facts agree. Prefer the more neutral framing. Never adopt one outlet's headline as your own.
- Assign exactly one category, chosen from this list and spelled exactly as written: ${CATEGORIES.join(", ")}. Use "Other" only if none of the others fit.
- Respond in English.
- Respond ONLY with valid JSON, no markdown code fences, no explanation, in exactly this shape:
{"headline": "...", "summary": "...", "category": "..."}

${articleBlocks}`;
}

function isRateLimit(err: unknown): boolean {
  const anyErr = err as any;
  const status = anyErr?.status ?? anyErr?.code ?? anyErr?.response?.status;
  if (status === 429) return true;
  const msg = String(anyErr?.message ?? err);
  return msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED");
}

// The old parser did `raw.replace(/```json|```/g, "")` and hoped. That
// survives fences but not a model that prefixes "Here is the JSON:" or
// appends a note. Take the outermost brace-delimited span instead.
//
// TODO (worth doing, costs one line): if this SDK surface accepts a
// generation config, set responseMimeType: "application/json" plus a
// responseSchema. That makes `kind: "parse"` structurally impossible and
// stats.parseFailed a permanent zero — which is the point of having it.
// Left alone here because the pipeline is currently working against this
// exact call shape and I am not going to break a live integration on a
// guess about a parameter name.
function extractJson(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

export async function summarizeCluster(
  articles: SourceArticle[]
): Promise<SummarizeResult> {
  const prompt = buildPrompt(articles);

  let raw: string;
  try {
    const interaction = await ai.interactions.create({
      model: "gemini-3.5-flash",
      input: prompt,
    });
    raw = interaction.output_text ?? "";
  } catch (err) {
    if (isRateLimit(err)) {
      return { ok: false, kind: "rate_limit", detail: String(err) };
    }
    return { ok: false, kind: "api", detail: String(err) };
  }

  const json = extractJson(raw);
  if (!json) {
    return {
      ok: false,
      kind: "parse",
      detail: `no JSON object in response: ${raw.slice(0, 200)}`,
    };
  }

  try {
    const parsed = JSON.parse(json);

    const headline =
      typeof parsed.headline === "string" ? parsed.headline.trim() : "";
    const summary =
      typeof parsed.summary === "string" ? parsed.summary.trim() : "";

    // An empty string is not a summary. It used to pass the typeof check,
    // get written to the DB, satisfy `summary is not null` in the view, and
    // surface a story card with a headline and a blank body.
    if (!headline || !summary) {
      return {
        ok: false,
        kind: "parse",
        detail: `empty headline/summary: ${raw.slice(0, 200)}`,
      };
    }

    // Never trust a free-text label into a column the app will filter on.
    const category: Category = (CATEGORIES as readonly string[]).includes(
      parsed.category
    )
      ? (parsed.category as Category)
      : "Other";

    return { ok: true, value: { headline, summary, category } };
  } catch (err) {
    return {
      ok: false,
      kind: "parse",
      detail: `${String(err)} | raw: ${raw.slice(0, 200)}`,
    };
  }
}
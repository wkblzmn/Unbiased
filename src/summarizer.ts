import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export interface SourceArticle {
  sourceName: string;
  title: string;
  bodyText: string;
}

export interface ClusterSummary {
  headline: string;
  summary: string;
}

// Cap body text per article — keeps prompts small/cheap. Same
// inverted-pyramid reasoning as the clustering body cap: key facts are
// near the top of a news article.
const MAX_BODY_WORDS = 800;

function truncate(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  return words.length <= maxWords ? text : words.slice(0, maxWords).join(" ") + "...";
}

function buildPrompt(articles: SourceArticle[]): string {
  const articleBlocks = articles
    .map(
      (a, i) =>
        `Article ${i + 1} (${a.sourceName}, headline: "${a.title}"):\n${truncate(a.bodyText, MAX_BODY_WORDS)}`
    )
    .join("\n\n");

  return `The following articles from different Bangladeshi news sources all cover the same real news event. Write a neutral, factual, 3-4 sentence summary of what happened, plus a short neutral headline (under 12 words) describing the event itself.

Rules:
- Do not take any political position or side with any party, individual, or outlet.
- Avoid characterizing a party's or individual's statement as an agreement, denial, confirmation, or dismissal unless they used words to that effect themselves — report what they actually said, not your interpretation of what it implies.
- Only state facts that are corroborated by at least two of the sources below. If a claim appears in only one source, omit it or note it as a single-source claim.
- Pay attention to how each outlet's HEADLINE frames the event, not just the body text — outlets sometimes frame the same event differently at the headline level even when the underlying facts agree. Prefer the more neutral framing.
- Respond in English.
- Respond ONLY with valid JSON, no markdown code fences, no explanation, in exactly this shape:
{"headline": "...", "summary": "..."}

${articleBlocks}`;
}

export async function summarizeCluster(articles: SourceArticle[]): Promise<ClusterSummary | null> {
  const prompt = buildPrompt(articles);

  try {
    const interaction = await ai.interactions.create({
      model: "gemini-3.5-flash",
      input: prompt,
    });

    const raw = interaction.output_text ?? "";
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    if (typeof parsed.headline !== "string" || typeof parsed.summary !== "string") {
      console.error("Gemini response missing expected fields:", raw);
      return null;
    }

    return { headline: parsed.headline, summary: parsed.summary };
  } catch (err) {
    console.error("Gemini summarization failed:", err);
    return null;
  }
}
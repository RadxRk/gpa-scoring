/**
 * Tiered response preparation for GPA scoring.
 *
 * Tier 1 (≤ fullUpTo)       — use full response as-is
 * Tier 2 (≤ extractUpTo)    — structured extraction of high-signal content
 * Tier 3 (> extractUpTo)    — LLM summarisation via claude-haiku-4-5
 */

const PV_PATTERN =
  /[^.!?\n]*(?:PRR|ROR|MGPS|EB05|MedDRA|NCT\d+|Bradford.Hill|dechallenge|rechallenge|serious\s+AE|adverse\s+event|GVP|ICH\s+E2C|PRAC|FAERS|VigiBase|disproportionality|signal\s+detect|causality|benefit.risk|incidence|prevalence)[^.!?\n]*/gi;

export type ResponseTier = "full" | "extracted" | "summarised";

interface TierResult {
  content: string;
  tier:    ResponseTier;
}

// ── Tier 2: structured extraction ────────────────────────────────────────────

export function extractHighSignalContent(response: string, maxChars = 6000): string {
  const budget = Math.floor(maxChars / 4);
  const parts: string[] = [];

  parts.push(`[OPENING]\n${response.slice(0, budget)}`);

  const pvSentences = Array.from(
    new Set((response.match(PV_PATTERN) || []).map(s => s.trim()))
  ).join(" ").slice(0, budget);
  if (pvSentences) parts.push(`[KEY FINDINGS]\n${pvSentences}`);

  const listPattern = /^\s*\d+\.\s+.+$/gm;
  const lists = (response.match(listPattern) || []).join("\n").slice(0, budget);
  if (lists) parts.push(`[STRUCTURED POINTS]\n${lists}`);

  parts.push(`[CONCLUSION]\n${response.slice(-budget)}`);
  return parts.join("\n\n");
}

// ── Tier 3: LLM summarisation ─────────────────────────────────────────────────

export async function summariseForScoring(
  question:    string,
  response:    string,
  queryFn:     (sql: string) => Promise<{ RESULT: string }[]>,
  judgeModel:  string,
  esc:         (s: string) => string
): Promise<string> {
  const prompt = `You are compressing an AI agent response for quality evaluation.
Extract the most evaluation-relevant content in under 3000 characters.

Focus on:
- The direct answer to the question
- Key findings and data cited
- Conclusions and recommendations
- Any caveats or limitations stated

Question: ${question.slice(0, 300)}
Full Response (${response.length} chars): ${response.slice(0, 30000)}

Output the compressed evaluation summary only:`;

  try {
    const rows = await queryFn(
      `SELECT SNOWFLAKE.CORTEX.COMPLETE('${judgeModel}', '${esc(prompt)}') AS RESULT`
    );
    return rows?.[0]?.RESULT || extractHighSignalContent(response, 6000);
  } catch {
    return extractHighSignalContent(response, 6000);
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────

export async function prepareResponse(
  question:   string,
  response:   string,
  tiers:      { fullUpTo: number; extractUpTo: number },
  queryFn:    (sql: string) => Promise<{ RESULT: string }[]>,
  judgeModel: string,
  esc:        (s: string) => string
): Promise<TierResult> {
  if (response.length <= tiers.fullUpTo) {
    return { content: response, tier: "full" };
  }
  if (response.length <= tiers.extractUpTo) {
    return { content: extractHighSignalContent(response, 6000), tier: "extracted" };
  }
  const summary = await summariseForScoring(question, response, queryFn, judgeModel, esc);
  return { content: summary, tier: "summarised" };
}

/**
 * Core scoring logic — pure function, no framework dependency.
 * Works with any Snowflake query function injected as a parameter.
 */

import {
  Dimension, DimensionScore, GpaScore, ScoreLabel,
  ScorerConfig, ScoreRequest, ScoreResult,
  DEFAULT_SCORER_CONFIG, DIMENSION_RUBRICS,
} from "./types";
import { prepareResponse } from "./response-prep";

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function scoreToLabel(v: number): ScoreLabel {
  if (v >= 3) return "High";
  if (v >= 2) return "Good";
  if (v >= 1) return "Partial";
  return "Low";
}

function buildPrompt(
  question:   string,
  response:   string,
  tier:       string,
  origLen:    number,
  dimensions: Dimension[]
): string {
  const rubrics = dimensions.map(d => {
    const r = DIMENSION_RUBRICS[d];
    const levels = r.levels
      .map(l => `   ${l.score} = ${l.label}: ${l.description}`)
      .join("\n");
    return `${r.key} — ${r.name}: ${r.description}\n${levels}`;
  }).join("\n\n");

  const keys = dimensions.map(d => `"${d.toLowerCase()}_score": <0-3>, "${d.toLowerCase()}_reasoning": "<one sentence>"`).join(", ");

  return `You are evaluating an AI agent response on the following dimensions.

Question: ${question}

Agent Response${tier !== "full" ? ` (${tier} from ${origLen} chars)` : ""}:
${response}

Score each dimension from 0 to 3:

${rubrics}

Return ONLY valid JSON — no extra text:
{${keys}}`;
}

// ── Main scoring function ─────────────────────────────────────────────────────

export async function scoreResponse(
  request:  ScoreRequest,
  config:   ScorerConfig,
  queryFn:  (sql: string) => Promise<{ RESULT: string }[]>
): Promise<ScoreResult> {
  const cfg = { ...DEFAULT_SCORER_CONFIG, ...config };
  cfg.dimensions  = config.dimensions  ?? DEFAULT_SCORER_CONFIG.dimensions;
  cfg.responseTiers = config.responseTiers ?? DEFAULT_SCORER_CONFIG.responseTiers;

  const t0 = Date.now();

  const truncatedQ = request.question.slice(0, cfg.maxQuestionChars);
  const rawResponse = request.response;

  // Prepare response (tiered)
  const { content: responseContent, tier } = await prepareResponse(
    truncatedQ, rawResponse,
    cfg.responseTiers,
    queryFn,
    cfg.judgeModel,
    esc
  );

  // Build and execute scoring prompt
  const prompt        = buildPrompt(truncatedQ, responseContent, tier, rawResponse.length, cfg.dimensions);
  const escapedPrompt = esc(prompt);

  let raw = "";
  try {
    const rows = await queryFn(
      `SELECT SNOWFLAKE.CORTEX.COMPLETE('${cfg.judgeModel}', '${escapedPrompt}') AS RESULT`
    );
    raw = rows?.[0]?.RESULT || "";
  } catch (err) {
    console.error("[gpa-scoring] CORTEX.COMPLETE error:", (err as Error).message);
    return {
      scores: { isScoring: false },
      tier,
      durationMs: Date.now() - t0,
    };
  }

  // Parse JSON response
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error("[gpa-scoring] Could not parse JSON from model response");
    return { scores: { isScoring: false }, tier, durationMs: Date.now() - t0 };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { scores: { isScoring: false }, tier, durationMs: Date.now() - t0 };
  }

  // Build GpaScore from parsed dimensions
  const scores: GpaScore = { isScoring: false, scoredAt: new Date() };

  for (const dim of cfg.dimensions) {
    const key      = dim.toLowerCase();
    const rawVal   = parsed[`${key}_score`];
    const rawReason = parsed[`${key}_reasoning`];
    const value    = Math.max(0, Math.min(3, Math.round(Number(rawVal))));
    const label    = scoreToLabel(value);
    const reasoning = String(rawReason || "").slice(0, 300);

    const ds: DimensionScore = { value, label, reasoning };
    (scores as Record<string, unknown>)[dim] = ds;
  }

  // Backwards-compatible flat fields (GF → value/label/reasoning, LC → lcValue/lcLabel/lcReasoning)
  if (scores.GF) {
    scores.value     = scores.GF.value;
    scores.label     = scores.GF.label;
    scores.reasoning = scores.GF.reasoning;
  }
  if (scores.LC) {
    scores.lcValue     = scores.LC.value;
    scores.lcLabel     = scores.LC.label;
    scores.lcReasoning = scores.LC.reasoning;
  }

  return { scores, tier, durationMs: Date.now() - t0 };
}

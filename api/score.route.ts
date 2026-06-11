/**
 * Configurable Next.js API route handler factory.
 *
 * Usage — drop into your app:
 *
 *   // app/api/agent/score/route.ts
 *   import { createScoreHandler } from "@/gpa-scoring/api/score.route";
 *   export const POST = createScoreHandler({
 *     agentName: "MY_AGENT",
 *     dimensions: ["GF", "LC"],
 *     storage: { table: "MY_DB.SCHEMA.GPA_SCORES", enabled: true },
 *   });
 */

import { NextRequest } from "next/server";
import { ScorerConfig, ScoreRequest } from "../lib/types";
import { scoreResponse } from "../lib/scorer";
import { persistScore } from "../lib/storage";

// ── Snowflake query adapter (injected at runtime) ─────────────────────────────
// This avoids a hard dependency — the host app supplies its own query function.
type QueryFn = (sql: string) => Promise<{ RESULT: string }[]>;
type ExecuteFn = (sql: string) => Promise<unknown>;

let _queryFn:   QueryFn   | null = null;
let _executeFn: ExecuteFn | null = null;

/**
 * Register your Snowflake query function once at app startup.
 * Typically called in your lib/snowflake.ts or similar.
 */
export function registerSnowflakeFns(queryFn: QueryFn, executeFn: ExecuteFn): void {
  _queryFn   = queryFn;
  _executeFn = executeFn;
}

// ── Handler factory ───────────────────────────────────────────────────────────

export function createScoreHandler(config: ScorerConfig) {
  return async function POST(req: NextRequest): Promise<Response> {
    try {
      const body = await req.json();
      const { question, response, threadId, messageId, toolResults } = body as ScoreRequest;

      if (!question || !response) {
        return Response.json({ error: "question and response are required" }, { status: 400 });
      }

      if (!_queryFn) {
        return Response.json(
          { error: "Snowflake query function not registered. Call registerSnowflakeFns() at startup." },
          { status: 500 }
        );
      }

      const request: ScoreRequest = { question, response, threadId, messageId, toolResults };
      const result  = await scoreResponse(request, config, _queryFn);

      // Persist asynchronously (fire-and-forget — does not block response)
      if (_executeFn) {
        persistScore(request, result.scores, result.tier, result.durationMs, config, _executeFn)
          .catch(e => console.error("[gpa-scoring] persist failed:", e));
      }

      // Return both the new structured scores and legacy flat fields for backwards compat
      return Response.json({
        scores:     result.scores,
        tier:       result.tier,
        durationMs: result.durationMs,
        // Legacy flat fields (clinical-trial-app compatibility)
        value:      result.scores.value,
        label:      result.scores.label,
        reasoning:  result.scores.reasoning,
        lcValue:    result.scores.lcValue,
        lcLabel:    result.scores.lcLabel,
        lcReasoning: result.scores.lcReasoning,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      console.error("[gpa-scoring] Error:", message);
      return Response.json({ error: message }, { status: 500 });
    }
  };
}

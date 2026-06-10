// =============================================================================
// GPA Scoring Module — Types
// Reusable across any Snowflake Cortex Agent + Next.js application
// =============================================================================

// ── Scoring dimensions ────────────────────────────────────────────────────────

export type Dimension = "GF" | "LC" | "EE" | "PQ" | "PA";

export type ScoreLabel = "High" | "Good" | "Partial" | "Low";

export interface DimensionScore {
  value:     number;       // 0–3
  label:     ScoreLabel;
  reasoning: string;       // 1-sentence judge explanation
}

export interface GpaScore {
  GF?: DimensionScore;     // Goal Fulfillment
  LC?: DimensionScore;     // Logical Consistency
  EE?: DimensionScore;     // Execution Efficiency
  PQ?: DimensionScore;     // Plan Quality
  PA?: DimensionScore;     // Plan Adherence
  isScoring?:  boolean;    // true while async call is in-flight
  scoredAt?:   Date;
  // Legacy flat fields — for backwards compat with clinical-trial-app
  value?:      number;     // = GF.value
  label?:      ScoreLabel; // = GF.label
  reasoning?:  string;     // = GF.reasoning
  lcValue?:    number;     // = LC.value
  lcLabel?:    ScoreLabel; // = LC.label
  lcReasoning?:string;     // = LC.reasoning
}

// ── Rubric definitions ────────────────────────────────────────────────────────

export interface DimensionRubric {
  key:         Dimension;
  name:        string;
  description: string;
  levels: {
    score: number;
    label: ScoreLabel;
    description: string;
  }[];
}

export const DIMENSION_RUBRICS: Record<Dimension, DimensionRubric> = {
  GF: {
    key: "GF", name: "Goal Fulfillment",
    description: "Did the agent completely and accurately answer the question?",
    levels: [
      { score: 3, label: "High",    description: "Fully answered with complete, accurate results" },
      { score: 2, label: "Good",    description: "Mostly answered with minor omissions or formatting" },
      { score: 1, label: "Partial", description: "Partially answered, missing key components" },
      { score: 0, label: "Low",     description: "Failed, incorrect, or refused to answer" },
    ],
  },
  LC: {
    key: "LC", name: "Logical Consistency",
    description: "Are the agent reasoning steps internally consistent?",
    levels: [
      { score: 3, label: "High",    description: "All reasoning logically consistent, no contradictions" },
      { score: 2, label: "Good",    description: "Minor inconsistencies that do not affect the outcome" },
      { score: 1, label: "Partial", description: "Noticeable inconsistencies or contradictory statements" },
      { score: 0, label: "Low",     description: "Major logical contradictions or incoherent reasoning" },
    ],
  },
  EE: {
    key: "EE", name: "Execution Efficiency",
    description: "Did the agent reach the goal without wasted or redundant steps?",
    levels: [
      { score: 3, label: "High",    description: "Reached answer in minimum necessary steps, no redundancy" },
      { score: 2, label: "Good",    description: "Minor inefficiencies that did not affect the outcome" },
      { score: 1, label: "Partial", description: "Several wasteful steps or repeated queries" },
      { score: 0, label: "Low",     description: "Highly inefficient — looped, re-ran same queries, wasted tokens" },
    ],
  },
  PQ: {
    key: "PQ", name: "Plan Quality",
    description: "Did the agent design an effective plan before executing?",
    levels: [
      { score: 3, label: "High",    description: "Correctly decomposed the problem, assigned best tools per step" },
      { score: 2, label: "Good",    description: "Mostly correct plan with minor gaps or suboptimal tool choice" },
      { score: 1, label: "Partial", description: "Plan had significant gaps or wrong tools assigned" },
      { score: 0, label: "Low",     description: "No coherent plan, jumped directly to execution incorrectly" },
    ],
  },
  PA: {
    key: "PA", name: "Plan Adherence",
    description: "Did the agent follow through on its stated plan?",
    levels: [
      { score: 3, label: "High",    description: "Executed every step of the plan in the correct order" },
      { score: 2, label: "Good",    description: "Minor deviation, one step reordered or slightly modified" },
      { score: 1, label: "Partial", description: "Skipped important planned steps or abandoned plan midway" },
      { score: 0, label: "Low",     description: "Plan was almost entirely ignored" },
    ],
  },
};

// ── Scorer configuration ──────────────────────────────────────────────────────

export interface ScorerConfig {
  /** Human-readable agent name stored in score history */
  agentName: string;
  /** Snowflake Cortex model for judging (default: claude-haiku-4-5) */
  judgeModel?: string;
  /** Which dimensions to evaluate (default: ["GF", "LC"]) */
  dimensions?: Dimension[];
  /** Max chars for question truncation (default: 1000) */
  maxQuestionChars?: number;
  /** Response length tiers: full / extracted / summarised */
  responseTiers?: {
    fullUpTo:      number;  // default 8000
    extractUpTo:   number;  // default 30000
    // above extractUpTo → summarise with LLM
  };
  /** Storage config */
  storage?: {
    table:    string;  // fully qualified table name
    enabled:  boolean; // set false to disable persistence
  };
  /** GF threshold below which to show a low-confidence warning */
  lowConfidenceThreshold?: number; // default 2
}

export const DEFAULT_SCORER_CONFIG: Required<ScorerConfig> = {
  agentName:            "UNKNOWN_AGENT",
  judgeModel:           "claude-haiku-4-5",
  dimensions:           ["GF", "LC"],
  maxQuestionChars:     1000,
  responseTiers:        { fullUpTo: 8000, extractUpTo: 30000 },
  storage: {
    table:   "SIGNAL_DB.META_DATA.GPA_SCORE_HISTORY",
    enabled: true,
  },
  lowConfidenceThreshold: 2,
};

// ── Score request / response ──────────────────────────────────────────────────

export interface ScoreRequest {
  question:   string;
  response:   string;
  threadId?:  string;
  messageId?: string;
}

export interface ScoreResult {
  scores:    GpaScore;
  tier:      "full" | "extracted" | "summarised";
  durationMs: number;
}

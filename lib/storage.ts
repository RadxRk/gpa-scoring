/**
 * Snowflake persistence for GPA scores.
 * Fire-and-forget — never blocks the API response.
 * Handles schema migrations for tables created by older versions.
 */

import { GpaScore, ScorerConfig, ScoreRequest } from "./types";

function esc(s: unknown): string {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const CREATE_TABLE_SQL = (table: string) => `
CREATE TABLE IF NOT EXISTS ${table} (
  id               VARCHAR    DEFAULT UUID_STRING() PRIMARY KEY,
  agent_name       VARCHAR,
  thread_id        VARCHAR,
  message_id       VARCHAR,
  question         TEXT,
  response_preview TEXT,
  gf_score         NUMBER, gf_label  VARCHAR, gf_reasoning  TEXT,
  lc_score         NUMBER, lc_label  VARCHAR, lc_reasoning  TEXT,
  ee_score         NUMBER, ee_label  VARCHAR, ee_reasoning  TEXT,
  pq_score         NUMBER, pq_label  VARCHAR, pq_reasoning  TEXT,
  pa_score         NUMBER, pa_label  VARCHAR, pa_reasoning  TEXT,
  tier             VARCHAR,
  duration_ms      NUMBER,
  scored_at        TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()
)`;

// Columns added in newer versions — ALTER adds them if missing on existing tables
const MIGRATION_SQLS = (table: string) => [
  `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS agent_name    VARCHAR`,
  `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS ee_score      NUMBER`,
  `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS ee_label      VARCHAR`,
  `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS ee_reasoning  TEXT`,
  `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS pq_score      NUMBER`,
  `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS pq_label      VARCHAR`,
  `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS pq_reasoning  TEXT`,
  `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS pa_score      NUMBER`,
  `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS pa_label      VARCHAR`,
  `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS pa_reasoning  TEXT`,
  `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS tier          VARCHAR`,
  `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS duration_ms   NUMBER`,
];

// Track which tables have been migrated in this process lifetime
const migratedTables = new Set<string>();

async function ensureSchema(
  table: string,
  executeFn: (sql: string) => Promise<unknown>
): Promise<void> {
  if (migratedTables.has(table)) return;

  // Create table if it doesn't exist
  await executeFn(CREATE_TABLE_SQL(table));

  // Add any missing columns for tables created by older versions
  for (const sql of MIGRATION_SQLS(table)) {
    try {
      await executeFn(sql);
    } catch {
      // Ignore — column may already exist or table may not support ALTER
    }
  }

  migratedTables.add(table);
}

export async function persistScore(
  request:    ScoreRequest,
  scores:     GpaScore,
  tier:       string,
  durationMs: number,
  config:     ScorerConfig,
  executeFn:  (sql: string) => Promise<unknown>
): Promise<void> {
  const storage = config.storage ?? {
    enabled: true,
    table: "SIGNAL_DB.META_DATA.GPA_SCORE_HISTORY",
  };
  if (!storage.enabled) return;

  const table = storage.table;

  try {
    await ensureSchema(table, executeFn);

    const g  = scores.GF;
    const lc = scores.LC;
    const ee = scores.EE;
    const pq = scores.PQ;
    const pa = scores.PA;

    await executeFn(`
      INSERT INTO ${table} (
        agent_name, thread_id, message_id,
        question, response_preview,
        gf_score, gf_label, gf_reasoning,
        lc_score, lc_label, lc_reasoning,
        ee_score, ee_label, ee_reasoning,
        pq_score, pq_label, pq_reasoning,
        pa_score, pa_label, pa_reasoning,
        tier, duration_ms
      ) VALUES (
        '${esc(config.agentName)}',
        '${esc(request.threadId  || "")}',
        '${esc(request.messageId || "")}',
        '${esc(request.question.slice(0, 500))}',
        '${esc(request.response.slice(0, 500))}',
        ${g  ? g.value  : "NULL"}, '${esc(g?.label  || "")}', '${esc(g?.reasoning  || "")}',
        ${lc ? lc.value : "NULL"}, '${esc(lc?.label || "")}', '${esc(lc?.reasoning || "")}',
        ${ee ? ee.value : "NULL"}, '${esc(ee?.label || "")}', '${esc(ee?.reasoning || "")}',
        ${pq ? pq.value : "NULL"}, '${esc(pq?.label || "")}', '${esc(pq?.reasoning || "")}',
        ${pa ? pa.value : "NULL"}, '${esc(pa?.label || "")}', '${esc(pa?.reasoning || "")}',
        '${esc(tier)}', ${durationMs}
      )
    `);
  } catch (err) {
    console.error("[gpa-scoring] Persistence error:", (err as Error).message);
  }
}

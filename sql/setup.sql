-- =============================================================================
-- GPA Scoring Module — Database Setup
-- Run once per Snowflake account.
-- Replace SIGNAL_DB.META_DATA with your preferred database and schema.
-- =============================================================================

-- Create the score history table
CREATE TABLE IF NOT EXISTS SIGNAL_DB.META_DATA.GPA_SCORE_HISTORY (
  id                VARCHAR    DEFAULT UUID_STRING() PRIMARY KEY,
  agent_name        VARCHAR,          -- which agent was scored
  thread_id         VARCHAR,          -- conversation thread
  message_id        VARCHAR,          -- specific message
  question          TEXT,             -- user question (truncated at 500 chars)
  response_preview  TEXT,             -- agent response preview
  -- Goal Fulfillment
  gf_score          NUMBER,
  gf_label          VARCHAR,
  gf_reasoning      TEXT,
  -- Logical Consistency
  lc_score          NUMBER,
  lc_label          VARCHAR,
  lc_reasoning      TEXT,
  -- Hallucination Detection
  hd_score          NUMBER,
  hd_label          VARCHAR,
  hd_reasoning      TEXT,
  -- Execution Efficiency (optional)
  ee_score          NUMBER,
  ee_label          VARCHAR,
  ee_reasoning      TEXT,
  -- Plan Quality (optional)
  pq_score          NUMBER,
  pq_label          VARCHAR,
  pq_reasoning      TEXT,
  -- Plan Adherence (optional)
  pa_score          NUMBER,
  pa_label          VARCHAR,
  pa_reasoning      TEXT,
  -- Metadata
  tier              VARCHAR,          -- full / extracted / summarised
  duration_ms       NUMBER,           -- scoring latency
  scored_at         TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()
);

-- Useful analytics queries:

-- Average scores by agent and day
SELECT
    agent_name,
    DATE_TRUNC('day', scored_at) AS day,
    COUNT(*)                     AS total,
    ROUND(AVG(gf_score), 2)      AS avg_gf,
    ROUND(AVG(lc_score), 2)      AS avg_lc,
    ROUND(AVG(hd_score), 2)      AS avg_hd,
    SUM(CASE WHEN gf_score < 2 THEN 1 ELSE 0 END) AS low_confidence
FROM SIGNAL_DB.META_DATA.GPA_SCORE_HISTORY
GROUP BY 1, 2
ORDER BY day DESC, agent_name;

-- Low-scoring responses to investigate (low quality OR likely hallucination)
SELECT agent_name, thread_id, question, gf_score, lc_score, hd_score, hd_reasoning
FROM SIGNAL_DB.META_DATA.GPA_SCORE_HISTORY
WHERE gf_score < 2 OR lc_score < 2 OR hd_score < 2
ORDER BY scored_at DESC
LIMIT 20;

-- Suspected hallucinations (HD flagged the response)
SELECT agent_name, thread_id, question, response_preview, hd_score, hd_label, hd_reasoning
FROM SIGNAL_DB.META_DATA.GPA_SCORE_HISTORY
WHERE hd_score IS NOT NULL AND hd_score < 2
ORDER BY scored_at DESC
LIMIT 20;

-- Thread-level quality summary
SELECT
    agent_name,
    thread_id,
    COUNT(*)             AS messages,
    ROUND(AVG(gf_score), 2) AS avg_gf,
    ROUND(AVG(lc_score), 2) AS avg_lc
FROM SIGNAL_DB.META_DATA.GPA_SCORE_HISTORY
WHERE thread_id IS NOT NULL AND thread_id != ''
GROUP BY 1, 2
ORDER BY avg_gf ASC
LIMIT 20;

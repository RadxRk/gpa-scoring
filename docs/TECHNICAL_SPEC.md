# GPA Scoring — Technical Specification

**Status:** Implemented (GF/LC production-ready; EE/PQ/PA scaffolded)
**Audience:** Engineers integrating, extending, or maintaining the module
**Companion docs:** [`DESIGN.md`](DESIGN.md) (why), [`../README.md`](../README.md) (how to use)

---

## 1. Purpose & scope

The GPA Scoring module is a server-plus-client package that grades AI agent responses
in real time using an LLM-as-judge, renders the result inline, and persists it to
Snowflake. It is implemented as a self-contained folder with no hard dependency on the
host application beyond:

- A **Next.js** App-Router runtime (the API route is a `POST` handler).
- A **Snowflake** query function injected by the host (so the module never imports the
  host's database client directly).
- A **React** client for the hook and badge.

The judge is invoked through `SNOWFLAKE.CORTEX.COMPLETE(model, prompt)`. The default
model is `claude-haiku-4-5`; any Cortex-available completion model may be substituted.

In scope: scoring orchestration, prompt construction, response tiering, persistence,
the React hook, and the badge component. Out of scope: the host's chat UI, streaming,
authentication, and Snowflake connection management.

---

## 2. Component map

| File | Responsibility | Runtime |
|------|----------------|---------|
| `lib/types.ts` | All interfaces, the dimension rubrics, and `DEFAULT_SCORER_CONFIG`. | Shared |
| `lib/scorer.ts` | Pure scoring function: prompt → `CORTEX.COMPLETE` → parse → clamp. | Server |
| `lib/response-prep.ts` | Tiered response preparation (full / extracted / summarised). | Server |
| `lib/storage.ts` | Self-migrating `GPA_SCORE_HISTORY` schema + fire-and-forget insert. | Server |
| `api/score.route.ts` | `createScoreHandler` factory + `registerSnowflakeFns` injection. | Server |
| `hooks/use-gpa-scoring.ts` | `useGpaScoring` (single message) + `useBatchGpaScoring` (thread). | Client |
| `components/GpaScoreBadge.tsx` | Badge, per-dimension tooltip, low-confidence banner. | Client |
| `sql/setup.sql` | DDL and analytics queries. | Snowflake |

---

## 3. Data flow

```
Client (after stream completes)
  └─ triggerScore({ question, response, threadId, messageId })
       └─ POST scoreEndpoint  ───────────────────────────────►  Server
                                                                 createScoreHandler(config)
                                                                   ├─ validate body (question & response required)
                                                                   ├─ scoreResponse(request, config, queryFn)
                                                                   │    ├─ prepareResponse(...)      → { content, tier }
                                                                   │    ├─ buildPrompt(...)          → prompt string
                                                                   │    ├─ CORTEX.COMPLETE(model, prompt)
                                                                   │    ├─ regex-extract JSON object
                                                                   │    ├─ JSON.parse + clamp(0..3) per dimension
                                                                   │    └─ map GF/LC → legacy flat fields
                                                                   ├─ persistScore(...)  (fire-and-forget, not awaited)
                                                                   └─ Response.json({ scores, tier, durationMs, ...legacy })
       ◄──────────────────────────────────────────────────────  JSON
  └─ setScore(newScore) → onScore(score) → GpaScoreBadge renders
```

Scoring **is awaited** server-side, so the HTTP response returns only after the judge
replies (~2–3 s). "Non-blocking" refers to the **chat stream**: the client fires
`triggerScore` *after* the answer has fully rendered, so the user never waits on scoring.
Persistence (`persistScore`) is *not* awaited and cannot delay the HTTP response.

---

## 4. Interface contracts

### 4.1 `ScoreRequest` (client → server)

```typescript
interface ScoreRequest {
  question:   string;   // required
  response:   string;   // required
  threadId?:  string;
  messageId?: string;
}
```

`question` and `response` are mandatory; a missing either yields `400`.

### 4.2 `ScorerConfig` (mount-time)

See [Configuration reference](../README.md#configuration-reference). Defaults live in
`DEFAULT_SCORER_CONFIG` (`types.ts`). Config is shallow-merged over the defaults at the
top of `scoreResponse`, with `dimensions` and `responseTiers` explicitly defaulted.

### 4.3 Response body (server → client)

```jsonc
{
  "scores": {
    "GF": { "value": 3, "label": "High", "reasoning": "…" },
    "LC": { "value": 2, "label": "Good", "reasoning": "…" },
    "isScoring": false,
    "scoredAt": "2026-06-10T…Z",
    // legacy flat mirror of GF/LC:
    "value": 3, "label": "High", "reasoning": "…",
    "lcValue": 2, "lcLabel": "Good", "lcReasoning": "…"
  },
  "tier": "full",            // full | extracted | summarised
  "durationMs": 2143,
  // legacy top-level mirror (clinical-trial-app compatibility):
  "value": 3, "label": "High", "reasoning": "…",
  "lcValue": 2, "lcLabel": "Good", "lcReasoning": "…"
}
```

On any failure that prevents scoring, `scores` is `{ isScoring: false }` and the client
treats it as "no badge."

### 4.4 React surface

```typescript
useGpaScoring(options): {
  score:        GpaScore | null;
  isScoring:    boolean;
  triggerScore: (request: ScoreRequest) => void;  // fire-and-forget
  clearScore:   () => void;
}

useBatchGpaScoring(options): {
  isRescoring: boolean;
  rescoreAll:  (messages: ScoredMessage[], threadId?: string,
                onUpdate?: (id: string, score: GpaScore) => void) => Promise<void>;
}
```

`GpaScoreBadge` props: `score?`, `threshold = 2`, `dimensions?` (display order;
defaults to `["GF","LC","EE","PQ","PA"]`, filtered to those actually present).

---

## 5. The scoring prompt

`buildPrompt` (`scorer.ts`) emits a single prompt evaluating **all** configured
dimensions at once, so GF + LC cost one LLM call. Shape:

```
You are evaluating an AI agent response on the following dimensions.

Question: <question, truncated to maxQuestionChars>

Agent Response[ (<tier> from <origLen> chars)]:
<prepared response content>

Score each dimension from 0 to 3:

GF — Goal Fulfillment: <description>
   3 = High: …
   2 = Good: …
   1 = Partial: …
   0 = Low: …

LC — Logical Consistency: …

Return ONLY valid JSON — no extra text:
{"gf_score": <0-3>, "gf_reasoning": "<one sentence>", "lc_score": <0-3>, "lc_reasoning": "<one sentence>"}
```

Rubric text per dimension comes from `DIMENSION_RUBRICS` (`types.ts`) — the single
source of truth for both the prompt and the badge's full-name tooltip.

### 5.1 Parsing & clamping

1. Regex `/\{[\s\S]*\}/` extracts the first `{…}` block (tolerates prose around the JSON).
2. `JSON.parse`; on failure → `{ isScoring: false }`.
3. Per dimension: `value = clamp(round(Number(raw)), 0, 3)`; `reasoning` is coerced to
   string and truncated to 300 chars.
4. `scoreToLabel`: `≥3 High`, `≥2 Good`, `≥1 Partial`, else `Low`.
5. GF and LC are mirrored into legacy flat fields for backwards compatibility.

---

## 6. Response tiering

`prepareResponse` (`response-prep.ts`) chooses by `response.length`:

| Tier | Condition | Behaviour | LLM call |
|------|-----------|-----------|:---:|
| `full` | `≤ fullUpTo` (8 000) | Pass response unchanged. | No |
| `extracted` | `≤ extractUpTo` (30 000) | `extractHighSignalContent`: `[OPENING]` (first ¼ budget) + `[KEY FINDINGS]` (PV_PATTERN sentences) + `[STRUCTURED POINTS]` (numbered lists) + `[CONCLUSION]` (last ¼ budget), each capped at `maxChars/4` with `maxChars = 6000`. | No |
| `summarised` | `> extractUpTo` | `summariseForScoring`: one `CORTEX.COMPLETE` call compresses to <3 000 chars; **falls back to extraction** on error. | Yes (1) |

> The `[KEY FINDINGS]` extraction uses `PV_PATTERN`, a hardcoded pharmacovigilance
> regex. See [§9 Known limitations](#9-known-limitations).

---

## 7. Persistence

`persistScore` (`storage.ts`) writes one row per scored response to the configured table
(default `SIGNAL_DB.META_DATA.GPA_SCORE_HISTORY`).

- **Self-migrating schema.** `ensureSchema` runs `CREATE TABLE IF NOT EXISTS` then a list
  of idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements, so tables created by
  older versions are upgraded in place. Migration runs once per table per process
  (tracked in an in-memory `Set`).
- **Fire-and-forget.** Called without `await` from the handler; errors are caught and
  logged, never surfaced to the client.
- **Truncation.** `question` and `response_preview` are stored truncated to 500 chars.
- Absent dimensions are written as SQL `NULL`.

### 7.1 Schema (`GPA_SCORE_HISTORY`)

| Column | Type | Notes |
|--------|------|-------|
| `id` | `VARCHAR` | `UUID_STRING()` default, primary key |
| `agent_name` | `VARCHAR` | Which agent was scored |
| `thread_id`, `message_id` | `VARCHAR` | Conversation / message identifiers |
| `question` | `TEXT` | Truncated to 500 chars |
| `response_preview` | `TEXT` | Truncated to 500 chars |
| `gf_score / gf_label / gf_reasoning` | `NUMBER / VARCHAR / TEXT` | Goal Fulfillment |
| `lc_score / lc_label / lc_reasoning` | `NUMBER / VARCHAR / TEXT` | Logical Consistency |
| `ee_* / pq_* / pa_*` | `NUMBER / VARCHAR / TEXT` | NULL unless dimension enabled |
| `tier` | `VARCHAR` | `full` / `extracted` / `summarised` |
| `duration_ms` | `NUMBER` | Scoring latency |
| `scored_at` | `TIMESTAMP_LTZ` | `CURRENT_TIMESTAMP()` default |

Analytics queries (avg by agent/day, low-scoring rows, thread summary, tier distribution)
ship in `sql/setup.sql`.

---

## 8. Error semantics

| Failure point | Behaviour | Visibility |
|---------------|-----------|------------|
| Missing `question`/`response` | `400` JSON error | Client `res.ok === false` → badge cleared |
| `registerSnowflakeFns` not called | `500` JSON error | Console + client |
| `CORTEX.COMPLETE` throws | `{ scores: { isScoring: false } }`, HTTP `200` | `console.error`; badge hidden |
| JSON not found / unparseable | `{ scores: { isScoring: false } }`, HTTP `200` | `console.error`; badge hidden |
| Summarisation call fails | Falls back to structured extraction | Transparent |
| Persistence fails | Swallowed | `console.error` only |
| Client fetch fails / `!res.ok` | `setScore(null)` | Badge hidden; `onError` called on throw |

Design stance: **scoring is auxiliary** — its failures must never degrade the chat. All
failure paths converge on "no badge."

---

## 9. Known limitations

> These are the results of a thoroughness audit. Items 1–3 are the most consequential.

1. **EE / PQ / PA cannot be scored as built.** `ScoreRequest` has no execution-trace
   field and `buildPrompt` only consumes `question` + `response`. Enabling these
   dimensions asks the judge to grade plan/execution quality with no trace data, so
   results are unreliable. **Fix path:** add `trace?: AgentTrace` to `ScoreRequest`,
   thread it through `scoreResponse` → `buildPrompt`, and only inject the trace-dependent
   rubric blocks when a trace is present. Until then, keep `dimensions: ["GF","LC"]`.

2. **`PV_PATTERN` is domain-coupled.** The Tier-2 `[KEY FINDINGS]` extractor is a
   pharmacovigilance regex. For a genuinely agent-agnostic module, lift it into config
   (e.g. `responseTiers.keyFindingsPattern?: RegExp`) with a neutral default.

3. **SQL via string interpolation.** `esc()` escapes only `\` and `'` before inlining
   the (model-bound) prompt and response into `CORTEX.COMPLETE(...)`. Correct for the
   current escaping, but bind variables / parameter binding would be more robust against
   future edge cases.

4. **No dimension-completeness validation.** A dimension the model omits is silently
   dropped; there is no retry or schema check on the judge's JSON.

5. **Silent degradation.** Errors hide the badge with no user-facing signal beyond
   `console.error`. Intentional, but reduces observability of judge failures.

6. **Uncapped batch concurrency.** `useBatchGpaScoring` issues one request per assistant
   message via `Promise.allSettled` with no concurrency limit.

7. **Latency floor.** Each score costs one synchronous `CORTEX.COMPLETE` round-trip
   (~2–3 s); summarised-tier responses cost two.

---

## 10. Performance characteristics

| Metric | Value |
|--------|-------|
| Scoring latency | ~2–3 s after response |
| LLM calls per response | 1 (GF + LC in one prompt); 2 for summarised tier |
| Token budget (typical) | ~800–2 000 tokens |
| Blocks the user? | No — fired after stream completes |
| Blocks the HTTP response? | Persistence no (async); scoring yes (awaited) |
| Tier selection | Automatic, by response length |

---

## 11. Integration checklist

- [ ] Copy `gpa-scoring/` into the app root.
- [ ] Run `sql/setup.sql` in Snowsight (once per account).
- [ ] Call `registerSnowflakeFns(queryFn, executeFn)` at startup.
- [ ] Create `app/api/<agent>/score/route.ts` with `createScoreHandler({ agentName, … })`.
- [ ] Call `triggerScore({ question, response, threadId, messageId })` after streaming completes.
- [ ] Render `<GpaScoreBadge score={message.gpaScore} threshold={2} />`.
- [ ] Verify: `SELECT * FROM GPA_SCORE_HISTORY WHERE agent_name = 'YOUR_AGENT'`.
</content>

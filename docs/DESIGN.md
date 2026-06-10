# GPA Scoring — Design Document

**Author:** Radx Radhakrishnan
**Audience:** Engineers onboarding to the module, reviewers, and future maintainers
**Companion docs:** [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md) (what & how), [`../README.md`](../README.md) (usage)

---

## 1. Problem

Cortex agents stream fluent, confident answers — but fluency is not correctness. In a
high-stakes domain (the first host app analyses clinical-trial safety data), users need a
fast, visible signal of *how much to trust each answer*, and the team needs a durable
record of answer quality over time to catch regressions when agent instructions or models
change.

Manual review doesn't scale to every message. We need **automated, per-response quality
scoring** that is:

- **Real-time** — visible the moment the answer lands, not in a nightly batch.
- **Unobtrusive** — never slows down or breaks the chat.
- **Reusable** — one implementation that drops into any Cortex agent app, not a bespoke
  feature welded to one product.
- **Auditable** — every score persisted for dashboards and trend analysis.

## 2. Approach: LLM-as-judge on the Agent GPA framework

We score each response with a second, cheaper LLM acting as a **judge**, prompted with an
explicit rubric. The rubric is the **Agent GPA (Goal-Plan-Action)** framework
([arXiv:2510.08847](https://arxiv.org/abs/2510.08847)), which decomposes agent quality into
goal-, plan-, and action-level dimensions:

| Layer | Dimension | What it measures | Needs trace? |
|-------|-----------|------------------|:---:|
| Goal | **GF** Goal Fulfillment | Did it answer completely and accurately? | No |
| — | **LC** Logical Consistency | Is the reasoning internally consistent? | No |
| Action | **EE** Execution Efficiency | Minimal, non-redundant steps? | Yes |
| Plan | **PQ** Plan Quality | Was an effective plan designed? | Yes |
| Plan | **PA** Plan Adherence | Did it follow the stated plan? | Yes |

**Why GF + LC first.** These two are evaluable from the response text alone — no agent
internals required — so they ship today with a single judge call. EE/PQ/PA require the
agent's execution trace (tool calls, plan steps) from AI Observability; their rubrics and
storage are in place, but the trace is not yet wired (see [§7 Roadmap](#7-roadmap)).

**Why Cortex as the judge.** The host already runs on Snowflake Cortex, so judging via
`SNOWFLAKE.CORTEX.COMPLETE` keeps data in-platform (no third-party egress), reuses existing
auth and billing, and needs no new infrastructure. `claude-haiku-4-5` is the default: cheap
and fast enough for an inline per-message call, capable enough for rubric grading.

## 3. Architecture & the decisions behind it

```
Browser (Next.js)                          Server (Next.js route)         Snowflake
  user question ─► Cortex Agent (SSE) ──┐
  stream completes ◄────────────────────┘
  triggerScore() ──► POST /score ─────────► createScoreHandler
                                              response-prep ─► scorer ─► CORTEX.COMPLETE
                                              storage (async) ───────────► GPA_SCORE_HISTORY
  GpaScoreBadge ◄──── GpaScore JSON ◄──────  Response.json
```

### Decision 1 — Score *after* streaming, client-triggered

Scoring fires from the client once the answer has fully rendered, not inline with
generation. **Why:** the answer must never wait on the judge. The user reads the response
immediately; the badge fills in 2–3 s later. The cost is a brief "Scoring…" state, which is
an acceptable, honest UI signal.

*Alternative rejected:* server-side scoring in the same request as generation — would add
latency to every answer and couple two independent concerns.

### Decision 2 — Dependency injection for Snowflake access

The module never imports the host's database client. The host calls
`registerSnowflakeFns(queryFn, executeFn)` once at startup. **Why:** keeps the module
truly portable — it works with any Snowflake access layer (connection pool, driver, proxy)
and stays trivially testable by injecting a fake. The price is a one-time registration step
and a runtime guard that returns `500` if it's skipped.

### Decision 3 — Single prompt for all dimensions

One `CORTEX.COMPLETE` call evaluates every configured dimension at once and returns a flat
JSON object. **Why:** N dimensions for the price of one call — GF + LC cost a single
round-trip. The trade-off is a longer prompt and the risk that the model omits a key; we
accept omissions silently (no retry) to keep the path simple and cheap.

### Decision 4 — Tiered response preparation

Rather than truncating long answers (which loses the conclusion) or always summarising
(which costs an extra call every time), we pick a strategy by length: full text when small,
structured extraction in the middle band, and LLM summarisation only for very long
responses. **Why:** preserves the highest-signal content — opening, key findings,
structured points, conclusion — while keeping the judge within budget and avoiding an extra
LLM call for the common case. *Known weakness:* the "key findings" extractor is currently a
clinical/pharmacovigilance regex and should be config-injectable (see
[§6 Trade-offs](#6-known-trade-offs--debt)).

### Decision 5 — Fire-and-forget persistence with self-migrating schema

The score row is written without `await`, so the HTTP response never waits on the insert;
and `ensureSchema` creates/upgrades the table on first use via idempotent DDL. **Why:**
persistence is for offline analytics, so it should add zero latency to the response; and
self-migration means dropping a new version into an existing deployment "just works" without
a manual migration step. The price is that a persistence failure is invisible except in
server logs, and DDL-on-write assumes the runtime role has create/alter privileges.

### Decision 6 — Zero-dependency badge, graceful degradation

`GpaScoreBadge` uses inline styles only and renders nothing on any missing/failed score.
**Why:** it must drop into any React app regardless of styling stack (Tailwind, shadcn, or
none), and a scoring failure should never break a message. The trade-off is inline styles
over a themeable class API — acceptable for a small, self-contained widget.

### Decision 7 — Backwards-compatible dual response shape

Every response includes both the new structured `scores` object and the legacy flat fields
(`value`, `label`, `lcValue`, …). **Why:** the original clinical-trial app consumed the flat
shape; emitting both lets the module evolve without a breaking change. This is explicit,
time-bounded debt — once all consumers read `scores`, the flat mirror can be retired.

## 4. UX behaviour

| State | What the user sees |
|-------|--------------------|
| Streaming | No badge |
| Scoring in flight | Grey "Scoring…" spinner |
| `GF ≥ threshold` | Coloured badges with hover tooltips (per-dimension reasoning) |
| `GF < threshold` | Badges **plus** an amber "Low confidence — try rephrasing" banner |
| Scoring error | Badge silently absent |
| Batch re-score | All badges spin, then update together |

Colours encode the label: green (High), teal (Good), yellow (Partial), red (Low). The
low-confidence banner turns a quality score into an actionable nudge — the only place the
module talks back to the end user.

## 5. Reusability model

The module is designed to serve many agents from one codebase:

- **One folder, copied once.** `cp -r gpa-scoring/ your-app/src/`.
- **One route per agent**, differing only in `agentName`.
- **One shared history table**, logically partitioned by `agent_name`.

Onboarding a new agent is: copy the folder (if not present) → add a route file → call
`triggerScore` after streaming → render the badge. No changes to the module itself.

## 6. Known trade-offs & debt

The audit behind these is in [`TECHNICAL_SPEC.md` §9](TECHNICAL_SPEC.md#9-known-limitations).
Summary of conscious trade-offs vs. genuine debt:

| Item | Conscious trade-off? | Debt to repay |
|------|:---:|---------------|
| Silent failure (no badge on error) | ✅ Yes — chat reliability over observability | Add opt-in telemetry/logging hook |
| Single prompt, no retry on missing dimension | ✅ Yes — cost/simplicity | Optional schema-validate + one retry |
| Fire-and-forget persistence | ✅ Yes — latency | Surface a failure counter |
| **EE/PQ/PA without trace** | ❌ No — a real gap | Plumb a `trace` field (see roadmap) |
| **`PV_PATTERN` domain coupling** | ❌ No — breaks "agent-agnostic" | Make extraction pattern configurable |
| SQL string interpolation | ⚠️ Partial | Move to bind variables |
| Uncapped batch concurrency | ⚠️ Partial | Add a concurrency limit |

## 7. Roadmap

1. **Wire the execution trace.** Add `trace?: AgentTrace` to `ScoreRequest`, thread it into
   `buildPrompt`, and conditionally include EE/PQ/PA rubric blocks only when a trace is
   present. This unlocks the three trace-dependent dimensions the schema already supports.
2. **Configurable Tier-2 extraction.** Replace the hardcoded `PV_PATTERN` with a
   `keyFindingsPattern` config option (neutral default), restoring true domain-agnosticism.
3. **Judge robustness.** Validate the judge's JSON against requested dimensions; retry once
   on a missing/invalid key.
4. **Observability hook.** Optional callback on scoring/persistence failure so operators can
   alert on judge errors without breaking the silent-degradation contract.
5. **Bind-variable SQL** and a **batch concurrency cap**.

## 8. References

- Agent GPA framework — *"What is Your Agent's GPA? A Framework for Evaluating Agent
  Goal-Plan-Action Alignment"* — [arXiv:2510.08847](https://arxiv.org/abs/2510.08847)
- Snowflake Cortex `COMPLETE` — [docs.snowflake.com](https://docs.snowflake.com/en/sql-reference/functions/complete-snowflake-cortex)
- Original design deck — `../REALTIME_GPA_SCORING.pdf`
</content>

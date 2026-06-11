# Contributing to GPA Scoring

Thanks for contributing! This document describes the **intended workflow** for changes to
this repository.

> ⚠️ **These rules are conventions, not server-enforced.** The repo is private on the
> GitHub Free plan, where branch protection and rulesets are unavailable. Until it moves to
> GitHub Pro or becomes public, `main` is technically writable directly — please follow the
> workflow below by agreement rather than enforcement. See
> [Enabling enforcement](#enabling-enforcement) for how to make these rules binding later.

---

## Branch & PR workflow

**Never commit directly to `main`.** All changes go through a pull request.

1. **Branch off `main`** using a descriptive, prefixed name:

   | Prefix | Use for |
   |--------|---------|
   | `feat/` | New functionality (e.g. `feat/trace-input-for-ee-pq-pa`) |
   | `fix/`  | Bug fixes (e.g. `fix/json-parse-fallback`) |
   | `docs/` | Documentation only (e.g. `docs/configurable-extraction`) |
   | `chore/` | Tooling, deps, housekeeping |
   | `refactor/` | Internal change, no behaviour change |

   ```bash
   git switch -c feat/your-change main
   ```

2. **Keep the change focused.** One logical change per PR. If you find yourself writing
   "and also…" in the description, split it.

3. **Open a pull request** into `main`:

   ```bash
   git push -u origin feat/your-change
   gh pr create --base main --fill
   ```

4. **At least one approving review** before merge. For solo work, self-review the diff in
   the GitHub UI before merging — read it as if someone else wrote it.

5. **Prefer "Squash and merge"** to keep `main` history linear and readable.

6. **Delete the branch** after merge.

---

## Commit messages

- Use a short, imperative subject line (≤ 72 chars): *"Add trace field to ScoreRequest"*,
  not *"Added"* / *"Adds"*.
- Add a body when the *why* isn't obvious from the subject.
- Reference issues with `Closes #123` when applicable.

---

## Code conventions

This is a TypeScript module designed to drop into any Next.js + Snowflake app. Match the
surrounding code:

- **Keep `lib/` pure and framework-free.** `scorer.ts`, `response-prep.ts`, and `storage.ts`
  receive their Snowflake access via injected functions — don't add direct imports of a
  database client or `next/*` into `lib/`.
- **`types.ts` is the single source of truth** for dimensions, rubrics, and config defaults.
  The scoring prompt and the badge both read from `DIMENSION_RUBRICS` — update it there, not
  in two places.
- **The badge stays dependency-free.** `GpaScoreBadge.tsx` uses inline styles only — no
  Tailwind, no shadcn, no new runtime deps.
- **Scoring must fail silently.** Any error path should degrade to "no badge," never throw
  into the host chat. Preserve this contract.
- **Don't break backwards compatibility** without discussion — responses currently emit both
  the structured `scores` object and the legacy flat fields.

---

## Before you open a PR

- [ ] Type-checks cleanly (`tsc --noEmit` in the host app, or your editor's TS server).
- [ ] No secrets, credentials, connection strings, or real database/schema names added.
- [ ] Docs updated if behaviour or config changed — `README.md`,
      [`docs/TECHNICAL_SPEC.md`](docs/TECHNICAL_SPEC.md), and
      [`docs/DESIGN.md`](docs/DESIGN.md) should stay in sync with the code.
- [ ] If you touched a [known limitation](README.md#known-limitations), update or remove its
      entry (and the roadmap in `DESIGN.md`).

---

## Working on the known gaps

The roadmap lives in [`docs/DESIGN.md` §7](docs/DESIGN.md#7-roadmap). The highest-value open
items, in priority order:

1. **Wire the execution trace** so EE / PQ / PA become functional.
2. **Make Tier-2 extraction configurable** (replace the hardcoded `PV_PATTERN`).
3. **Validate the judge's JSON** against requested dimensions, with one retry.

If you pick one up, open an issue first so the approach can be discussed before the PR.

---

## Enabling enforcement

When the repo moves to **GitHub Pro** (private) or becomes **public**, make the rules above
binding with a branch ruleset on `main`:

```bash
gh api -X PUT repos/RadxRk/gpa-scoring/branches/main/protection --input - <<'JSON'
{
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "required_status_checks": null,
  "enforce_admins": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "restrictions": null
}
JSON
```

Or via the UI: **Settings → Rules → Rulesets → New branch ruleset**, targeting the default
branch, with *Require a pull request*, *Block force pushes*, and *Require linear history*.
</content>

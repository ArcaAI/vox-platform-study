# TASK-536 — Pre-Release Comment Cleanup

| | |
|---|---|
| **Status** | In Progress (Wave 1 inventory COMPLETE; Waves 2+ gated — see Blockers) |
| **Type** | refactor (comment-only) |
| **Program** | Release Readiness (TASK-536 comments · TASK-537 docs · TASK-538 traceability · TASK-539 quality) |
| **Execution agents** | Sonnet 5, reasoning effort **high**, worktree-isolated, one per scope unit |
| **Created** | 2026-07-21 |
| **Ticket number** | Provisional — next after TASK-535; confirm before merge |

## Requirement Analysis

Hundreds of completed/overlapping tickets have left provenance narration throughout the codebase. Before first release we want source files to present **fresh, clear context** for new development: comments that state constraints and intent, not history. Git history and ticket READMEs own provenance; comments do not.

**In scope:** all hand-written TS/TSX/PY/Prisma sources under `apps/` and `packages/`.
**Out of scope:** `packages/database/src/generated/` (regenerated), `node_modules`, `dist`, `.next`, docs (TASK-537), test fixture data, `.claude/rules`, **`apps/ui-playground`** (deprecated, no maintenance plan — 693 tagged lines with near-zero cleanup ROI, confirmed by Wave 1).

### Keep / delete policy (the bar every comment must clear)

A comment **stays** iff it states something the code cannot show: a constraint, an invariant, a non-obvious why, a safety/PHI note, an external contract, or API documentation (docstrings, Swagger). A comment **goes** if it records where code came from, what the next line does, that a reviewer asked for it, or code that is commented out.

### Protected classes — agents MUST NOT touch

Wave 1 verified the actual footprint; the allowlist reduces to **5 concrete greppable markers**:

| Class | Verified footprint |
|---|---|
| `// AUTH-NOTE(TASK-532):` route markers (mandated by rule 05) | Exactly 2 — `apps/api/src/modules/prompt-management/prompt-template.controller.ts:80`, `prompt-management.controller.ts:315` |
| Retired-route redirect pages incl. release-removal comments (rule 13) | 2 pages — admin-console `prompt-studio`, `pstudio` — excluded in their entirety |
| `eslint-disable*` **with** trailing justification; `@ts-expect-error` / `# noqa` / `# type: ignore` **with** reason text | keep suppression + reason together |
| License headers / top-of-file legal blocks | verify presence per package before Wave 2 |
| Python docstrings that are genuine API docs | e.g. `apps/guardrail/src/guardrail/core/tenant_config.py` module docstring — substantive architecture doc despite TASK ids |

Dropped from the original spec (zero live instances, don't build tooling for them): `@allowedDirectPrisma` (0 in code — policy-only escape hatch) and Prisma `///` doc comments (0 — the schema uses plain `//`: 1,452 lines, 116 TASK-tagged, which get normal category triage like TS code, **not** a syntax exemption).

### Debt taxonomy (drives agent decisions)

(a) ticket-provenance narration — delete; (b) review-artifact comments — **effectively absent** (2 instances repo-wide, both in excluded ui-playground) — no tooling; (c) commented-out code — **very low** (~10 genuine instances) — handle opportunistically during (a)/(g) passes; (d) stale/misleading comments — fix or delete; (e) redundant what-comments (~84 heuristic hits) — delete, spot-checking that none serve as section headings over multi-line logic; (f) live TODO/FIXME — harvest into backlog, never silently delete; (g) constraint comments carrying a ticket id — keep, optionally strip the id if the constraint stands alone.

## Current State Evaluation — Wave-1 inventory findings (2026-07-21, workflow `wf_e0632a48-a69`)

**Metrics (verified):** 6,515 TS/TSX/PY files; **9,913** TASK-tagged comment lines; 90 TODO/FIXME/HACK. Concentration: `packages/applications` 2,710 · `apps/api` 1,743 · `packages/agentic-sdk-v2` 1,392 · `apps/ui-playground` 693 (excluded) · `apps/stt-v2` 609 · `packages/domains` 586 · `packages/database` 525 · `apps/harness` 497 · `apps/admin-console` 417 · remaining surfaces ≤ 110 each.

**Findings that reshape the plan:**
1. **No blanket regex delete — ever.** Categories (a) and (g) are interleaved line-by-line inside the same functions (verified: `packages/applications/src/authorization/authorization.guard.ts:94-99` — pure narration 3 lines above load-bearing TASK-302/301 deny-by-default security rationale; same pattern in `paginatedQueryParamConverters.ts` and guardrail `tenant_config.py`). Every TASK-tagged comment needs per-comment classification.
2. **Mechanical quick win (P0):** 72 literal `// TODO: Implement this` lines are dead scaffold-generator boilerplate above fully-implemented files across `packages/applications/src/services/**` (verified: `tag.service.ts` is 195 lines of complete CRUD under one). Category (d) masquerading as (f). Bulk-delete, zero risk.
3. **3 genuine live TODOs — 2 are security/compliance findings:** `packages/applications/src/services/auth/auth.service.ts:63` — `isTokenRevoked()` always returns `false` (no revocation check implemented); `:108` — no persisted HIPAA-compliance audit tracking. **Must be ticketed before cleanup lands; never deleted or "resolved" as narration.**
4. **Adjacent, out of scope (separate ticket candidate):** 827 bare `eslint-disable-next-line` comments with no justification (431 applications, 121 api, 98 domains; 804 outside vendored registries) — lint-hygiene debt, not provenance debt.
5. Branch `fix/2605-review` still carries **185 uncommitted paths** — see Blockers.

## Blockers

**B1 — dirty working tree.** 185 uncommitted paths mean a sweep would entangle cleanup diffs with unlanded feature work, and worktree-based agents would miss/conflict with it. **Waves 2+ must not start until `fix/2605-review` is committed/landed** (this is also OD-7 in the SOTA-Track program plan and step 1 of TASK-539's cycle-1 order). Owner action.

## Implementation Plan

### Wave 0 — Baseline ✅ CLEARED (2026-07-21)
Baseline SHA: **`c6c44de2`** (checkpoint commit landing the TASK-505/506/523–535 wave + program docs). The auth.service.ts security TODOs were routed to **TASK-541** (implemented, status Review) before cleanup; the eslint-suppression debt became **TASK-540**.

### Wave 1 — Inventory ✅ COMPLETE (2026-07-21)
Findings above; full agent report in workflow `wf_e0632a48-a69` output.

### Wave 2 — Per-package cleanup (Sonnet 5, effort high) — batch 1 IN PROGRESS (workflow `wf_81525326-b65`)
Batch 1 (running): scope units 1–2 below (applications quick-win + api pilot), executed sequentially in the main tree off the clean `c6c44de2` baseline (worktree isolation dropped for batch 1 — single writer per lane on a clean tree; revisit for parallel batches). Ordering per Wave-1 recommendation:
1. **`packages/applications`** — opens with the 72-line scaffold-TODO bulk delete (fast, zero-risk win), then the 2,710-line classification pass.
2. **`apps/api`** — pilots the protected-marker allowlist on the smallest AUTH-NOTE footprint (2 markers).
3. **`packages/domains`, `packages/database`** — schema + seed comments; moderate density, mostly single-author narration; Prisma `//` comments triaged like code comments.
4. **`packages/agentic-sdk-v2`** — 1,392 lines, dense but well-organized per-hook/per-type.
5. **Python apps** — `apps/{stt-v2,harness,smr,guardrail,nlp,tts-v2}`; verify docstrings are genuine API docs before touching (tenant_config.py precedent).
6. **`apps/admin-console`, `packages/ui`, remaining small packages** — admin-console explicitly excludes the two redirect pages.

Mechanics: one agent per scope unit, `isolation: worktree` (pre-instructed to `git reset --hard <baseline>` — worktrees base off `main` by default), batches of ≤8 concurrent.

**Agent contract (verbatim in every prompt):**
1. Comment-only diffs. Zero changes to executable code, strings, or formatting outside comment lines.
2. Apply the keep/delete policy, taxonomy, and 5-marker allowlist above (embedded in the prompt).
3. Category (d) fixes: rewrite the comment to match the code — never "fix" the code.
4. Category (f): copy every live TODO/FIXME (file:line + text + subsystem) into the report; do not delete unless provably done (the 72 scaffold lines are pre-classified as provably-dead).
5. When uncertain, KEEP and flag. Deletion bias applies to provenance narration only.
6. Verify: `pnpm --filter <pkg> build lint test` (or `py:<svc>:test`/`lint` lanes) green before reporting.
7. Report: files touched, removed/rewritten/kept-flagged counts, TODO harvest, verification output.

### Wave 3 — Verification & review
1. **Comment-only proof** per scope unit: strip comments from before/after trees; code diff must be empty.
2. Full affected suites: `pnpm turbo lint`, `pnpm test:unit`, `py:<svc>:test` for touched Python apps, `pnpm build:api`, admin-console build.
3. Reviewer agent (sonnet high) samples ≥10% of deletions per unit for false positives (constraint deleted as narration).
4. Protected-marker greps unchanged before/after (`AUTH-NOTE(` = 2; redirect pages untouched).
5. Land as one MR per surface group (backend TS / frontend / python / SDK-and-libs).

### Wave 4 — TODO backlog
`docs/backlog/todo-harvest-2026-07.md`: all harvested TODOs grouped by subsystem with dispositions. Seeded already with: auth token-revocation + HIPAA audit tracking (→ dedicated security ticket), plus the 827-bare-eslint-disable lint-hygiene candidate ticket.

### Verification criteria (definition of done)
- [ ] Comment-only proof passes for every scope unit
- [ ] All package builds/lints/tests green; `pnpm turbo lint` no new warnings
- [ ] Protected-marker grep counts unchanged
- [ ] TODO harvest doc exists; auth security TODOs ticketed; no TODO silently deleted
- [ ] Reviewer sample ≥ 98% precision on deletions; flagged cases human-resolved

### Risks
| Risk | Mitigation |
|---|---|
| Constraint comment deleted as narration | Per-comment classification (no regex deletes); keep-when-uncertain; 10% sample review; marker greps |
| Docstring/API-doc loss in Python | Docstrings protected; only narration inside them may be trimmed |
| Merge conflicts with in-flight work | Wave-0 gate; worktree isolation; per-surface MRs landed quickly |
| Security TODOs vanish in the sweep | Pre-ticketed in Wave 0; Wave 4 cross-check |

## Implementation Summary

**Batch 1 ✅ (2026-07-21, workflow `wf_81525326-b65`):**
- **Quick win complete:** all 72 `// TODO: Implement this` scaffold lines deleted across 72 files in `packages/applications` — each individually verified implemented first; `git diff` proof: 144 deletions, **0 additions**. Build green; 6,669 tests passed. The auth.service.ts TODOs were already replaced by TASK-541's implementation (nothing to harvest).
- **apps/api pilot: 30 of 308 files done** (291 of 1,433 tagged lines; the highest-density production files: stt-ws.gateway, auth.controller, app.module, smr-proxy/transcription-job controllers, bootstrap/common/database/decorators clusters). Methodology validated: per-comment classification, ticket-prefix stripping with substance preserved, 1 stale comment rewritten, 3 lines commented-out dead code removed opportunistically, zero string/Swagger/test-description edits (one near-miss caught and self-reverted). Verification: `pnpm build:api` green · 2,394 api tests passed · eslint 0 errors (65 pre-existing bare-disable warnings = TASK-540 debt) · scripted comment-stripped before/after diff proves code-invariance on all 30 files. **Remaining: 278 files / 1,142 tagged lines** — density-ordered continuation list captured in the batch report (user.controller 26, prompt-management 20+18, consultation.controller 20, …).

## Change History

- 2026-07-21 — Ticket created; Wave-1 inventory launched.
- 2026-07-21 — Wave 1 complete (4-agent workflow `wf_e0632a48-a69`). Plan updated: ui-playground excluded; allowlist reduced to 5 real markers; scaffold-TODO quick win added; auth security TODOs flagged for pre-ticketing; categories (b)/(c) demoted to opportunistic handling.
- 2026-07-21 — Finding 3 ticketed: **TASK-541** (`docs/implementation/TASK-541-Auth-Token-Revocation-HIPAA-Audit/README.md`) now owns the two `auth.service.ts` security TODOs (`:63` revocation stub, `:108` HIPAA audit). Wave 4 must not touch those two comments until TASK-541 A1/B2 land (they are resolved there, not deleted).
- 2026-07-21 — **Finding 3 CLOSED — Wave 4 is unblocked for `auth.service.ts`.** TASK-541 landed A1 + B2: the revocation stub now delegates to `IJwtRevocationService` and the HIPAA TODO is replaced by a docblock naming `AuditLogService.handleUserAuthenticatedEvent` as the persistence authority. Verified: `grep TODO packages/applications/src/services/auth/auth.service.ts` returns no live TODO, and neither original TODO string exists anywhere in the repo. Both were **resolved in code, not deleted as narration** — the rule finding 3 was written to protect. Note TASK-541 also REMOVED `isTokenRevoked()`/`validateUser()` from `IAuthService` (dead after the `gateway-jwt` retirement), so Wave 4 will find a smaller surface there than the Wave 1 inventory recorded.

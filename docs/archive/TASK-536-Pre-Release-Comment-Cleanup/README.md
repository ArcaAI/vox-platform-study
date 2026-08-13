# TASK-536 — Pre-Release Comment Cleanup

| | |
|---|---|
| **Status** | Review — ALL waves + Directive-v2 exit gate PASSED 2026-07-21/22 (see Implementation Summary) |
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

### OWNER DIRECTIVE v2 (2026-07-21) — SUPERSEDES the softer id rules used in batches 1–3

1. **Zero ticket numbers in comments and notes.** Every `TASK-xxx`, `BUG-xxx`, and review-artifact identifier (`AC-n`, `D-nn`, `M-nn`, `OD-n`, `GAP-*`, `Phase n`/`Wave n`-style provenance) is removed from every comment in every language — including Prisma schema/seed comments and doc-path pointers whose only content is a ticket folder. The earlier allowances ("keep the id when the constraint carries it", "doc-path pointers are fine") are REVOKED.
2. **Content review, not just deletion:** each surviving comment is condensed and checked for accuracy and coherence against the implemented code — after id removal the sentence must fully stand alone; stale or contradicting text is rewritten to match the code.
3. **Marker migration:** `// AUTH-NOTE(TASK-532):` → `// AUTH-NOTE:` (marker stays mandatory; rule 05 updated 2026-07-21; both call sites migrated).
4. **Swagger/API description strings** (`@ApiOperation`/`@ApiProperty` summaries etc.) are user-facing notes — ticket ids come out of them too (with test verification, since some suites assert doc strings).
5. **Explicitly out of scope for now** (executable identifiers / traceability anchors; separate owner-approved wave if desired): `describe()`/`it()` test-title strings, spec FILE names (`task-307-*.spec.ts` — cited by the traceability matrix), request-payload data strings, thrown-error messages. **UPDATE 2026-07-22 (Directive v2 rule 5 exclusion lifted):** the owner lifted the exclusion for spec FILE names and `describe()`/`it()`/`test()` title strings — both are now IN scope for de-ticketing (titles must remain descriptive and unique within their file). Request-payload/fixture data strings, thrown-error/log message strings, and CLI descriptions remain OUT of scope. Executed the same day: all `task-XXX-*.spec.ts`/`BUG-XXX-*.spec.ts` files under `apps/api/tests/e2e/` renamed to descriptive, id-free names (see TASK-534 §10 Change History for the full rename map and the `task-524-config-plane.spec.ts` 3-way split), with every doc/config reference to the old filenames updated across `docs/traceability-matrix.md`, `docs/traceability/*.md`, and the TASK-524/526/531/534/541 implementation READMEs.

Exit gate is measurable: a comment/API-doc-string scan for `TASK-[0-9]+|BUG-[0-9]+` over `apps/` + `packages/` returns **zero** outside the out-of-scope classes (and excluded dirs: generated, migrations, ui-playground).

6. **Knowledge preservation (owner directive 2026-07-21):** condensing a comment must never orphan engineering knowledge. Comments keep the local constraint; the deeper rationale, cross-cutting contract, or operational detail must exist in the authoritative doc set (architecture docs, `development-patterns-and-standards.md`, per-surface README, traceability). Every cleanup agent reports substantive content it condensed/removed; TASK-537's **C7 knowledge-absorption pass** mines those reports plus the ticket-README corpus and writes anything load-bearing into the reference docs. A comment may only shrink because the knowledge lives somewhere better — never because it vanished.

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

**Metrics (verified):** 6,515 TS/TSX/PY files; **9,913** TASK-tagged comment lines; 90 TODO/FIXME/HACK. Concentration: `packages/applications` 2,710 · `apps/api` 1,743 · `packages/agentic-sdk-v2` 1,392 · `apps/ui-playground` 693 (excluded) · `apps/stt` 609 · `packages/domains` 586 · `packages/database` 525 · `apps/harness` 497 · `apps/admin-console` 417 · remaining surfaces ≤ 110 each.

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
5. **Python apps** — `apps/{stt,harness,smr,guardrail,nlp,tts}`; verify docstrings are genuine API docs before touching (tenant_config.py precedent).
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
2. Full affected suites: `pnpm turbo lint`, `pnpm test:unit`, `py:<svc>:test` for touched Python apps, `pnpm api:build`, admin-console build.
3. Reviewer agent (sonnet high) samples ≥10% of deletions per unit for false positives (constraint deleted as narration).
4. Protected-marker greps unchanged before/after (`AUTH-NOTE(` = 2; redirect pages untouched).
5. Land as one MR per surface group (backend TS / frontend / python / SDK-and-libs).

### Wave 4 — TODO backlog
`docs/backlog/2026-07-21-TODO-HARVEST.md`: all harvested TODOs grouped by subsystem with dispositions. Seeded already with: auth token-revocation + HIPAA audit tracking (→ dedicated security ticket), plus the 827-bare-eslint-disable lint-hygiene candidate ticket.

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
- **apps/api pilot: 30 of 308 files done** (291 of 1,433 tagged lines; the highest-density production files: stt-ws.gateway, auth.controller, app.module, smr-proxy/transcription-job controllers, bootstrap/common/database/decorators clusters). Methodology validated: per-comment classification, ticket-prefix stripping with substance preserved, 1 stale comment rewritten, 3 lines commented-out dead code removed opportunistically, zero string/Swagger/test-description edits (one near-miss caught and self-reverted). Verification: `pnpm api:build` green · 2,394 api tests passed · eslint 0 errors (65 pre-existing bare-disable warnings = TASK-540 debt) · scripted comment-stripped before/after diff proves code-invariance on all 30 files. **Remaining: 278 files / 1,142 tagged lines** — density-ordered continuation list captured in the batch report (user.controller 26, prompt-management 20+18, consultation.controller 20, …).

**Batch 2 ✅ (2026-07-21, workflow `wf_2d341eb7-eab`):**
- **apps/api COMPLETE**: 3 chunk agents finished the remaining tree (343 changed files total across batches). Verifier evidence: build 8/8 green · 2,397 api tests green · eslint 0 errors / 65 pre-existing warnings · **AST-based comment-only proof 343/343 files code-identical** (naive text-strip scripts false-positive on template literals — the AST parse+print method is now the standard for Wave-3 proofs) · AUTH-NOTE markers = 2, byte-identical. Remaining `TASK-` hits in apps/api are exclusively string literals (Swagger/test titles/payloads), the 2 protected markers, and verified doc-path pointers — zero cleanable comments left.
- **packages/domains COMPLETE**: 523 comment lines individually classified — the surface is dominated by legitimate constraint/tenancy documentation (kept by design); build + 1,373 tests green; **`generate-data-entity:check` and factory check GREEN with schema coverage OK** (also closes finding F-019). 2 live TODOs harvested.
- **packages/database COMPLETE**: surface confirmed already-clean (schema/seed comments are constraint documentation); 2 small .prisma comment edits; `generate-data-model:check` no-drift · 853 tests · build green.
- Follow-ups: the contradictory elevated-tier comment in `admin-impersonation.controller.ts:34` fixed post-batch (SUPER_ADMIN retired per TASK-417); TODO harvest doc created at `docs/backlog/2026-07-21-TODO-HARVEST.md` (3 live TODOs). One conservative call recorded: the section-heading comment adjacent to the prompt-template AUTH-NOTE marker was left untouched.
- **Remaining scope (batch 3, running):** `packages/agentic-sdk-v2` (1,392 lines), Python apps (`stt` 609, `harness` 497, `tts` 90, `smr`/`nlp`/`guardrail` 84 each), `apps/admin-console` (417), `packages/ui` (107), small packages; then Wave-3 program-level verification and Wave-4 harvest finalization.
- **`apps/stt` COMPLETE (batch 3, 2026-07-21):** all 609 TASK-tagged lines (369 `src/`+`scripts/`, 240 `tests/`) individually classified. Finding: this surface is a dense, technically-loaded ASR/streaming implementation where essentially every TASK-tagged comment states a genuine constraint, design-decision rationale, or PHI/tenancy invariant (same "kept by design" pattern as the `packages/domains`/`packages/database` batch-2 finding) — no narration-only or stale comments, no commented-out code, and no bare/redundant TASK-only "what" comments were found among the 609 lines reviewed. The one edit applied: 16 single-line docstrings across 10 files where the `TASK-XXX [sub-id] — ` prefix was a pure provenance label in front of an already self-contained sentence (e.g. `"""TASK-507 — an unrecognized denoise engine is a hard validation error."""` → `"""An unrecognized denoise engine is a hard validation error."""`); every other TASK-tagged comment in the surface carries substantive constraint content (decision letters D1-D6, phase numbers P0-P5, review findings B-04/B-05/C2-0x, or a `docs/implementation/TASK-xxx-.../README.md` pointer) and was left untouched. 1 live TODO harvested (`session_manager.py:3130`, crash-recovery VAD warm-up — harmless deferral, not a defect). No protected-marker instances in this surface (no AUTH-NOTE, no redirect pages). Verification: AST-based comment-only proof (docstrings masked before comparison, since edits are inside docstrings not `#` comments) — 10/10 files structurally identical outside the one intended docstring edit per file; `ruff check` 0 errors; `pytest apps/stt/tests/unit/` 2455 passed, 1 pre-existing skip (pyannote not installed), 0 failures; `black --check` on the 10 touched files shows 7 pre-existing (unrelated to this change — confirmed present at HEAD before editing, all in code far from the touched docstring lines) reformat candidates — this is pre-existing formatting debt in the surface, not introduced by this batch, and out of scope for a comment-only diff.
- **Batch 4 + EXIT GATE ✅ PASSED (2026-07-21/22, workflow `wf_27e35833-f0a`):** six parallel sweep agents completed the Directive-v2 pass (applications ×2 incl. sanctioned Swagger-string edits in 10 DTO files with confined-diff proof; apps/api Swagger strings; stt docstrings; database/domains/SDK; python+frontend residuals). Content-review rule applied for real — stale claims rewritten, e.g. "encryption-at-rest still unwired" (it is wired, per the file's own tests), "metering lands in Phase 2" (implemented), "no enforcement" (kill-switched enforcement exists). The gate agent then built reproducible comment-aware scanners (TS AST + Swagger decorator args · Python tokenize + docstrings + doc-kwargs · Prisma `//`) over 5,237 TS + 790 PY + 31 prisma files, fixed the last ~150 violation lines across 75 files itself, and attested the **final scan: TS = 5 hits, all inside the 2 protected redirect pages · Python = 1 hit, a protected CLI description · Prisma = 0 — zero violations**. A raw-grep cross-check confirmed the remaining `TASK-` text repo-wide is exclusively protected string classes (test titles, log/fixture/payload strings). Verification, all green: applications 6,678 · api 2,397 + build 8/8 · database 853 · domains 1,373 · vox 3,540 + med-ner/vad/room/stt/noise-filter/pipeline builds+tests · admin-console build + 1,112 · py: nlp 173, guardrail 172, smr 947 ×2, tts 178, harness 957.
- **`apps/admin-console` + `packages/ui` COMPLETE (batch 4 sub-scope, 2026-07-21):** Directive-v2 pass over both surfaces (the two retired-route redirect pages excluded in their entirety, per rule 13). AST-based comment discovery (TS scanner over the full parser output — a naive regex/scanner pass silently desyncs on JSX text containing apostrophes and undercounted by ~26%) found 380 real comments in admin-console and 61 in `packages/ui`, all individually classified and, where kept, de-ticketed and condensed per rule 2 (ticket ids and review-artifact sub-refs — `M-nn`, `D-nn`, `B-n`, `E3-Ln`, `Δn`, `§n`, `Phase n`, `PHASE-2-PLAN §n`, `TASK-nnn/nnn` shared-prefix shorthand — stripped; surviving sentences rewritten to stand alone; Figma `frame N`/`matrix row N` references kept per existing precedent). No narration-only deletions, no commented-out code, and no live TODOs found in either surface. Verification: `pnpm --filter @arcaai/admin-console build lint test` (build green, 1112/1112 tests, eslint 0 errors) and `pnpm --filter @arcaai/ui build lint test` (build green, 656/656 tests, eslint 0 errors); AST parse+print-with-`removeComments` proof shows all 238 (admin-console) + 43 (`packages/ui`) changed files code-identical to HEAD outside comments. Remaining `TASK-`/`BUG-` hits in both surfaces are exclusively `describe()`/`it()` test-title strings and 3 rendered-JSX-copy strings (`db-studio-screen.tsx`, `impersonation-gate-panel.tsx`, `transcription-jobs-screen.tsx`) — out of scope per rule 5 (string literals) — zero cleanable comments left. No `AUTH-NOTE` markers exist in either surface (confirmed 0 before and after).
- **`apps/stt` Directive-v2 completion COMPLETE (batch 4 sub-scope, 2026-07-21):** the batch-3 pass had left ~593 lines under the superseded "keep the id when the constraint carries it" allowance; this pass revoked that allowance and removed every remaining ticket/review-artifact identifier (`TASK-nnn`, decision letters `D1-D6`, phase labels `P0-P5`/`Phase N`, review findings `AC-n`/`M-n`/`OD-n`/`B-nn`/`C-n`/`I-n`/`MIN-n`/`TG-n`/`H-n`/`C2-0x` etc.) from 37 files (36 test files + 1 shared integration helper), condensing each surviving sentence to stand alone. Two class names (`TestTask505ReviewFixes`, `TestP1ReviewFixes`) were left untouched — they are Python identifiers, not comments, and renaming them would be an executable-code change outside a comment-only diff; their docstrings were still de-ticketed. Left deliberately untouched (all non-comment string-literal classes, confirmed by re-reading each production/test pairing): 2 thrown-error messages naming a doc path (`semantic_endpointer.py`, `streaming_sortformer.py`) plus the 2 test assertions that check for their exact text; 1 assertion message string (`test_streaming_integration.py`, pre-existing from batch 3); 4 JSON-report data literals (`"harness": "TASK-... "` fields in the 3 quality/latency/loss harnesses); 2 `print()` log-style outputs in `benchmark_pipelines.py`; 1 YAML fixture string embedded in `test_yaml_parser.py`. No Swagger/FastAPI description strings carry ticket ids in this surface (none found). No live TODOs found beyond the one already harvested in batch 3. Verification: `ruff check apps/stt/src/ apps/stt/tests/` 0 errors; `pytest apps/stt/tests/unit/` 2455 passed/1 pre-existing skip; `pytest apps/stt/tests/integration/` 45 passed/3 pre-existing live-service skips; full `pnpm stt:test` 2702 passed/38 skipped/3 xfailed, all pre-existing env-gated reasons, 0 failures; a tokenize-based comment-only proof (COMMENT and STRING tokens blanked, all other tokens compared verbatim) shows all 37 touched files code-identical to HEAD outside comments/docstrings, with the 34 files carrying docstring edits individually diff-reviewed. Exit-gate grep for `TASK-[0-9]+|BUG-[0-9]+` over `apps/stt` now returns exactly 12 hits, all in the protected string-literal classes listed above — zero cleanable comments/docstrings remain.

## Change History

- 2026-07-21 — Ticket created; Wave-1 inventory launched.
- 2026-07-21 — Wave 1 complete (4-agent workflow `wf_e0632a48-a69`). Plan updated: ui-playground excluded; allowlist reduced to 5 real markers; scaffold-TODO quick win added; auth security TODOs flagged for pre-ticketing; categories (b)/(c) demoted to opportunistic handling.
- 2026-07-21 — Finding 3 ticketed: **TASK-541** (`docs/implementation/TASK-541-Auth-Token-Revocation-HIPAA-Audit/README.md`) now owns the two `auth.service.ts` security TODOs (`:63` revocation stub, `:108` HIPAA audit). Wave 4 must not touch those two comments until TASK-541 A1/B2 land (they are resolved there, not deleted).
- 2026-07-21 — **Finding 3 CLOSED — Wave 4 is unblocked for `auth.service.ts`.** TASK-541 landed A1 + B2: the revocation stub now delegates to `IJwtRevocationService` and the HIPAA TODO is replaced by a docblock naming `AuditLogService.handleUserAuthenticatedEvent` as the persistence authority. Verified: `grep TODO packages/applications/src/services/auth/auth.service.ts` returns no live TODO, and neither original TODO string exists anywhere in the repo. Both were **resolved in code, not deleted as narration** — the rule finding 3 was written to protect. Note TASK-541 also REMOVED `isTokenRevoked()`/`validateUser()` from `IAuthService` (dead after the `gateway-jwt` retirement), so Wave 4 will find a smaller surface there than the Wave 1 inventory recorded.
- 2026-07-21 — **`apps/stt` cleanup complete (batch 3 sub-scope).** All 609 tagged lines classified; 16 bare ticket-id-prefix docstring edits applied across 10 files (comment-only, AST-proven); 1 live TODO harvested to `docs/backlog/2026-07-21-TODO-HARVEST.md` (#4); 2455 unit tests + ruff clean; pre-existing (not introduced) black-formatting debt noted in 7 of the touched files.
- 2026-07-21 — **`apps/admin-console` + `packages/ui` cleanup complete (batch 4 sub-scope).** 441 comments de-ticketed/condensed across 281 files (238 + 43); build/lint/test green on both packages (1112 + 656 tests); AST comment-only proof 281/281 files; no live TODOs found; retired-route redirect pages untouched.
- 2026-07-21 — **`apps/stt` Directive-v2 completion (batch 4 sub-scope).** Removed all remaining ticket/review-artifact ids from 37 files (comments + docstrings only), superseding the batch-3 "keep the id" allowance; tokenize-based comment-only proof 37/37 files code-identical to HEAD outside comments; full test suite 2702 passed/38 skipped/3 xfailed (all pre-existing); ruff clean; exit-gate grep returns 12 hits, all protected string-literal classes (thrown-error messages, report-data literals, an assertion string, a YAML fixture, and print/log output) — no cleanable comments remain in this surface.
- 2026-07-22 — **Directive v2 rule 5 exclusion lifted (owner directive) and executed: spec filenames + test titles de-ticketed.** All 50 ticket-numbered `apps/api/tests/e2e/*.spec.ts` files renamed to descriptive, id-free names (`task-524-config-plane.spec.ts` split 3-way into `ai-provider-connections.spec.ts` / `ai-runtime-profiles.spec.ts` / `settings-registry-write.spec.ts`; full map in TASK-534 §10). Every documentation/config reference to the old filenames was updated: `docs/traceability-matrix.md`, all 10 affected `docs/traceability/*.md` domain files (re-stamped `Last verified: 2026-07-22`), and the TASK-524/526/531/534/541 implementation READMEs. `describe()`/`it()`/`test()` title de-ticketing (inside the renamed spec files themselves) is tracked as a separate code-editing pass, not part of this doc-only reference-update wave. Request-payload/fixture data strings, thrown-error/log message strings, and CLI descriptions remain untouched per the still-standing part of rule 5.

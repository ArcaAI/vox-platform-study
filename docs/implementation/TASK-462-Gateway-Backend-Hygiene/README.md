# TASK-462 — Gateway + Backend Hygiene (C4-05 · C2-04 · C5-03 interim decision)

- **Status**: Review
- **Type**: bugfix (security-hardening + correctness) + docs/decision
- **Decision (manifest purity)**: **Option B** — all three findings kept in this one grab-bag hygiene ticket (they are file-disjoint and low-risk); TS and Python gates run separately (per the orchestrator's instruction to keep them together).
- **Branch (built)**: `fix/task-462-backend-hygiene` (from `fix/2605-review` HEAD `87b33f57`).
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 3 (P2)
- **Findings**: C4-05 (Low, security-tenancy — PHI/prompt echo) · C2-04 (Low, correctness — no-op control) · C5-03 (Med, doc-drift — **INTERIM decision only**) — all CONFIRMED — see [TASK-448 register](../TASK-448-Harness-Loop-Quality-Review/README.md)
- **Branch (when scheduled)**: `fix/task-462-gateway-backend-hygiene` (from the current `fix/2605-review` HEAD)
- **Size**: S–M
- **Suggested agent**: general-purpose (gateway TS + STT Python; a security lens on C4-05 for review)

## ⚠️ Manifest-purity decision — C2-04 is Python/STT, the rest is TS/decision (resolve before assigning)

This ticket as written spans **three surfaces in two languages**: C4-05 in `apps/api` (NestJS/TS), C2-04 in `apps/stt-v2` (FastAPI/Python), and C5-03 as a Prisma-comment + `packages/applications` guard (TS) + decision text. Each finding is **independently mergeable** — they share no file. The orchestrator should decide up front:

- **Option A (recommended for manifest purity)**: split **C2-04** into its own tiny Python ticket (or fold it into a future `apps/stt-v2` control-frame ticket — note it is adjacent to the [TASK-467](../TASK-467-STT-WS-Control-Frame-Classification/README.md) control-frame work) so one agent = one language. TASK-462 then = C4-05 + C5-03 only.
- **Option B**: keep all three here as a grab-bag hygiene ticket; the implementing agent runs the TS and Python gates separately. Acceptable because the three are file-disjoint and low-risk.

The scaffold below documents all three; **pick A or B before assigning** and prune the manifest accordingly.

## File-ownership manifest (exclusive — binding)

| File | Change | Finding |
|---|---|---|
| `apps/api/src/modules/streaming/smr-proxy.controller.ts` | `buildUpstreamException` returns a GENERIC sanitized client message; the raw upstream detail is logged server-side only | C4-05 |
| `apps/api/src/modules/streaming/__tests__/smr-proxy.controller.test.ts` | RED-first: assert the client-facing exception carries no upstream body; assert the detail is logged | C4-05 |
| `apps/stt-v2/src/stt_v2/streaming/session_manager.py` | Implement PAUSE/RESUME, OR reject PAUSE with a clear typed error instead of a silent no-op log | C2-04 |
| `apps/stt-v2/tests/unit/test_streaming.py` (or the nearest control-frame unit test) | RED-first: assert PAUSE is honored or explicitly rejected (not a swallowed log) | C2-04 |
| `packages/database/src/prisma/db_main/consultation.prisma` | `//`-comment annotation on the five ontology columns: "populated by SOTA Theme C (clinical NER linker) — see SOTA-Track"; **comment-only, NO migration, NO `db:generate`** | C5-03 |
| `packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts` | Groundedness guard: skip/annotate the coded-list assembly when all ontology codes are empty (the current always-true case) so it doesn't silently emit an empty "codes:" block | C5-03 |
| `packages/applications/src/services/consultation/prompt/__tests__/*` | RED-first: empty-codes input → guard engages (no misleading coded output) | C5-03 |

STOP-and-report before touching: the NLP/harness **readers** `harness-internal.service.ts` / `summary.processor.ts` beyond a read-only trace (their code pass-through is fine as-is), any Prisma **migration** (this is a comment-only schema edit), the SMR retry/idempotency logic ([TASK-460](../TASK-460-Gateway-Auth-Retry-Hygiene/README.md) territory / [TASK-469](../TASK-469-SMR-Idempotency/README.md)), or a barrel/`turbo.json`. Anything outside the manifest → STOP.

## Requirement Analysis

Three residual hygiene findings deferred from the earlier waves. Two are genuine low-severity code fixes; the third (C5-03) is scoped here to a **decision + guardrail only** — the real fix is a SOTA-track deliverable, not this ticket.

### C4-05 (Low, security-flavored) — SMR proxy forwards the raw upstream error body verbatim → prompt/PHI echo
`buildUpstreamException` ([smr-proxy.controller.ts:223-239](apps/api/src/modules/streaming/smr-proxy.controller.ts)) rethrows the upstream failure by wrapping the raw upstream body straight through to the client: `new HttpException({ detail: payload }, status)` (:230, string payload) and `new HttpException(payload, status)` (:233, object payload). Since the SMR `/generate` request body carries the assembled clinical **prompt** (and SMR/LM-Studio error bodies can echo request content or internal detail), an upstream 4xx/5xx can land **prompt fragments / PHI / internal stack detail into the caller's telemetry**. This is the same class as the reviewed-good fail-closed posture elsewhere — the proxy should return a **generic** sanitized message to the client and keep the upstream detail **server-side only** (structured log at the gateway). Only the `fallbackMessage` path (:235, :238) is already safe; the two verbatim-forward branches are the leak.

### C2-04 (Low, correctness) — PAUSE/RESUME are silent no-op logs
The control-frame handler ([session_manager.py:1775-1780](apps/stt-v2/src/stt_v2/streaming/session_manager.py)) matches `ControlAction.PAUSE` / `ControlAction.RESUME` and only logs `"Control action received (not yet implemented)"` (:1776-1780), then returns — the frame is silently swallowed. The register **downgraded this to Low** because no current client emits a backend PAUSE (the SDK `pause()` halts audio at the source and only `finalize`/`cancel` reach here), so the harm is **latent, not active**. Fix: either implement PAUSE/RESUME (suspend/resume consumption + the idle/reaper clock) OR reject PAUSE with a clear typed error/close-code so a future client that sends it fails loudly instead of assuming it worked. Rejecting-loudly is the simplest correct option given no client needs the feature yet.

### C5-03 (Med, doc-drift) — ontology columns are READ everywhere but WRITTEN nowhere → **scope here = interim decision + guard only**
The `NamedEntity` ontology columns `umlsCui`/`snomedCode`/`rxnormCode`/`icdCode`/`loincCode` ([consultation.prisma:314-318](packages/database/src/prisma/db_main/consultation.prisma)) are **read** by three durable-path consumers — prompt assembly ([prompt-assembly.service.ts:45-49](packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts) builds `umls:…/snomed:…/rxnorm:…` code strings into the harness prompt), harness-internal ([harness-internal.service.ts:739-743](packages/applications/src/services/consultation/harness/harness-internal.service.ts)), and the summary processor ([summary.processor.ts:320-324](packages/applications/src/services/consultation/jobs/processors/summary.processor.ts)) — but **no path writes them**: the NLP token classifier emits no codes (no linker), the generated `NamedEntityFactory`/mapper expose the fields but nothing populates them, and a repo-wide writer search returns only the "these coded fields are NOT encrypted" comment in `phi-read-decrypt.ts`. So the coded-list logic runs on **permanently empty codes** today.

**This ticket does NOT implement the linker.** The real writer — a server-side clinical NER + ontology linker that populates these columns — is **SOTA Theme C** ([SOTA-Track](../SOTA-Track/README.md), candidate TASK-476). TASK-462's C5-03 scope is the **interim** only:
1. Annotate the columns (`//` comment) so the next reader knows the fields are populated by SOTA Theme C, not orphaned.
2. Add a **groundedness guard** so the coded-list assembly doesn't silently run on empty codes (today it produces an empty/no-op "codes:" contribution that reads as if coding was attempted). The guard makes "no codes present" explicit rather than silent.

### Acceptance criteria

- [ ] **C4-05 (red first)**: a test drives an upstream error with a body containing prompt/PHI-shaped text and asserts the client-facing `HttpException` does NOT contain it (only a generic message), AND that the upstream detail is logged server-side. Then sanitize `buildUpstreamException`'s two verbatim-forward branches. No prompt/PHI/internal detail reaches the client.
- [ ] **C2-04 (red first)**: a test sends a PAUSE control frame and asserts it is either honored (consumption suspended) OR rejected with a clear error/close-code — NOT a swallowed log. Then implement the chosen behavior (reject-loudly is acceptable and simplest). Document which was chosen and why.
- [ ] **C5-03 (interim — red first on the guard)**: a test with all-empty ontology codes asserts the coded-list assembly does not emit a misleading empty codes block (guard engaged). Then add the guard + the `//` column annotations. **No linker, no migration.** Record in this README that the real writer is SOTA Theme C (TASK-476).
- [ ] **AC-gate (per language)**: `pnpm build:api` + `pnpm test:unit` (smr-proxy) + `pnpm lint` (hard errors in apps/api) green; `pnpm py:stt-v2:test:unit` + `pnpm py:stt-v2:lint` green (if C2-04 kept here); `pnpm --filter @arcaai/applications test` green (C5-03 guard). Output pasted.

### Non-goals

- **The clinical NER/ontology linker itself (the real C5-03 writer)** — SOTA Theme C ([SOTA-Track](../SOTA-Track/README.md), TASK-476). Do not implement it here; do not delete the columns (they are the linker's target).
- SMR retry/idempotency (C4-04 → TASK-460, done; C1-04 SMR idempotency → [TASK-469](../TASK-469-SMR-Idempotency/README.md)).
- The broader guardrail fail-closed / live-output-moderation work (SOTA Theme D).
- Full PAUSE/RESUME product semantics if reject-loudly is chosen for C2-04 — a follow-up can implement real pause when a client needs it.

## Current State Evaluation (code-verified 2026-07-10 against `fix/2605-review`)

- **C4-05**: verbatim forwards at [smr-proxy.controller.ts:230] (`{ detail: payload }`, string) and [:233] (`payload`, object); safe fallback branches at [:235,:238]. The retry/connect-phase logic just above (:203-221, TASK-460) is unrelated — do not touch it.
- **C2-04**: no-op log at [session_manager.py:1775-1780]; `ControlAction` enum has PAUSE/RESUME/FINALIZE/CANCEL; only FINALIZE (:1759-1772) and CANCEL (:1773-1774) are implemented. No production client emits backend PAUSE (register verdict, re-confirmed).
- **C5-03**: columns [consultation.prisma:314-318]; readers [prompt-assembly.service.ts:45-49], [harness-internal.service.ts:739-743], [summary.processor.ts:320-324]; NLP classifier emits none (grep-empty); no writer anywhere (grep-confirmed). The prompt-assembly reader is the one that turns the (always-empty) codes into a prompt string — the natural home for the guard.
- **Test gaps**: `smr-proxy.controller.test.ts` has no error-body-sanitization assertion; no PAUSE-frame test exists; no empty-codes prompt-assembly test.

## Implementation Plan (TDD — strict order)

> Context pack for the implementing agent: this README · TASK-449 §Architecture preamble · `.claude/rules/05-nestjs-api.md` (C4-05 — error mapping, PHI posture) + `.claude/rules/06-python-services.md` (C2-04 — STT control frames) + `.claude/rules/04-application-services.md` + `.claude/rules/02-database-prisma.md` (C5-03 — comment-only schema edit, no migration).

1. RED→GREEN per finding, independent (they share no file). If Option A was chosen, C2-04 moves to its own ticket.
2. C4-05: assert the leak first (client exception carries the body), then sanitize.
3. C2-04: assert the swallow first, then implement/reject.
4. C5-03: assert the empty-codes guard first, then add guard + annotations. Keep it comment-only on the schema — verify no migration is generated.

### Verification gate

```bash
# C4-05
pnpm build:api && pnpm test:unit && pnpm lint
# C2-04 (if kept here)
pnpm py:stt-v2:test:unit && pnpm py:stt-v2:lint
# C5-03
pnpm --filter @arcaai/applications test
```

Adversarial review focus: (a) C4-05 — can ANY upstream-error shape still leak the body to the client? is the detail still available server-side for debugging? (b) C2-04 — is a PAUSE now unambiguous (honored or loudly rejected), with no swallowed frame? (c) C5-03 — does the guard actually prevent misleading empty-codes output WITHOUT suppressing real codes once the linker lands? is the schema edit truly comment-only (no migration diff)? is the SOTA-Theme-C handoff documented? (d) zero diff outside the (pruned) manifest.

## Implementation Summary

All three findings implemented via strict TDD (RED → GREEN), each isolated to its manifest file(s). Zero diff outside the (Option B) manifest — the 7 manifest files are the only source/test/schema changes (plus this README).

### C4-05 — SMR proxy no longer echoes the raw upstream error body (`apps/api`)

- **Fix**: `buildUpstreamException` (`apps/api/src/modules/streaming/smr-proxy.controller.ts`) previously returned `new HttpException({ detail: payload }, status)` (string body) and `new HttpException(payload, status)` (object body) — forwarding the raw upstream body verbatim. Both verbatim-forward branches were removed. It now:
  1. Logs the raw upstream detail **server-side only** (`this.logger.error({ message: 'SMR upstream error detail (server-side only; not forwarded to client)', upstreamStatus, upstreamDetail })`), then
  2. Returns a **generic** `{ detail: fallbackMessage }` to the client, **preserving the status-code mapping** (numeric upstream status passes through; no-response falls back to `502 BAD_GATEWAY`).
- **RED → GREEN**: the pre-existing test `should propagate upstream 404 details from SMR` encoded the leak as expected behaviour — it was rewritten to assert the sanitized posture. Added a `TASK-462 C4-05` describe block: string-body PHI, object-body PHI (+ `error_code`), server-side-logging assertion (spies `Logger.prototype.error` for `upstreamDetail`), and the no-response → 502 fallback. RED = 4 failing (client response contained `prompt fragment: … SSN 123-45-6789` / `LEAK`, no `upstreamDetail` log). GREEN = 77/77 in the file.
- **Adjacent same-class leak flagged (NOT fixed — out of manifest scope)**: `streamTaskEvents` (the SSE path, `smr-proxy.controller.ts:557-568`) inlines its **own** verbatim forward (`res.status(status).json({ detail: upstreamPayload })` / `res.status(status).json(upstreamPayload)`) — it does not go through `buildUpstreamException`. This is the same PHI/prompt-echo class but on the `GET /text/tasks/:taskId/stream` error path. Left untouched per the exclusive manifest (`buildUpstreamException` only); **recommend a follow-up** to route it through the same sanitizer.

### C2-04 — PAUSE/RESUME rejected loudly instead of silently swallowed (`apps/stt-v2`)

- **Chosen behaviour**: **reject loudly** (the simpler correct option — no client needs backend pause yet). Rationale: the `ControlListener` reader wiring (`redis_streams.py:557-563`) already **catches and swallows** any exception from `_on_control` (logs a warning + advances the stream), so *raising* would not surface to the client. The client-visible channel in this Redis-streams architecture is the result stream, so the handler now calls `publisher.publish_error(...)`.
- **Fix**: the `elif control.action in (ControlAction.PAUSE, ControlAction.RESUME)` branch (`session_manager.py`) — formerly a lone `logger.info("… (not yet implemented)")` — now logs a **warning** (`"Unsupported control action rejected"`) and publishes a client-visible error to the result stream: `publisher.publish_error(f"Control action '{action}' is not supported by the streaming backend")` (guarded by `if publisher:`, mirroring the FINALIZE `publish_status` pattern). Change is isolated to the PAUSE/RESUME handler region — the finalize/reaper and reader-wiring regions were **not** touched. Real pause/resume semantics remain a follow-up (noted against the TASK-467 control-frame work).
- **RED → GREEN**: added `test_pause_is_rejected_loudly_not_silently_swallowed` + `test_resume_…` to `TestControlHandlerIntegration` (`tests/unit/test_streaming_integration.py`), asserting `publish_error` is awaited once with a message naming the action, and that PAUSE is **not** mistaken for finalize/cancel (no `flush`/`_cancel_session`/`_finalize_session`). RED = 2 failing (`publish_error` awaited 0×; captured log showed `Control action received (not yet implemented) action=resume`). GREEN = 7/7 in `TestControlHandlerIntegration` (2 new + 5 existing finalize/cancel unchanged).

### C5-03 — interim groundedness guard + column annotation (NO linker, NO migration)

- **Guard** (`packages/applications/.../prompt/prompt-assembly.service.ts`): `serializeNerEntities` now computes `hasAnyOntologyCode` across the entity set and, when **no** entity carries any of umls/snomed/rxnorm/icd/loinc, appends an explicit note line — `(note: no clinical ontology codes present — entity coding pending, populated by SOTA Theme C / TASK-476)` — so the block never reads as if coding was attempted. The per-entity un-coded lines (text/type/offsets, which ARE real NER output) still reach the LLM; only the missing-codes fact is made explicit. The guard **disengages automatically** once the linker starts populating codes (some entity then carries one), so it never suppresses real codes.
- **Annotations** (comment-only): the five ontology columns in `packages/database/src/prisma/db_main/consultation.prisma` carry a new `//` block stating they are read by the durable summarization path but written by no code, are populated by **SOTA Theme C (candidate TASK-476)**, and must not be dropped. The `serializeNerEntities` doc comment carries the matching read-site note. **`//` comments do not affect DDL — no migration was created, `db:generate` was not run** (verified: `git status` shows no migration dirs; the prisma diff is comment-only).
- **RED → GREEN**: added two tests to the `NER injection` block — all-empty-codes → the explicit marker is present (and no `[]` / dangling `umls:` tokens); at-least-one-code → the marker is **absent** (guard disengaged, `icd:J18.9` still emitted). RED = 1 failing (marker absent on current code). GREEN = 31/31 in the file.
- **Explicitly NOT done (SOTA-track handoff)**: the clinical NER + ontology linker that actually writes these columns is **SOTA Theme C**, candidate **TASK-476** (`docs/implementation/SOTA-Track`). This ticket ships the interim decision + guard only.

### Verification gates (all green — worktree, branch `fix/task-462-backend-hygiene`)

| Finding | Gate | Result |
|---|---|---|
| C4-05 | `pnpm build:api` | `Tasks: 8 successful, 8 total` |
| C4-05 | `pnpm --filter @arcaai/api test` | `Test Files 124 passed \| 2 skipped`; `Tests 2039 passed \| 4 skipped` (smr-proxy file: 77/77) |
| C4-05 | `eslint smr-proxy.controller.ts` | 0 errors (test file is eslint-ignored by config) |
| C2-04 | `py:stt-v2` unit suite (worktree src) | `2106 passed` (`TestControlHandlerIntegration` 7/7) |
| C2-04 | `py:stt-v2:lint` (ruff) | `All checks passed!` |
| C2-04 | `py:stt-v2:typecheck` (mypy) | `Success: no issues found in 103 source files` |
| C5-03 | `pnpm --filter @arcaai/applications test` | `Test Files 273 passed \| 1 skipped`; `Tests 5929 passed \| 4 skipped` (prompt-assembly file: 31/31) |
| C5-03 | `eslint prompt-assembly.service.ts` | PASS (0 problems) |

**Environment deviations (for reviewer awareness)**:
- The worktree was created off `main` (`f4c08f63`); it was re-branched to `fix/task-462-backend-hygiene` from `fix/2605-review` HEAD `87b33f57` before any work. `pnpm install` was run in the worktree (fresh checkout had no `node_modules`).
- **Python source resolution**: `stt_v2` is editable-installed in conda `arcaenv` pointing at the **main checkout**, so the bare `pnpm py:stt-v2:test` would import the main-repo source, not the worktree edits. The stt-v2 test run therefore used `PYTHONPATH="$(pwd)/apps/stt-v2/src"` to force the worktree copy (verified: `stt_v2.__file__` resolved into the worktree). `ruff`/`mypy` operate on the worktree file paths directly, so they needed no override.
- The full `pnpm py:stt-v2:test` (all of `tests/`) additionally includes integration/e2e tests requiring live Docker infra + ASR model weights; the hermetic **unit** suite was run for a clean signal (the C2-04 change is unit-covered and isolated).

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | **Implemented all three findings (Option B — grab-bag) via strict TDD; status → Review.** C4-05: sanitized `buildUpstreamException` (removed both verbatim-forward branches → generic client message + status preserved + upstream detail logged server-side only); flagged the adjacent same-class SSE leak in `streamTaskEvents` (out of manifest scope, recommend follow-up). C2-04: PAUSE/RESUME now **reject loudly** via `publisher.publish_error(...)` + a warning log (client-visible; raising would be swallowed by the reader wiring), isolated to the handler region. C5-03: added the groundedness guard in `serializeNerEntities` (explicit "no ontology codes present" note when the whole set is un-coded, auto-disengages once populated) + comment-only annotations on the five `consultation.prisma` columns and the read site (no migration, no `db:generate`); real writer remains SOTA Theme C / TASK-476. Gates green — build:api (8/8); `@arcaai/api` 2039 passed; stt-v2 unit 2106 passed + ruff/mypy clean; `@arcaai/applications` 5929 passed; lint clean. Branch `fix/task-462-backend-hygiene` off `87b33f57`. |
| 2026-07-10 | Ticket scaffolded from TASK-448 findings C4-05, C2-04, and the C5-03 **interim decision** as Wave 3 (P2). All three re-verified OPEN against the current `fix/2605-review` tree: C4-05 (`buildUpstreamException` verbatim forwards at smr-proxy :230/:233), C2-04 (PAUSE/RESUME no-op log at session_manager :1775-1780), C5-03 (columns consultation.prisma :314-318 read by 3 services, written by none — NLP emits no codes). C5-03 scoped to interim decision + groundedness guard ONLY; the real writer is SOTA Theme C (TASK-476). Manifest-purity flag raised for C2-04 (Python vs TS). No implementation. |

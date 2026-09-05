# TASK-869 — The managed e2e stack runs every test for real

**Status:** In Progress
**Branch:** `dev-2.2`
**Owner directive (2026-09-05):** *"as the test stack is always started and ready for testing e2e, it must
perform tests properly, ensure test environment variables, test environment, seed data are fit and ready
for testing e2e."* No environment-gated skips.

> Ticket number assigned per `CLAUDE.md` §Ticket Workflow: `docs/implementation/` tops out at TASK-866,
> and `task-867` / `task-868` are already in use as branch labels for TASK-861 follow-ups. **Awaiting
> owner confirmation of 869.**

## 1. Requirement Analysis

Baseline: `pnpm test:e2e:managed` on 2026-09-05 → **1132 passed, 58 skipped, 0 failed** (1190 tests).
The 58 skips are the subject. Each lane below states what makes the tests skip, what must change, and
whether that is configuration, test code, seed data, or product code.

| # | Lane | Skipped | Root cause | Change class |
|---|---|---|---|---|
| L1 | Retired AsrPipeline templates | 16 | seeded template copies deleted by TASK-861; specs had nothing to probe | **DONE** — specs deleted |
| L2 | STT live streaming session | 10 | default ASR agent points at a PRIVATE HF repo; HF credential row seeded blank+disabled; model load blows the gateway's 15s budget | seed + test fixture |
| L3 | Harness/full-stack env gates | 12 | four undeclared `HARNESS_E2E_*` ids + a redundant second flag `TASK711_E2E_FULL` | test code + script |
| L4 | LLM unreachable | 6 | seeded LM Studio `baseUrl` is the k3s Service name `hope-lmstudio` | seed |
| L5 | TEXT stub (byo-llm) | 3 | needs the gateway's own `TEXT_URL` pointed at a test stub at BOOT | test infra (2nd gateway) |
| L6 | Rate limiting | 3 | `RATE_LIMIT_ENABLED=false` for the whole suite, by design | test infra (2nd gateway) |
| L7 | Streaming baseline/TARGET | 4 | 3 need a live STT session (L2 unblocks them); 1 needs an observability signal that does not exist | test infra + **product code** |
| L8 | `E2E_TEXT_SERVICE_TOKEN` | 2 | variable simply never exported; the value is `.env.test`'s own `TEXT_SERVICE_TOKEN` | script |
| L9 | Seed-data shape | 2 | rbac test depends on a sibling test's state; audit terminal-page walk is unbounded | test code (+ optional seed) |

## 2. Current State Evaluation (evidence)

### L2 — STT (the fixture is staged and proven)

- whisper.cpp is **fully built**: `WhisperCppLoader` (`apps/stt/src/stt/models/whisper_cpp_loader.py:54`),
  `whisper_cpp_asr.py`, registry entry `cache.py:294`, `pywhispercpp>=1.5.0` already installed in `arcaenv`.
- The default agent `platform-transcription` (`seed/25-agents.ts:128`) uses
  `arcaai-whisper-large-ml-en-gguf` → `sourceUri: taphuynh/…-GGUF`, a **private** repo; the
  `model-registry:huggingface` connection is seeded blank + `enabled: false`
  (`seed/17-ai-provider-connection.ts:507`). Anonymous pull 401s.
- `createSession` loads the model INLINE; the gateway call has a hard 15s timeout
  (`streamingSession.service.ts:200`). Any non-201 → helper returns `{ok:false}` → skip.
- The plain `whisper-large-v3-turbo-gguf` slug is RETIRED in a never-reuse ledger
  (`seed/ai-models/retired.ts:94`) → a NEW slug is required, not a resurrection.
- **Staged and validated on this machine (2026-09-05):** `ggerganov/whisper.cpp` →
  `ggml-large-v3-turbo-q8_0.bin`, 874,188,075 bytes, anonymous 200; cached at
  `~/.cache/huggingface/hub/models--ggerganov--whisper.cpp` (834M) and loaded under pywhispercpp with
  `_ctx` non-null (the check `whisper_cpp_loader.py:98` exists for exactly this — a non-whisper.cpp GGUF
  returns a live handle with a null context and segfaults on first transcribe).

### L4 — LLM (fixed locally, proven)

Repointing the SYSTEM `lm-studio` row at `http://localhost:1234/v1` turned *connection refused* into real
inference (`POST /v1/chat/completions 200`, `model: gemma-4-e2b-it-qat`), and `task-709`'s 3 skips became
passes. Residual, separate finding: the v1 compat summary path answers
`500 "empty LLM content"` with `completion_tokens: 256, finish_reason: "length"` — truncation, not a
transport fault. `core."AiTaskDefault"` is **empty** in the test DB, so nothing selects a model or token
budget through the documented cascade.

### L5 + L6 — why these two are the same problem

`scripts/start-test-app.sh:181` launches every service with `npx dotenv **-o** -e .env.test`, so
`.env.test` **overrides** anything exported by the caller. `TEXT_URL` and `RATE_LIMIT_ENABLED` are both
declared there, so neither can be redirected per-spec. And both settings are process-wide on a single
shared gateway: throttling on would 429 the login helpers of the other ~1150 tests (the spec's own header
documents this), and a stubbed `TEXT_URL` would break every spec needing real TEXT.

`playwright.config.ts` already has the pattern to fix it — `api-exclusive-tests` runs last and alone via
`dependencies`, and a project may override `use.baseURL`.

### L7 — correction to the earlier framing

Only **one** of the four is a genuine `test.fixme`
(`streaming-backpressure-recovery.spec.ts:180`). The other three are plain `test.skip(!created.ok, …)` —
they need a live STT session, which L2 delivers. The resume-after-drop spec's docstring is **stale**: the
defect it describes (`Buffer.isBuffer` frame misclassification, immediate `handleDisconnect` teardown) is
already fixed — the gateway routes on the `isBinary` flag (`stt-ws.gateway.ts:719`), keeps sessions alive
for `WS_RESUME_GRACE_MS`, and implements the full `fromSeq` resume handshake (`:1206-1263`).

The real fixme needs product code: `droppedPartialResults` / `droppedFinalResults` are only
`logger.debug`'d server-side (`stt-ws.gateway.ts:834-856`); nothing surfaces them to a client, so
"partials are dropped **and observable**" cannot be asserted from e2e today.

## 3. Implementation Plan

### Wave A — unblocked, no decision needed

1. **L4 seed fix.** Seed-time override for the LM Studio endpoint, defaulting to the cluster name, set to
   `http://localhost:1234/v1` in `.env.test`; register in `turbo.json#globalEnv`. Precedent:
   `process.env.MINIO_ENDPOINT ?? default` (`seed/05b-tenant-bucket-provision.ts:19`).
2. **L2 fixture.** New `AiModel` row `whisper-large-v3-turbo-q8_0` (WHISPER_CPP, `computeType: q8_0`,
   `sourceUri: ggerganov/whisper.cpp`); repoint the **Global** tenant's `example-transcription` agent to
   it (leave `platform-transcription`/SYSTEM untouched); add an `agentSlug` passthrough to
   `tests/helpers/streaming.helper.ts` and have the two specs name the fixture agent.
3. **L3 + L8 env consolidation.** Retire `TASK711_E2E_FULL` in favour of `HARNESS_E2E_FULL`; export
   `HARNESS_E2E_FULL=1` and `E2E_TEXT_SERVICE_TOKEN` (from `.env.test`'s `TEXT_SERVICE_TOKEN`) in
   `scripts/test-run.sh` — the choke point that reaches Playwright cleanly, since neither is declared in
   `.env.test` and `pnpm test:e2e` runs dotenv **without** `-o`.
4. **L3 id removal.** Rewrite the `harness-gate` / `harness-institutional-rag` full-loop blocks to drive
   the loop themselves — the pattern `task-704-generator-seam` and `consultation-state-machine` already
   use — deleting the need for `HARNESS_E2E_CONSULTATION_ID`, `_TENANT_ID`, `_CONTEXT_ITEM_ID`,
   `_TENANT_B_CONSULTATION_ID`. No seeded consultation is at `PENDING_REVIEW` (seeds set only
   `metadata.status`; the typed column defaults to `OPEN`), so these ids cannot be derived from seed data.
5. **L9.** Make the rbac update test create its own throwaway role (removes the sibling-test coupling);
   scope the audit terminal-page walk to a seed-controlled filter (`action=LOGIN`, 3 rows) so it stays
   bounded as the suite's own audit volume grows.

### Wave B — needs the owner's go-ahead (§5)

6. **L5 + L6 — one dedicated gateway.** A second `apps/api` process on its own port, booted with
   `RATE_LIMIT_ENABLED=true` and `TEXT_URL` pointed at the byo-llm stub, plus a Playwright project
   (`api-isolated-gateway-tests`) that `dependencies`-runs last with its own `use.baseURL`. One instance
   serves both lanes: the throttle spec hits `/auth/*`, the byo spec hits `/text-generations/*`.
7. **L7 — egress observability.** Add a client-observable dropped-partial / queued-final signal
   (a WS frame in the shape of the existing `BRIDGE_ERROR`), then write the fixme against it.

## 4. Verification Criteria

- `pnpm test:e2e:managed` → **0 skipped for environment reasons**; remaining skips only where a test is
  deliberately not applicable, each with a stated reason.
- Every previously-skipped test asserted to PASS, not merely to run.
- `pnpm test:unit` and the affected package gates stay green; seed changes proven on a shadow DB.

## 5. Owner Decisions Required

| # | Decision | Recommendation |
|---|---|---|
| OD-1 | Confirm ticket number **TASK-869** | — |
| OD-2 | Wave B item 6: add a second gateway process to the managed run? It is the only way L5/L6 can run without breaking the other 1150 tests | **Yes** — it automates the workaround the throttle spec's own header prescribes |
| OD-3 | Wave B item 7: add product code (a client-visible dropped-partial signal) so the backpressure fixme can be written? | **Yes, but as its own ticket** — it is product surface, not test infra |
| OD-4 | L4 residual: the only seeded LM Studio text model is a 2B (`gemma-4-e2b-it-qat`) and `AiTaskDefault` is empty. Point the local stack at `medgemma-27b-text-it`, and/or raise the compat token budget? | Needs your call — affects what "passing" means for summarization |
| OD-5 | Retired-code sweep: delete the ~20 unit suites covering deprecated-but-live AsrPipeline code NOW, ahead of the R4 code removal? | **No** — they cover shipping code; the register's own policy is remove-at-R4 |
| OD-6 | Orphaned console feature `apps/admin-console/src/features/audio-pipelines/` (no route, nothing imports it) — delete feature + its 2 test files together? | **Yes**, as one change |
| OD-7 | `entitlement.prisma:69,194` still quotas `maxAsrPipelines`, unlisted in the deprecation register | Add a register row |

## 6. Implementation Summary

**Result: 58 environment-gated skips → 5.** Managed e2e on the worktree:

| | baseline | after |
|---|---|---|
| passed | 1132 | 1157+ |
| skipped | 58 | 5 |
| failed | 0 | 0 (one `fixme`, see below) |

### What was actually wrong (none of it was "a missing flag")

**Six `.env.test` variables silently defaulted to DEV ports or dev-only values.** Every
one was commented out, so the test stack pointed at services that were not running:
`API_GATEWAY_URL` (+ the guardrail/nlp/harness siblings) → 8868; `TEMPORAL_ADDRESS` → the dev
Temporal; `HARNESS_TEXT/NLP/GUARDRAIL_BASE_URL` → 8862/8864/8863. `API_GATEWAY_KEY` was a random
hex matching no ApiKey row, so STT's credential lookup 401'd and failed CLOSED.

**The test infra had no Temporal at all**, so harness workflows had nothing to execute them.
Added `temporal-test` (7333, dedicated databases) + `temporal-init-test`, which registers the
`default` namespace AND the `HarnessTenantId` search attribute — `auto-setup` creates neither, and
both fail silently (no namespace ⇒ the worker polls nothing and never recovers if started first;
no attribute ⇒ the harness degrades to memo-only and jobs sit at PENDING). `worker` joined the
managed service list.

**Product defects found by tests that had never run:**

| Defect | Fix |
|---|---|
| `HarnessServiceTokenGuard` accepted only the legacy `HARNESS_SERVICE_TOKEN` while the harness presents the shared `INTERNAL_ACCESS_TOKEN` — every worker callback 401'd and the workflow FAILED | guard accepts either, shared first, constant-time over all candidates |
| `Object.assign(existingMeta, summaryMeta, { id })` over a getter-only `BaseEntity.id` → `TypeError` → 500 on EVERY adopted draft | explicit per-field assignment (also restores `setProperty` change tracking) |
| Six routes returned 201 while `openapi.json` documents 200 (`prime`, `recording/start`, `recording/stop`, `close`, `reopen`, `summary/:ctx/approve`) — specs had been widened to `[200, 201]` in three files | `@HttpCode(HttpStatus.OK)` |
| Platform rate-limit RULES never applied (login brute-force protection not firing) | **TASK-870** raised; e2e `fixme` against it |

**Stale tests corrected:** `case 2/4` polled for `applyLegacySafetyFloor`, deleted with the legacy
generator (a grep gate asserts zero references); `/escalate` vs the real `/escalation`; tenant KEY
sent where the tenant UUID was required; two stateful describes not `serial`; a required
`expectedVersion` never sent; `harness-gate` demanding four hand-set ids no seed can produce.

**Test infra added:** an isolated gateway (`--isolated`, port 8969) with its own Playwright project
for the two specs needing boot-time settings the shared gateway cannot have; a public whisper.cpp
GGUF fixture (staged via `scripts/stage-e2e-stt-model.sh`, `localPath` env-driven) so STT sessions
open without a Hub credential; one consolidated `HARNESS_E2E_FULL`.

### Open, deliberately

- **TASK-870** — rate-limit rules not applied. Product ticket; the e2e is its acceptance test.
- **`task-704-generator-seam`** (`fixme`) — regenerates on a SEEDED consultation that sits at OPEN,
  so the draft write is an illegal transition. Either the spec stages its subject like its siblings
  or the product accepts it; owner notes TASK-704 is old and may be superseded.
- **`harness-institutional-rag`** (3 skips) — needs seeded ingested knowledge chunks, not just ids.
- **Compat summary truncation** — `finish_reason: length` at 256 tokens on `gemma-4-e2b-it-qat`;
  per OD-4 no other model may be used, so this is a token-budget decision.
- **Temporal namespace/attribute registration** is in compose; if CI ever runs this suite it needs
  the same init container, not the manual commands.



_Filled as waves land._

- **L1 (done, 2026-09-05).** Deleted `apps/api/tests/e2e/pipeline-template-governance.spec.ts` (10 tests)
  and `pipeline-clone-resync-cross-tenant.spec.ts` (6). Both probed
  `TEMPLATE_SLUG = 'production-whisper-large-v3-turbo-gguf'`, a row TASK-861 stopped seeding, so they
  asserted nothing; no fixture or helper is orphaned. `docs/traceability/transcription.md` and
  `docs/operations/deprecation-register.md` updated from "skipped" to "deleted". Suite:
  1190 → **1174 tests in 114 files**. Unit/integration/contract suites for the still-live surface were
  deliberately NOT touched (see OD-5).

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened from the owner's directive. Four read-only scouts mapped all 58 skips. L1 executed. L4 root-caused and proven locally (not yet made durable). L2 fixture downloaded and validated under pywhispercpp. Waves A/B planned; OD-1..OD-7 raised. |

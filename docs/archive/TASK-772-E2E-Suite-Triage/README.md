# TASK-772 — E2E Suite Triage: four failures, four unrelated causes

| Field | Value |
|---|---|
| **Status** | Completed |
| **Type** | bugfix |
| **Branch** | `feat/loop` |
| **Opened** | 2026-08-19 |
| **Surface** | `packages/applications` (S3, consultation jobs), `apps/api` (consultation controller, one e2e spec), `.env.test` / `.env.dev` |
| **Trigger** | `pnpm test:e2e:managed` reported 6 failed / 990 passed / 41 skipped |

## Requirement Analysis

Six failing e2e tests were reported across four spec files. They looked related (three of the four
files touch the consultation/summary surface) but are four **independent** causes — one boot-time
race, one product regression, one test-budget defect, one environment-config gap. Each is diagnosed
from evidence (service logs, live reproduction) rather than inferred from the assertion text.

| # | Failing test(s) | Cause class |
|---|---|---|
| A | `admin-panel-patch-surfaces.spec.ts` — bucket PATCH ×2 → 500 | boot-time race in `S3Service` |
| B | `task-704-generator-seam.spec.ts` — "job is resolvable by its creator" → 404 | product regression (TASK-732 fallout) |
| C | `task-709-note-occ.spec.ts` — `beforeAll` hook timeout | test budget vs. a real LLM call |
| D | `task-767-standalone-feature-credentials.spec.ts` — compat STT ×2 → 401 | `.env.test` placeholder sentinel |

## Current State Evaluation

### A — `S3Service` is the only storage consumer gating on a cache-only secret read

`StorageController.updateBucket` is the sole route on that controller that reaches for the raw
`IS3Service`; every sibling (`create`, `delete`, `get`, `listFiles`, upload) goes through
`IBlobStorageService`. The two resolve the *same two credentials* by different means:

| Consumer | Call | Behaviour on a cold cache |
|---|---|---|
| `S3Service.hasRequiredConfiguration` | `secretsService.getSecretSync(...)` | `undefined` — **never loads**, by design |
| `BlobStorageProviderFactory` | `await secrets.getSecretOptional(...)` | fetches from Vault and populates the cache |

`SecretsService.boot()` tolerates a warmup miss (`Promise.allSettled`, logged at WARN) and
`.env.test` sets `LOG_LEVEL=error`, so a miss is silent. The re-warm backstop does not help either:
`SECRETS_REWARM_INTERVAL_SEC=0` falls through to `max(30, TTL/2)` and `SECRETS_TTL_SEC=86400`, i.e.
a 12-hour loop. So one lost race pins the service at "not configured" until some *unrelated* async
consumer happens to warm the cache.

Evidence from the failing run's `api.log`: the API process banner is at `03:40:58`, both PATCHes
fail at `03:41:02.308` and `03:41:04.180`, and by `03:41:25` `S3Service.setBucketPolicy` is working
(it logs an unrelated MinIO policy error, which means `ensureInitialized` had by then succeeded).
Bucket *creation* succeeded throughout.

Not reproducible on an idle machine — a PATCH issued 137 ms after health went green returned 200 —
consistent with a load-dependent race when six services contend for Vault and Postgres at startup.

### B — the async summary endpoint returns an id nothing can resolve

`generateSummaryAsync` returns `jobId: decision.harnessJobId`, the synthetic `harness-doc-<uuid>`
minted in `note-generation.service.ts`. `GET /consultations/jobs/:jobId` resolves through
`ConsultationJobService.getJobStatus`, which reads the Redis key `consultation_job:<id>` — written
only by the private `storeJobStatus`, which the harness seam never calls. The
`@TenantOwnedResource('ConsultationJob')` interceptor reads the same method for its tenancy check,
so the request 404s before reaching the handler. `/cancel` and `/stream` are affected identically.

Introduced by TASK-732: the legacy BullMQ enqueue that created the record was deleted when the seam
moved into the controller. Log evidence:
`GET /api/v1/consultations/jobs/harness-doc-43e6ac3a-… → 404`.

### C — a real LLM generation under the 30 s global test timeout

The block's `beforeAll` performs a real summarization through `apps/text`. In the failing run that
single `POST /api/v1/generate` took **34.6 s** (`text.log`: `duration_ms: 34638.58` — 20.8 s of
model latency plus queueing behind parallel workers) against `playwright.config.ts`'s
`timeout: 30000`, with no override. Playwright charges a `beforeAll` timeout to the first test in
the block, so it read as an OCC regression. The house pattern for real-generation blocks is to
raise the budget (`task-635-live-agent-lineage.spec.ts` uses 180–300 s).

### D — `INTERNAL_ACCESS_TOKEN=CHANGE_ME` means two different things to the two ends

`.env.test:803` carried the unfilled-secret sentinel. The two ends disagree on what that means:

- **Gateway** reads the token from Vault. `scripts/vault-seed-secrets.sh:251` deliberately skips
  `CHANGE_ME`, so Vault has no such key (`INTERNAL_ACCESS_TOKEN  SKIP (not set in environment)`).
  `resolveInternalAccessToken` then falls back to the legacy per-service key — but for STT the
  legacy key *is* `INTERNAL_ACCESS_TOKEN`, so it sends an **empty** `X-Service-Token`.
- **STT** reads the same variable straight from the env file, so
  `accepted_service_tokens == ("CHANGE_ME",)` — non-empty, which turns the local-dev bypass OFF
  (`dev_bypass_active`) and makes it demand exactly that value → **401**.

`stt.log`: `POST /internal/streaming/sessions 401 Unauthorized`. STT is the only service with no
legacy `*_SERVICE_TOKEN` (deliberate — `platform-secrets.descriptors.ts:48`), which is exactly why
only STT failed while text/nlp/guardrail/harness/tts kept working on their seeded legacy tokens.

## Implementation Plan

1. **A** — resolve the credential gate through the async `getSecretOptional`; the await also warms
   the cache the sync `getS3Configuration()` reads immediately after. Update the unit-test double.
2. **B** — add `registerHarnessNoteJob` to `IConsultationJobService` and call it from the controller
   after the seam returns `'harness'`.
3. **C** — `test.setTimeout(180_000)` on the hook that generates.
4. **D** — give `INTERNAL_ACCESS_TOKEN` a real 64-hex value in `.env.test` and `.env.dev`; re-seed
   Vault. Committed `.env.sample` files keep their placeholders (gitleaks rule
   `hope-committed-env-file`).
5. Re-run the managed suite and triage anything the fixes unmask.

### Why B lives in the controller, not the seam

`NoteGenerationService.generate` mints the id and would be the natural home, but
`ConsultationJobServiceModule` already imports `NoteGenerationServiceModule` — injecting the job
service into the seam closes a module cycle. The controller already injects
`IConsultationJobService`, so the call site there is both cycle-free and minimal.

## Implementation Summary

| File | Change |
|---|---|
| `packages/applications/src/services/baseServices/storage/s3/s3.service.ts` | credential gate uses `await getSecretOptional` instead of `getSecretSync` |
| `…/storage/s3/__tests__/s3.service.test.ts` | secrets double now supplies both methods |
| `packages/applications/src/services/consultation/jobs/consultation-job.service.ts` | new `registerHarnessNoteJob` (interface + impl) |
| `apps/api/src/modules/consultation/consultation.controller.ts` | `generateSummaryAsync` registers the harness job before returning |
| `apps/api/tests/e2e/task-709-note-occ.spec.ts` | hook timeout; approve OCC block rebuilt (see below) |
| `.env.test`, `.env.dev` (untracked) | real `INTERNAL_ACCESS_TOKEN` |

### What the fixes unmasked

Two tests had never actually executed and began failing once they could run. Both are **latent
defects surfaced, not regressions introduced**.

**1. The approve OCC case was asserting something unreachable.** `POST :id/summary/:id/approve`
with a stale `If-Match` expected 412 but got
`409 Illegal consultation state transition: OPEN → SIGNED`. `approveSummary` asserts sign legality
(`consultation.transitionTo(SIGNED)`, TASK-711) *before* the version CAS, and the block left its
consultation in `OPEN` — which the matrix in `ConsultationEntity.ts` deliberately excludes as a
predecessor of `SIGNED` (only `DRAFT_PENDING_SENSORS`, `PENDING_REVIEW`, `TIMED_OUT` qualify). The
route returned 409 for a *fresh* `If-Match` too; the assertion could never reach the OCC path. The
sibling 428 case passed only because `@RequiresIfMatch()` is a guard and fires before the handler.

Fixed as a **test** defect, not a product change: the 409 is correct, and hoisting the CAS above the
legality check would report "re-fetch and retry" for a state where retrying can never succeed. The
approve cases now live in their own block that stages a genuinely signable consultation —
`OPEN → PRIMED → RECORDING → DRAINING` over the public routes (with the `AI_DOCUMENTATION` consent
grant TASK-712 requires, recorded through the admin surface), then the service-token-guarded
`internal/harness/consultations/:id/draft`, which both promotes to `PENDING_REVIEW` and creates the
draft the OCC assertions edit. Since TASK-732 removed `applyLegacySafetyFloor`, `persistDraft` is
the only remaining writer of those states. No `apps/harness` process is involved — that endpoint is
the gateway's own inbound half. The block self-skips with a stated reason when
`HARNESS_SERVICE_TOKEN` is absent.

**2. `streaming-backpressure-recovery.spec.ts` now runs.** It self-skips on
`streaming session unavailable (is STT running?)`, which is precisely what fix D repaired — the
skipped count fell 41 → 34. It now genuinely exercises the STT ingest-overload path and fails
intermittently there (`captions must still flow after the ingest overload`): passed in 2 of 4
full-suite runs on identical code. **Open — not addressed by this ticket**; needs its own
investigation into whether the recovery invariant or the test's tolerance is wrong.

### Verification

`pnpm test:e2e:managed` (full stack: api stt text guardrail nlp harness):

```
  1 failed    ← streaming-backpressure-recovery (pre-existing flake, newly un-skipped; see above)
  34 skipped
  1007 passed (3.6m)
```

Baseline was `6 failed · 41 skipped · 990 passed`. All six originally-failing tests pass by name,
and the task-709 file is green in isolation (9/9, including the three approve cases that had never
run):

```
✓ admin-panel-patch-surfaces.spec.ts:201 — should update bucket via PATCH
✓ admin-panel-patch-surfaces.spec.ts:209 — should disable bucket via PATCH with resourceStatus
✓ task-704-generator-seam.spec.ts:97    — the job is resolvable by its creator
✓ task-709-note-occ.spec.ts:222         — GET the generated summary carries a strong ETag
✓ task-767…:254                         — API key: an stt:stream:write key passes the gate
✓ task-767…:263                         — service account: an svc:stt:stream:write token passes the gate
✓ task-709-note-occ.spec.ts:384/393/402 — approve: legal state · 428 · 412
```

Other gates: `pnpm --filter @arcaai/applications typecheck build` clean; `pnpm --filter @arcaai/api
typecheck` clean and `pnpm run build` clean (after clearing a stale `dist` left by orphaned
`nest start --watch` processes — unrelated to these changes); `lint` reports 0 errors on both
packages, with no new warnings on changed lines; 50/50 S3 unit tests, 1828 consultation unit tests
and 177 API controller tests pass.

## Notes for the reviewer

- **A is mitigated, not proven fixed.** The mechanism and the asymmetry with `IBlobStorageService`
  are established, and the gate can no longer fail on a cold cache; but the original boot-window
  race was never reproduced on an idle machine, so the fix is verified by construction plus a green
  suite rather than by a red→green reproduction.
- **D changes local env files only.** Deployed environments must set a real `INTERNAL_ACCESS_TOKEN`
  in Vault; the sentinel now fails visibly on STT rather than silently degrading, which is the
  intended posture.
- `HarnessServiceTokenGuard` accepts only `HARNESS_SERVICE_TOKEN`, not the shared
  `INTERNAL_ACCESS_TOKEN`. Consistent with today's code, but worth a look when the legacy family is
  retired.

## Change History

| Date | Change |
|---|---|
| 2026-08-19 | Diagnosed six e2e failures to four independent causes; fixed all four; rebuilt the approve OCC block onto a signable consultation; recorded the newly-un-skipped streaming flake as open. |
| 2026-08-20 | Follow-up from TASK-776: cause A left a stale unit test. Changing the S3 readiness gate from `getSecretSync` to `await getSecretOptional` (`s3.service.ts`) was correct, but `s3.service.secret-gate.test.ts` mocks SecretsService with ONLY `getSecretSync`, so the gate resolved no credentials and the suite failed with the misleading `S3 configuration validation failed: S3_ENDPOINT must be a valid URL` — the endpoint was fine; the credentials were not. Fixed in TASK-776 (`c13ddd967`) by stubbing both forms from the same map. `packages/applications` is green again (519 files / 9566 tests). |
| 2026-08-20 | Status advanced to Completed per owner directive: diagnosis and implementation complete; outstanding e2e execution/verification is not a status gate. |

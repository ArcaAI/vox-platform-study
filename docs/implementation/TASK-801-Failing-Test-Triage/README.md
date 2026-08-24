# TASK-801 — Failing-Test Triage (1 unit flake + 9 e2e failures)

- **Status**: Review
- **Type**: bugfix
- **Branch**: `dev-2.2`
- **Opened**: 2026-08-25

> Ticket number assigned per `00-project-context.md` §Ticket Workflow: the highest number in
> `docs/implementation/` was 800. `docs/archive/**` is off-limits this sprint, so it could not be
> checked for a collision — rename this folder if 801 is already taken there.

## Requirement Analysis

One `pnpm test:unit` failure and nine `pnpm test:e2e` failures were reported. The task is to
determine, for each, whether the PRODUCT or the TEST is wrong, and fix the wrong one. Nothing here
is a request to change behaviour: every product change below restores a boundary that a recent
ticket removed by omission.

## Current State Evaluation

| # | Failure | Verdict |
|---|---|---|
| 1 | unit — `throttle-guard.test.ts` (d) `/t/skip` returned **400** | TEST INFRA. Not reproducible in isolation (25/25 green) nor on a re-run of the full suite. `/t/skip` has no code path to a 400: no pipe, no body, no validation, and the guard returns `true` before anything else runs. supertest binds and closes a FRESH ephemeral port for every request when the server is not already listening, so this file alone performs ~50 listen/close cycles; under full-suite parallelism a released port can be re-bound by another worker between our bind and our connect. |
| 2–3 | e2e — `PATCH /storage/buckets/{name}` → **500** | PRODUCT. `S3Service.ensureInitialized` threw *"S3 service is not configured"*. `hasRequiredConfiguration()` gates on `appSettingsService.hasSetting('S3_ENDPOINT')`, a CACHE-ONLY read. The row exists in the DB; the cache simply had not seen it yet. 43s later in the same run `setBucketPolicy` got past the same gate (the 45s refresh cron had run), and both PATCH tests pass on a warm process. Every sibling storage route kept working throughout, because `BlobStorageProviderFactory` reads the same configuration through the DB-backed tenant-storage cascade. |
| 4–5 | e2e — `llama-cpp must seed keyless` (`hasKey` true) | TEST. TASK-799 lane B deliberately seeds the four self-hosted ENGINE rows (ollama, lm-studio, vllm, llama-cpp) with the non-secret placeholder `not-needed`, because the `provider_overrides` fold that DELIVERS a connection to `apps/text` drops any row without key material. `built-in` stays keyless (no remote endpoint), as do all six cloud rows. |
| 6 | e2e — tenant admin's effective `AiTaskDefault` list | TEST. TASK-799 R6 added `guardrail.pii` and `guardrail.pii.spans` to `AI_TASK_KEYS`. Super-admin-only keys still LIST for a tenant admin (every `nlp.*` key already did); the lock shows up as "the SYSTEM row always wins". |
| 7 | e2e — context write conforming to the pinned kind → **400** | TEST. TASK-798 W3 seeded DEPARTMENT-scoped default context schemas for ArcaAI's General Medicine and Rheumatology. A DEPARTMENT default SHADOWS the tenant default wholesale (`resolveServableVersion`), which is the documented model and what that seed's own header says it is doing. The spec's probe schema is TENANT-scoped and the seeded consultation sits in General Medicine, so the write resolved `consultation_gen_arcaai`, which does not declare `referral_letter`. The `describe.serial` block then aborted, which is why 3 later tests in the file "did not run". |
| 8 | e2e — inventory of `@Public() /internal/*` routes: 24 vs 27 | TEST. Three routes were added since the number was pinned: `live-summary` + `live-assist` (TASK-795) and `provider-credential` (TASK-799). The behavioural half of the same test (all 27 answer 401) already passed. |
| 9–10 | e2e — `WF-CONS-007` / `WF-CONS-002` never fire | PRODUCT. `WorkflowInvariantRule` is not seeded (by design — no seed exists), so `WorkflowValidatorService.resolveRuleSet` takes its unseeded fallback. That fallback used `DRAFT_SUMMARIZATION_RULE_SET` **alone**, and `validate()` skips any rule whose `paletteKey` does not match the graph's. A consultation graph therefore matched only the palette-agnostic `WF-S-*` rows: every `WF-CONS-*` clinical invariant (mandatory nodes, consent/HITL reachability) silently never evaluated, on a report that still reported `ok: true`. The other two palette sets were not even exported from `@arcaai/workflow-contract`'s barrel, which is how the omission survived. |

## Implementation Plan

1. Export the union of every palette's bundled rule set and use it as the validator's unseeded
   fallback (RED test first).
2. Make the S3 settings gate reload AppSettings once on a cache miss, mirroring the secret half of
   the same gate (RED test first).
3. Update the six stale e2e expectations to the behaviour their owning tickets deliberately
   introduced.
4. Remove the supertest listen/close churn in the throttle test.

## Implementation Summary

### Product

- `packages/workflow-contract/src/validate.ts` — `ALL_DRAFT_RULES` is now exported (it was already
  `validate()`'s own default for callers that pass no `rules`).
- `packages/workflow-contract/src/index.ts` — re-exports it, with the reason a DB-backed caller
  needs it.
- `packages/applications/src/services/workflow-validator/workflow-validator.service.ts` — the
  empty-rule-table fallback is now `ALL_DRAFT_RULES`, not `DRAFT_SUMMARIZATION_RULE_SET`.
- `packages/applications/src/services/baseServices/storage/s3/s3.service.ts` — new
  `hasUsableSetting()`: a cache miss on a required non-secret setting forces ONE `refreshCache()`
  and re-reads before concluding "not configured". Only the miss path pays for it.

### Tests

- `packages/applications/src/services/workflow-validator/__tests__/workflow-validator.service.test.ts`
  — pins that the empty-table fallback carries every palette's rules (verified RED first).
- `packages/applications/src/services/baseServices/storage/s3/__tests__/s3.service.test.ts` — pins
  the reload-on-miss (verified RED first).
- `apps/api/src/modules/throttle/__tests__/throttle-guard.test.ts` — one `listenOnce(app)` helper
  binds a single ephemeral listener per app instead of one per request.
- `apps/api/tests/e2e/ai-provider-connections.spec.ts`, `admin-providers.spec.ts` — `hasKey` now
  asserted against the self-host placeholder posture rather than a blanket `false`.
- `apps/api/tests/e2e/ai-task-defaults-cross-tenant.spec.ts` — the two PII task keys added.
- `apps/api/tests/e2e/task-776-route-authz-matrix.spec.ts` — inventory 24 → 27, with the breakdown.
- `apps/api/tests/e2e/task-658-context-schema-plane.spec.ts` — the plane's context writes now use a
  consultation this spec opens with NO department, so the DEPARTMENT tier is skipped and the
  TENANT-scoped probe schema is the one that resolves.

## Verification

`pnpm test:unit` — three consecutive full runs, all green (the flake did not recur; the first two
also covered the pre-`listenOnce` tree, so the fix is not what made them pass — the flake is simply
rare, which is why it was addressed at its mechanism rather than by re-running until green):

```
 Test Files  1232 passed | 2 skipped (1234)
      Tests  20566 passed | 4 skipped | 9 todo (20579)
packages/agentic-sdk-v2 test:  Test Files  269 passed (269)
apps/admin-console test:  Test Files  241 passed (241)
EXIT=0
```

`pnpm test:e2e` (`RESET_DB=false`, against api + stt + text + guardrail + nlp + harness on the test
stack), re-run after the final rebuild:

```
  42 skipped
  1156 passed (3.3m)
```

Baseline for comparison — the reported run was `9 failed · 8 did not run · 39 skipped · 1142
passed`. The 8 "did not run" were the tail of the two `describe.serial` blocks the failures
aborted. The 3 extra skips are self-skipping specs that need a real LLM behind `apps/text`
(`task-767` end-to-end summarization, two `task-635` lineage tests); they are unrelated to this
ticket and skip on the local box either way.

Gates on the touched packages:

```
pnpm --filter @arcaai/workflow-contract lint      → clean
pnpm --filter @arcaai/workflow-contract typecheck → clean
pnpm --filter @arcaai/applications      lint      → 0 errors, 223 pre-existing warnings (none in the touched files)
pnpm --filter @arcaai/applications      typecheck → clean
pnpm --filter @arcaai/api               lint      → 0 errors, 64 pre-existing warnings
pnpm --filter @arcaai/api               typecheck → clean
pnpm --filter @arcaai/workflow-contract build     → ok
pnpm --filter @arcaai/applications      build     → ok
pnpm --filter @arcaai/api               build     → ok
```

Both product fixes were driven RED-first: reverting the validator fallback to a
consultation-less rule list, and short-circuiting the settings reload, each fail exactly the new
test and nothing else.

No route was added or changed, so `route-manifest.json` / `openapi.json` need no regeneration.

## Change History

| Date | Change |
|---|---|
| 2026-08-25 | Initial triage and fix of 1 unit flake + 9 e2e failures. |

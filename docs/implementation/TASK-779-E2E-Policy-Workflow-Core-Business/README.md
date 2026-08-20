# TASK-779 — E2E: Policy, Workflow, Core Business Tasks

| Field | Value |
|---|---|
| Status | Completed |
| Type | test |
| Branch | `wt/task-779` (worktree), base `feat/loop` |
| Surfaces | `apps/api/tests/e2e/task-779-*.spec.ts` |

## Requirement Analysis

End-to-end (real HTTP, Playwright, live gateway) coverage of three areas:

1. **Policy** — the authorization/config-policy surface. Specifically: the TASK-712
   CASL instance-enforcement pairs on `ApiKey`, the difference between a **403 privilege**
   boundary and the **404-over-403** cross-tenant/ownership posture, and the two-tier
   `tenant → SYSTEM` configuration cascade.
2. **Workflow** — the Workflow Studio authoring plane: `create → validate → publish`,
   the `WF-CONS-*` / `WF-S-*` rule catalogue at the wire, `If-Match`/`ETag` OCC
   (missing → 428, drift → 412), and cross-tenant isolation on definitions.
3. **Core business tasks** — the consultation lifecycle: `open` (get-or-create), context
   (case-note) capture, the async summary/job contract, and the job read plane.

Constraint from the orchestrator: the test API was already running and seeded on
`http://localhost:8968`; specs run with `RESET_DB=false` (which also makes the Playwright
global teardown leave the shared stack alone — `tests/setup/playwright.global-teardown.ts`).
No DB reset, no reseed.

## Current State Evaluation

`apps/api/tests/e2e/` already carries ~115 specs. The gaps this ticket fills, after reading
the adjacent suites:

| Area | Already covered | Gap filled here |
|---|---|---|
| ApiKey ownership | `api-key-owner-scope.spec.ts` pins cross-user → 404 at the SERVICE level | Nothing pinned the TASK-712 **guard-level enforce pair** (`read/update/delete:ApiKey`). This spec proves the observable posture is still 404 and that `casl_enforce_denial_total` never fires — i.e. the enforce list is inert in practice. |
| 403 vs 404 | scattered | One spec that exercises BOTH postures side by side, so the distinction is a pinned contract rather than folklore. |
| Config cascade | `ai-task-defaults-cross-tenant.spec.ts` (cross-tenant writes) | The **resolution** invariant: `source ∈ {tenant, system}`, `source==='system'` ⟺ the tenant row does not exist (`version === 0`), a request always resolves to the tenant asked for, and a platform admin with no tenant scope gets 400 rather than a silent customer-tenant default. |
| Workflow | `task-722-workflow-exposure.spec.ts` (exposure plane), `task-723-*` (runs read model) | The **authoring plane** — `/admin/workflow-definitions` — had no e2e at all: lifecycle, validator findings at the wire, OCC, cross-tenant. |
| Consultation | `consultation-state-machine.spec.ts`, `consultation-job-cross-{tenant,user}.spec.ts`, `task-709-note-occ.spec.ts` | `open` get-or-create idempotency, the case-note projection, and the async-summary **fail-closed** contract. Also restores the job 401/404 assertions that live in a file the runner never picks up (see Findings F-3). |

## Implementation Plan

1. `task-779-policy-boundaries.spec.ts` — area 1.
2. `task-779-workflow-lifecycle.spec.ts` — area 2.
3. `task-779-core-business.spec.ts` — area 3.
4. Run each spec against the live gateway with `RESET_DB=false`; record real counts.
5. `pnpm --filter @arcaai/api lint typecheck`.

Determinism rules applied: every fixture is created by the spec (unique slugs/patient ids
derived from `Date.now()`), nothing asserts a hardcoded row id, and every deletable fixture
is deleted in `afterAll`. Two deliberate exceptions are documented in the specs themselves:
consultations have no DELETE route (each run uses a fresh patient id, so nothing collides),
and the config-cascade assertions are strictly READ-ONLY precisely so they leave no residue.

## Implementation Summary

Three specs added under `apps/api/tests/e2e/`. All were executed against the running
gateway; counts are in the Verification section.

### Findings

**F-1 — the TASK-712 `CASL_ENFORCED_PAIRS` entries for `ApiKey` are unreachable.**
`ApiKeyController`'s `resolveApiKeyInstance` resolves the subject instance by calling
`IApiKeyService.fetchById(id)`, which itself runs `assertKeyAccess` and throws
`NotFoundException` for a key the caller does not own. So on exactly the request the enforce
pair exists to deny, the resolver **throws**, `runCaslInstanceChecks` swallows it (its
documented fail-open path), no denial is returned, and the handler answers the service's
own 404. Where the resolver DOES succeed the caller has already passed `assertKeyAccess`,
so the instance verdict is necessarily `true`. Net: `read/update/delete:ApiKey` can never
produce the 403 the enforce list describes, and `casl_enforce_denial_total` can never
increment — which also means any future "measure then enforce" reading of that counter is
vacuous. Not a security hole (404 hides existence, which is strictly stronger than 403), so
NOT fixed here: making it fire would replace a 404 with an existence-leaking 403, the exact
regression `policy.engine.ts` warns about for `UserVoiceProfile`. Documented and pinned.

**F-2 — `POST /admin/workflow-definitions/:id/validate` and `:id/publish` answer 201, not
the documented 200.** Both are plain `@Post()` handlers, so Nest's default 201 applies,
while their `@ApiResponse` (and therefore `openapi.json`) declares 200. A generated client
that checks for 200 will treat a successful publish as a failure. Small and real; left as a
finding rather than fixed, because changing a published status code is an API contract
change that needs an owner decision. The spec asserts the ACTUAL behaviour (201) with the
drift called out inline.

**F-3 — `apps/api/tests/e2e/consultation-jobs.spec.ts` is never executed.** The
Playwright `testMatch` is `**/*.spec.ts`; the file ends in `.e2e-spec.ts`, which does not
match. Its seven assertions have therefore never run. Its two portable assertions
(unknown job → 404, unauthenticated → 401) are reproduced in
`task-779-core-business.spec.ts` so they actually execute. The dead file was left in place
(renaming it is out of scope and would need its stream-ticket half re-verified).

**F-5 — `packages/database` does not compile on this base commit (pre-existing, out of scope).**
`src/prisma/db_main/seed/ai-models/nlp.ts` lines 111 / 167 / 261 pass a `languages` key into
`AiModel.metadata`, whose type only admits `{ voices?, azureDeployment?, ttsProvider? }` —
three `TS2353` errors introduced by `9d43d51e1 feat(TASK-776): complete the nlp safety-plane
roster`. `tsc` still EMITS (the package has no `noEmitOnError`), so nothing downstream
notices until someone builds from a clean checkout, where `pnpm --filter @arcaai/api^...
build` fails at that package. Unrelated to this ticket and untouched; reported, not fixed.
Consequence for the gates below: `@arcaai/domains` and `@arcaai/applications` had to be
built explicitly after the database package's failed-but-emitting build before
`apps/api` typecheck could run.

**F-6 — `GET /consultations/:id/summary/latest` returns 200 with a ZERO-BYTE body** when the
consultation has never been summarised (not `{}`, not `null`). A client that calls `.json()`
unconditionally throws on the ordinary "no summary yet" state. Pinned as-is.

**F-4 — rule-catalogue findings never block publish (by design; now pinned).** A
consultation-palette graph missing the mandatory `consultation.persistDraft` node records
an `ERROR`-severity `WF-CONS-007` finding, `validationReport.ok === false`, and still
publishes successfully. Only the engine gate (shape + `compile()`) blocks. This matches the
controller's documented intent, but it is a surprising contract and had no e2e evidence.

## Verification

All commands run from the worktree, against the already-running test gateway
(`http://localhost:8968`), with `RESET_DB=false` so neither the database nor the shared
Docker stack is touched (globalSetup skips the reset; globalTeardown skips `compose down`).

### E2E — all three specs, one run

```
RESET_DB=false SKIP_DB_PRECHECK=true npx dotenv -e .env.test -- \
  npx playwright test --config playwright.config.ts apps/api/tests/e2e/task-779- --reporter=list

  25 passed (10.2s)
```

Per file: `task-779-policy-boundaries.spec.ts` 6 passed · `task-779-workflow-lifecycle.spec.ts`
11 passed · `task-779-core-business.spec.ts` 8 passed. **0 failed, 0 skipped** — no test in
this ticket skips itself under any condition. The one downstream-dependent assertion
(`summary/async`) is written as a two-branch CONTRACT that always executes and records which
branch it took via a Playwright annotation, rather than skipping.

Two assertions were WRONG on first execution and were corrected against the real system
rather than the other way round — recorded here because a green suite that never failed
proves nothing:

1. `source` on the config cascade admits a documented third value, `null` (neither tier has
   an opinion). The first draft asserted `['tenant','system']` and failed on
   `text.live.fallback`.
2. The first draft derived the "own tenant" from `ConsultationResponse.tenantId`, a field
   that does not exist. It silently resolved `undefined`, picked the caller's OWN tenant as
   the "foreign" one, and therefore asserted 404 against a same-tenant request that
   correctly answers 403. Now derived from the JWT payload, with the trap documented in
   the helper.

### Lint

```
pnpm --filter @arcaai/api lint
✖ 63 problems (0 errors, 63 warnings)
```

0 errors. The 63 warnings are pre-existing `eslint-comments/require-description` /
`@typescript-eslint` warnings in `apps/api/src/**`, none in the new files.

### Typecheck

```
pnpm --filter @arcaai/api typecheck
> tsc --noEmit
(clean, exit 0)
```

Preceded by `pnpm --filter @arcaai/domains --filter @arcaai/applications build` — see F-5.

## Change History

| Date | Change |
|---|---|
| 2026-08-20 | Ticket created; three e2e specs added and executed; findings F-1..F-4 recorded. |

# TASK-780 — API Contract Corrections (from TASK-779 e2e findings)

| Field | Value |
|---|---|
| Status | Completed |
| Type | bugfix |
| Branch | `wt/task-780` (worktree), base `feat/loop` |
| Surfaces | `apps/api/src/modules/workflow-definition/`, `apps/api/src/modules/consultation/`, `apps/api/tests/e2e/task-779-*.spec.ts` |

## Requirement Analysis

TASK-779's e2e run recorded six findings (F-1..F-6). Two are confirmed contract defects to
fix here:

- **F-2** — `POST /admin/workflow-definitions/:id/validate` and `:id/publish` return HTTP
  **201** at runtime (Nest's default for a bare `@Post()`), while their `@ApiResponse`
  decorators and the generated `openapi.json` declare **200**. These are state transitions
  on an EXISTING resource (DRAFT → VALIDATED, DRAFT → PUBLISHED), not creations of a new
  one, so 200 is the correct code — fix the code to match the documented contract, not the
  other way round.
- **F-6** — `GET /consultations/:id/summary/latest` (and, by the same code path, the sibling
  `:id/summary/pre-summary/latest`) returns HTTP 200 with a literal **zero-byte body** when
  the consultation has never been summarised. An unconditional `.json()` on the client
  throws (there is no valid JSON to parse — not even `null`).

One finding needs analysis only, not a code change:

- **F-4** — DRAFT rule-catalogue findings (`WF-CONS-007` etc., `ERROR` severity,
  `validationReport.ok === false`) never block `publish`; only the engine gate (shape +
  `compile()`) does. The controller docstring says this is intentional. This ticket
  documents the options and a recommendation under "F-4 — Owner Decision Required" below,
  and makes NO change to publish gating.

Out of scope (per the assignment): F-1, F-3, F-5 — already fully disposed of in the
TASK-779 README as "not fixed here" / "reported, not fixed" with sound reasoning; nothing
new to add.

## Current State Evaluation

### F-2 — status code

`apps/api/src/modules/workflow-definition/workflow-definition.controller.ts`:
- `validate()` (`@Post(':id/validate')`) and `publish()` (`@Post(':id/publish')`) carry
  `@ApiResponse({ status: 200, ... })` but no `@HttpCode` override, so Nest's default POST
  status (201) is what actually goes on the wire. Every other controller in `apps/api` that
  needs a POST route to answer something other than 201 already does this with
  `@HttpCode(HttpStatus.OK)` (verified precedent: `workflow-sandbox-run.controller.ts`,
  `auth.controller.ts`, `auth-sso.controller.ts`, `admin-impersonation.controller.ts`,
  `health.controller.ts`) — so this is a one-line-per-route fix using an established house
  pattern, not a new one.

### F-6 — empty body

`apps/api/src/modules/consultation/consultation.controller.ts`:
- `getLatestSummary()` / `getLatestPreSummary()` call
  `SummaryService.getLatestSummary` / `getLatestPreSummary`, both typed
  `Promise<SummaryResponse | null>`, and return the service result directly — including
  `null`. Nest's Express adapter sends a `null` handler return value as an empty body (not
  the literal 4-byte JSON `"null"`), which is where the zero-byte body comes from.
- The house pattern for "service may return null, meaning the singleton resource doesn't
  exist yet" is NOT "let null through as 200" — every sibling case in the codebase converts
  it to a 404 in the controller:
  - `dna-writing-style.controller.ts` / `dna-writing-style-admin.controller.ts` —
    `getDnaReport()` returns `DnaReportResponse | null`; controller: `if (!report) throw
    new NotFoundException(...)`.
  - `consultation-job.controller.ts#getJob` — `getJobStatus()` returns
    `JobStatusResponse | null`; controller: `if (!status) throw new NotFoundException(...)`.
  - `harness-admin.controller.ts#getLiveSession` — the closest structural analog ("get the
    latest/active X for this id", also consultation-scoped) — `getSessionStats()` returns
    `LiveDocSessionStatsResponse | null`; controller: `if (!stats) throw new
    NotFoundException('No active live-documentation session for this consultation.')`.
  - `getLatestSummary`/`getLatestPreSummary` are the ONLY two `getLatest*`/`| null`
    controller methods in `apps/api` that do NOT follow this pattern.
- **Decision: fix to 404.** A summary that has never been generated is "no such resource
  yet" — structurally identical to "no active live-documentation session" or "no DNA report
  yet" — and 404 is what every sibling "optional latest resource" endpoint in this codebase
  already answers. It is also the option that requires no new response shape (no `nullable`
  DTO field, no client-side `if (body === null)` branch) and keeps `SummaryResponse` a
  non-nullable success shape everywhere a 200 is returned, which is the more defensible
  contract for a generated/typed client.

### F-4 — publish gating (analysis only)

See "F-4 — Owner Decision Required" below.

## Implementation Plan

1. **F-2** (TDD):
   - RED: add unit-test assertions in
     `apps/api/src/modules/workflow-definition/__tests__/workflow-definition.controller.test.ts`
     asserting `Reflect.getMetadata(HTTP_CODE_METADATA, ...)` is `200` for `validate` and
     `publish` — run, watch fail (no `@HttpCode` metadata present today).
   - GREEN: add `@HttpCode(HttpStatus.OK)` to both handlers; import `HttpCode`, `HttpStatus`
     from `@nestjs/common`.
   - Update `task-779-workflow-lifecycle.spec.ts` — the two assertions currently pinning
     `.toBe(201)` for validate/publish flip to `.toBe(200)` (with the drift note removed,
     since there is no more drift).
2. **F-6** (TDD):
   - RED: add unit tests in
     `apps/api/src/modules/consultation/__tests__/consultation.controller.test.ts` — mock
     `getLatestSummary`/`getLatestPreSummary` to resolve `null`, assert the controller
     methods reject with `NotFoundException` — run, watch fail (today they resolve `null`).
   - GREEN: in `consultation.controller.ts`, add the `if (!result) throw new
     NotFoundException(...)` guard to both `getLatestSummary` and `getLatestPreSummary`,
     matching the `getJob`/`getLiveSession`/`getDnaReport` shape. Update the `@ApiResponse`
     annotations to add the 404 case and drop the nullable return type.
   - Update `task-779-core-business.spec.ts` — the `summary/latest` test flips from
     asserting `200` + empty text to asserting `404`.
3. Regenerate `apps/api/openapi.json` / `apps/api/route-manifest.json` if the build/emit
   scripts can run in this environment (they require a live-ish env/DB stub); re-run the
   `generate-vox-node-admin-check` equivalent (`pnpm --filter @arcaai/vox-node gen:admin:check`)
   if regeneration succeeds.
4. Verify: `pnpm --filter @arcaai/api lint typecheck test:unit`, plus the two updated e2e
   specs against the live test gateway (requires an API rebuild/restart to observe the
   fix — call out plainly if that isn't possible).
5. Document Implementation Summary + Verification evidence + F-4 analysis below.

## F-4 — Owner Decision Required: should ERROR-severity rule-catalogue findings block publish?

**Current behavior (pinned by `task-779-workflow-lifecycle.spec.ts`, confirmed intentional
by the controller's own docstring):** `publish` rejects 400 ONLY when the engine gate (shape
validation + `compile()`) is unclean — a cycle, an unregistered node type, or malformed
shape. DRAFT rule-catalogue findings (the `WF-CONS-*`/`WF-S-*` catalogue introduced by
TASK-716, e.g. a missing mandatory `consultation.persistDraft` node producing an
`ERROR`-severity `WF-CONS-007` finding with `validationReport.ok === false`) are recorded on
the persisted validation report but never inspected by `publish`.

**Options:**

1. **Keep as-is (status quo).** Rule-catalogue findings stay advisory; only the engine gate
   blocks. Authors can publish a graph that is structurally soundbut clinically
   incomplete (e.g. never persists a draft), and must notice the `ERROR` finding in the
   validation report themselves before activating it for real consultations.
2. **Block publish on any `ERROR`-severity finding.** `publish` inspects the latest
   validation report and rejects 400 (mirroring the existing 400-on-unclean-engine-gate
   shape) if any finding has `severity === 'ERROR'`. This makes the rule catalogue
   load-bearing rather than advisory, which is presumably what "TASK-716's not-yet-clinically-
   reviewed rules" was gesturing toward when the catalogue was built.
3. **Split the catalogue.** Introduce a distinction between rules that are genuinely
   mandatory-for-safety (block publish) and rules that are best-practice/style (advisory
   only) — requires re-classifying every existing `WF-CONS-*`/`WF-S-*` rule, more invasive
   than options 1/2.

**Recommendation: Option 2, but NOT unilaterally decided here.** The controller docstring
("DRAFT rule-catalogue findings never block publish") reads as a documented CHOICE rather
than an oversight, and reversing it changes which workflow definitions tenant admins can
activate today — a behavior change with real blast radius that needs a product/clinical-
safety owner to confirm before it ships (a currently-publishable definition that is missing
`consultation.persistDraft` would start hard-failing publish). This ticket makes NO change
to publish gating; F-4 stays pinned as-is in the e2e suite, per the assignment.

## Implementation Summary

### F-2 fixed
`apps/api/src/modules/workflow-definition/workflow-definition.controller.ts` — added
`@HttpCode(HttpStatus.OK)` to `validate()` and `publish()`. Both now answer 200, matching
their `@ApiResponse` declarations and `openapi.json`. No other behavior changed.

### F-6 fixed
`apps/api/src/modules/consultation/consultation.controller.ts` — `getLatestSummary()` and
`getLatestPreSummary()` now throw `NotFoundException` when the underlying service resolves
`null` (no summary/pre-summary generated yet), instead of letting `null` fall through to an
empty-body 200. Return types narrowed from `Promise<SummaryResponse | null>` to
`Promise<SummaryResponse>`; `@ApiResponse({ status: 404, ... })` added to both routes'
Swagger annotations.

### TDD evidence
- RED: `workflow-definition.controller.test.ts` — new assertion on
  `Reflect.getMetadata(HTTP_CODE_METADATA, ...)` failed with `expected undefined to be 200`
  before the fix.
- RED: `consultation.controller.test.ts` — new assertions
  `rejects.toThrow(NotFoundException)` failed with `promise resolved "null" instead of
  rejecting` before the fix.
- GREEN: both suites pass after the two-line/six-line fixes (see Verification).

### e2e specs updated (were pinning the buggy behaviour)
- `apps/api/tests/e2e/task-779-workflow-lifecycle.spec.ts` — 6 assertions flipped from
  `.toBe(201)` to `.toBe(200)` for `validate`/`publish` responses (create-route 201s and
  cross-tenant 404 probes were untouched — they were already correct).
- `apps/api/tests/e2e/task-779-core-business.spec.ts` — the `summary/latest` test renamed
  and flipped from asserting `200` + empty-body text to asserting `404`.

### F-4 — no change made
See "F-4 — Owner Decision Required" above. Publish gating is unchanged; the existing e2e
assertion pinning "ERROR findings do not block publish" was left in place (only its status
code assertion moved from 201 to 200, consistent with the F-2 fix).

### Additional finding investigated at the coordinator's request (not a TASK-780 defect)

While running the e2e suite against a live instance, one run's server log showed
`POST /admin/workflow-definitions/:id/validate` (and several sibling by-id routes) answering
**500** with `errorType: "DataNotFoundException"`, which should map to 404 via the global
`DataNotFoundExceptionFilter` (`apps/api/src/app.module.ts`, `apps/api/src/filters/data-not-found.filter.ts`).

Investigated and NOT reproducible:
- The diff for this ticket touches only `workflow-definition.controller.ts` (`@HttpCode`
  additions) and `consultation.controller.ts` (the `getLatestSummary`/`getLatestPreSummary`
  guard) — neither file is on the `findById` → `DataNotFoundException` → filter path, so this
  cannot have been introduced by TASK-780's changes.
- Direct verification against a freshly rebuilt instance of this worktree's code (port 8969):
  `GET`, `POST :id/validate`, and `POST :id/publish` against a genuinely non-existent
  workflow-definition id (`00000000-0000-0000-0000-000000000000`) all correctly answered
  `404 {"code":"HTTP.NOT_FOUND","message":"Resource not found"}`.
- The full `task-779-workflow-lifecycle.spec.ts` suite — including the cross-tenant probe
  test that exercises this exact `GET/versions/PATCH/validate/publish/DELETE` sequence
  against a foreign-tenant id — passed cleanly with zero 500s when run serially
  (`--workers=1`) against this build; the 500 was observed only during a period when
  multiple test-runner processes (including several aborted launch attempts of my own, per
  the port-8968-already-in-use errors during startup) were concurrently hitting the same
  shared, non-reset test Postgres/Vault instance — the server log from that window also shows
  `"settings cache exploded"` and `"Vault forbidden"` entries, consistent with infra
  contention rather than a request-handling defect.
- Conclusion: most likely a transient artifact of concurrent test-runner/Vault contention
  during that window, not a reproducible gap in the `DataNotFoundException` → 404 mapping.
  No fix applied — not reproducible, not introduced by this ticket's diff, and the scope
  given was "report if pre-existing, do not fix unless small and obviously correct." If it
  recurs under controlled (single-writer) conditions, it would need its own ticket with a
  repro.

## Verification

### Unit tests — TDD RED before the fix (excerpt)

```
FAIL src/modules/workflow-definition/__tests__/workflow-definition.controller.test.ts
  > answers validate/publish with 200, not Nest's default 201 for POST (TASK-780 F-2)
AssertionError: expected undefined to be 200

FAIL src/modules/consultation/__tests__/consultation.controller.test.ts
  > getLatestSummary throws NotFoundException when the service resolves null
AssertionError: promise resolved "null" instead of rejecting
  > getLatestPreSummary throws NotFoundException when the service resolves null
AssertionError: promise resolved "null" instead of rejecting
```

### Unit tests — GREEN after the fix

```
pnpm --filter @arcaai/api exec vitest run src/modules/workflow-definition/__tests__/workflow-definition.controller.test.ts src/modules/consultation/__tests__/consultation.controller.test.ts

 Test Files  2 passed (2)
      Tests  95 passed (95)
```

### Full `@arcaai/api` unit suite

```
npx dotenv -e .env.test -- pnpm --filter @arcaai/api exec vitest run

 Test Files  250 passed | 2 skipped (252)
      Tests  3885 passed | 10 skipped (3895)
```
(Two earlier runs showed one unrelated, non-reproducing flake each —
`users-me-route-precedence.test.ts` once, `throttle-guard.test.ts` once, both passing on
retry — neither touches code this ticket changed; consistent with parallel-worker resource
contention, not a regression.)

### Lint

```
pnpm --filter @arcaai/api lint
✖ 63 problems (0 errors, 63 warnings)
```
Same 63 pre-existing warnings as TASK-779's baseline; 0 in the changed files.

### Typecheck

```
pnpm --filter @arcaai/api typecheck
> tsc --noEmit
(clean, exit 0)
```

### E2E — both updated specs against a rebuilt instance of this worktree (port 8969, not the
shared 8968 instance)

```
RESET_DB=false SKIP_DB_PRECHECK=true API_URL=http://localhost:8969/api/v1 \
  npx dotenv -o -e .env.test -- npx playwright test --config playwright.config.ts \
  apps/api/tests/e2e/task-779-workflow-lifecycle.spec.ts apps/api/tests/e2e/task-779-core-business.spec.ts \
  --reporter=line --workers=1

  19 passed (1.0m)
```
Run serially (`--workers=1`) to avoid the shared-test-DB concurrency contention described
above; a parallel run against the same instance also passed 19/19 (49s) — the serial run is
the one pasted here as the cleanest evidence.

No DB reset was run; `docker compose down` was never invoked. The port-8969 instance was
started, and later left running, by this session against the test Docker stack that was
already up; it was not stopped so as not to disturb any other verification in progress. The
shared instance on port 8968 was never touched.

## Change History

| Date | Change |
|---|---|
| 2026-08-20 | Ticket created; plan written; F-4 analysis recorded (no gating change). |

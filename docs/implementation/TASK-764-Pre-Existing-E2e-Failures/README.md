# TASK-764 — Pre-existing E2E failures

| Field | Value |
|---|---|
| **Status** | Completed |
| **Type** | bugfix (test-suite integrity) |
| **Branch** | `feat/loop` |
| **Owner** | — |
| **Created** | 2026-08-18 |

---

## Requirement Analysis

Six Playwright specs in `apps/api/tests/e2e/` fail on the current branch **and** on
baseline commit `e3f3713fb` (before the TASK-754..763 workstream), against the same
freshly-seeded test database. They are therefore **pre-existing**, not regressions
introduced by that workstream.

| # | Spec:line | Test |
|---|---|---|
| 1 | `agent-management-contract.spec.ts:287` | POST test without If-Match → accepted (the run itself writes nothing) |
| 2 | `auth-throttle-per-endpoint.spec.ts:117` | POST /auth/login enforces 5/min — at least one 429 within the first 6 rapid attempts |
| 3 | `consultation-job-cross-user.spec.ts:163` | GET /consultations/jobs/:jobId — same-tenant peer can READ |
| 4 | `task-658-context-schema-plane.spec.ts:94` | discovery answers 200 with null fields and ETag `"none"` |
| 5 | `task-704-generator-seam.spec.ts:86` | the job is resolvable by its creator |
| 6 | `task-709-note-occ.spec.ts:173` | GET the generated summary carries a strong ETag equal to its version |

Each failure must be categorised, with evidence, as exactly one of:

- **(a) product defect** — fix the product, keep the test;
- **(b) stale test premise** — the product changed deliberately; fix the test to assert
  the current *intended* behaviour, never weaken it into vacuity;
- **(c) test-order pollution / shared-state dependence** — make the spec
  self-provisioning rather than dependent on state another spec mutates;
- **(d) environment-dependent** — needs a downstream service that is not running; follow
  the existing graceful-skip-with-logged-probe pattern.

Everything fixable without an owner decision is fixed; the rest is documented with a
precise recommendation. `pnpm --filter @arcaai/api test` and `pnpm api:build` must stay
green.

### Test-infrastructure constraints observed

- Playwright was **always** run as `RESET_DB=false …`. The bare command's
  `globalTeardown` runs `docker compose -f tests/docker-compose.test.yml down -v`, which
  destroys the seeded test database; `RESET_DB=false` is the documented
  "caller owns the infra lifecycle" signal that both `globalSetup` and `globalTeardown`
  honour (`tests/setup/playwright.global-teardown.ts:63`).
- No destructive DB command was run (`db push --force-reset`, `test:db:reset`,
  `pnpm db:all`). No `git stash`. No files under `apps/api/src/bootstrap/**` or
  `packages/eslint-plugin-arcaai-internal/**` were touched (TASK-761 owns those).
- The pre-existing test API on port 8968 was reused, never restarted.

---

## Current State Evaluation

### Method

Each spec was run **in isolation** and compared against its behaviour under the full
suite. The decisive discovery came from a second axis: the same spec was run **with** and
**without** `.env.test` loaded.

```
# sanctioned invocation (what `pnpm test:e2e` expands to)
RESET_DB=false pnpm exec dotenv -e .env.test -- playwright test <spec> --workers=1

# bare invocation
RESET_DB=false pnpm exec playwright test <spec> --workers=1
```

Two of the six failures reproduce **only** under the bare invocation. `pnpm test:e2e` is
`dotenv -e .env.test -- playwright test` (`package.json:297`), so a bare
`pnpm exec playwright test` gives the Playwright **client** process none of `.env.test` —
including `RATE_LIMIT_ENABLED`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASS`, `REDIS_URL`.
Specs that read those variables to decide what to assert, or where to seed a fixture, then
mis-target silently.

### Environment at time of investigation

Every Python service was **down** — verified by probing both the dev and test ports:

```
8862 -> 000 DOWN   8962 -> 000 DOWN    (apps/text / SMR)
8866 -> 000 DOWN   8966 -> 000 DOWN    (apps/harness)
8864 -> 000 DOWN   8964 -> 000 DOWN    (apps/nlp)
8861 -> 000 DOWN   8961 -> 000 DOWN    (apps/stt)
```

`.env.test` points the gateway at `TEXT_URL=http://localhost:8962` and
`HARNESS_URL=http://localhost:8966` (`.env.test:2456,2464`). Three of the six failures are
this and nothing else.

### Per-failure findings

---

#### 1. `agent-management-contract.spec.ts:287` — **(d) environment-dependent**

**Root cause.** `POST /admin/prompt-templates/:id/test` forwards to apps/text (SMR).
With SMR down the gateway answers **400**, naming the refused connection:

```
status=400
{"message":"Failed to call SMR service: AggregateError: connect ECONNREFUSED ::1:8862;
  connect ECONNREFUSED 127.0.0.1:8862","error":"Bad Request","statusCode":400,
  "correlationId":"01a0155d-21c7-7993-81d3-fe740595897d"}
```

(reproduced directly with curl against a freshly created ARCAAI department + template).

The test's stated contract is that the run is **not OCC-gated** — the controller comment
it cites says "This route no longer writes, so it carries NO `If-Match` requirement", so a
bare POST must never be refused for want of one. But it asserted `[200, 201]`, which
conflates "not OCC-gated" with "SMR is reachable". Its own sibling test 12 lines below
already gets this right (`expect(res.status()).not.toBe(428)` plus a
`console.warn` when the run could not be issued) — the two tests simply disagreed about
the same environmental fact.

**Not a product defect.** Nothing about the OCC posture is wrong.

---

#### 2. `auth-throttle-per-endpoint.spec.ts:117` — **(d) environment-dependent, via a guard that could not see its own environment**

**Root cause.** The spec is opt-in: it is the only spec that requires throttling
*enabled*, and the full suite runs with `RATE_LIMIT_ENABLED=false` (`.env.test:2452`)
because a shared per-IP login budget cannot survive dozens of parallel specs logging in.
Its guard read:

```ts
test.skip(process.env.RATE_LIMIT_ENABLED === 'false', '…');
```

That skips only when the variable is **explicitly** `'false'`. Under a bare invocation the
variable is *undefined*, the guard does not fire, the spec runs against an API that has
throttling off, and six rapid logins return `[401,401,401,401,401,401]` — reported as a
throttling regression.

**Evidence.**

| Invocation | Result |
|---|---|
| `dotenv -e .env.test` (sanctioned) | `3 skipped` |
| bare `pnpm exec playwright test` | `Error: expected ≥1 of the 6 rapid login attempts to 429, got statuses [401,401,401,401,401,401]` |

**Not a product defect.** An unset variable means "I have not been told throttling is on",
which is a skip condition, not a pass condition.

---

#### 3. `consultation-job-cross-user.spec.ts:163` — **(c)/(d): fixture targeting + no visibility precondition. Product verified CORRECT.**

**The product is right.** Seeding the Redis row by hand into the *test* Redis and calling
the API directly shows the same-tenant peer read succeeding exactly as the test intends:

```
--- creator GET --- status=200
--- peer GET ---    status=200
{"jobId":"task764-manual-1787065001","type":"PRE_SUMMARY","status":"RUNNING",…,
 "tenantId":"50000000-0000-0000-0000-000000000000","userId":"70000000-…-010"}
```

**Root cause.** The spec seeds its own fixture into whichever Redis the **client**
process's env names, via `buildRedisClient()`, which fell back to
`localhost:6379` **with no password** — that is the *dev* Redis, while the test API reads
the *test* Redis on 6380 (`.env.test:2429-2432`). It then asserted a 200/404 distinction
without ever checking that the fixture was visible to the API at all, so a mis-targeted
seed is indistinguishable from the read contract regressing.

**Evidence (determinism).**

| Invocation | Runs | Result |
|---|---|---|
| `dotenv -e .env.test` | 8 | 8 × `3 passed` |
| bare | 2 | 2 × `Received: 404` at line 167 |
| bare + forced `REDIS_HOST/PORT/PASS` (+`REDIS_URL`) | 9 | 5 pass / 4 fail — still flaky |

The residual flakiness under forced coordinates is the same defect seen from the other
side: with no visibility precondition, a fixture the API cannot yet see is reported as the
peer-read contract failing. Note also that a missing fixture makes case 1 (peer cancel →
404) pass *vacuously*, which is why the file's failure signature is always "1 passed,
1 failed".

---

#### 4. `task-658-context-schema-plane.spec.ts:94` — **(b) stale test premise**

**Root cause.** The spec's header asserted that "`__GLOBAL__` is deliberately never given
a schema, so the 'no schema configured' arm stays true however often this spec runs".
That stopped being true. TASK-686 (`63d0a33f2`, 2026-08-12) added
`packages/database/src/prisma/db_main/seed/07e-consultation-loop-defaults.ts`, which seeds
a **PUBLISHED** `consultation_default` context schema for every seeded tenant. The spec
(`c96e378df`) is an ancestor of that commit — verified with `git merge-base --is-ancestor`.

The test DB shows exactly that, freshly seeded, created by the system user:

```
                  id                  |  tenant_key |         slug         |  status   | isDefault |        createdAt
79000000-0000-0000-0002-000000000001  | __SYSTEM__  | consultation_default | PUBLISHED | t         | 2026-08-18 14:12:24.044
79000000-0000-0000-0000-000000000001  | __GLOBAL__  | consultation_default | PUBLISHED | t         | 2026-08-18 14:12:24.047
79000000-0000-0000-0001-000000000001  | ARCAAI      | consultation_default | PUBLISHED | t         | 2026-08-18 14:12:24.048
```

So discovery on `__GLOBAL__` correctly returns a real bundle and a content-derived ETag
(`"d008b1594b680fe8412c336490178cea"`) instead of `"none"`. This is the intended day-1
posture (see `pre-production: build for day-1` — ship complete and ENABLED), not
pollution and not a defect.

**The K7 contract itself is still live and still meaningful.**
`resolveServableVersion` (`consultation-context-schema.service.ts:452`) is strictly
tenant-scoped — it consults the department-scoped default then the tenant-scoped default
and returns `null`; it never widens to the SYSTEM tenant. So `ETag "none"` remains
genuinely reachable, just not for a *seeded* tenant. The arm needed a tenant of its own.

A freshly provisioned tenant is exactly that state: `TenantService.create`
(`tenant.service.ts:150-213`) provisions storage buckets, tenant configs, a default
department, and the model / pipeline / agent catalogs — but **no context schema**.

---

#### 5. `task-704-generator-seam.spec.ts:86` — **(d) environment-dependent; the block's own comment was stale**

**Root cause.** The `beforeAll` POSTs `:id/summary/async` and hard-asserts a 2xx. It
returns **500**:

```
=== POST :id/summary/async on 90000000-0000-0000-0000-000000000001
status=500
{"statusCode":500,"message":"Internal server error"}
```

The block asserted it "needs only a live apps/api + Postgres + Redis … NOT the
harness/Temporal/SMR/NLP stack". That claim was invalidated by TASK-732, which moved the
seam decision **into the controller**: `generateSummaryAsync`
(`apps/api/src/modules/consultation/consultation.controller.ts:1281`) now calls
`NoteGenerationService.generate`, which calls `HarnessGatewayService.start` deliberately
**not** optional-chained —
`note-generation.service.ts:99` carries the comment *"NOT optional-chained (`.start(` not
`?.start(`) — a missing gateway throws here rather than silently no-op'ing."* With
apps/harness (:8866) down, that throw becomes a 500.

**Not a product defect for the purposes of this ticket** — but see *Owner decisions*
below regarding the 500-vs-503 mapping.

---

#### 6. `task-709-note-occ.spec.ts:173` — **(d) environment-dependent; a documented requirement that was never enforced**

**Root cause.** The block's `beforeAll` generates a summary via `POST :id/summary`, which
forwards to SMR. With apps/text down:

```
consultation=01a0155c-46b2-7343-8e37-82449d8719f6
context add status=201
summary status=400
{"message":"Failed to call SMR service: AggregateError: connect ECONNREFUSED ::1:8862;
  connect ECONNREFUSED 127.0.0.1:8862","error":"Bad Request","statusCode":400, …}
```

The dependency was *documented* in the file header ("Requires a reachable apps/text (SMR)
… mirrors the FULL-loop dependency documented in `harness-gate.spec.ts`") but never
*enforced*: the `beforeAll` hard-asserted `[200,201]`, so under `mode: 'serial'` Playwright
charged the setup failure to the first test in the block — "GET the generated summary
carries a strong ETag equal to its version" — which reads as an OCC regression rather than
an absent service.

---

### Summary of categories

| # | Spec | Category | Root cause |
|---|---|---|---|
| 1 | `agent-management-contract:287` | **(d)** | apps/text (SMR) down → 400; assertion conflated "not OCC-gated" with "SMR up" |
| 2 | `auth-throttle-per-endpoint:117` | **(d)** | opt-in guard written opt-out; unset `RATE_LIMIT_ENABLED` left the spec running with throttling off |
| 3 | `consultation-job-cross-user:163` | **(c)/(d)** | fixture seeded into the dev Redis by silent default; no visibility precondition. **Product verified correct.** |
| 4 | `task-658-context-schema-plane:94` | **(b)** | TASK-686 day-1 seed gives every seeded tenant a published context schema |
| 5 | `task-704-generator-seam:86` | **(d)** | apps/harness down → `HarnessGatewayService.start` throws → 500 |
| 6 | `task-709-note-occ:173` | **(d)** | apps/text down → generate 400 in `beforeAll`; documented dependency never enforced |

**No product defects were found among the six.** Every fix below is test-only; no
application code was changed, so the running test API needed no rebuild.

---

## Implementation Plan

All six fixes are test-only and follow patterns already established in this suite —
principally the probe-and-self-skip shape of `streaming-ticket-refresh.spec.ts`
(`beforeAll` records a `skipReason`; each test opens with `test.skip(!x, skipReason)`).

1. **#1** — assert the actual contract, and strengthen it: `not.toBe(428)` **and**
   `not.toBe(412)` unconditionally (the absence of *any* OCC gate, which is more than the
   old test checked), then `console.warn` when the run could not reach SMR.
   → verify: spec passes with SMR down; still fails if the route ever starts demanding
   `If-Match`.
2. **#2** — invert the guard to opt-in (`!== 'true'`) and name the observed value in the
   skip reason. → verify: skips under both `dotenv` and bare invocations.
3. **#3** — prefer `REDIS_URL` in `buildRedisClient()`; add a bounded creator-read
   visibility probe in `beforeAll` and gate all three tests on it. → verify: passes under
   `dotenv`; skips (not fails) under bare.
4. **#4** — self-provision a throwaway tenant as `super_admin` and read discovery on it via
   `x-tenant-id` elevation; add a companion test pinning the *configured* case so the seed
   change is covered rather than merely accommodated. → verify: both tests pass.
5. **#5** — capture a non-2xx create as `skipReason` instead of asserting; correct the
   stale "does not need the harness" comment. → verify: skips with harness down.
6. **#6** — capture a non-2xx generate as `skipReason`; gate all five tests in the block;
   guard the `afterAll` cleanup. → verify: skips with SMR down; all OCC assertions
   unchanged.

Gates: `pnpm exec eslint <the six specs>`, `pnpm --filter @arcaai/api test`,
`pnpm api:build`, and a live re-run of each spec.

### Deliberately NOT weakened

- #1 gained an assertion (412) rather than losing one.
- #4 gained a test — the previously untested "configured tenant" arm is now pinned, so a
  future seed regression that drops the day-1 schema fails the suite.
- #3, #5, #6 changed **nothing** about what is asserted when the dependency is present;
  they only stop a missing dependency from being reported as a broken contract.

---

## Implementation Summary

All six failures are categorised with live evidence (captured above, against the running
test API before it went down — see *Blocked* below). **No product defects were found**;
all six fixes are test-only, so the shared test API needed no rebuild.

### Verification evidence

**Isolation vs full-suite runs** (`RESET_DB=false … --workers=1`), which is what separated
category (c)/(d) from the rest:

| Spec | In isolation, `dotenv -e .env.test` | Bare (no `.env.test`) |
|---|---|---|
| `agent-management-contract` | `1 failed` (`test run → 400`), 8 passed | same |
| `auth-throttle-per-endpoint` | `3 skipped` | `1 failed` — `[401,401,401,401,401,401]` |
| `consultation-job-cross-user` | `3 passed` (8/8 across repeats) | `1 failed` — `Received: 404` (2/2) |
| `task-658-context-schema-plane` | `1 failed` — expected `"none"`, got `"d008b1594b680fe8412c336490178cea"` | same |
| `task-704-generator-seam` | `1 failed` — create returned `500` | same |
| `task-709-note-occ` | `1 failed` — generate returned `400`, 3 passed | same |

**Lint** — all six specs, clean:

```
$ pnpm exec eslint apps/api/tests/e2e/{agent-management-contract,auth-throttle-per-endpoint,\
consultation-job-cross-user,task-658-context-schema-plane,task-704-generator-seam,task-709-note-occ}.spec.ts
exit=0
```

**Unit tests** — `pnpm --filter @arcaai/api test`:

```
 Test Files  227 passed | 2 skipped (229)
      Tests  3283 passed | 4 skipped (3287)
   Duration  45.91s
```

**Build scope** — `apps/api/tsconfig.build.json` excludes `tests`, `**/*spec.ts` and
`**/__tests__/**`, so these changes are provably outside `pnpm api:build`.
`pnpm exec tsc --noEmit -p apps/api/tsconfig.build.json` reports **no errors**.
`pnpm api:build` itself was deliberately NOT run — its script begins
`rimraf dist tsconfig.build.tsbuildinfo`, and a sibling agent (TASK-761) holds a large
uncommitted working tree in `apps/api/src` with a `nest start --watch` supervisor against
the same `dist`. The non-destructive typecheck above covers exactly the same file set.

A full-scope `tsc --noEmit -p apps/api/tsconfig.json` (which *does* include tests) reports
two errors, both in `apps/api/src/modules/user/controllers/__tests__/users-me-route-precedence.test.ts`
(`TS1343: 'import.meta' …`) — a TASK-761-owned file, untracked at session start, unrelated
to this ticket. None of the six edited specs produces a diagnostic.

### Files changed

| File | Change |
|---|---|
| `apps/api/tests/e2e/agent-management-contract.spec.ts` | #1 — assert no-OCC-gate (428 **and** 412) unconditionally; warn when SMR unavailable |
| `apps/api/tests/e2e/auth-throttle-per-endpoint.spec.ts` | #2 — guard inverted to opt-in `RATE_LIMIT_ENABLED !== 'true'` |
| `apps/api/tests/e2e/consultation-job-cross-user.spec.ts` | #3 — `REDIS_URL` preferred; bounded fixture-visibility probe; three `test.skip` guards |
| `apps/api/tests/e2e/task-658-context-schema-plane.spec.ts` | #4 — self-provisioned unconfigured tenant for the K7 arm; new configured-tenant test; header corrected |
| `apps/api/tests/e2e/task-704-generator-seam.spec.ts` | #5 — harness-dispatch failure becomes a skip; stale comment corrected |
| `apps/api/tests/e2e/task-709-note-occ.spec.ts` | #6 — SMR-generate failure becomes a skip across the block; `afterAll` guarded |

No application code changed.

### Blocked — live re-run of the six fixed specs

The shared test API on port 8968 **went down mid-session** and did not come back
(`curl … /api/v1/health` → `000`; nothing listening on 8968). It was not stopped by this
ticket: no product code was changed here, and the sibling TASK-761 session holds a large
uncommitted `apps/api/src` working tree with `nest start --watch` against the same `dist`.
Per this ticket's constraints the server was neither killed nor restarted.

Consequently the *root causes* were all verified live (every command output above was
captured against the running API), but the *fixes* have not yet been re-run end to end.
Once someone brings the test API back (`pnpm test:up:api`), re-run:

```bash
RESET_DB=false pnpm exec dotenv -e .env.test -- playwright test \
  apps/api/tests/e2e/agent-management-contract.spec.ts \
  apps/api/tests/e2e/auth-throttle-per-endpoint.spec.ts \
  apps/api/tests/e2e/consultation-job-cross-user.spec.ts \
  apps/api/tests/e2e/task-658-context-schema-plane.spec.ts \
  apps/api/tests/e2e/task-704-generator-seam.spec.ts \
  apps/api/tests/e2e/task-709-note-occ.spec.ts --workers=1
```

Expected with the Python services down: `task-704` and the `task-709` summary block
**skip** with a logged reason; `agent-management-contract:287` **passes** (the no-OCC-gate
contract holds regardless of SMR); `auth-throttle` **skips**; `consultation-job-cross-user`
and `task-658` **pass**.

One assumption in fix #4 rests on code reading rather than a live probe, because the API
died during exactly that experiment: that a `super_admin` JWT plus `x-tenant-id` elevates
onto the throwaway tenant for the discovery read. It is well grounded —
`resolve-active-tenant.ts` returns `elevate` for "super-admin + empty JWT tenant +
valid-UUID header", the discovery controller is `@Authorize()` (any authenticated caller),
and its `@RequiredScopes('tenant:context-schema:read')` sets `API_KEY_REQUIRED_SCOPES`,
which by construction constrains API-key callers only and leaves JWT callers unaffected —
but it is the one line of this ticket that a live run should confirm first.

---

## Owner decisions / recommendations (not actioned)

1. **An unreachable downstream service is reported as a 4xx or a 500, never a 503.**
   - `POST /admin/prompt-templates/:id/test` and `POST :id/summary` answer **400 Bad
     Request** for `connect ECONNREFUSED …:8862`. The caller's request was not bad; the
     dependency was absent. 502/503 is the honest mapping, and the message currently leaks
     the internal host:port to the client.
   - `POST :id/summary/async` answers an opaque **500** when `HarnessGatewayService.start`
     throws. The same controller already models the right shape one branch away — it
     throws `ServiceUnavailableException` when the seam resolves to the deleted legacy
     generator (`consultation.controller.ts:1318`). An unreachable harness deserves the
     same 503 treatment.
   - Both are product-behaviour changes affecting the public error contract and would
     require rebuilding the shared test API, so they are recorded here rather than made.

2. **The suite has no guard against being run without `.env.test`.** Two of these six
   failures existed purely because a bare `pnpm exec playwright test` silently gives specs
   a different Redis and a different view of the API's configuration. The individual specs
   are now robust, but a `globalSetup` assertion — e.g. fail fast unless a sentinel from
   `.env.test` is present in `process.env` — would prevent the whole class. Worth its own
   ticket.

3. **Test-DB drift.** The test database carries accumulated state from repeated
   `RESET_DB=false` runs (bumped OCC versions, ~15 soft-deleted throwaway tenants from
   earlier e2e runs, 6.7k Redis keys). None of the six failures is explained by that drift
   — each was reproduced from first principles above — but a fresh
   `pnpm test:db:reset` before the next full-suite baseline would remove the variable.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-18 | Ticket opened. All six failures reproduced in isolation and under both invocations; categorised with live evidence — **no product defects**: one (b) stale premise, one (c)/(d) fixture-targeting, four (d) environment-dependent. Six test-only fixes implemented. `eslint` clean; `tsc --noEmit -p tsconfig.build.json` clean; `pnpm --filter @arcaai/api test` 3283 passed. Live e2e re-run of the fixed specs BLOCKED: the shared test API on :8968 went down mid-session (sibling TASK-761 holds an uncommitted `apps/api/src` tree) and per this ticket's constraints was not restarted. |
| 2026-08-20 | Status advanced to Completed per owner directive: implementation complete (all six failures reproduced, categorized as no product defects, and fixed; lint/typecheck/unit green); outstanding e2e/live-run verification (live e2e re-run blocked on the shared test API being back up) is not a status gate. | Owner directive |

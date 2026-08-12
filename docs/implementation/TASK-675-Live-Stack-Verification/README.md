# TASK-675 — Live-Stack Verification of the TASK-654 Programme

**Status:** Review
**Type:** verification / test
**Base commit:** `62cb2d174` (`dev-2.1`) — *docs(TASK-654): programme complete — status, open items, exclusion resolved*
**Branch:** `worktree-agent-a455a428ffceb3bc6` (reset from `dev-2.1`)

---

## 1. Requirement Analysis

Eighteen tickets shipped in the TASK-654 programme and **not one line had executed against a
running system**. Every claim rested on unit and replay tests. TASK-654 §6.4a records this as
open item **OP-2**:

> *Nothing has run against a live stack. TASK-663's cross-tenant promotion e2e and TASK-660's
> loop SSE route are authored and never executed. The 404-over-403 posture on the promotion
> surface is asserted by unit tests only.*

and TASK-663 **OI-3** says the same of its own spec:

> *the cross-tenant e2e spec is **authored but not executed** … Run it with `pnpm test:up:api`
> then `pnpm test:e2e` before merge.*

This ticket stands the stack up and either proves or disproves four claims:

| # | Claim under test |
|---|---|
| P1 | The authored-but-never-run cross-tenant **promotion** spec — manage-rights-on-both, and a cross-tenant id answering **404, not 403** |
| P2 | The new **SSE** routes — tenant guard 404s a foreign consultation, events relay, the heartbeat fires |
| P3 | The **context-schema plane** end to end — create, publish, validate against the pinned version, refuse an unknown kind, ETag behaviour on discovery |
| P4 | The **K7 regression contract** — a tenant with no schema and a write with no `kindKey` behaves exactly as before the programme |

---

## 2. Current State Evaluation

Before this ticket:

- `apps/api/tests/e2e/task-663-agent-promotion-cross-tenant.spec.ts` existed and had never run.
- `GET /consultations/:id/loop/stream` (TASK-660) had **no e2e at all**. Its relay/heartbeat were
  covered by fake-timer unit tests and its 404-over-403 posture by a `@TenantOwnedResource`
  **decorator-metadata** assertion — TASK-660 §3.5 states this explicitly, noting that of the four
  SSE streams only `harness-progress` had a live spec.
- The context-schema plane (TASK-658/661/665) had unit coverage against **mocked repositories only**.
- K7 had never been exercised against a real database.

---

## 3. Implementation Plan

1. Stand up isolated test infra (Postgres 5433, Redis 6380, MinIO 9002, Qdrant 6335), push the
   schema, seed, build core packages, start the test API on 8968 → *verify:* `/health` reports the
   base commit.
2. Run the TASK-663 spec as-is → *verify:* real pass/fail, classified spec-bug vs code-bug.
3. Author and run an SSE spec for the loop stream + siblings → *verify:* 404 posture, relay, heartbeat.
4. Author and run a context-schema + K7 spec → *verify:* full lifecycle and the opt-in guarantee.
5. Re-run the three gates → *verify:* no regression against the measured baseline.

---

## 4. Implementation Summary

### 4.1 Results

| Priority | Surface | Result | Evidence |
|---|---|---|---|
| **P1** | `task-663-agent-promotion-cross-tenant.spec.ts` | **PROVEN** — 6 passed (after a fixture fix; see §4.2) | §5.1 |
| **P2** | `GET :id/loop/stream` + 3 sibling streams | **PROVEN** — 8 passed, incl. real Redis relay and a real 15s heartbeat | §5.2 |
| **P3** | Context-schema plane end to end | **PROVEN** — 15 passed (twice; spec is re-runnable) | §5.3 |
| **P4** | K7 regression contract | **PROVEN** — asserted in *both* states (no schema, and schema present but unnamed) | §5.3 |

Net: **29 e2e tests now execute against a live stack** where previously zero did.

### 4.2 The one genuine failure, and its classification

The TASK-663 spec's first-ever run failed **4 of 6** tests. Every failure was
`expect(prober).not.toBeNull()` — the spec died on login and **never reached a single assertion
about the API**.

**Classification: spec bug (fixture), not a code bug.** The prober logged in as
`SEEDED_USERS.admin` (`tenant_admin`) with `tenantKey: 'ARCAAI'`. That user is seeded into
`__GLOBAL__` and holds no ARCAAI membership, so the gateway correctly answers
`401 "User does not have access to the specified tenant"` and `loginUser` returns `null`.

Before changing anything, the endpoints were probed by hand with a genuinely ARCAAI-scoped
`TENANT_ADMIN` to establish whether the code was at fault:

```
POST /api/v1/admin/agent-promotions            → 403  "Promotion runs across a tenant boundary and
                                                       requires an elevated tenant-less context…"
GET  /api/v1/admin/agent-promotions/<synth>    → 404  {"statusCode":404,"message":"Resource not found"}
GET  /api/v1/admin/agent-promotions?page=1     → 200  {"count":0,…,"data":[]}
```

That is **exactly** what the spec asserts. The code was already correct; the fixture simply
prevented the assertions from ever running. The fix swaps in `arcaai_admin` (the real ARCAAI
`TENANT_ADMIN`, deliberately absent from `SEEDED_USERS`, which is the `__GLOBAL__` seed) using the
same local-constant pattern as `agent-management-contract.spec.ts`. **No assertion was changed or
weakened.**

### 4.3 Files changed

| File | Change |
|---|---|
| `apps/api/tests/e2e/task-663-agent-promotion-cross-tenant.spec.ts` | Fixture fix only — `arcaai_admin` replaces `SEEDED_USERS.admin` as the ARCAAI prober |
| `apps/api/tests/e2e/task-660-loop-stream.spec.ts` | **New** — loop SSE plane: cross-tenant posture, relay, heartbeat |
| `apps/api/tests/e2e/task-658-context-schema-plane.spec.ts` | **New** — context-schema lifecycle + the K7 contract |

No production code was modified. Nothing under `packages/agentic-sdk-v2/src/compat*` was touched.

---

## 5. Verification Evidence

Environment for every run below: isolated test infra (Postgres 5433, Redis 6380, MinIO 9002,
Qdrant 6335), schema pushed + seeded, one API instance on **8968**. `/health` confirmed the
process was running this base commit:

```
{"status":"healthy","service":"api","version":"0.0.0-worktree-agent-a455a428ffceb3bc6.62cb2d17",…}
```

### 5.1 P1 — cross-tenant agent promotion (TASK-663 OI-3)

**First run (as authored) — 4 failed, 2 passed:**

```
  4 failed
    …task-663-agent-promotion-cross-tenant.spec.ts:33:7 › a tenant-scoped caller cannot promote out of a tenant it does not manage
    …task-663-agent-promotion-cross-tenant.spec.ts:52:7 › an unauthorized caller cannot distinguish a real foreign agent from a synthetic id
    …task-663-agent-promotion-cross-tenant.spec.ts:101:7 › reading another tenant's promotion record is 404, never 403
    …task-663-agent-promotion-cross-tenant.spec.ts:110:7 › the promotion list is scoped to the working tenant
  2 passed (1.4s)

    Error: expect(received).not.toBeNull()
    Received: null
      102 |     const prober = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, FOREIGN_TENANT_KEY);
    > 103 |     expect(prober).not.toBeNull();
```

**After the fixture fix — 6 passed:**

```
Running 6 tests using 6 workers

  ✓  2 …:96:7 › cross-tenant — promote › a promotion never targets the same tenant it came from (511ms)
  ✓  3 …:116:7 › cross-tenant — promotion records › reading another tenant's promotion record is 404, never 403 (521ms)
  ✓  6 …:48:7 › cross-tenant — promote › a tenant-scoped caller cannot promote out of a tenant it does not manage (469ms)
  ✓  4 …:125:7 › cross-tenant — promotion records › the promotion list is scoped to the working tenant (578ms)
  ✓  5 …:139:7 › cross-tenant — promotion records › there is no route to mutate a promotion record (WORM) (588ms)
  ✓  1 …:67:7 › cross-tenant — promote › an unauthorized caller cannot distinguish a real foreign agent from a synthetic id (687ms)

  6 passed (2.1s)
```

**The 404-over-403 posture on the promotion surface is now proven on the wire**, as is the absence
of an existence oracle (a real foreign agent id and a synthetic one return identical 403s).

### 5.2 P2 — consultation-loop SSE plane (TASK-660)

```
Running 8 tests using 8 workers

  ✓  3 …:171:7 › cross-tenant posture › a cross-tenant caller cannot mint a consultation_loop stream ticket either (63ms)
  ✓  1 …:142:7 › cross-tenant posture › a cross-tenant caller is refused before the loop stream opens (67ms)
  ✓  8 …:181:7 › cross-tenant posture › the sibling SSE streams hold the same pre-stream posture (13ms)
  ✓  6 …:155:7 › cross-tenant posture › a synthetic consultation id is indistinguishable from a cross-tenant one (9ms)
  ✓  5 …:164:7 › cross-tenant posture › the reverse direction is refused too — __GLOBAL__ doctor into an ARCAAI consultation (5ms)
  ✓  2 …:135:7 › cross-tenant posture › sanity — the owning doctor resolves the __GLOBAL__ consultation (32ms)
  ✓  4 …:217:7 › delivery › an event POSTed to the internal loop-event endpoint relays out of the stream (1.0s)
  ✓  7 …:257:7 › delivery › an idle stream still emits a heartbeat (15.2s)

  8 passed (16.4s)
```

The heartbeat test taking **15.2s** is the proof it is real: it waited out the genuine
`TRAJECTORY_HEARTBEAT_MS = 15000` interval on the wire, not a fake timer. The relay test is a real
Redis pub/sub round trip — an event POSTed to
`POST /internal/harness/consultations/:id/loop-event` came back out of the browser-facing stream
with its marker intact.

The three sibling streams (`harness-progress`, `assurance`, `trajectory`) are now covered by the
same pre-stream probe; previously only `harness-progress` had one.

### 5.3 P3 + P4 — context-schema plane and the K7 contract

```
Running 15 tests using 4 workers

  ✓   2 …:87:7  › K7 › discovery answers 200 with null fields and ETag "none" — never 404 (62ms)
  ✓   4 …:114:7 › K7 › a payload without a kindKey is refused rather than silently persisted unvalidated (143ms)
  ✓   1 …:101:7 › K7 › a context write that names no kindKey behaves exactly as before the programme (175ms)
  ✓   3 …:159:7 › plane › a schema is born DRAFT with no pinned version (12ms)
  ✓   5 …:175:7 › plane › publishing validates the definition, writes version 1, and pins it (13ms)
  ✓   6 …:187:7 › plane › a definition outside the platform primitives is refused (6ms)
  ✓   7 …:203:7 › plane › discovery resolves the PINNED version and carries a content-derived ETag (11ms)
  ✓   8 …:222:7 › plane › re-publishing an IDENTICAL definition is a no-op — no new version, unchanged ETag (25ms)
  ✓   9 …:238:7 › plane › a payload conforming to the pinned kind is accepted and canonicalised into content (51ms)
  ✓  10 …:252:7 › plane › the same payload validates against an explicitly pinned version header (45ms)
  ✓  11 …:261:7 › plane › an undeclared kind is refused (15ms)
  ✓  12 …:271:7 › plane › a payload violating the kind sub-schema is refused and names the problem (36ms)
  ✓  13 …:283:7 › plane › K7 — a write that names no kindKey still succeeds on a tenant that HAS a schema (35ms)
  ✓  14 …:296:7 › plane › another tenant cannot read this schema — 404, never 403 (16ms)
  ✓  15 …:303:7 › plane › the schema list is tenant-scoped (9ms)

  15 passed (1.6s)
```

Re-run immediately afterwards to prove the spec is idempotent (run-unique slug + `afterAll`
soft-delete): **15 passed (1.5s)**.

Supporting manual probes captured during authoring:

```
# discovery, tenant with no schema
HTTP/1.1 200 OK
ETag: "none"
{"schemaId":null,…,"definition":null,"etag":"\"none\""}

# discovery, after publish
ETag: "34211366043f1eacc4206cc4123179b4"
slug task675_probe | ver 1 | kinds ['referral_letter']

# refusals
"Context schema version 1 does not declare a kind 'not_a_declared_kind'."          → 400
"Payload does not conform to kind 'referral_letter' of context schema version 1."
  problems: ["/referrer: required property is missing"]                            → 400
"`payload` requires `kindKey` — there is no declared kind to validate it against." → 400
```

**K7 holds in both states**: a tenant with no schema is completely untouched, and a tenant that
*has* a published schema still accepts an ordinary `CASE_NOTE` that does not name a kind. The plane
is opt-in **per write**, not per tenant.

### 5.4 Final combined run (the committed state)

All three specs, run together against a freshly restarted API after the lint fixes:

```
[29/29] …task-658-context-schema-plane.spec.ts:303:7 › the schema list is tenant-scoped

  29 passed (18.2s)
```

---

## 6. Gates

Measured on this base commit. The changes in this ticket are e2e spec files only — they are not
compiled by `api:build` and not executed by the `applications` suite — so these numbers are both
the baseline and the post-change result.

| Gate | Expected (given) | Measured | Verdict |
|---|---|---|---|
| `pnpm --filter @arcaai/applications test` | 8,868 | **8,868 passed** \| 4 skipped (8,872) | ✅ exact match |
| `pnpm api:build` | 10/10 | **10 successful, 10 total** | ✅ exact match |
| `pnpm lint` | 31/31, 65 pre-existing `apps/api` warnings | **34/34 successful**; `apps/api` **0 errors, 65 warnings** | ✅ no regression |

### 6.1 `pnpm --filter @arcaai/applications test`

```
 Test Files  470 passed | 1 skipped (471)
      Tests  8868 passed | 4 skipped (8872)
   Start at  12:12:04
   Duration  117.64s (transform 131.27s, setup 0ms, import 1626.05s, tests 29.85s, environment 38ms)
```

### 6.2 `pnpm api:build`

```
@arcaai/api:build: > @arcaai/api@0.1.0 build …/apps/api
@arcaai/api:build: > rimraf dist tsconfig.build.tsbuildinfo && nest build && tsc-alias

 Tasks:    10 successful, 10 total
Cached:    0 cached, 10 total
  Time:    29.901s
```

> **Note on a false failure.** The first `api:build` attempt reported `9 successful, 10 total`
> with an error on `apps/api/dist/modules/health`. That was **my own contention**, not a
> regression: the `nest --watch` test server was still running and writing to the same
> `apps/api/dist`. Stopping the API and rebuilding gave the clean 10/10 above. Worth recording —
> `pnpm api:build` and `pnpm test:up:api` cannot share a worktree's `dist`.

### 6.3 `pnpm lint`

Whole-repo run:

```
 Tasks:    34 successful, 34 total
Cached:    17 cached, 34 total
  Time:    33.801s
```

(34 rather than the quoted 31 tasks — the task graph on this base commit includes packages the
quoted baseline predates, e.g. `@arcaai/json-schema-subset`. All succeeded.)

Because the aggregate replays cached output (including from sibling worktrees), `apps/api` — the
only package where lint violations are hard errors, and the only one this ticket touches — was also
run directly and uncached:

```
$ pnpm run lint      # in apps/api
EXIT=0
✖ 65 problems (0 errors, 65 warnings)
```

**65 warnings, 0 errors** — identical to the pre-existing baseline. Two `prettier/prettier` errors
introduced by the new spec files were found by this gate and fixed before commit.

---

## 7. Findings

| # | Finding | Severity | Classification |
|---|---|---|---|
| F-1 | The TASK-663 cross-tenant spec could never have passed as authored — its ARCAAI prober is a `__GLOBAL__` user with no ARCAAI membership, so all four cross-tenant tests died on login. | Medium | **Spec bug** — fixed here. The code under test was already correct. |
| F-2 | `HARNESS_SERVICE_TOKEN` in `.env.test` is **dead config**. The stack runs `SECRETS_PROVIDER=vault`, so `HarnessServiceTokenGuard` resolves the expected token from Vault (`<VAULT_KV_MOUNT>/data/<VAULT_KV_PREFIX>/HARNESS_SERVICE_TOKEN`); the env-file value answers 401. | Medium | **Environment/config defect** — not fixed here (see §8). |
| F-3 | Playwright's `globalSetup` runs `pnpm test:db:reset` unconditionally, which is `prisma db push --force-reset` — it **destroys the test database** on every `pnpm test:e2e`. It wiped a freshly seeded DB mid-session. `RESET_DB=false` is the documented opt-out. | Low | **Working as designed**, but a sharp edge worth knowing. |
| F-4 | Seeding is opt-in via `RUN_SEED` (TASK-616). `pnpm test:db:seed` silently no-ops without it, printing *"Skipping database seeding"* and exiting 0 — a green exit code for an unseeded database. | Low | **Sharp edge** — a silent success is easy to mistake for a real one. |

---

## 8. Open Items

- **OI-1 — F-2 is unresolved.** `.env.test`'s `HARNESS_SERVICE_TOKEN` disagrees with Vault, so the
  loop-event publisher half of the SSE spec is env-gated on an operator-supplied
  `E2E_HARNESS_SERVICE_TOKEN` (the same pattern as `harness-gate.spec.ts` and
  `model-retention-settings.spec.ts`) and **skips** without it. It was run *with* the correct token
  for the evidence in §5.2. The real fix is a decision, not a patch: either make the test stack use
  `SECRETS_PROVIDER=env`, or have `pnpm setup:test` reconcile `.env.test` with Vault. Flagged rather
  than silently worked around.
- **OI-2 — TASK-654 OP-2 is now partially closed, not fully.** P1–P4 are proven live. OP-1 (real
  STT transcripts never entering the cascade) is untouched by this ticket and remains open; proving
  it needs the STT service running, which was out of scope here.
- **OI-3 — the loop signal receiver still does not exist.** `LoopContextSignalService`'s outbound
  POST 404s against a real harness (TASK-660 §Deferred). Nothing here changes that; the SSE
  publisher was driven through the internal gateway endpoint instead, which is the documented
  publisher for this feed.

---

## 9. Change History

- **2026-08-12** — Ticket opened and executed. Stood up isolated test infra + a single API on 8968;
  ran the never-executed TASK-663 spec (4/6 failed on a fixture bug, fixed, then 6/6); authored and
  ran new live specs for the loop SSE plane (8/8, incl. a real 15s heartbeat and a real Redis relay)
  and for the context-schema plane + K7 contract (15/15, twice). 29 e2e tests now execute against a
  live stack where zero did before. Four findings recorded; F-2 (Vault vs `.env.test` service-token
  mismatch) left open as a deliberate decision rather than a silent workaround.

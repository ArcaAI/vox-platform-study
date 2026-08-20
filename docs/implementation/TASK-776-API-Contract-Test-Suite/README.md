# TASK-776 — API Contract & Authorization Test Suite

| Field | Value |
|---|---|
| Status | Completed |
| Type | test / infrastructure |
| Branch | `feat/loop` |
| Surfaces | `apps/api`, `packages/applications` (read-only), `.claude/rules` |

## Requirement Analysis

Establish unit, integration and e2e coverage validating every `apps/api` HTTP surface for:
correct request validation, correct response parsing/serialization, and correct
authentication/authorization for four credential classes — super-admin JWT, tenant-admin JWT,
API key, and tenant service account. Then encode the resulting standard into the project rules.

## Current State Evaluation (recon, 2026-08-19)

The gateway was NOT uncovered — it was **unevenly** covered.

| Surface | Before |
|---|---|
| Controllers | 118 |
| Routes (runtime manifest) | 656 (408 admin, 53 OCC-guarded) |
| e2e specs | 106 |
| apps/api unit tests | 236 files |

Coverage was heavily skewed toward JWT paths:

| Dimension | Before |
|---|---|
| JWT super-admin / tenant-admin | ~90%+ of specs |
| Request validation | ~65% |
| Response-shape assertions | ~25%, mostly ad-hoc field reads |
| **API-key authz** | **~13 specs** |
| **Service-account-token authz** | **~6 specs** |

Module specs (billing, workflow, knowledge, tenant-*, ai-*) exercised JWT paths only and never
asserted what an API key or service-account token could reach on the same routes, so scope and
`@ForbidApiKey` regressions on the machine planes were largely uncaught.

Critically, **all four credential types were already obtainable** via `tests/helpers/e2e.helper.ts`
and seed data — including deliberately REVOKED and EXPIRED API-key fixtures. No new harness was
needed; the gap was usage, not capability.

## Implementation

### 1. Route manifest promoted to an authorization oracle

`apps/api/src/scripts/emit-route-manifest.ts` already emitted a runtime-accurate route walk using
the same `Reflector.getAllAndOverride([methodRef, ControllerClass])` lookup `UnifiedAuthGuard` and
the boot audits use. It covered only the service-account class. Extended with five fields:

| Field | Meaning |
|---|---|
| `apiKeyForbidden` | `@ForbidApiKey()` present |
| `apiKeyScopes[]` | `@RequiredScopes(...)`, deduped + sorted |
| `requiredPermissions` | `null` = no metadata, `[]` = bare `@Authorize()`, else `{action,subject}[]` — the null-vs-empty distinction is load-bearing for the boot audit |
| `isPublic` | `SKIP_AUTH_KEY` **or** the legacy `'isPublic'` key, mirroring the guard exactly |
| `permissionMode` | `'AND' \| 'OR' \| null` |

Also added the side-effect import of `bootstrap/third-party-public-routes`; without it the manifest
reported `/metrics` as non-public while the gateway serves it unauthenticated. Output remains
byte-deterministic (verified by double-run sha256) and the downstream consumer is unaffected
(`pnpm --filter @arcaai/vox-node gen:admin:check` → no drift, 52 areas, 390 routes).

### 2. Generated breadth — route authorization conformance matrix

`apps/api/tests/e2e/task-776-route-authz-matrix.spec.ts` + `tests/e2e/helpers/route-manifest.helper.ts`.
Sweeps all 656 routes in one `beforeAll` (1286 deduped requests, concurrency 24, 10s per-request
timeout, ~4s wall clock), then asserts:

| Case | Count | Assertion |
|---|---|---|
| A1 | 615 | non-public route rejects no-credential with 401 |
| A2 | 437 | `apiKeyForbidden` route returns 403 to a VALID API key |
| A3 | 18 | `forbidServiceAccount` route returns 403 to a valid service token |
| A4 | 175 | no declared svc scopes ⇒ 403 (deny-by-default) |
| A5 / A5b | 17 / 24 | genuinely public routes reachable; `@Public()` internal routes are service-token gated |

Path params are substituted with a well-formed non-existent UUID so 404 is safe; every assertion
checks a **specific** rejection code, never "not 200". **0 routes returned 2xx to a forbidden
credential class. 0 skips. 0 timeouts.**

### 3. Hand-written depth — credential-class semantics

`task-776-credential-classes.spec.ts`, `task-776-credential-negative.spec.ts`. Eight invariants,
all holding. The two most important were proven with discriminating evidence:

- **Scopes AND abilities compose** — same key, same scope, rebound to a different human:
  `GET /workflows` 200 → **403 `Missing permissions: list:WorkflowDefinition`**. The *ability*
  message, not the scope message: the scope gate passed and the request still died on the bound
  human. A grant-time defense also refuses to mint such a key through the API.
- **Service-account tenant binding** — visible user sets byte-identical with no header and with
  `X-Tenant-Id` set to Global / SYSTEM / ARCAAI; a Global user fetched with `X-Tenant-Id: Global`
  returns **404**. No escalation vector.

Also asserted: ambiguous credentials (both API key and service token) 401 before either is
validated; revoked/expired/malformed credentials 401; and that a wrong secret and an unknown
clientId are **indistinguishable** at `POST /auth/service-token` (no client-id enumeration oracle).

### 4. Validation & parsing

`task-776-request-validation.spec.ts`, `task-776-response-parsing.spec.ts`. Global pipe
(`whitelist + forbidNonWhitelisted + forbidUnknownValues`) envelope, exception→status map, the full
If-Match matrix (strong quoted-decimal ETag; missing → 428; unquoted/weak/wildcard/negative/
non-numeric → 400; stale → 412; correct → 200 with increment), and both pagination envelopes.

### 5. Controller unit tests

66 tests across entitlements, rbac (`policies`, `permission-check`), service-account (both
controllers) and user (`password-reset`, `user-preferences`) — each asserting service delegation
plus the authorization metadata actually present on the handler/class, so decorator drift fails a
test. `billing` was found to already have full coverage and was correctly left alone.

## Verification

| Gate | Result |
|---|---|
| `playwright test task-776` | **75 passed** |
| apps/api unit suite | **245 files, 3842 tests passed** |
| `tsc --noEmit` (apps/api) | exit 0 |
| eslint (changed files) | exit 0 |
| `vox-node gen:admin:check` | no drift (52 areas, 390 routes) |
| manifest determinism | identical sha256 across two runs |

## Findings (behavior pinned as-is; no production code changed)

| Id | Finding |
|---|---|
| **F-01** | `BaseService.updateEntity()` (`base.service.ts:123-125`) stamps `updatedBy` **before** applying the DTO. When that stamp is a real value transition (NULL→user on a fresh row, or a change of editor) a semantically EMPTY PATCH still commits: **200, `_version` bumped, `updatedAt` rewritten, `ResourceUpdated` audit event**. The documented `hasChanges` → 400 guard only fires once `updatedBy` is stable, so the contract is **history-dependent** — the identical request returns 200 or 400 depending on who wrote the row last. Impact: no-op writes silently invalidate other clients' ETags (spurious 412s) and add audit noise. |
| **F-02** | Offset pagination echoes `limit: 0` when `limit` is omitted although the effective page size is 10; a client paginating off the echoed value computes the wrong offset. |
| **F-03** | `apps/api/src/filters/prisma.filter.ts` is never wired — Prisma mapping happens in `ExceptionInterceptor`. Dead code that reads as active protection. |
| **F-04** | `@ForbidApiKey()` is inert on 6 `@Public()` routes (`auth/login`, `auth/refresh`, `health` ×4) — `@Public()` short-circuits the guard so the 403 can never fire. Not exploitable; frozen as an inventory so new instances fail. |
| **F-05** | No `IsUUID` in the sampled request DTOs — ids are `IsString()+IsNotEmpty()`, so malformed ids reach the repository layer. |
| **F-06** | Prisma `P2025`→404 is structurally unreachable on OCC write paths (`findById` throws the domain 404 first; `updateWithVersion` uses `updateMany`). Documented rather than asserted. |

F-01 and F-02 are the two with client-visible consequences and are the recommended follow-ups.
None is an authorization hole: **no credential class reached a route it should not.**

## Test Hygiene (idempotency)

The e2e stack is normally run with `RESET_DB=false` against a shared, already-seeded test DB, so
specs that create rows MUST clean up after themselves. The two specs that create departments track
the ids **they** created in a worker-local array and delete exactly those in `test.afterAll`.

This is deliberately id-based rather than name-prefix based: Playwright runs a file's tests across
multiple workers and `test.afterAll` fires **once per worker**, so a prefix match (`t776-*`) would
let one worker delete rows a sibling worker was still using mid-test. That produced a real,
observed flake — a different test failed on each run — before the id-tracking fix.

Verified idempotent: three consecutive full runs, 75 passed each, 0 leftover `t776-*` rows after
every run.

## Change History

| Date | Change |
|---|---|
| 2026-08-19 | Initial implementation: manifest extended, 5 e2e specs (75 tests), 66 controller unit tests, rules updated (`05-nestjs-api.md` §API Test Standard, `01-development-workflow.md`, rules `README.md` v6.5.0). Six findings recorded. |
| 2026-08-19 | Test hygiene: added worker-local id-tracked cleanup to the two department-creating specs after observing cross-worker deletion flake; purged 123 leaked rows from earlier runs; verified idempotency over three consecutive runs. |

## Follow-up findings (post-fix review round)

Recorded from the REST and SSE/WebSocket reviews plus full-suite triage. Severity is as verified
against the running gateway, not as claimed.

| Id | Severity | Finding | Status |
|---|---|---|---|
| **C-01** | CRITICAL | DNA job status/stream looked jobs up in a global BullMQ queue with NO tenant/doctor check and returned `job.returnvalue` (`{reportId, reportData, styleText}`). Route carried `requiredPermissions: []`, so ANY authenticated user in ANY tenant could read it; BullMQ ids default to sequential integers, so the space is enumerable. | **Fixed + verified** — owner 200 / non-owner 404 at route and ticket-mint |
| **H-01** | HIGH | `?token=` rewrite in `unified-auth.guard.ts` was gated on nothing — a full session JWT in a query string authenticated ALL 656 routes, defeating the stream-ticket subsystem (query strings reach CDN logs, browser history, `Referer`). | **Fixed + verified** — `?token=<JWT>` now 401; `?ticket=` unaffected |
| **H-02** | HIGH | Stream-ticket scope registry was fail-OPEN: `dna_job:` and `text_task:` had no mint-time ownership branch. | **Fixed** — registry fails closed; `dna_job:` asserted; `text_task:` debt explicit |
| **M-01** | MEDIUM | SSE subscription setup raced teardown in 5 places: an aborted request leaked a Redis channel refcount permanently (StrictMode double-mount, nav-during-load, reconnect storms). | **Fixed** — one shared `sseFromRedisChannel` helper replaces 5 copies |
| **M-02** | MEDIUM | `consultation-job.service` force-completed a SHARED per-channel Subject, silently freezing every other viewer's stream. Same anti-pattern already fixed in 4 sibling services. | **Fixed** |
| **REST H-1** | HIGH | OCC is per-route, not per-resource: 49 of 88 PATCH/PUT routes are last-write-wins, and 8 aggregates are internally mixed (`PATCH /consultations/:id` unprotected while `prime`/`close`/`reopen` on the same row are). GETs emit an ETag, so clients are told the resource is conditionally updatable, then handed an unconditional write. | **Open** — breaking to fix; phased plan in the review |
| **REST H-2** | HIGH | Four incompatible error body shapes; `statusCode` absent from OCC 412s, `correlationId` absent from 404s, machine-readable `code` only on domain exceptions. | **Open** — fixable additively, non-breaking |
| **F-07** | MEDIUM | Nine sub-collection routes return `200` with an empty payload for a NONEXISTENT parent (`/admin/users/{missing}/roles`). Client cannot distinguish "no roles" from "no such user". Not a leak. | **Open** |
| **F-08** | — | Superseded by F-09 — the cursor `500` is not a keyset/race bug; it is the PHI decrypt crash below. | **Closed, merged into F-09** |
| **F-10** | **HIGH** | Audit snapshots persist PHI **plaintext** next to the ciphertext (`AuditLog.data.content`), defeating envelope encryption for audited clinical edits. Written at audit time, not at read time. Needs an owner decision. | **Open** |
| **F-09** | **HIGH → CRITICAL** | **PHI decrypt crashed every audit read — and the same path could silently DISCLOSE PHI.** `phi-read-decrypt.ts` `collectNode` matches `PHI_CIPHERTEXT_FIELDS` **by key name anywhere in the object graph** and recurses into arbitrary nested JSON — including `AuditLog.data`/`previousData` snapshots. Those snapshots JSON-serialize entity `Buffer`s as `{"type":"Buffer","data":[…]}`, so the walker finds e.g. `encryptedContent`, assumes a `Uint8Array`, and calls `Buffer.from(object)` → `TypeError [ERR_INVALID_ARG_TYPE]` → bare **500** (no `correlationId` — it escapes `ExceptionInterceptor`). | **Open** |

### Regressions introduced by our own fixes (caught by the FULL suite, not the targeted runs)

| Id | Cause | Status |
|---|---|---|
| **R-1** | F-01 moved the `hasChanges` guard ahead of the CAS, so a no-op payload skips the OCC precondition entirely: unchanged value + stale `expectedVersion` returned 200 instead of 412 (`tenant.service.ts:1291-1310`). Generalizes to every `if (!hasChanges) throw` service, which now 400s where it used to 412. | **Being fixed** — precondition must be evaluated before the no-changes short-circuit |
| **R-2** | C-01's mint applied the doctor-ownership rule to BOTH surfaces, so a tenant admin could read a job (200) but never mint a ticket for it (404) — making the admin SSE route dead for the Admin Console. | **Fixed + verified** — mint is now the union of both surface rules; route still re-asserts the precise one |

### F-10 — audit snapshots persist PHI plaintext (found while verifying F-09; needs an owner decision)

`AuditLog.data` for a `ContextItem` mutation contains **both** the ciphertext and the decrypted
transient:

```
data->>'encryptedContent'  = {"type":"Buffer","data":[…]}      (vault:v1:… ciphertext)
data->>'content'           = "advance before stale approve"     (PLAINTEXT)
```
Verified straight from the test DB; 4 `ContextItem` rows currently carry it, and no other
resourceType does.

This is NOT the F-09 read-path bug — the plaintext is written at AUDIT time, not decrypted at read
time. F-09's fix is confirmed correct precisely because the API response merely echoes what is
already stored.

Mechanism: the audit snapshot serializes the entity, and a PHI entity carries its decrypted value
as a transient field alongside the ciphertext column (`PHI_CIPHERTEXT_FIELDS` maps
`encryptedContent` → the transient `content`). Nothing strips the transient before persisting.

Why it matters: these columns are envelope-encrypted specifically because the database alone is not
treated as sufficient protection for PHI. Persisting the plaintext into `AuditLog.data` defeats that
for every audited clinical edit, and the audit table has a different retention and export profile
than the source table — `GET /admin/audit-logs/export` streams it to CSV.

The pattern for the fix already exists but was never generalized: `services/tenant/scrubbing.ts`
(`scrubLockedForAudit`) scrubs locked/secret values out of tenant-config audit payloads. There is no
equivalent for PHI transients, and the scrub is local to the tenant service rather than applied in
the shared audit path.

**Owner decision needed**, because the alternative reading is defensible: if audit snapshots are
deliberately plaintext for forensic reconstruction, then say so explicitly and scope the audit table
accordingly (retention, export gating, at-rest posture). What is not defensible is encrypting the
source column and silently copying the plaintext next to it.

### F-09 detail (verified 2026-08-19)

Stack: `Buffer.from` → `collectNode` (`packages/domains/src/common/phi-read-decrypt.ts:166`) →
`decryptPhiRows:195` → `AuditLogRepository.findAll` → `AuditLogService.exportFiltered`.

Offending stored value, straight from the test DB:
```json
"encryptedContent": {"data": [118, 97, 117, 108, 116, 58, 118, 49, …], "type": "Buffer"}
```

**All three audit read paths fail** once an affected row lands in the page — this is data-dependent,
not route-dependent:

| Route | Result |
|---|---|
| `GET /admin/audit-logs?page=40&limit=20` (offset) | **500** (pages 0–25 fine) |
| `GET /admin/audit-logs/cursor` | **500** at page 2 of the walk |
| `GET /admin/audit-logs/export?format=csv\|xlsx\|pdf` | **500** on all three |

Why it matters in production: any audited mutation of a PHI entity (ContextItem, Highlight,
NamedEntity, SummaryMeta, TranscriptionJob …) writes a snapshot containing serialized ciphertext
buffers. From then on, every audit read whose page includes that row returns 500. On a healthcare
platform the audit trail is a compliance surface — it failing closed-with-a-500 is an availability
defect, and it is guaranteed to occur rather than merely possible.

**The second-order concern was REAL, not hypothetical — confirmed by the fix's RED test.** Node's
`Buffer.from` *accepts* the `{"type":"Buffer","data":[…]}` JSON form, so the walker decrypted
`vault`-wrapped content out of an audit payload and wrote it onto `data.content` **without
throwing**. The crash and the silent-disclosure path are the same bug; which one you get depends
only on the byte payload. That reclassifies F-09 from an availability defect to a PHI disclosure
path, and it is why the fix must not be a `try/catch` or an `instanceof` skip — either would have
converted a loud crash into a quiet leak.

**Fix (verified):** matching is now schema-derived and model-scoped — `PHI_MODEL_CIPHERTEXT`
(14 models: only declared columns may be decrypted; `auditLog` declares none) and
`PHI_MODEL_RELATIONS` (44 parents / 98 edges: recursion follows only declared relation edges, so
`Json`/`JsonB` snapshot columns are structurally unreachable). The decision comes from the schema,
never from the value's shape. A schema-parity test re-derives both maps from `db_main/*.prisma` and
fails on drift. Any fix should scope the match to the model's declared ciphertext columns
rather than matching bare key names anywhere in the graph, and should stop recursing into opaque
JSON payload columns entirely.

Not caused by this ticket — `phi-read-decrypt.ts` is untouched here; our test traffic merely
generated the audit rows that expose it.

### Final full-suite attribution (2026-08-19, 1048 passed / 12 failed / 45 skipped)

Every remaining failure was attributed. **None is caused by the changes in this ticket.**

| Cause | Count | Specs |
|---|---|---|
| **F-09** (PHI decrypt crash, pre-existing) | 7 | `admin-fetchall-cross-tenant` (audit-logs), `shared-component-contracts` (cursor), `task-776-response-parsing` (cursor), `super-admin-backend-backlog` export ×4 |
| **Dirty-DB / spec self-pollution** (pre-existing spec defects) | 3 | `role-members-cross-tenant` M4, `task-615-invoice-lifecycle` idempotency, `task-729-nlp-task-expansion` topic list |
| **Environment** | 1 | `super-admin-ops-surfaces` — asserts `ENABLE_PRISMA_STUDIO` is unset |
| **Another session's in-flight edits** | 1 | `task-635-prompt-test-bench` (`prompt-management` is being modified concurrently) |

Evidence for the dirty-DB group, which is the one most likely to be misread as a cross-tenant leak:
`role-members-cross-tenant` M4 asserts a tenant admin sees 0 members of the SUPER_ADMIN role. It
sees 8. The DB holds **16** SUPER_ADMIN assignments scoped to the Global CUSTOMER tenant
(`50000000-…-0000`) versus 1 on SYSTEM — and all 16 were created between 15:00 and 17:00 on
2026-08-19, i.e. during this session's own test runs. The seed ships none. Tenant scoping is
working correctly; the specs create SUPER_ADMIN assignments and never clean them up. Same shape for
`task-729` (asserts `version === 0`, i.e. row must not exist, then creates it — passes once per DB)
and `task-615` (asserts invoice idempotency against a period a prior run already invoiced).

### Regressions introduced and then fixed within this ticket

All three were caught ONLY by the full 1123-test suite; every targeted run was green.

| Id | Regression | Resolution |
|---|---|---|
| **R-1** | F-01 moved the `hasChanges` guard ahead of the CAS, so a no-op payload skipped the OCC precondition entirely (unchanged value + stale `expectedVersion` → 200 instead of 412). | New shared `assertExpectedVersion` applied at 26 call sites; ordering is now precondition (412) → no-changes → write. Verified: unchanged+stale 412, changed+stale 412, unchanged+current 200 with no version burn. |
| **R-2** | C-01's ticket mint applied the doctor-ownership rule to BOTH surfaces, so a tenant admin could read a DNA job (200) but never mint a ticket for it (404) — the admin SSE route was dead for the Admin Console. | Mint is now the union of the two surface rules; the route still re-asserts the precise one. Verified: owner 200, same-tenant admin 200, non-owner clinician 404. |
| **R-3** | F-01 broke **PUT idempotency** — an identical repeat PUT returned 400 `No changes to write to.`, violating RFC 9110 §9.2.2 on 7 upsert routes an independent REST review had verified as idempotent. | No-changes behavior is now decided by HTTP method: PUT upserts return 200 + current representation (no write, no version bump, no sys-event); PATCH keeps the 400 contract. Verified: 3 identical PUTs → 200/200/200, version stable, stale → still 412. |

### Test-isolation notes

The e2e suite is run with `RESET_DB=false` against a test DB shared with several concurrent
sessions. Consequences observed and worth knowing before triaging a red suite:

- `task-776-response-parsing` cursor case fails in the full run but passes in isolation — cross-spec interference, not a defect.
- `agentic-policy`'s stale-`If-Match` test hardcodes `If-Match: "999"` and races a sibling test that CREATES the policy row; the first edit creates rather than updates, so the precondition never applies. Order-dependent, pre-existing.
- Continuous audit-log writes from the suite itself are what expose F-08.


## Final verification (2026-08-20) — zero failing tests

| Gate | Result |
|---|---|
| e2e, CI configuration (`--workers=1`, as `playwright.config.ts` sets for CI) | **1083 passed / 0 failed**, twice consecutively, **no DB reset between runs** |
| `apps/api` unit | 248 files / **3881** passed |
| `@arcaai/applications` | 519 files / **9566** passed |
| `@arcaai/domains` | **1821** passed |
| `@arcaai/database` | **1541** passed |
| `pnpm api:build` | 12/12 tasks successful |
| `tsc --noEmit` (api / applications / domains) | clean |
| eslint (all touched files) | 0 errors |
| `vox-node gen:admin:check` | no drift (52 areas, 390 routes) |
| route-manifest determinism | identical sha256 across re-runs |

### What it took to get from "12 failing" to zero, and what each failure actually was

None of the twelve were caused by this ticket's production changes. They fell into five classes,
and the distinction matters because four of them were latent defects rather than noise:

1. **PHI decrypt crash (7 failures)** — F-09. Fixed; see above.
2. **Specs that pass only once per database (3)** — `role-members-cross-tenant` M4,
   `task-729-nlp-task-expansion`, `task-615-invoice-lifecycle`. Each asserted a PROXY for its
   invariant that only holds on a virgin DB (`total === 0`, `version === 0`, `201 not 409`). The
   canonical `pnpm test:e2e` hid this by resetting in `globalSetup`, so a reset buys exactly ONE
   green run. Rewritten to assert the real invariant — every member belongs to the caller's tenant;
   the list round-trips verbatim using run-unique content; recompute returns the SAME invoice id on
   a period claimed fresh — each with worker-local id-tracked cleanup. Verified by three
   consecutive runs per spec with no reset.
   Notable correction found while doing it: `BillingService.computeDraft` **is** idempotent while a
   period is DRAFT; the 409 is the deliberate contract for FINALIZED/VOID. The spec was reusing a
   month its own later tests had terminalized. That contract is now pinned by an explicit assertion.
3. **A spec whose premise the tracked sample contradicts (1)** — `super-admin-ops-surfaces` asserted
   `enabled: false` "because `.env.test` does not set the flag", but `.env.sample` (tracked) carries
   `ENABLE_PRISMA_STUDIO=true` and `.env.test` is GENERATED from it, so the test could never pass
   for any developer. Rewritten to assert the honesty invariant it is named for: the probe agrees
   with whether the shell is actually mounted — true with the flag set or unset.
4. **A stale mock after another ticket's change (1)** — `s3.service.secret-gate.test.ts`. TASK-772
   changed the S3 readiness gate from `getSecretSync` to `await getSecretOptional`; the mock stubbed
   only the sync form, so the gate resolved no credentials and failed with the misleading
   `S3_ENDPOINT must be a valid URL`. Both forms are now stubbed from the same map.
5. **A real-work test against the default timeout (1)** — `task-760` presummary. The "scope fence"
   proves only routing, but the compat route accepts `{}` and performs a REAL summarization
   (~6.5s idle, well past 30s once the suite saturates apps/text). Raised per the existing house
   pattern (`task-709-note-occ.spec.ts:189`, added by TASK-772 for the identical cause).

### Local parallelism is flaky; CI is not

`playwright.config.ts` sets `workers: isCI ? 1 : undefined` with `fullyParallel: true`, so CI
serializes while a local run fans out. Under local parallelism the failing SET moves between runs —
`admin-panel-patch-surfaces` and `users-management-contract` fail intermittently because a file's
own tests mutate shared collections (roles, users) while sibling tests list and sort them. Both pass
in isolation and under `--workers=1`. The CI-equivalent invocation is the authoritative one and is
what the table above reports. Chasing a green local parallel run would mean fixing fixture sharing
inside those two specs — worth doing, but it is not a regression and not in this ticket's scope.

### Environment prerequisites discovered

`pnpm test:up:api` alone is not sufficient for a fully green suite. The test-port **text service on
:8962** must also be running (`./scripts/start-test-app.sh text`) or four specs fail — three on the
missing service and, subtly, `task-760` only becomes slow ONCE it is up. Starting it plainly yielded
gateway→text `401`s; exporting `SERVICE_TOKEN` (from `.env.test`'s `TEXT_SERVICE_TOKEN`) before
starting resolved it, after which the gateway correctly returns **404** for an unknown task —
the documented "upstream 4xx propagates" behaviour, rather than the 503 seen when the service is
absent. The precise mechanism behind the 401 was not isolated; recorded here as a runbook note, not
as a diagnosed defect.

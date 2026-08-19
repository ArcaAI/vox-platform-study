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

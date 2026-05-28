# TASK-309 — Cross-tenant CI hardening (genuine probes + TestAppModule harness)

| Field | Value |
|---|---|
| **Ticket** | TASK-309-CrossTenant-CI-Hardening |
| **Created** | 2026-05-28 |
| **Updated** | 2026-05-28 |
| **Status** | `Pending` |
| **Classification** | Test infrastructure (CI confidence) |
| **Priority** | Medium — production code is correct today; this prevents future regressions in W1/W3/W4b logic from slipping through CI |
| **Source** | TASK-307 §10.1 deferrals W7.A.2-followup + W7.A.10 + W7.A.19 |
| **Audit refs** | C-12 (refresh-token cross-tenant verification gap) + D-3 (4/5 W3 controllers use synthetic IDs) + C-7 (full HTTP walker) |
| **Base branch** | `fix/2605-review` (HEAD `2a1ee7be` — TASK-307 closed) |

---

## 1. Requirement Analysis

### 1.1 Description

TASK-307's W1 and W3 closed the cross-tenant production gaps. Three test-side gaps remain:

1. **W7.A.2-followup**: `auth-refresh.spec.ts` "Cross-tenant carry-through" today asserts stability (no 200, body shape unchanged) instead of active rejection. We need a genuine probe — issue a refresh in tenant A, attempt rotation with a JWT identifying tenant B, assert 401 + family revoke event.
2. **W7.A.10**: Cross-tenant E2E specs for Consultation Job, Storage, Transcription Job, Voice Profile use synthetic IDs (always 404, regardless of cross-tenant logic). Only TenantBucket has a genuine probe. We need genuine fixtures across the remaining 4 controllers.
3. **W7.A.19**: W4b's synthetic-module test gives the `APP_GUARD` contract guarantee but doesn't walk the real `AppModule` route tree. We need a `TestAppModule` that re-exports `AppModule`'s controllers + providers, but stubs the infra-heavy modules (`RedisServiceModule`, `BullModule`, `AuthServiceModule.OidcStrategy`, `AppSettingsService.initializeCache`), then walks every route via `supertest`.

### 1.2 Business context

Pure CI confidence work. Today's production code (W1's `RefreshTokenService.consume()` family-revoke + W3's `@TenantOwnedResource` interceptor + W4b's global `APP_GUARD`) correctly rejects cross-tenant probes. The gap is that CI doesn't actively prove this — a future refactor that accidentally weakens any of these guards would not be caught by tests.

### 1.3 Acceptance criteria

- **AC-1** `auth-refresh.spec.ts` "Cross-tenant carry-through" upgraded to a genuine probe:
  - Bootstrap two tenants (A, B) with their own users + access tokens.
  - Issue refresh in tenant A, capture the refresh token.
  - Attempt rotation while the JWT identifies tenant B (forge or use B's JWT against A's refresh token row).
  - Assert: 401 response, the refresh-token family in tenant A is fully revoked (verify via direct Redis inspection or follow-up legitimate rotation also 401s).
- **AC-2** Genuine cross-tenant probes added to:
  - `consultation-job-cross-tenant.spec.ts` — start a real job in tenant A, attempt access from tenant B.
  - `storage-cross-tenant.spec.ts` — create a real bucket file in tenant A, attempt download from tenant B.
  - `transcription-job-cross-tenant.spec.ts` — start a real transcription in tenant A, attempt status query from tenant B.
  - `voice-profile-cross-tenant.spec.ts` — enroll a real voice profile in tenant A, attempt deletion from tenant B.
- **AC-3** Each probe in AC-2 asserts: 404 (not 403) — the no-existence-leak posture from W3.
- **AC-4** A new `TestAppModule` is introduced under `apps/api/tests/helpers/` that:
  - Re-exports `AppModule`'s controllers + providers via `imports: [...AppModule.imports]` with module overrides.
  - Replaces `RedisServiceModule` with a stub providing only the symbols `UnifiedAuthGuard`, `RefreshTokenService`, and similar consumers actually need.
  - Replaces `BullModule.forRootAsync` with `BullModule.forRoot({ connection: { host: 'localhost', port: 0 } })` (lazy/dead connection) or a no-op module.
  - Replaces `AuthServiceModule`'s `OPENID_CLIENT` with `useValue: null`.
  - Stubs `AppSettingsService.initializeCache` to a resolved Promise.
- **AC-5** A new integration test `apps/api/tests/integration/full-route-walk.spec.ts` boots the `TestAppModule`, walks every controller route via `DiscoveryService` + `MetadataScanner`, hits each via `supertest` without an Authorization header, and asserts the W4b contract: `@Public()` routes → not 401; everything else → 401.

### 1.4 Out of scope

- Adding cross-tenant probes for `Roles`, `Policies`, `Audit Log`, `User` controllers (not SDK-facing; deferred to a future ticket if there's demand).
- Fixing any production bugs surfaced by AC-2/AC-5 → if found, PAUSE and report; address in a separate ticket.

---

## 2. Current State Evaluation

### 2.1 Existing code

- `apps/api/tests/e2e/auth-refresh.spec.ts` — has the stability-check probe; TSDoc at lines 149–159 explains the gap (TASK-307 W7).
- `apps/api/tests/e2e/{consultation-job,storage,transcription-job,voice-profile}-cross-tenant.spec.ts` — exist with synthetic IDs.
- `apps/api/tests/e2e/tenant-bucket-cross-tenant.spec.ts` — the reference implementation (genuine probe).
- `apps/api/tests/integration/auth-coverage.spec.ts` — W4a metadata walk + W4b synthetic-module contract test; full HTTP walker is the missing third leg.

### 2.2 Dependencies / impact areas

- E2E tests require the dev stack (`docker compose up postgres redis` + seeded multi-tenant fixtures).
- `TestAppModule` requires deep familiarity with `AppModule`'s DI graph — see TASK-307 §3 W4b for the blocker analysis on why a literal `imports: [AppModule]` doesn't work.

### 2.3 Risk

- Bootstrapping two tenants in CI may surface seed-data gaps. Use the existing `tenant-bucket-cross-tenant.spec.ts` fixture pattern as a template.
- `TestAppModule` may stay fragile as `AppModule` evolves. Document the override contract clearly so module additions trigger a CI failure (rather than silently bypassing the walker).

---

## 3. Implementation Plan

### 3.1 Phase order

1. **AC-4**: Build `TestAppModule` first. Verify boot via a sanity test (`app.init() + app.close()` in <5s with no Redis warning spam).
2. **AC-5**: Wire the full route walker using `TestAppModule`.
3. **AC-2 + AC-3**: Upgrade the 4 synthetic-ID probes to genuine ones, using `tenant-bucket-cross-tenant.spec.ts` as the template.
4. **AC-1**: Upgrade `auth-refresh.spec.ts` cross-tenant probe.

### 3.2 Testing

| Layer | Test |
|---|---|
| Integration | `full-route-walk.spec.ts` (NEW, AC-5) |
| Integration | `test-app-module.spec.ts` (NEW, AC-4 sanity) |
| E2E | `auth-refresh.spec.ts` (extend) |
| E2E | `consultation-job-cross-tenant.spec.ts` (rewrite) |
| E2E | `storage-cross-tenant.spec.ts` (rewrite) |
| E2E | `transcription-job-cross-tenant.spec.ts` (rewrite) |
| E2E | `voice-profile-cross-tenant.spec.ts` (rewrite) |

### 3.3 Estimated scope

- **AC-4 + AC-5**: M (4–6h) — `TestAppModule` is the bulk of the effort
- **AC-1**: S (1–2h)
- **AC-2 + AC-3** (4 specs): M (3–5h)
- **Total**: M-L (8–13h)

---

## 4. Implementation Summary
*(to be filled in at close-out)*

---

## 5. Change History

| Date | Description | Files modified |
|---|---|---|
| 2026-05-28 | Ticket created from TASK-307 §10.1 deferrals (W7.A.2-followup + W7.A.10 + W7.A.19) | — |

# OCC Coverage Inventory — REST review finding H-1

**Status:** Phase 0b + Phase 2 SHIPPED (2026-08-20) — the seven tier-A routes now require `If-Match`,
and the clients that drive them send it. Tier A is 0; the boot audit reports `46/88` protected
(was `39/88`) and the two sanctioned exceptions now come from in-place decorators, not the audit's
lookup table. Tier B is untouched and still needs `version` on its DTOs first (§9 phase 3).
**Source of truth:** `apps/api/route-manifest.json` (regenerate with `pnpm api:route-manifest`) plus the
boot audit `apps/api/src/bootstrap/occ-coverage-audit.ts`.
**Last measured:** 2026-08-20, against `feat/loop`.

## 1. The finding

Optimistic concurrency is applied **per-ROUTE**, not per-RESOURCE. RFC 7232's contract is
per-resource: if a client can obtain a validator for a row, every conditional write to that row
should honour it. Today of **88 PATCH/PUT routes, 39 carry `@RequiresIfMatch()`** — and eight
aggregates are internally *mixed*, meaning the same row is CAS-protected on one route and
clobberable on another.

Two distinct failure shapes hide behind that single number, and Phase 1's main result is that
they must be separated:

| Tier | What is true | Client-visible symptom | Count |
|---|---|---|---|
| **A — advertised but unenforced** (CLOSED — all seven flipped, 2026-08-20) | The response DTO carries `version`, so `ETagInterceptor` emits a strong `ETag`. A GET *tells* the client the resource is conditionally updatable; the write path then ignores `If-Match`. | Silent lost update, with a conflict-detection story the client reasonably believed in. | **7** |
| **B — versioned row, unexposed validator** | The Prisma row has `_version` (the standard model template gives it to every model), but the response DTO omits it, so `ETagInterceptor` never fires. The client is *still* handed a **weak Express content-hash ETag** (§8) that the write path will not accept. | Silent lost update — and worse than tier A, because a conforming client that echoes the validator back has its precondition **silently ignored** while believing it applied. Adding `@RequiresIfMatch()` alone would 428 every caller forever: there is no strong validator to echo. | **42** |

Tier A is worse than emitting no strong ETag at all, and it is where the *decorator* migration starts — but §8 shows the weak-ETag problem is larger than either tier and should be fixed first. Tier B needs a
DTO change (surface `version`) *before* a decorator change is even coherent — which is the single
most useful thing this inventory establishes.

## 2. Detection rule and its limits

Implemented in `apps/api/src/bootstrap/occ-coverage-audit.ts` (warn-only; see that file's header
for the full statement). A route is reported when it is PATCH/PUT, carries neither
`@RequiresIfMatch()` nor `@NoOptimisticConcurrency()`, and at least one of:

- **E1 `responseDtoVersion`** — a declared 2xx response model (read from `swagger/apiResponse` and
  `swagger/apiExtraModels`, i.e. including `@ApiEndpoint({ returnedModel })`) declares a `version`
  property via `@ApiProperty`. This is deliberately the *same* condition that makes
  `ETagInterceptor` fire.
- **E2 `expectedVersionParam`** — the handler takes an `@ExpectedVersion()` parameter, matched by
  factory identity rather than by name. The route already speaks OCC but never makes the
  precondition mandatory.

The audit therefore detects **tier A only**. Known error modes, stated rather than hidden:

- *Under-reports (dominant).* Any route whose response omits `version` — the whole of tier B — is
  invisible to it. Tier B below was assembled by hand from the manifest and is authoritative where
  the two disagree.
- *Under-reports.* A DTO inheriting `version` from a base class that does not decorate it with
  `@ApiProperty` is missed. (Today this cannot happen: `BaseResponse` in
  `packages/applications/src/common/dto/base.response.ts` has **no** `version` field at all — which
  is exactly why tier B is so large.)
- *Over-reports.* An action route that echoes a versioned resource back without mutating it has
  nothing to CAS on and is still flagged. `@NoOptimisticConcurrency('<reason>')` is the way to
  retire such a case from the report.

## 3. Mixed aggregates — highest risk, fix first

A client reasonably assumes per-resource consistency. These eight aggregates break that assumption
*within a single aggregate*, which is strictly more surprising than an aggregate with no OCC at all.

| Aggregate | Protected route(s) | Unprotected route(s) on the same row | Tier | Client blast radius of adding `@RequiresIfMatch()` |
|---|---|---|---|---|
| **Consultation** | `PATCH /consultations/:id/context/:contextId`, `PATCH /consultations/:id/summary/:summaryId`, `POST /consultations/:id/{prime,close,reopen}` | **`PATCH /consultations/:id`** | **A** | **Largest.** Clinician-facing, highest call volume. `@arcaai/vox` (browser) and `@arcaai/vox-node` both drive it; the admin console consultation screens do too. Two admin-console tabs on one consultation lose an edit silently today. |
| **Tenant** | `PATCH /admin/tenants/:id` | `PUT /admin/tenants/:id/tags`, `PATCH /admin/tenants/configs/:identifier` | A (tags), B (configs) | Admin console tenant screens + `hope.admin.tenants.*`. Low volume, single editor. |
| **HarnessPolicy** | `PATCH /admin/harness/policy`, `PATCH /admin/harness/policy/global` | `PATCH /admin/harness/live/config`, `PATCH /admin/harness/gate-edit-exemplars/:id/curation` | B | `/agentic-policy` screen + `hope.admin.harness.*`. Low volume. |
| **DnaWritingStyle** | `PATCH /dna-writing-styles/:reportId`, `PATCH /admin/dna-writing-styles/:reportId` | `PATCH /dna-writing-styles/:reportId/default`, `PUT /dna-writing-styles/settings` | **A** (both) | Playground DNA screen + SDK. `setSettings` already takes `@ExpectedVersion()` — it is one decorator away. |
| **TenantStorageConfig** | `PUT /admin/tenants/storage/config/platform` | `PUT /admin/tenants/storage/config` | B | Admin storage screen only. Very low volume. Note the *platform* row is protected and the *tenant* row is not — the inverse of the usual risk ordering. |
| **TenantTtsConfig** | `PUT /admin/tts-config/row` | `PUT /admin/tts-config/credentials/:provider` | B | Admin TTS screen. Its exact STT twin, `PUT /admin/stt-config/credentials/:provider`, **is** protected — a one-line divergence, not a design decision. |
| **TenantIdpConfig** | `PUT /admin/tenant-idp-config/:id` | `PUT /admin/tenant-idp-config/:id/directory-credentials` | **A** | Admin IdP screen. Low volume, single editor. |
| **PromptTemplate** | `PATCH /prompt-templates/:id`, `PATCH /admin/prompt-templates/:id` | `PUT /prompt-templates/preferred` | B | Prompt studio + SDK. `preferred` is a pointer write, so a "last write wins" argument is defensible — decide explicitly and record it with `@NoOptimisticConcurrency()` rather than leaving it silent. |

## 4. Tier A — the seven ETag-advertising routes with no precondition

**All seven now carry `@RequiresIfMatch()` + `@ExpectedVersion()` and CAS through
`repository.updateWithVersion` (2026-08-20).** Where the service had a short-circuit ahead of the
CAS — `TenantService.setTags` (identical tag set) and `DnaWritingStyleService.setDefaultReport`
(already the default) — `assertExpectedVersion` runs BEFORE it, so a stale client gets 412 rather
than a 200 that certifies a precondition nobody evaluated. Two are create-or-update and use the
`"0"` create-intent validator (`PUT .../override`, `PUT /dna-writing-styles/settings`). Contract
pinned by `apps/api/tests/e2e/task-776-occ-tier-a.spec.ts`.

Verbatim from the boot audit BEFORE the flip (see §7 for the raw WARN):

| Route | Handler | Evidence |
|---|---|---|
| `PATCH /admin/entitlements/plans/:plan` | `EntitlementsAdminController.updatePlan` | responseDtoVersion |
| `PUT /admin/entitlements/tenants/:tenantId/override` | `EntitlementsAdminController.upsertOverride` | responseDtoVersion |
| `PUT /admin/tenant-idp-config/:id/directory-credentials` | `TenantIdpConfigAdminController.setDirectoryCredentials` | responseDtoVersion |
| `PUT /admin/tenants/:id/tags` | `TenantController.setTags` | responseDtoVersion |
| `PATCH /consultations/:id` | `ConsultationController.update` | responseDtoVersion |
| `PATCH /dna-writing-styles/:reportId/default` | `DnaWritingStyleController.setDefault` | responseDtoVersion |
| `PUT /dna-writing-styles/settings` | `DnaWritingStyleController.setSettings` | responseDtoVersion, **expectedVersionParam** |

## 5. Tier B — versioned rows whose validator is never exposed

42 routes, grouped by aggregate. Each needs `version` added to its response DTO (or the aggregate's
canonical GET) **before** a precondition can be required.

| Aggregate / area | Routes |
|---|---|
| User | `PATCH /admin/users/:id`, `/:id/departments`, `/:id/profile`, `/:id/settings/:namespace/:key`, `/:id/status` |
| UserPreferences / UserSettings | `PATCH /users/me/preferences`, `PATCH /users/me/settings/:namespace/:key` (+ the two `/user/me/*` redirect shims) |
| RBAC — Role | `PATCH /admin/rbac/roles/:id`, `PUT /admin/rbac/roles/:id` |
| RBAC — Policy | `PATCH /admin/rbac/policies/:id`, `PUT /admin/rbac/policies/:id` |
| ApiKey | `PATCH /admin/api-keys/:id` |
| Notification | `PATCH /admin/notifications/:id` |
| ResourceSubscription | `PATCH /admin/resource-subscriptions/:id` |
| StorageBucket | `PATCH /storage/buckets/:name`, `PUT /admin/tenants/storage/buckets/defaults` |
| TenantStorageConfig | `PUT /admin/tenants/storage/config` |
| TenantTtsConfig | `PUT /admin/tts-config/credentials/:provider` |
| Tenant | `PATCH /admin/tenants/configs/:identifier` (+ `PATCH /tenant/me/config` shim) |
| HarnessPolicy | `PATCH /admin/harness/live/config`, `PATCH /admin/harness/gate-edit-exemplars/:id/curation` |
| PromptTemplate | `PUT /prompt-templates/preferred` |
| VoiceProfile | `PATCH /voice-profiles/:id/{activate,deactivate}` (+ two redirect shims) |
| Entitlements (global-kv) | `PUT /admin/entitlements/enabled` |
| RateLimit (global-kv) | `PUT /admin/rate-limit/enabled`, `/tiers/:tier`, `/routes/:routeId` |
| Scheduler (global-kv) | `PATCH /admin/schedulers/:name/{cron,toggle}` |
| ConsultationJob | `PATCH /consultations/jobs/:jobId/cancel` |
| STT internal callbacks | `PATCH /internal/stt/jobs/:id/{start,progress,complete,fail}` |

Two sub-groups are probably **out of scope permanently** and should be closed with
`@NoOptimisticConcurrency()` rather than migrated:

- **`/internal/stt/*` job callbacks** — single-writer worker state machine, service-token only, no
  concurrent human editor. A precondition adds retry complexity for no conflict class.
- **Idempotent state toggles** (`voice-profiles/:id/activate|deactivate`, `jobs/:jobId/cancel`) —
  the operation is convergent; a lost update is not observable.

## 6. Sanctioned exceptions (already correct)

Both use `@ExpectedVersion()` **without** `@RequiresIfMatch()` on purpose: a create-or-update write
has no row on the first call, therefore no ETag, therefore nothing for the client to echo. The
service applies the precondition only when a row exists.

| Route | Reason |
|---|---|
| `PUT /admin/settings/registry/:key` (`SettingsRegistryWriteController.putSetting`) | create-or-update; `@RequiresIfMatch()` would 428 the first write forever |
| `PUT /admin/tenant-frontend-config` (`TenantFrontendConfigAdminController.upsert`) | one row per tenant; OCC applies on UPDATE only |

**Both migrated (2026-08-20)** to an in-place `@NoOptimisticConcurrency('<reason>')` on the
controller, carrying the same reason strings. `SANCTIONED_EXCEPTIONS` in the audit is now an empty
map and must stay empty — an exception belongs on the route it excuses, where a reader of the
controller sees it. Pinned by `occ-coverage-audit.test.ts`.

## 7. Audit output (boot)

**After the phase-2 flip the walk reports** `OCC coverage: 46/88 PATCH/PUT routes require
If-Match; 2 sanctioned exception(s); 0 version-bearing route(s) unprotected.` and emits no WARN.
The 46 is reproducible without a boot: `apps/api/route-manifest.json` carries 88 PATCH/PUT routes,
46 with `requiresIfMatch: true`. The two exceptions are now the in-place
`@NoOptimisticConcurrency()` decorators of §6 — `SANCTIONED_EXCEPTIONS` is an empty map, pinned by
`occ-coverage-audit.test.ts`.

The BEFORE output, kept as the record of what was found:

```
[Nest] LOG [OccCoverageAudit] OCC coverage: 39/88 PATCH/PUT routes require If-Match; 2 sanctioned exception(s); 7 version-bearing route(s) unprotected.
[Nest] WARN [OccCoverageAudit] REST review H-1 — OCC is applied per-ROUTE, not per-RESOURCE. 7 version-bearing PATCH/PUT route(s) lack @RequiresIfMatch(), so a client that read an ETag can still blind-overwrite the row:
  ConsultationController
    - PATCH /consultations/:id (update) [responseDtoVersion]
  DnaWritingStyleController
    - PATCH /dna-writing-styles/:reportId/default (setDefault) [responseDtoVersion]
    - PUT /dna-writing-styles/settings (setSettings) [responseDtoVersion,expectedVersionParam]
  EntitlementsAdminController
    - PATCH /admin/entitlements/plans/:plan (updatePlan) [responseDtoVersion]
    - PUT /admin/entitlements/tenants/:tenantId/override (upsertOverride) [responseDtoVersion]
  TenantController
    - PUT /admin/tenants/:id/tags (setTags) [responseDtoVersion]
  TenantIdpConfigAdminController
    - PUT /admin/tenant-idp-config/:id/directory-credentials (setDirectoryCredentials) [responseDtoVersion]
  Evidence keys: responseDtoVersion = the response DTO declares a version property (ETagInterceptor fires); expectedVersionParam = the handler already takes @ExpectedVersion() but never makes it mandatory.
  Adding the decorator is BREAKING (missing header ⇒ 428). Inventory and phased migration: docs/implementation/TASK-776-API-Contract-Test-Suite/occ-coverage-inventory.md. Deliberate exceptions declare @NoOptimisticConcurrency('<reason>').
```

## 8. Express's default weak ETag — the API advertises a token it will not accept

Verified live on `:8968` as `super_admin`, 2026-08-20. My Phase-1 claim that unprotected routes
"emit no ETag" was **wrong**, and the truth is sharper than either the review or that correction.

**There are two independent ETag emitters.**

| Emitter | Validator | Fires on |
|---|---|---|
| `ETagInterceptor` (ours) | **strong** `"<version>"` | any response body with a numeric top-level `version` |
| **Express's default `etag` setting** (Express 5, `app.set('etag')` defaults to `'weak'`) | **weak** `W/"<len>-<hash>"` — a content hash | **every** JSON GET that did not already set an ETag |

Measured:

```
GET /admin/users/:id        -> ETag: W/"362-tUwkMCUYSWkSpsL7M4x2qR6Avgo"   body has NO version
GET /admin/departments/:id  -> ETag: "1"                                    body.version = 1
```

So an RFC 9110-conforming client — read the `ETag` from a GET, echo it as `If-Match` on the write —
is handed a precondition token on **every** resource. What happens next depends on the route, and
both outcomes are bad:

| Write route | Behaviour with the weak validator | Verified |
|---|---|---|
| Route that parses `If-Match` (`@ExpectedVersion()` / `@RequiresIfMatch()`) | **400** — `extractExpectedVersion`'s `STRONG_VALIDATOR_RE` rejects `W/`, deliberately (pinned by `task-776-response-parsing.spec.ts`) | `PATCH /admin/departments/:id` with `If-Match: W/"362-abc"` → 400 *"Expected a strong validator of the form `"<positive integer>"`"* |
| Route that does not parse it (all 42 tier-B routes) | **Silently ignored** — the header never reaches a parser and the write proceeds | `PATCH /admin/users/:id` returned the identical 400 *"No changes to write to."* **with and without** the header, i.e. the precondition was never evaluated |

The second row is the real damage, and it is strictly worse than the tier-A case in §1: the client
did everything RFC 9110 asks, believes the write was conditional, and still loses the update
silently. (Note for the record: a `PATCH /admin/users/:id` carrying a body may 400 on the DTO
whitelist — `property lastName should not exist` — which looks like an If-Match rejection but is
not. With an empty body the header is provably ignored.)

### Quantified

Same DTO scan as §2, applied to GET routes (322 total):

| Class | GET routes | Validator the client actually receives |
|---|---|---|
| Response DTO declares `version` | **96** | strong `"<n>"` from `ETagInterceptor` — usable as `If-Match` |
| Response DTO declared, no `version` | **169** | weak Express content hash only — **unusable** as `If-Match` |
| No declared response model (scan cannot tell) | **57** | weak by default unless the body happens to carry `version` |

**226 of 322 GET routes (70%) hand the client a validator the write path will never accept.**

### Remedy — recommendation

**Recommended: `app.set('etag', false)` in `main.ts`, so the interceptor's strong validator is the
only ETag the API ever emits.** Then an ETag's presence *means* "this resource has a version
predicate you can precondition on", and its absence honestly means "no concurrency story here" —
which is exactly the signal a client needs.

The objection to check first was M-3: Express's freshness check currently provides the API's only
`If-None-Match` → `304` support, so disabling the setting might remove conditional GET wholesale.
**Measured, and it does not.** Live today:

```
GET /admin/users/:id       If-None-Match: W/"362-tUwk…"  -> 304 Not Modified
GET /admin/departments/:id If-None-Match: "1"            -> 304 Not Modified
```

and against a minimal Express 5 app isolating the setting (curl, not `fetch` — Node's `fetch`
rewrites conditional headers and reports a misleading 200):

```
etag=true   /weak ETag=W/"a-HwR7Nh…"  If-None-Match -> 304   | /strong (explicit "1") -> 304
etag=false  /weak ETag=(none)                                | /strong (explicit "1") -> 304
```

The freshness check reads whatever `ETag` is on the response, regardless of who set it. So
`etag: false` **keeps** `304` on all 96 strong-ETag routes and loses it only on the 226 that had no
version to condition on anyway. That is a real but bounded regression — worth naming in release
notes, and worth pairing with explicit `If-None-Match` handling on the versioned routes (M-3) if
conditional GET is wanted more broadly.

**Rejected — accepting weak validators in the If-Match parser.** I agree this is wrong and argue
against it. A content hash is not a version predicate: two different `_version` values can hash
identically after a no-op round-trip (edit a field, edit it back), so the CAS would pass on a row
that has moved twice — a lost update that the precondition actively certified as safe. It also
makes `If-Match` semantics route-dependent, which is precisely the per-route-not-per-resource
disease this finding is about. `task-776-response-parsing.spec.ts` pins the 400 deliberately and
should stay.

**Rejected — scoping the default ETag off for writes-capable routes only.** Not expressible.
`app.set('etag', …)` is application-global; the only per-response lever is setting the header
yourself, which is what `ETagInterceptor` already does. A middleware that stripped weak ETags on
"routes that also accept PATCH/PUT" would have to reason about a *sibling* route's verbs from
inside a GET response, and would still leave the weak validator on every read-only resource. Not
worth the machinery for a strictly worse contract.

## 9. Recommended phased migration

Ordering principle: **flip where the validator already exists and the editor is single**, and only
touch the clinician-facing high-volume path once every SDK in the field sends the header.

**Phase 0a — stop advertising a token we reject.** `app.set('etag', false)` (§8). It belongs here,
alongside the SDK work and before any decorator flips, because it changes what clients observe on
**every GET**, and because the SDK rule in 0b ("echo the ETag you were given") is only safe once the
only ETag a client can be given is one the write path accepts. Ship it with release-note copy for
the `304` loss on version-less GETs.

**Phase 0b — SDKs (no gateway change). DONE 2026-08-20**, shipped in the SAME change set as the
phase-2 flip (shipping the flip first would have turned every current caller into a 428):
`@arcaai/vox` echoes the version it holds on `PATCH /consultations/:id` and
`PATCH /dna-writing-styles/:reportId/default` and maps 412 to `ConfigConflictError`;
`@arcaai/vox-node`'s generated admin surface now types `ifMatch` as REQUIRED on the four admin
routes; the admin console sends the read ETag on all five surfaces it owns and surfaces 412 as
"someone else edited this — reloaded, try again". Original text: `@arcaai/vox` and `@arcaai/vox-node` send `If-Match`
on *every* PATCH/PUT whose prior GET returned an `ETag`, and retry-on-412 with a refetch. The admin
console proxy already passes `If-Match`/`ETag` through, so its work is per-screen: capture the ETag
on read, echo it on write, surface the 412 as "someone else edited this". **Nothing below may ship
until a release carrying this is out.**

**Phase 1 (this change) — detection only.** Warn-only boot audit, `@NoOptimisticConcurrency()`, this
inventory. Non-breaking.

**Phase 2 — DONE 2026-08-20.** Executed as ONE change set rather than the staged order below,
because 0b shipped with it: all seven tier-A routes flipped, `PATCH /consultations/:id` last.
Original plan text:

**Phase 2 — admin-config surfaces, tier A.** `PUT /admin/tenant-idp-config/:id/directory-credentials`,
`PUT /admin/tenants/:id/tags`, `PATCH /admin/entitlements/plans/:plan`,
`PUT /admin/entitlements/tenants/:tenantId/override`. Single editor, low call volume, ETag already
emitted, and each closes a *mixed* aggregate. Lowest risk in the whole list.

**Phase 3 — close the remaining mixed aggregates, tier B.** For each of TenantStorageConfig,
TenantTtsConfig, HarnessPolicy live-config, Tenant configs: add `version` to the response DTO
(non-breaking on its own — it only starts emitting an ETag), ship, wait one client release, *then*
add `@RequiresIfMatch()`. The TTS/STT credential divergence should be closed in this phase by
symmetry with the already-protected STT twin.

**Phase 4 — declare the permanent exceptions.** `@NoOptimisticConcurrency()` on the four
`/internal/stt/*` job callbacks, the voice-profile toggles, `consultations/jobs/:jobId/cancel`, and
`PUT /prompt-templates/preferred` if the owner accepts last-write-wins there. Also migrate the two
`SANCTIONED_EXCEPTIONS` entries in §6 to in-place decorators.

**Phase 5 — DONE 2026-08-20 (folded into phase 2).** `PATCH /consultations/:id` was flipped last,
without waiting for a telemetry window: this is a pre-production platform (no prod data), so the
"wait for the header on 100% of live traffic" gate has no traffic to wait on, and the browser SDK
that drives the route ships in the same change. Original text:

**Phase 5 — DnaWritingStyle, then `PATCH /consultations/:id` last.** `PUT /dna-writing-styles/settings`
is one decorator away (it already parses `@ExpectedVersion()`), so it goes first as the rehearsal.
`PATCH /consultations/:id` is the highest-volume clinician-facing write and the only one where a 428
lands in front of a clinician mid-consultation — it flips only after telemetry shows the header
present on effectively 100% of live traffic.

**Phase 6 — flip the audit fail-closed.** With the inventory at zero, `auditOptimisticConcurrencyCoverage`
throws instead of warning, and `@NoOptimisticConcurrency('<reason>')` becomes the only escape hatch.

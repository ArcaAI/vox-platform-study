# TASK-786 — Super-admin-managed credential policy (password + issued secret)

**Status:** Completed
**Type:** feature
**Branch:** `dev-2.2`

## Requirement Analysis

A SUPER_ADMIN must be able to manage the platform's credential policy — length and
complexity — and every issuing path must PREFER the configured/stored policy over a
hardcoded default.

Two credential classes are in scope (both selected by the owner):

| Class | Surface |
|---|---|
| Human | `security.password.*` — password complexity + rotation |
| Machine | `security.secret.*` — the CSPRNG material behind service-account client secrets, API keys, webhook signing secrets and storage access keys |

## Current State Evaluation (pre-change, verified)

- **Passwords already resolved from storage but were UNREACHABLE.**
  `password-policy.ts` defined `DEFAULT_PASSWORD_POLICY` (min 12, four character
  classes, `maxAgeDays: 0`) and `resolvePasswordPolicy()` already preferred
  `security.password.*` `GlobalSetting` rows. But none of the six keys had a
  descriptor in `settings-registry/descriptors/`, and registering a descriptor is
  the only step that makes a key governed and writable — so the policy was
  configurable in principle and unmanageable in practice.
- **Machine secrets had no policy at all.** All four issuing paths drew a literal:
  `ServiceAccountService.generateClientSecret()`, `ApiKeyService.generateRawKey()` and
  `WebhookService.generateRawSecret()` were each `randomBytes(32).toString('hex')`, and
  `StorageAccessKeyFactory.generateRawSecret()` was `randomBytes(32).toString('base64url')` —
  a hardcoded configuration value, which `09-infrastructure-devops.md`
  §"No hardcoded configuration" forbids.

## Implementation Summary

**New:** `packages/applications/src/services/security/secretPolicy/secret-policy.ts` — the
machine-credential sibling of `password-policy.ts`. Pure and DI-free:
`GeneratedSecretPolicy { byteLength, encoding }`, `resolveGeneratedSecretPolicy()`
(stored row wins; defaults are the last fallback), `generateSecretString()`.

**Readers now prefer the stored policy:**

| Path | Change |
|---|---|
| `ServiceAccountService.create` / `.rotate` | `static generateClientSecret()` → instance method resolving `security.secret.*`. The old static survives as `generateClientSecretWithDefaults()` (deprecated, policy-blind) |
| `ApiKeyService.generateRawKey` | takes a `GeneratedSecretPolicy` (defaulted), supplied by `resolveSecretPolicy()` at both issuance call sites |
| `WebhookService.create` / `.rotateSecret` | `static generateRawSecret()` → instance method resolving `security.secret.*`. The old static survives as `generateRawSecretWithDefaults()` (deprecated, policy-blind) |
| `StorageAccessKeyService.generateKey` | generation MOVED LAYERS — out of `StorageAccessKeyFactory` (DI-free by the domain contract, so it could never reach the settings cache) into a policy-aware `generateRawSecret()` on the service. The factory static is `@deprecated` and no longer called by the application layer |

Both services take `IAppSettingsService` as an `@Optional()` append-only injection, so
fixtures that construct them directly keep the exact pre-policy behaviour.

**New descriptors** (`descriptors/security-policy.descriptors.ts`, registered in
`registry.ts`): all eight keys — the six password keys plus
`security.secret.byteLength` and `security.secret.encoding`. `tier: 'global-kv'`,
`maxScope: 'system'`, `globalOnly: true`, `editableBy: 'all'`,
`failMode: 'open-to-default'`, `sensitivity: 'internal'`. Every `default` mirrors the
reader's own code default, so cataloging them changed no behaviour.

### Three decisions worth recording

1. **Platform-only, not tenant-overridable.** How much entropy the platform puts behind
   its own credentials is a floor it owes every tenant; a tenant-writable key would let
   one tenant weaken issued material. The per-tenant credential dial that legitimately
   exists is `apiKey.maxLifetimeDays` (tighten-only, lower-is-stricter).
2. **The floor lives in code, not in the row.** `byteLength` is clamped to [16, 64] bytes
   (128–512 bits) AFTER it is read, so no GlobalSetting write — typo or malice — can drive
   an issued credential below 128 bits; a bad row degrades to the nearest legal value.
3. **Two surfaces pin their alphabet; two honour it.** `ApiKeyService`'s `KEY_FORMAT_REGEX`
   (`{service}_{type}_[a-f0-9]{32,}_{checksum}`) and `extractChecksum` parse the raw key
   structurally, so `encoding` applies to service-account client secrets and webhook
   signing secrets only; `byteLength` applies to all three. A policy-generated key the
   platform's own validator rejects would be worse than an unconfigurable one. Storage
   access keys pin **base64url** for a different reason: the platform default encoding is
   `hex`, so honouring `encoding` there would silently change the shipped S3-style
   credential shape (32 bytes → 43 url-safe chars) on every deployment that has stored no
   policy at all. Nothing constrains a webhook secret or a service-account client secret —
   both are only ever HMAC inputs. `byteLength` applies to all four.

Policy applies at ISSUANCE: `create`/`rotate` only, never retroactively. Verifiers are
peppered HMACs of whatever string was issued, so changing length or alphabet never breaks
authentication of an older credential — tightening the policy is a prompt to rotate. The
same is true from the other side for webhooks: a live subscriber verifies signatures with
the secret it already holds, and rewriting it on a policy change would break every
in-flight integration.

## The super-admin management interface

Registering the descriptors already made all eight keys reachable one at a time through the
generic `GET/PUT /admin/settings/registry/:key` lane. That is not a usable way to manage a
credential policy: an operator deciding "12 characters with four character classes, 32-byte
machine secrets" would reconstruct it from eight reads and then work out which of eight
writes failed. So the policy also gets a surface of its own.

**`GET/PUT /admin/security/policy`** (`apps/api/src/modules/security-policy/`, tag
`admin-security-policy`, backed by `SecurityPolicyService`):

- `GET` returns the EFFECTIVE policy — stored rows over code defaults, read from the same
  `AppSettingsService` cache the password validator and the credential issuers consult, so
  it is exactly what the next password check and the next issuance will apply — plus
  `bounds`: the code-enforced entropy floor/ceiling, the pinned alphabets, and which
  credential surfaces the secret policy governs.
- `PUT` takes a PARTIAL body and writes one registry key per supplied field.

**The service owns no enforcement of its own.** Every write is delegated to
`SettingsRegistryWriteService`, the single descriptor-driven enforcement point — which is
what supplies the super-admin gate (all eight descriptors are `globalOnly`, so a tenant
admin gets a 403 there), the `dataType` check, the SYSTEM-row target, the sys-event and
the cache refresh. Duplicating any of that would create a second write path with its own
drift. `@CanManage('GlobalSetting')` on the route is therefore NOT the real gate; the route
carries the standard `AUTH-NOTE` marker saying so.

The PUT is **not transactional and does not pretend to be**: each key is its own
`GlobalSetting` row under per-key compare-and-set, so a mid-request failure leaves earlier
keys applied. Every field is independently valid, so a partial application is always a
coherent policy — and the response is the re-read effective policy, which is what the
caller should trust. It carries `@NoOptimisticConcurrency` with that reason: eight rows
have eight versions, so no single `If-Match` could precondition the write. Per-key
compare-and-set remains available on the registry lane for callers that need it.

### The 428 the live check caught

The first live PUT succeeded and the second returned **428 Precondition Required**. The
write lane is compare-and-set: once a backing row exists it refuses any write that carries
no `expectedVersion`. A policy PUT would therefore have worked exactly ONCE per deployment
— unit tests could not see it, because they mock the write service and no row ever exists.

`updatePolicy` now reads each key's backing row version immediately before writing it and
passes it as the precondition. That is a genuine compare-and-set against the version just
observed, not a bypass: a concurrent edit landing in between still fails with a 412 rather
than being silently overwritten. There is no per-key ETag a caller could echo — eight rows
have eight versions and this surface exposes one object — and a caller that wants to hold a
precondition across its own read still has the per-key registry lane.
`security-policy.service.test.ts` now pins it.

## Admin console — `/security-policy`

**The Figma design gate was waived by the owner for this ticket** (`12-design-workflow.md`
gate 2 otherwise forbids a screen before its frame is approved). Recorded here because the
screen carries no approved frame and a later design pass may restyle it.

`apps/admin-console/src/features/security-policy/` + `app/(console)/(global)/security-policy/`
— tier 10-19 (cross-tenant; never needs a working tenant), nav-gated on `manage:all`, which
mirrors the gateway's own answer: every backing key is `globalOnly`, so a tenant admin is
403'd there regardless of what the nav shows.

One `ScreenTemplate` with two cards (passwords · issued machine credentials), a pinned
footer that counts unsaved changes, and segment `loading.tsx` skeletons mirroring the loaded
shape. Three decisions in the client worth keeping:

1. **Only CHANGED fields are sent.** The gateway write is partial and per-key, so submitting
   an unchanged value would bump that row's version and emit a sys-event for a non-change.
   A field edited and then edited back is not sent, and Save re-disables.
2. **The server's answer wins.** On success the draft is dropped and the re-read effective
   policy becomes the baseline, so a value the platform normalised is what the operator then
   sees — the form never argues with the platform.
3. **A failed write re-seeds from the server.** The PUT is not transactional, so after a
   failure the true state is unknown; the mutation invalidates on error and the draft is
   cleared rather than left showing a policy that a partially-applied write has moved.

Bounds come from the server's `bounds` block, not from client constants, and the pinned
alphabets are named in the field hint so the ignored setting is never a surprise. The
entropy field refuses an out-of-bounds value at the field, before any request.

`security.password.maxLength` (128) is deliberately NOT cataloged: it is a hashing-DoS
bound, and bcrypt reads only the first 72 bytes.

## Files Changed

- **new** `packages/applications/src/services/security/secretPolicy/{secret-policy.ts,index.ts}`
- **new** `packages/applications/src/services/settings-registry/descriptors/security-policy.descriptors.ts`
- `packages/applications/src/services/settings-registry/registry.ts` (import + registration)
- `packages/applications/src/services/serviceAccount/service-account.service.ts`
- `packages/applications/src/services/apiKey/apikey.service.ts`
- `packages/applications/src/services/webhook/webhook.service.ts`
- `packages/applications/src/services/storage-access-key/storage-access-key.service.ts`
- `packages/domains/src/factories/generated/core/StorageAccessKeyFactory.ts` (deprecation note only)
- **new** `packages/applications/src/services/security/secretPolicy/{security-policy.service.ts,ISecurityPolicyService.ts,security-policy.service.module.ts,dto/}`
- **new** `apps/api/src/modules/security-policy/{security-policy.controller.ts,security-policy.module.ts}`
- `apps/api/src/app.module.ts` (module registration), `apps/api/src/openapi/tags.ts` (new tag)
- regenerated: `apps/api/route-manifest.json`, `apps/api/openapi.json`, `apps/admin-console/src/server/api-docs/openapi.{admin,business}.json`
- **new** `apps/admin-console/src/features/security-policy/**` (api + screen + tests)
- **new** `apps/admin-console/src/app/(console)/(global)/security-policy/{page.tsx,loading.tsx}`
- `apps/admin-console/src/shared/navigation/nav-config.ts` (+ its inventory test: 55 → 56 routes)
- `packages/applications/src/services/security/index.ts` (barrel)
- **new tests** `security/secretPolicy/__tests__/secret-policy.test.ts`,
  `serviceAccount/__tests__/service-account.secret-policy.test.ts`,
  `apiKey/__tests__/apikey.secret-policy.test.ts`,
  `webhook/__tests__/webhook.secret-policy.test.ts`,
  `storage-access-key/__tests__/storage-access-key.secret-policy.test.ts`,
  `security/secretPolicy/__tests__/security-policy.service.test.ts`,
  `apps/api/src/modules/security-policy/__tests__/security-policy.controller.test.ts`,
  `settings-registry/__tests__/security-policy.descriptors.test.ts`

No migration and no new env var: both families are `global-kv` and already resolved
through the existing `AppSettingsService` cache and its `app-settings:invalidate` channel.

## Verification

```
pnpm --filter @arcaai/applications test → 497 files passed | 1 skipped, 9234 tests passed
pnpm --filter @arcaai/domains test      → 1841 passed | 2 skipped | 9 todo
pnpm api:build                          → 12 tasks successful
pnpm api:route-manifest                 → 659 routes; both new routes present with their guards
pnpm api:openapi && pnpm api:portal     → regenerated
pnpm api:openapi:check                  → OK (every served route documented or excluded)
pnpm api:portal:check                   → no drift
pnpm --filter @arcaai/admin-console test → 214 files passed, 1702 tests passed (incl. 0 axe violations on the new screen)
pnpm --filter @arcaai/admin-console lint / typecheck / build → clean
lint (applications + api)               → 0 errors and 0 warnings in every file this ticket touches
```

### Live verification (running gateway on 8868, seeded dev DB)

```
GET  /admin/security/policy            → 200, effective policy + bounds
PUT  {"secretByteLength":48,…}         → 200, echoes 48; a fresh GET agrees (cache propagated)
POST /admin/service-accounts           → clientSecret is 96 hex chars = 48 bytes  ← policy is live end-to-end
PUT  (repeat write)                    → 200 after the 428 fix below; 428 before it
PUT  {"secretByteLength":4}            → 400 (DTO bound)
PUT  {"nope":1}                        → 400 (forbidNonWhitelisted)
PUT  as tenant_admin                   → 403 "managed by super administrators only"
```

The probe service account was revoked and the policy restored to its defaults (32 bytes,
minLength 12) afterwards.

**Browser check:** the screen was loaded in a running `next dev` — it routes, renders its
chrome and breadcrumb, calls `/api/hope/admin/security/policy` through the BFF proxy, and
renders the `ErrorState` with a retry on an expired session. The AUTHENTICATED form was NOT
exercised in-browser: doing so needs credentials typed into the login form, which I do not
do. Its behaviour is covered by the 16 screen tests and by the live API checks above; a
one-minute manual pass (log in, change a value, save) is the remaining gap.

One existing test was ADAPTED, not weakened:
`storage-access-key.service.test.ts` stubbed `StorageAccessKeyFactory.generateRawSecret`;
it now stubs the service's own generator. Its assertions — plaintext returned exactly once,
only the hash persisted — are unchanged.

**Not mine, from a parallel session:** `apps/api` reports 6 failing tests in
`modules/throttle/` and lint errors in `modules/admin-rate-limit/`, from in-progress
TASK-785 files written into this checkout while this ticket was being verified. Unrelated to
these changes. `apps/api/tests/e2e/task-776-route-authz-matrix.spec.ts` will cover the two
new routes automatically off the regenerated manifest; it needs a live gateway and was not
run here.

`typecheck` reports two errors in `services/rate-limit/rate-limit-rule.{cache,service}.ts` —
untracked, in-progress TASK-785 files written by a PARALLEL session while this ticket was
being verified. Out of scope here and unrelated to these changes.

## Change History

| Date | Change |
|---|---|
| 2026-08-22 | Initial implementation — `security.secret.*` policy for service-account client secrets and API keys; `security.password.*` cataloged so a super admin can actually manage it. |
| 2026-08-22 | Webhook signing secrets brought under the same policy (`WebhookService.create` / `.rotateSecret`), honouring `encoding` as well as `byteLength`. |
| 2026-08-22 | Fixed a 428 found in live verification: a repeat policy PUT failed because the write lane demands `expectedVersion` once a row exists. `updatePolicy` now preconditions each write on the version it just read. |
| 2026-08-22 | Admin-console screen `/security-policy` (design gate waived by the owner) — one ScreenTemplate, changed-fields-only writes, server answer wins, re-seed on failure; 0 axe violations. |
| 2026-08-22 | Storage access keys brought under the policy — generation moved from the DI-free domain factory into `StorageAccessKeyService`, base64url pinned. Added the cohesive super-admin surface `GET/PUT /admin/security/policy` over the single registry enforcement point. |

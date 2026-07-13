# TASK-499 — Tenant-Scoped External Identity Provider (SAML 2.0)

| | |
|---|---|
| **Status** | `Review` — TASK-498 landed; P0–P2 backend implemented (config layer, `IdpResolverService`/`FederatedAuthService` SAML branches, `auth/sso/saml/*` routes). **Hard gate before ship**: the signed-assertion tampered/expired/replayed/XSW test matrix (§6) is NOT yet built — see §8. P3 (admin-console) not started — design-gated, no Figma frame. |
| **Type** | `feature` — full-stack; adds a SAML SP dependency + XML-signature validation |
| **Created** | 2026-07-12 |
| **Depends on** | [TASK-498 (OIDC + foundation)](../TASK-498-Tenant-External-Identity-Provider/README.md) — `TenantIdentityProvider`, `FederatedIdentity`, `TenantIdentityProviderDomain`, `IdpResolverService`, `FederatedAuthService.resolveOrProvisionUser`, `TenantIdpConfigService` protocol switch, `auth/sso` controller, `admin/tenant-idp-config` surface, BFF SSO scaffolding. |
| **Branch (suggested)** | `feature/499-tenant-external-idp-saml` |
| **Reported** | 2026-07-12 by the user (SAML split from TASK-498) |

---

## 1. Requirement Analysis

Add **SAML 2.0** as a second external-IdP protocol so tenant admins whose corporate IdP speaks SAML (legacy Entra/ADFS/Okta/OneLogin/Shibboleth) get the same two capabilities TASK-498 delivers for OIDC:

1. **Identity verification** — HOPE (SP) verifies a SAML assertion against the tenant's IdP at login, then mints HOPE's own session.
2. **User sync** — JIT provisioning on first login + admin-triggered directory pull (directory pull is protocol-agnostic and already built in TASK-498 P3; SAML reuses it where the provider exposes a directory API).

SAML is **greenfield** — zero SAML anywhere in the codebase — and XML-signature validation is historically the highest-risk part of any federation stack. Splitting it from OIDC lets OIDC ship on the audited-library `openid-client` path without waiting on SAML hardening.

### Decisions (owner: product owner, confirmed 2026-07-12)

- **D1 — SP-initiated SSO, HTTP-Redirect (AuthnRequest) → HTTP-POST (ACS).** Standard, widely-supported binding. IdP-initiated SSO is **out of scope** (unsolicited-response replay surface; add later only if a customer requires it, with strict `InResponseTo`-optional hardening).
- **D2 — Library, never hand-rolled XML.** Use a maintained SP library — **`@node-saml/node-saml`** (the maintained successor to `passport-saml`) — for AuthnRequest generation, response parsing, and signature validation. No bespoke XML-DSIG code.
- **D3 — Reuse the TASK-498 foundation verbatim.** SAML adds a protocol branch, not a parallel stack: `TenantIdentityProvider.protocol = SAML`, `FederatedIdentity.subject = NameID`, `FederatedAuthService.resolveOrProvisionUser` reused unchanged, same JIT/default-role/default-department/group-map + membership-invariant rules, same `admin/tenant-idp-config` service/controller, same BFF session sealing.
- **D4 — Assertion validation is strict and non-negotiable.** Verify: assertion signature against the **pinned IdP signing certificate** (no unsigned assertions, no unsigned responses where the assertion is unsigned), `Issuer`, `Audience` (SP entityID), `Destination`/ACS URL, `InResponseTo` (matches a live AuthnRequest), `NotBefore`/`NotOnOrAfter` (clock-skew ≤ 60s), and an **assertion-ID replay cache** (Redis, TTL = assertion validity). Encrypted assertions supported when the SP decryption key is configured.
- **D5 — Config secrets sealed in Vault.** IdP signing cert is non-secret config; the **SP private key** (for signing AuthnRequests / decrypting assertions) is sealed with Vault Transit in the existing `encryptedSecretRef` column. IdP metadata may be supplied as a URL (fetched + pinned) or pasted XML.
- **D6 — Break-glass + HOPE-owned authz unchanged.** Same as TASK-498 D6/D7 — the IdP is an identity oracle; HOPE RBAC authorizes; `GLOBAL_ADMIN` never SAML-grantable; local admin login stays unless `enforceSsoOnly`.

**Guardrail principle:** identical to TASK-498 — a SAML login produces a HOPE JWT whose authorization comes solely from HOPE RBAC. Everything downstream of the mint is byte-for-byte the same as local + OIDC login.

---

## 2. Current State Evaluation

**Foundation delivered by TASK-498 (must be merged first):**

- `TenantIdentityProvider` (with `IdpProtocol` enum already carrying `SAML`, and a `Json config` that absorbs SAML fields), `FederatedIdentity`, `TenantIdentityProviderDomain` tables + domain trios.
- `TenantIdpConfigService` with a protocol switch (OIDC branch live), `IdpResolverService` with a per-provider client cache, `FederatedAuthService.resolveOrProvisionUser` (protocol-neutral JIT provisioning that fixes the `createExternalUser`-sets-no-membership gap).
- `auth/sso` controller (`start` + OIDC `callback`), `admin/tenant-idp-config` controller, CASL subject `TenantIdentityProvider`, BFF SSO route scaffolding + `setSession` reuse, HRD (email-domain → provider).

**What this ticket adds (SAML-only):**

| Need | Phase |
|---|---|
| `@node-saml/node-saml` dependency + SP key management | P0 |
| SAML columns/config: SP private key (sealed), IdP entityID/SSO-URL/cert, `nameIdFormat`, attribute + group mappings | P1 |
| SP metadata endpoint (`/auth/sso/saml/:tenantKey/metadata`) | P2 |
| AuthnRequest build (signed) + `start` SAML branch (RelayState = signed state) | P2 |
| ACS endpoint (`POST /auth/sso/saml/:tenantKey/acs`) + full assertion validation (D4) + replay cache | P2 |
| SAML branch of `FederatedAuthService` → `resolveOrProvisionUser` (reused) | P2 |
| `TenantIdpConfigService` SAML branch (CRUD, test-connection, metadata parse) | P2 |
| BFF ACS route + admin-console SAML tab (enable the "coming soon" protocol selector) | P3 |

Nothing in the OIDC path changes.

---

## 3. SAML Flow (delta vs. TASK-498 §3)

Config (Flow A) and user-sync (Flow B) are as in TASK-498 with SAML-shaped inputs (paste/point-to IdP metadata; HOPE returns SP metadata to register in the IdP). The login round-trip (Flow C) differs:

```
User (browser)      admin-console BFF          API gateway (SP)             Tenant IdP
  | pick workspace (tenantKey) / email HRD      |                             |
  |------------------->| POST /api/auth/sso/start {tenantKey}                  |
  |                    |----------------------->| resolve provider (SAML); build signed AuthnRequest
  |                    |                        | store RelayState + request id (live-request cache)
  |                    |<-----------------------| 302 to IdP SSO URL (SAMLRequest, RelayState)
  |<-- 302 to IdP ----------------------------- |                             |
  |------------------------------------------------ authenticate at IdP ----->|
  |<----------------------------------------------- HTTP-POST SAMLResponse + RelayState
  | POST /api/auth/sso/saml/:tenantKey/acs (form) |                           |
  |------------------->| forward SAMLResponse --->| ACS: validate signature (pinned IdP cert)
  |                    |                        |   + Issuer + Audience + Destination
  |                    |                        |   + InResponseTo (live request) + NotBefore/NotOnOrAfter
  |                    |                        |   + replay-cache(assertion id); decrypt if encrypted
  |                    |                        | NameID + attributes → FederatedIdentity → HOPE user
  |                    |                        | resolveOrProvisionUser (JIT, reused from TASK-498)
  |                    |                        | assert membership invariant → mint HOPE JWT + refresh
  |                    |<-----------------------| { token, refreshToken, user }
  |                    | setSession() → sealed JWE cookie                             |
  |<-- 302 to app -----|                                                              |
```

- **Attribute mapping:** `NameID` → `FederatedIdentity.subject`; configured attribute names → email/username/displayName; group attribute → `groupToRoleMap` (same D6 rules, same `Role.externalName`/`externalId` matching). No mapping → default role + default department.
- **Downstream identical** to OIDC/local login (guard/proxy/refresh reused).

---

## 4. Design — Deltas

### 4.1 Data model

No new tables. Add to `TenantIdentityProvider.config` (Json, no migration) the SAML fields: `idpEntityId`, `idpSsoUrl`, `idpSigningCert` (PEM), `nameIdFormat`, `attributeMappings`, `wantAssertionsSigned` (default true), `signAuthnRequests` (default true), `spEntityId`. Add **one** sealed column reuse: the SP private key goes in the existing `encryptedSecretRef` (Vault Transit). If TASK-498 shipped `encryptedSecretRef` as a single ciphertext, and a tenant needs BOTH an OIDC secret and a SAML SP key on the same row — they won't (one row = one protocol), so a single sealed column suffices. Migration only if a dedicated `spCertificate` (public, non-secret) column is preferred over Json: folder `<timestamp>_task_499_saml_provider_fields`.

### 4.2 Application layer

- `TenantIdpConfigService` — add the `SAML` case to the protocol switch: metadata parse/validate, SP-metadata generation, `test-connection` (validate IdP metadata + cert parseable; optional AuthnRequest dry-build).
- `IdpResolverService` — add a per-provider `SAML` instance cache (`@node-saml/node-saml` configured from decrypted SP key + IdP cert), invalidated on config update.
- `FederatedAuthService` — add `verifySamlResponse(tenantKey, samlResponse, relayState)`: library-validate → extract NameID/attributes → **reuse** `resolveOrProvisionUser`. Add the replay cache (Redis) + live-AuthnRequest cache for `InResponseTo`.

### 4.3 API gateway

Extend `auth-sso.controller.ts`:
- `GET /auth/sso/saml/:tenantKey/metadata` (`@Public`) — SP metadata XML.
- `POST /auth/sso/saml/:tenantKey/acs` (`@Public`, throttled) — ACS. Raw-form body; strict validation (D4).
- `start` gains a SAML branch (AuthnRequest redirect) alongside the OIDC branch.

### 4.4 admin-console

- Enable the SAML option in the `identity-providers` protocol selector (the TASK-498 "coming soon" tab). SAML form: IdP metadata URL/paste, entityID, SSO URL, signing cert, NameID format, attribute/group mappings, SP-metadata + ACS-URL copy blocks. Same write-only-secrets, Skeleton, Field forms, axe-0, both-themes rules. Design-gate a SAML frame before build.

---

## 5. Implementation Plan (phased, TDD)

**P0 — Dependency.** Add `@node-saml/node-saml` to `apps/api`; lockfiles updated; SP key generation/handling helper.
*Verify:* `pnpm build:api`.

**P1 — Config fields.** Extend the config schema/DTO (SAML validation), SP-key sealing, `test-connection` SAML branch. TDD the config service SAML case.
*Verify:* `pnpm --filter @arcaai/applications test`; migration (if any) SQL reviewed.

**P2 — SAML end-to-end.** SP metadata + signed AuthnRequest + ACS validation + replay/InResponseTo caches + `verifySamlResponse` → `resolveOrProvisionUser`. TDD with **signed sample assertions**: valid, tampered-signature, wrong-audience, expired (`NotOnOrAfter`), replayed, and (if configured) encrypted — each asserted.
*Verify:* `pnpm --filter @arcaai/applications test` + `pnpm test:unit`; e2e SP-initiated round-trip against a mock IdP (e.g. a `saml-idp` test harness); cross-tenant assertion (SAML user lands only in the configuring tenant).

**P3 — admin-console SAML.** (Design gate first.) BFF ACS route; enable SAML tab + form; SP-metadata/ACS copy blocks. Colocated Vitest; axe 0; both themes; `next-dev-loop` runtime pass.
*Verify:* `pnpm --filter @arcaai/admin-console build lint test`; runtime SAML login exercised in a running app.

**Global verification:** `pnpm lint` clean; affected builds; `pnpm test:unit` + `pnpm test:e2e` (SAML ACS + config, incl. cross-tenant + the full tampered/expired/replayed matrix); SAML login round-trip exercised end-to-end; **security review of assertion validation is a hard gate** (§6).

---

## 6. Security Posture (SAML-specific — the reason this is its own ticket)

- **Signed assertions only** — reject unsigned assertions and responses whose assertion is unsigned; validate against the **pinned** IdP cert (never trust metadata fetched over an unauthenticated channel without pinning).
- **Full condition validation (D4)** — `Issuer`, `Audience`/SP-entityID, `Destination`/ACS URL, `InResponseTo` (must match a live AuthnRequest — blocks unsolicited/IdP-initiated replay), `NotBefore`/`NotOnOrAfter` with ≤ 60s skew.
- **Replay defense** — Redis assertion-ID cache (TTL = assertion validity) + one-time RelayState/request-id.
- **XML attack surface** — rely on the maintained library's hardened parser (XXE/XSLT/signature-wrapping defenses); pin the library version; never parse SAML XML with a general-purpose XML lib. Track advisories for the chosen library.
- **SP private key sealed in Vault** (D5); never logged; write-only in the UI.
- **HOPE-owned authz + break-glass** unchanged (D6) — `GLOBAL_ADMIN` never SAML-grantable; local admin login stays unless `enforceSsoOnly`.
- **Signature-wrapping (XSW)** — explicitly covered by the tampered-assertion test matrix in P2; verify the library rejects moved/duplicated signed elements.

---

## 7. Risks / Notes

- **XML-signature validation is the whole risk** — do not ship without the P2 tampered/expired/replayed/XSW test matrix passing and a security review of the ACS path. This is why SAML is decoupled from OIDC.
- **Blocked on TASK-498** — if the foundation seams (`resolveOrProvisionUser`, config protocol switch, `IdpResolverService`, `auth/sso` controller) aren't clean, SAML work stalls. Coordinate: land TASK-498 P1–P2 before starting P1 here.
- **IdP-initiated SSO deferred (D1)** — some enterprise customers expect it; adding it later requires relaxing `InResponseTo` with compensating replay controls — a deliberate, separately-reviewed change.
- **Encrypted assertions optional** — only when the SP decryption key is configured; keep the code path but gate it on config to avoid mandatory key management for tenants that don't need it.
- **Design gate** — SAML admin screen (tier 30–49) needs an approved Figma frame before P3 (`12-design-workflow`); P0–P2 are not design-gated.

---

## 8. Implementation Summary

TASK-498 landed (uncommitted, on this branch) between the P0 and P1 passes, unblocking the rest of this ticket. P0's util moved (see Deviations) once the real caller (`TenantIdpConfigService`, `packages/applications`) became visible.

### P0 — Dependency + SP key helper (done 2026-07-12)

- `generateSamlSpKeyPair()` — RSA key pair (default 2048-bit) + self-signed cert (sha256, 3-year default validity), via the maintained `selfsigned` library. 9 unit tests (`node:crypto` `X509Certificate.checkPrivateKey`/`.verify` — no XML/SAML-specific assertions here, pure X.509).

### P1 — Config layer (done 2026-07-13)

- **`SamlProviderConfigDto`** (`packages/applications/.../tenant-idp-config/dto/saml-provider-config.dto.ts`) — `idpEntityId`, `idpSsoUrl`, `idpSigningCert`, `spEntityId`, `nameIdFormat?`, `signAuthnRequests?`, `spCertificatePem?` (server-generated, read-only), `attributeMappings?` (reuses OIDC's `ClaimMappingsDto` — same field names, so `resolveOrProvisionUser` reads both through identical `claims[key]` lookups), `groupToRoleMap?`, `defaultRoleId`, `defaultDepartmentId`, `jitEnabled?`, `enforceSsoOnly?`, `directoryProvider?`.
- `CreateTenantIdpConfigRequest`/`UpdateTenantIdpConfigRequest` widened: `protocol` accepts `SAML`; `config`/`clientSecret` become `@ValidateIf(protocol===OIDC)` + `@IsDefined()`; new `samlConfig` field is `@ValidateIf(protocol===SAML)` + `@IsDefined()`. **A TDD-caught bug**: `@ValidateNested()` alone does NOT reject a missing/undefined nested object (class-validator skips nested validation on `undefined`) — the first version of this DTO silently accepted a SAML create with no `samlConfig` at all. Fixed by stacking `@IsDefined()` before `@ValidateNested()`; the failing-red test that caught it is still in the suite.
- `TenantIdpConfigService.create()` — SAML branch generates the SP key pair server-side (never admin-supplied, D5), seals the private key into `encryptedSecretRef` (same column OIDC uses for its client secret — one row = one protocol, D5), persists `{...samlConfig, spCertificatePem}`. `update()` — SAML branch preserves the server-generated `spCertificatePem` across a `samlConfig` replacement (would otherwise be silently discarded, orphaning the sealed private key from its public counterpart). `testConnection()` — SAML branch: no live network probe is possible (SAML has no discovery endpoint, unlike OIDC's `Issuer.discover` — the IdP is only reachable via a real browser redirect), so this is a config-CONSISTENCY smoke test: build a real `SAML` client from the pinned cert + sealed key, then `generateServiceProviderMetadata()` to force parse/serialize of the cert — catches a malformed cert or bad field before the tenant registers with their IdP. Success still flips DRAFT → ENABLED (D7).
- `IdpResolverService.buildSamlClient()` — hardcodes `wantAssertionsSigned: true`, `validateInResponseTo: 'always'`, `signatureAlgorithm: 'sha256'`, `acceptedClockSkewMs: 60000` as **non-negotiable** (not a tenant-admin knob) per D4/§6. `wantAuthnResponseSigned: false` is a deliberate deviation from the library's own default (`true`) — requiring the outer `<Response>` signed (in addition to the assertion) would reject the common "assertion-signed-only" default most real IdPs (Okta, Azure AD, OneLogin) ship with; D4 only requires the assertion itself be signed. `resolveSamlForTenant`/`resolveSamlByProviderId` mirror the OIDC resolver's cache/decrypt pattern, in a separate `samlCache` Map (different client type).
- **`RedisSamlCacheProvider`** (`packages/applications/.../idp-resolver/saml-redis-cache-provider.ts`) — implements node-saml's own `CacheProvider` interface (`saveAsync`/`getAsync`/`removeAsync`) over `IRedisCacheService`. This is the actual mechanism satisfying D4's "InResponseTo matches a live AuthnRequest" + single-use replay requirement — `SAML.getAuthorizeUrlAsync` saves the outstanding request id via this provider, `validatePostResponseAsync` consults it and removes it on use (a second use of the same request id sees nothing). The library's default in-memory provider is per-pod only, insufficient once `start` and `acs` can land on different replicas — same class of problem the OIDC resolver's doc comments already flag.

### P2 — SAML end-to-end orchestration + routes (done 2026-07-13, minus the hard gate below)

- `FederatedAuthService` — `buildSamlAuthnRequest(tenantKey, acsUrl)` (SP-initiated, tenantKey-only, no email HRD), `getSamlServiceProviderMetadata(tenantKey, acsUrl)` (servable for a DRAFT provider too — no secret exposure risk), `verifySamlResponse(tenantKey, samlResponse, acsUrl)`: calls `SAML.validatePostResponseAsync`, then a **defense-in-depth assertion-ID replay cache** (Redis `saml-assertion-seen:<id>`, TTL 300s) on top of the InResponseTo cache, then `resolveOrProvisionUser` — reused verbatim from OIDC, unchanged.
- **A second TDD-caught bug**: `provisionUser`'s namespaced username was hardcoded `` `oidc:${provider.id}:${subject}` `` — a SAML login would have silently minted `oidc:`-prefixed usernames. Fixed to `` `${provider.protocol.toLowerCase()}:${provider.id}:${subject}` `` (no-op for OIDC; existing tests still pass unchanged). A regression test asserts the `saml:` prefix.
- Extracted `finalizeFederatedSession()` — the membership re-check + role/permission flatten + `lastLoginAt` stamp was duplicated verbatim between `verifyOidcCallback` and the new `verifySamlResponse`; since the membership re-check is a security invariant (closes the loop on a revoked role/department for a previously-JIT'd user), duplicating it risked future drift between the two protocols. Now shared.
- `apps/api` — `AuthSsoController` gains `GET /auth/sso/saml/:tenantKey/metadata`, `POST /auth/sso/saml/:tenantKey/start`, `POST /auth/sso/saml/:tenantKey/acs` (new `SamlAcsRequest` DTO). Extracted `mintSession()` (JWT + refresh-token mint, identical to `AuthController.login`'s path) shared by `callback()` and the new `samlAcs()`.

**Deviations from the original plan (§4.3), both deliberate, both recorded here rather than silently diverging:**
1. **SP-key util relocated** `apps/api/src/modules/auth/saml/` → `packages/applications/.../tenant-idp-config/saml-sp-key.util.ts`, and its deps (`@node-saml/node-saml`, `selfsigned`) moved from `apps/api/package.json` to `packages/applications/package.json`. P0 guessed the location before TASK-498's actual shape was visible; once `TenantIdpConfigService` (application layer) turned out to be the real caller, keeping the util in `apps/api` would have been a backwards dependency (`packages/applications` never depends on `apps/*`) — mirrors `openid-client`, which likewise lives only in `packages/applications`, never `apps/api`.
2. **`start` is a separate SAML-specific route, not a shared branch of `/auth/sso/start`.** §4.3 reads "`start` gains a SAML branch alongside the OIDC branch," implying one endpoint. Implemented instead as `POST /auth/sso/saml/:tenantKey/start`, consistent with the `saml/:tenantKey/{metadata,acs}` sub-namespace already specified. Reason: branching the already-shipped, tested OIDC `start`/`buildAuthorizeUrl` path to also resolve SAML providers would have required restructuring `resolveStartTarget`'s protocol-hardcoded HRD lookup — real risk to code that TASK-498 just landed, for zero behavioral gain (the BFF calls a known route either way).

**Evidence:**

```
$ pnpm --filter @arcaai/applications build
> rimraf dist tsconfig.tsbuildinfo && tsc   (clean exit)

$ pnpm --filter @arcaai/applications exec vitest run
 Test Files  299 passed | 1 skipped (300)
      Tests  6237 passed | 4 skipped (6241)

$ pnpm --filter @arcaai/applications exec eslint "src/**/*.ts" --quiet
(clean — 0 problems)

$ pnpm --filter @arcaai/api build
> rimraf dist && nest build && tsc-alias   (clean exit)

$ pnpm --filter @arcaai/api exec vitest run --exclude '**/integration/**' --exclude '**/e2e/**'
 Test Files  1 failed | 132 passed (133)
      Tests  5 failed | 2149 passed (2154)

$ pnpm --filter @arcaai/api exec eslint "src/modules/auth/**/*.ts" --quiet
(clean — 0 problems)
```

The 5 apps/api failures are pre-existing and unrelated (`src/__tests__/env-port-standardization.test.ts`, TTS_URL/TTS_PORT legacy-property removal — a different in-flight ticket). A raw `tsc --noEmit -p .` on `apps/api` also surfaces pre-existing, unrelated typecheck errors in `auth.controller.*.test.ts`/`ai-service-admin`/`notification`/`break-glass` test files (a constructor-arity mismatch against the committed `AuthController` — confirmed via `git status` that these files are untracked-clean, i.e. pre-existing on this branch, not introduced by this work); `nest build` (the actual production build, which excludes test files) is unaffected and green.

### What's NOT done — the hard gate (§6, §7)

**The signed-assertion tampered/expired/replayed/XSW test matrix has NOT been built.** This is the ticket's own explicitly-flagged hard security gate ("XML-signature validation is the whole risk... do not ship without the P2 tampered/expired/replayed/XSW test matrix passing and a security review of the ACS path" — §7) and it is deliberately not rushed:
- What exists: `verifySamlResponse`'s ORCHESTRATION is unit-tested (replay-cache ordering, membership re-check, error propagation, `resolveOrProvisionUser` wiring) against a **mocked** `SAML.validatePostResponseAsync` — this proves our code calls the library correctly, not that the library's own signature/timestamp/audience validation behaves correctly against a real signed XML payload.
- What's missing: real signed SAMLResponse XML fixtures (valid / tampered-signature / wrong-audience / expired `NotOnOrAfter` / replayed / signature-wrapping) exercised against the ACTUAL `@node-saml/node-saml` `SAML` class (not mocked), asserting each is accepted/rejected correctly.
- Why deferred rather than rushed: hand-constructing well-formed, correctly-canonicalized signed SAML XML (matching what `xml-crypto`/`xml2js` inside node-saml expect) is itself a nontrivial, error-prone task — a subtly-wrong test fixture produces false confidence, which is worse than an honestly-incomplete test suite. The ticket's own P2 verify line names a `saml-idp`-style mock-IdP test harness for exactly this reason.
- Recommended next step: either (a) stand up a `saml-idp`-based mock IdP for a real e2e SP-initiated round-trip, or (b) build a small xml-crypto-based test-fixture signer (using this ticket's own `generateSamlSpKeyPair` output as the "IdP" key for test purposes) and drive the matrix at the unit level against the real `SAML` class. Either way, a security review of the ACS path (§6) should follow before this ships to a real tenant.

### Not started

**P3 (admin-console SAML tab)** — design-gated per `12-design-workflow.md`; no Figma frame exists for the SAML config form. Not attempted.

---

## 9. Change History

| Date | Change | Author |
|---|---|---|
| 2026-07-12 | Ticket created — SAML 2.0 split from [TASK-498](../TASK-498-Tenant-External-Identity-Provider/README.md) to de-risk OIDC; scoped to SP-initiated SSO on the maintained `@node-saml/node-saml` library, reusing the TASK-498 identity foundation; strict assertion-validation matrix defined as a hard gate. | Claude (Opus 4.8) + Tap Huynh |
| 2026-07-12 | P0 implemented (TDD) — added `@node-saml/node-saml` + `selfsigned` to `apps/api`; `generateSamlSpKeyPair()` SP key/cert helper + 9 unit tests. Scoped to the non-TASK-498-overlapping slice; P1–P3 stay blocked. | Claude (Sonnet 5) + Tap Huynh |
| 2026-07-13 | TASK-498 landed; P1–P2 implemented (TDD) — SP-key util relocated to `packages/applications`; `SamlProviderConfigDto` + widened create/update/response DTOs (caught + fixed a `@ValidateNested()`-without-`@IsDefined()` validation gap); `TenantIdpConfigService` SAML branch (create/update/testConnection); `IdpResolverService.buildSamlClient` with hardcoded D4/§6 security options + `RedisSamlCacheProvider` (D4 InResponseTo/replay defense via node-saml's own `CacheProvider` hook); `FederatedAuthService` SAML methods (caught + fixed a hardcoded `oidc:` username-prefix bug that would have mis-namespaced SAML users) + shared `finalizeFederatedSession`; `AuthSsoController` SAML routes (`metadata`/`start`/`acs`, deliberately separate from OIDC `start` rather than a shared branch). 57 new tests, all green; full `packages/applications` (6237 tests) + `apps/api` suites pass (5 pre-existing unrelated failures). **Hard gate not done**: the signed-assertion tampered/expired/replayed/XSW matrix against the real `@node-saml/node-saml` library (§6/§7) — deliberately deferred rather than rushed; orchestration-level tests against a mocked client exist, but not the real-crypto matrix. P3 admin-console not started (design-gated). | Claude (Sonnet 5) + Tap Huynh |

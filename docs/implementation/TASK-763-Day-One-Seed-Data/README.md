# TASK-763 — Day-1 Seed Data

| | | | |
|---|---|---|---|
| **Status** | Review | **Owner** | Platform / Data |
| **Date** | 2026-08-18 | **Type** | bugfix (day-1 readiness) |
| **Related** | **TASK-756** (API-key privilege ceiling) · **TASK-757** (admin plane JWT-only — CONCURRENT) · **TASK-758** (business-plane auth model) · **TASK-762** (machine identity) · `.claude/rules/02-database-prisma.md` §Seeds · `.claude/rules/00-project-context.md` §Configuration Principles + §"The two reserved tenants are NOT two config tiers" |

> **Concurrency note.** TASK-757 was landing in the same worktree while this ticket
> was written. Nothing under `apps/api/src/**` or
> `packages/applications/src/services/apiKey/**` was edited here; this ticket's write
> set is `packages/database/src/**` plus `.env.dev`. Where the two meet — seeded API-key
> scopes — this ticket reads TASK-757's registry as the authority and conforms the seeds
> to it.

---

## 1. Requirement Analysis

Owner's words: *"updating seed data — note that we have super admin, arcaai tenant admin,
etc… all of data must be reasonable and useful for day-1 deployment in any environment."*

Restated as testable criteria:

| # | Criterion |
|---|---|
| R1 | Every persona (SUPER_ADMIN, ArcaAI tenant admin, tenant admins, clinicians) can log in and do its job on a **fresh** deploy — including a non-development one. |
| R2 | No seeded credential carries authority that is inert, unreproducible, or wider than its purpose. |
| R3 | Seeded configuration honours **request tenant → SYSTEM**. `50000000-…` ("Global") is a CUSTOMER tenant and never a runtime tier. |
| R4 | Nothing environment-specific or secret is hardcoded into a seed. |
| R5 | Seeds stay idempotent, FK-ordered, and keep the `XX-name.ts` phase convention. |

Classification: **bugfix**. Every change below removes an existing day-1 defect; none adds a feature.

---

## 2. Current State Evaluation

The whole phased chain (`00-constants` … `22-consent-grant`, `91-user`) was audited. Findings
are split into what this ticket FIXED and what needs an owner decision (§5).

### 2.1 A fresh non-development deploy could not log in (R1) — the headline defect

`RUN_SEED="safe"` is the documented production bootstrap (`seed-mode.ts:27`). It runs every
platform-configuration phase and excludes `91-user` — correctly, because those are demo accounts
(`*@example.com`) sharing one documented password.

The consequence nobody had closed: **`safe` produces zero `User` rows and zero
`UserRoleAssignment` rows.** The only `@Public()` auth routes are `POST /auth/login` and
`POST /auth/refresh` — there is no registration and no signup. A search of `apps/api/src`,
`scripts/`, `packages/applications`, `packages/database/scripts` and `packages/tools` found **no
env-driven first-admin provisioner of any kind**. Every alternative path is circular:

| Candidate | Why it does not work |
|---|---|
| Service account (TASK-762) | Issuance is SUPER_ADMIN-only (`service-account.service.ts:68,130,418`) |
| Tenant creation with an initial admin | Requires an authenticated platform admin |
| `packages/tools/gen-dev-token` | Mints a token for a user that must already exist; dev-only |
| `packages/tools/gen-api-key` | Requires an existing user id |
| `RUN_SEED=all` | Explicitly refused when `NODE_ENV` is not development/test — and would plant `password123` plus synthetic PHI |

So the only real options were hand-writing rows into Postgres, or shipping demo credentials to
production. **R1 failed outright.**

### 2.2 Seeded API keys carried authority that is now inert (R2)

TASK-757 makes `/api/v1/admin/*` JWT-only (`@ForbidApiKey()`, checked *before* the scope check),
and marks **59** scope strings `reserved: true` — refused at grant time and dropped from the
advertised catalog. Enumerated from the landed registry: all 57 `admin:*` strings plus
`webhook:event:read|write` (their only consumer is `WebhookController` at `admin/webhooks`).

Against that, `02-apikey.ts` seeded:

| Key | Reserved scopes held | Effect |
|---|---|---|
| `SDK_ARCAAI` | `admin:user:read`, `admin:apikey:read`, `admin:tenant:read` | Dead at request time AND not reproducible through the console |
| `WEBHOOK_ADMIN` | `webhook:event:read`, `webhook:event:write` | Same |

Separately, `SERVICE_ACCOUNT` held `'*'` — an unrestricted credential satisfying every scope on
every non-admin route — **bound to a CUSTOMER tenant** (`SEED_TENANT_ID`, the Global playground).
Its actual job is narrow: BUG-013 requires `API_GATEWAY_KEY` to be the RAW value of a registered
ACTIVE SERVICE_ACCOUNT row, and the STT worker calls only `/internal/stt/*` (10 call sites in
`apps/stt/src/stt/core/api_client/gateway.py`, all under that prefix) plus the `@Public()`
`/internal/effective-config`. `SttInternalController` declares
`@RequiredScopes('internal:stt:worker')` — so the wildcard bought the worker nothing.

### 2.3 The SDK's day-1 surface 403s on scopes the seeded keys never had (R1)

TASK-758 gave nine previously-undeclared controllers a business-plane scope. Several sit directly
on the SDK path. Cross-referencing the endpoint literals in `packages/agentic-sdk-v2` and
`packages/vox-node` against the controllers that serve them:

| SDK call | Required scope | Seeded keys had it? |
|---|---|---|
| `GET /prompt-templates/available` (clinician template selector) | `prompt:template:read` | **No** |
| `GET /audio/pipelines` | `stt:model:read` | **No** |
| `GET /tenant/me/context-schema` | `tenant:context-schema:read` | **No** |
| `GET /tenant/me`, `/tenant/me/config` | `tenant:profile:read` | **No** |
| `GET /entitlements/me` | `tenant:account:read` | **No** |
| `GET`/`PATCH /user/me/settings` | `user:settings:read|write` | **No** |
| `GET /user/me/departments`, `POST /rbac/check` | `user:profile:read` | **No** |
| `GET /changelog`, `/changelog/unseen` | `platform:changelog:read` | **No** |
| `POST /speech/synthesize`, `GET /speech/voices` | `tts:speech:write`, `tts:voice:read` | **No** |

The nine-scope block was also copy-pasted across five key definitions, which is how `SDK_ARCAAI`
drifted into carrying three admin scopes none of the others had.

### 2.4 Two reader-plane scopes were unmintable by the audience their route already admits

The gap named in the brief, plus a second instance of the identical shape, found by evaluating
every registry scope's `implies` against every seeded role's policy set (script in §6):

| Scope | Route | Implied ability | Granted by any seeded policy? |
|---|---|---|---|
| `platform:changelog:read` | `ChangelogController` — `@Authorize()`, **no ability** | `read:ChangelogEntry` | **No.** SUPER_ADMIN only, via `manage:all` |
| `tenant:context-schema:read` | `MyTenantContextSchemaController` — `@Authorize()`, **no ability** | `read:ConsultationContextSchema` | Only tenant admins, via `manage:` |

Both routes are open to **any authenticated user**; row-level filtering lives in the service. But
`assertScopeCeiling` refuses to mint a scope whose implied pair the caller does not hold. So a
clinician could *use* the What's New dialog and context-schema discovery in a session yet could
not mint an SDK key for either — and the changelog reader plane was unreachable by **any**
tenant-minted key.

The sweep found **no third instance**. Every other non-admin scope resolves to an ability a
tenant admin already holds; the remaining denials (`internal:stt:worker` → `manage:all`, and the
`'*'` wildcard) are correctly super-admin-only.

### 2.5 Two smaller defects

- **`91-user.ts:814`** carried `password` in the **`update:`** branch, so every re-seed of a
  shared dev/test box silently reset a rotated password back to `password123`.
- **`05-tenant.ts:18`** described the Global customer tenant as
  `'System-wide default tenant — do not remove'` — the exact "default tenant" framing that
  `.claude/rules/00-project-context.md` §"The two reserved tenants are NOT two config tiers"
  exists to stop, written into the row an admin reads in the console.

---

## 3. Implementation Plan

Executed in this order; each step's verification is in §6.

1. **Grant the two reader-plane abilities** in `01-policy.ts` → the mintability sweep reports zero
   contradictions for every key-minting role.
2. **Conform the seeded API keys** to TASK-757's registry in `02-apikey.ts`: one shared SDK scope
   set, no reserved scopes, `SERVICE_ACCOUNT` narrowed → new tests fail before, pass after.
3. **Add the bootstrap-admin phase** `92-bootstrap-admin.ts` + wire it into `index.ts` → rule tests
   pass; phase enabled in `safe`.
4. **Stop the re-seed password reset** in `91-user.ts` → `password` absent from the update branch.
5. **Correct the Global tenant description** in `05-tenant.ts`.
6. **Document** the env contract in `.env.dev`; record owner decisions here.
7. `build` + `test` + `typecheck` green.

---

## 4. Implementation Summary

### 4.1 Files changed

| File | Change |
|---|---|
| `packages/database/src/prisma/db_main/seed/01-policy.ts` | `user-profile-own` gains `read:ChangelogEntry` (unconditional — it is a platform-wide resource) and `read:ConsultationContextSchema` (tenant-conditioned — it is tenant data) |
| `.../seed/02-apikey.ts` | New exported `SDK_DAY_ONE_SCOPES` (20 scopes, each traced to an SDK call in a table comment); five SDK keys now spread it instead of five hand-maintained copies; `WEBHOOK_ADMIN` → `[]`; `SERVICE_ACCOUNT` `'*'` → `['internal:stt:worker']` |
| `.../seed/92-bootstrap-admin.ts` | **New phase.** Env-driven, CREATE-ONLY first SUPER_ADMIN |
| `.../seed/index.ts` | Imports + invokes `seedBootstrapAdmin` after `seedUser`, in **every** seeding mode |
| `.../seed/91-user.ts` | `password` removed from the `update:` branch |
| `.../seed/05-tenant.ts` | Global tenant description corrected to state it is a customer-tenant playground, never a config tier |
| `.env.dev` | Documents the three `BOOTSTRAP_SUPER_ADMIN_*` variables (commented; no values) |

### 4.2 Tests added

| File | Locks |
|---|---|
| `.../seed/__tests__/bootstrap-admin.test.ts` (new, 12 cases) | No-op when unset · username defaults to `admin` · half-configured throws · password `< 12` throws · well-known values (incl. this repo's own `password123`, case-insensitive) throw · malformed email/username throw · phase runs in `safe` and `all`, not in `none` · reserved id collides with no `SEED_USER_IDS` entry |
| `.../seed/__tests__/reader-plane-mintability.test.ts` (new, 29 cases) | For TENANT_ADMIN / DOCTOR / DEPARTMENT_HEAD, every business-plane scope whose route is `@Authorize()`-open is mintable · SUPER_ADMIN keeps `manage:all` · the two new grants are READ-only, so the admin `manage:` plane stays closed |
| `src/__tests__/seed-apikey-sdk-scopes.test.ts` (extended, +26 cases — 5 → 31) | No seeded key carries an `admin:`- or `webhook:`-prefixed scope · `SERVICE_ACCOUNT` is exactly `['internal:stt:worker']` · each of the 11 TASK-758 business-plane scopes is present, pinned to the SDK call needing it · all five SDK keys use the shared set verbatim |

### 4.3 The bootstrap admin, in detail

Three variables, **seed-time only**, read once by `packages/database` and never at runtime:

```
BOOTSTRAP_SUPER_ADMIN_EMAIL       # required to provision
BOOTSTRAP_SUPER_ADMIN_PASSWORD    # required to provision; >= 12 chars
BOOTSTRAP_SUPER_ADMIN_USERNAME    # optional, defaults to `admin`
```

Posture, and why each choice was made:

| Property | Rationale |
|---|---|
| **Absent = no-op** | The seed never invents a credential. It prints what to set and moves on. |
| **Half-set = hard error** | An operator who set the password but not the email would otherwise discover the problem only when they cannot log in. |
| **Well-known values refused, checked BEFORE length** | Most weak values are also short, and *"must be at least 12 characters"* invites padding `password123` → `password1234`, which passes. Naming the real problem is the only message that changes behaviour. |
| **CREATE-ONLY, keyed by reserved id `70000000-…00ff`** | A re-seed never rewrites the row, so a rotated password survives — the opposite of the `91-user.ts` defect fixed in the same change. Also checked by username, so a rename skips cleanly instead of colliding on the unique index. |
| **SYSTEM tenant** | SUPER_ADMIN is `ELEVATED_ROLES`; its authority is platform-wide, so the assignment tenant is the config TIER, never a customer tenant. |
| **`passwordChangedAt` stamped** | `NULL` means "never expires"; a bootstrap credential should age normally. |
| **Password never logged** | Only the username and email are printed. |
| **Runs in `safe` AND `all`** | It is deliberately not on `SEED_PHASES_EXCLUDED_FROM_SAFE` — being skipped in `safe` is the bug it exists to fix. |

**Why `env`, given rule 00 says minimise env vars.** This *is* the bootstrap floor that rule
names: `09-infrastructure-devops.md` §Configuration Tiers keeps in `env` only what is needed to
reach the database or authenticate to Vault, and a first-admin credential is the same class —
the one input that cannot be read from the system it unlocks.

**Why no `SettingDescriptor`, and why not in `turbo.json#globalEnv`.** Registering a descriptor is
the only step needed to make a key *governed and writable* (rule 09); a bootstrap password must
not become addressable through the settings plane. And the root `.env.sample` is a **generated**
artifact (`scripts/env-sync.mts`) whose declared surface is the settings registry plus the
gateway/console/tools config modules — `packages/database` is not one of them, so a hand-edit
there is drift (`pnpm env:sync --check` was re-run to confirm the tree is clean). The precedent
followed is `RUN_SEED` itself: the variable that gates the entire seed appears in neither
`globalEnv` nor the descriptor catalog, for the same reason. Whether these three should acquire
descriptors is listed as an owner decision (§5, OD-6).

---

## 5. Owner Decisions Required

Ordered by day-1 impact. None was guessed at; none is fixed by this ticket.

### OD-1 — The Global customer tenant IS the platform config tier at runtime (highest value)

`.claude/rules/00-project-context.md` says the runtime cascade is exactly *request tenant →
SYSTEM* and that `50000000-…` "never appears in it". The runtime does the opposite, and the seeds
materialise it:

| Evidence | Fact |
|---|---|
| `applications/.../appSettings.service.ts:42` | `PLATFORM_TENANT_IDS = [GLOBAL_TENANT_ID, SYSTEM_TENANT_ID]` |
| same, `:45` | `platformRank` = index in that array → **Global outranks SYSTEM** |
| `settings-registry-write.service.ts:227` | a super-admin write at `'system'` scope lands in `GLOBAL_TENANT_ID` |
| `entitlements.constants.ts:22`, `rate-limit.constants.ts:23` | hardcode Global as the platform row owner |
| seeds writing there | `11-global-setting.ts:420` (18 keys), `11a:162,175`, `11c:96,111`, `12:124,139`, `15:317,329,356,369` |

Complicating it: `.claude/rules/09-infrastructure-devops.md` §"Config caches" **sanctions** this
("sound ONLY because it admits platform-reserved tenants exclusively … `00000000-…` SYSTEM and
`50000000-…` default"). So rules 00 and 09 contradict each other, and `service-account.service.ts:34-41`
refuses Global explicitly — three positions in one codebase. Already logged as C9 PARTIAL in
`docs/programs/agentic-workflow-platform/conformance/gateway-and-sdk.md:45`.

**Not fixable from the seed.** Re-pointing those rows at SYSTEM without changing the runtime
constants would break settings resolution outright. Needs a ruling on which rule wins, then a
coordinated change to the constants + a data migration. This ticket corrected only the part that
is genuinely the seed's: the Global tenant's own description.

> #### OD-1 — RESOLVED 2026-08-20
>
> Owner's ruling, verbatim:
>
> > "SYSTEM will be the reference point as default for all tenants. When creating new tenant, it
> > must clone/copy from SYSTEM tenant. GLOBAL tenant is where super admins can test any
> > configuration, perform a sync to update/transform/release a validated configuration from
> > GLOBAL to SYSTEM for all other tenants to refer to."
>
> So: the runtime cascade is request-tenant → SYSTEM, full stop. GLOBAL (`50000000-…`) NEVER
> appears in a runtime cascade; it reaches other tenants only by an explicit promotion into
> SYSTEM.
>
> **The ranking correction landed** (audit ticket, not this one — see that ticket's README for the
> full hit list and test evidence):
>
> | Site | Before | After |
> |---|---|---|
> | `AppSettingsService.PLATFORM_TENANT_IDS` | `[GLOBAL_TENANT_ID, SYSTEM_TENANT_ID]`, Global ranked first (outranked SYSTEM) | `[SYSTEM_TENANT_ID]` — the sole platform tier; GLOBAL is filtered out exactly like any other customer tenant |
> | `SettingsRegistryWriteService.targetTenantFor('system', …)` / its own `PLATFORM_TENANT_IDS` | resolved to `GLOBAL_TENANT_ID` | resolves to `SYSTEM_TENANT_ID` |
> | `ENTITLEMENTS_TENANT_ID`, `RATE_LIMIT_TENANT_ID` | `50000000-…` (Global) | `00000000-…` (SYSTEM) |
> | Seed rows `11a-platform-knob-settings.ts`, `11c-consultation-gate-settings.ts`, `12-rate-limit-settings.ts`, `15-entitlements.ts` | wrote the platform row under `SEED_TENANT_ID` (Global) | write it under `SYSTEM_TENANT_ID` — matches the corrected write-lane target, so an operator's first `PUT` no longer creates a duplicate platform row |
> | `.claude/rules/09-infrastructure-devops.md` §"Config caches" | sanctioned Global as one of two "platform-reserved tenants" | corrected to name SYSTEM as the sole platform tier |
>
> A CONSEQUENCE, confirmed correct rather than a regression: the `tenantSettings(SEED_TENANT_ID,
> {…})` block in `11-global-setting.ts` (general/feature-flag/admin-menu-order rows, non-`registry`
> namespace) no longer enters `AppSettingsService`'s flat platform cache. That is the fix working
> as intended — those rows are Global's OWN tenant-scoped settings (mirrored 1:1 by an identical
> ArcaAI block right below them) and were never meant to govern every other tenant; they remain
> correctly reachable through the tenant-scoped `GlobalSettingService`/`GlobalSettingController`
> CRUD path (which resolves `tenantId` from CLS, unlike the flat cache).
>
> **NOT resolved by this correction, deliberately** — `TenantService.provisionTenantConfigs`
> (`packages/applications/src/services/tenant/tenant.service.ts`) still looks up the tenant keyed
> `__GLOBAL__` and clones ITS `GlobalSetting` rows into every newly created tenant. Per the owner's
> ruling, new-tenant config provisioning must clone from SYSTEM, not GLOBAL — this is a real,
> confirmed defect against the ruling, but implementing the fix (plus the GLOBAL→SYSTEM
> promotion/sync surface the ruling describes) is out of scope for the ranking-correction ticket
> and is being turned into its own ticket. See that ticket's README §"Promotion-feature scope" for
> the full writeup.

### OD-2 — No day-1 service account is seeded (answers the brief's question 1) — **RESOLVED (owner ruling, 2026-08-20): seed a day-1 SECRET too, opt-in and non-recoverable**

**Original decision (2026-08-18): do not seed one.** TASK-762's own definition of done says *"no
secret value in any migration, seed, or fixture"* (§DoD), the secret is shown once and never
persisted recoverably, and `credentialsRef` points at a Vault path an operator provisions. Seeding
a usable service account would require embedding a client secret, contradicting the ticket that
created the model.

**The consequence, stated plainly at the time:** with TASK-757 landing, a fresh deploy would have
**no machine path to administration at all** until a human SUPER_ADMIN logged in and issued a
service account. TASK-766 (2026-08-19) closed half of that: `94-service-account.ts` now seeds the
ArcaAI tenant's `ARCAAI_ADMIN` service account's **authority** (tenant-scoped `svc:*` scopes
matching `TENANT_ADMIN`, derived and pinned by `__tests__/service-account-seed.test.ts`) on every
deploy, in every environment — but left the **secret** inert outside dev/test, so the human-in-the-
loop requirement above still held for anything that needed to actually authenticate.

**Owner ruling, 2026-08-20, verbatim intent:** the current day-1 posture — no service account
usable until a human SUPER_ADMIN logs in and issues/rotates one — is **not acceptable**;
CI/automation needs machine access from day one. The hard constraint that produced the original
posture still stands unchanged: TASK-762's DoD forbidding a recoverable secret in seed data is not
up for negotiation, and the platform handles PHI.

**Resolution — mirror the bootstrap-admin shape onto this credential, don't invent a new one.**
`92-bootstrap-admin.ts` already proves the exact shape that satisfies both constraints at once: an
operator-supplied value that never touches a tracked file, read once at seed time, turned into a
one-way hash before it ever reaches a column. `94-service-account.ts` now offers the same shape for
this credential, gated on a new env var, `BOOTSTRAP_SERVICE_ACCOUNT_SECRET`:

| Environment | What the seed does |
|---|---|
| `BOOTSTRAP_SERVICE_ACCOUNT_SECRET` set (ANY `NODE_ENV`, incl. production/CI) | The operator's value is peppered-HMAC'd via `computeSecretVerifier` (identical construction to `ServiceAccountService.exchangeToken`'s verifier check) and written as `secretVerifier`. The account authenticates immediately at `POST /api/v1/auth/service-token` — no human login, no `rotate` call. |
| Unset, development/test | Unchanged: the deterministic `SEED_SERVICE_ACCOUNT_DEV_SECRETS` fixture (TASK-766 behaviour, untouched). |
| Unset, everywhere else | Unchanged: the inert random verifier — **the seed invents no credential.** The log names the `rotate` endpoint, exactly as before. |

Why this satisfies TASK-762's constraint: what lands in the database is a peppered HMAC-SHA256
digest with **no recoverable preimage** anywhere in the seed, migration, or fixture tree — the
plaintext lives only in the operator's env/Vault delivery mechanism at seed time, which is the same
bootstrap-floor class of input `09-infrastructure-devops.md` §Configuration Tiers already carves
out for `BOOTSTRAP_SUPER_ADMIN_PASSWORD` (the one input that cannot be read from the system it
unlocks). Absence is still absence: unset the variable and a fresh cluster has zero machine-admin
path, exactly as TASK-766 shipped it — this is a strict opt-in, not a change of default.

**Scope set — deliberately unchanged, and deliberately NOT super-admin.** The credential this
unlocks is still exactly `ARCAAI_TENANT_ADMIN_SVC_SCOPES` — the same tenant-scoped authority a
human `TENANT_ADMIN` holds, no more. "CI/automation needs machine access" was a request to remove
the human-in-the-loop *activation* step, not a request to widen *what* the account can do; the
scope-derivation rule from TASK-766 (include `svc:admin:<area>` iff every ability it implies is one
`TENANT_ADMIN` already holds) is untouched and still mechanically checked by the same test file.

**Validation, mirroring the two existing bootstrap credentials:** minimum 32 characters (higher
than the 12-character human-password floor, because this credential has no login rate limiting
behind it) and the same well-known-value stop-list, checked before the length rule. Absent →
`resolveBootstrapServiceAccountSecret()` returns `undefined` and the seed logs that it is skipping,
same posture as `resolveBootstrapAdminConfig`.

**CREATE-ONLY still applies.** This path only produces a working secret on the row's FIRST
creation — the existing-account reconcile branch still only ever touches `scopes`, never the
credential, so setting the variable against an already-seeded (inert or previously rotated)
environment changes nothing.

**Interaction with TASK-762, restated for the record:** TASK-762's DoD line — *"no secret value in
any migration, seed, or fixture"* — is about what is committed to the repository, not about what an
operator supplies at deploy time and the seed hashes before persisting. `BOOTSTRAP_SERVICE_ACCOUNT_
SECRET` never appears in a migration, seed literal, or fixture; it is read from `process.env`
exactly like the two credentials that already satisfy the same DoD line today. Nothing in TASK-762
is reopened or weakened by this change — the Vault-write gap TASK-762 §7 recorded as deviation D2
(no `ISecretsProvider` write path exists in any of its five providers) is exactly why this seed
reuses the pepper-HMAC construction rather than attempting a Vault write.

Implementation: `packages/database/src/prisma/db_main/seed/94-service-account.ts` (see its "OD-2
revisited, 2026-08-20" docblock section), tests in
`packages/database/src/prisma/db_main/seed/__tests__/service-account-seed.test.ts` and
`packages/applications/src/services/serviceAccount/__tests__/service-account.service.test.ts`.
Operator-facing documentation: `docs/operations/day-one-deployment.md` §2.4.

### OD-3 — A developer's personal domain is a seeded trusted CORS origin — **RESOLVED: KEEP AS IS (owner ruling, 2026-08-20)**

`11b-tenant-allowed-origins.ts:209` seeds `https://*.taphuynh.dev:*` and `:215`
`https://*.4bits.vn:*` as ArcaAI-tenant allowed origins — a personal domain and a former vendor
domain, trusted in **every** environment that runs the seed. `:230,236,242` additionally admit
`chrome-extension://*`, `moz-extension://*`, `safari-web-extension://*` — i.e. any installed
browser extension. The BCMCH hosts (`:183,189,195,203`) are legitimately customer-specific but are
equally wrong for a non-BCMCH deploy.

**Owner decision (2026-08-20): keep every row exactly as seeded, in every environment, including
production.** No code change. The residual exposure, stated plainly so this stops being
re-raised: on every fresh cluster — production included — `*.taphuynh.dev`, `*.4bits.vn`, and the
three browser-extension wildcards are trusted CORS origins for the ArcaAI tenant from first boot,
until an operator removes them through the admin origin UI. `task-641-allowed-origins-seed-corrections.test.ts`
continues to pin this exact row set deliberately; do not "fix" it without a new owner ruling.

### OD-4 — Provider `baseUrl` values cannot be right in both a laptop and a cluster — **RESOLVED: KEEP the seed, ADD a runbook (owner ruling, 2026-08-20)**

`17-ai-provider-connection.ts` seeds `localhost:11434` (ollama), `localhost:1234/v1` (lm-studio),
`http://hope-vllm:8000/v1` and `http://hope-llama-cpp:8080` (k3s Service DNS). The rows are
CREATE-ONLY, so on a fresh cluster the two `localhost` rows are wrong on first boot and an admin
`PUT` is required before the LM Studio-backed `text.live` / `text.finalize` / `guardrail.validate`
defaults resolve to a reachable endpoint.

**Owner decision (2026-08-20): no change to the seed's provider `baseUrl` rows.** The day-1
operator step is now real, tracked documentation instead of a ticket-only recommendation:
[`docs/operations/day-one-deployment.md`](../../operations/day-one-deployment.md) §3.1 names
exactly which rows are CREATE-ONLY and therefore wrong on a fresh cluster, the precise
`GET`/`PUT /api/v1/admin/providers/:service/:provider` calls to correct or disable each, and when
in the deploy sequence it must be done (before the first live consultation, only if the resolved
task default actually selects a local engine).

### OD-5 — `05c-platform-storage-config.ts` persists `http://localhost:9000` when `MINIO_ENDPOINT` is unset — **RESOLVED: KEEP the seed, ADD a runbook (owner ruling, 2026-08-20)**

CREATE-ONLY, so the seed will never self-correct it; an operator must edit it in the console.

**Owner decision (2026-08-20): no change to the seed's storage fallback.** Same treatment as
OD-4: [`docs/operations/day-one-deployment.md`](../../operations/day-one-deployment.md) §3.2
names the exact `GET`/`PUT /api/v1/admin/tenants/storage/config/platform` call, the fields to
correct (`endpoint`, `region`), and the reminder that credentials are never accepted in that body
— only a Vault `credentialsRef` path, which must be populated separately.

### OD-6 — Should `BOOTSTRAP_SUPER_ADMIN_*` acquire `SettingDescriptor`s?

See §4.3 for why they deliberately do not. If the answer is yes, the password needs a tier that
keeps it out of the readable settings plane.

### OD-7 — `WEBHOOK_ADMIN` now has no reachable surface

Its two scopes are reserved and `WebhookController` is JWT-only. The row is kept with `scopes: []`
(fails closed) because `10-audit-log.ts:133` references its id and a WEBHOOK-type key's purpose is
outbound delivery identity. Decide whether to give it a real inbound capability or retire it.

### OD-8 — Smaller items — **owner ruling on departments, 2026-08-20; two sub-items explicitly NOT selected**

Owner's words (2026-08-20): *"what belong to BCMCH keep those in ArcaAI, for SYSTEM and GLOBAL,
use different ones."* Three sub-items from the table below were in scope; the ruling only
addresses the departments row, and only two of the three original findings were selected at all.

**Departments — PARTIALLY RESOLVED, follow-up required.** Re-audited 2026-08-20 against the
current seed (per the owner's instruction to check what currently seeds departments for each
tenant before changing anything):

| Tenant | What currently seeds its departments |
|---|---|
| ArcaAI | `ARCAAI_ALL_CLINICAL_DEPARTMENTS` (`04-department.ts:395-619`) — the 11 BCMCH/v1-parity departments, each FK-bound to its own APPROVED prompt templates (`07-prompt-template.ts`) and (for 7 of the 11) a default `DepartmentAgent` (`07a-agent-golden-library.ts`). |
| Global (`50000000-…`) | `DEFAULT_DEPARTMENTS` (`04-department.ts:14-362`) — 18 rows. **11 of those 18 codes/names are the same 11 BCMCH specialties as ArcaAI's set** (`GEN`/`NEUR`/`ORTH`/`DERM`/`SURG`/`BREN`/`RHEUM`/`HEME`/`DIET`/`NEPH`/`SONC`), plus 7 broader categories ArcaAI does not carry (`CARD`/`RAD`/`LAB`/`PSYCH`/`PEDS`/`ER`/`MED`). |
| SYSTEM (`00000000-…`) | **Not seeded directly at all.** `07a-agent-golden-library.ts`'s `GOLDEN_DEPARTMENTS` maps `DEFAULT_DEPARTMENTS` 1:1 onto the SYSTEM tenant (same `code`/`name`/`description`, new ids) to build the platform's golden department/template/agent library — the exact mechanism `TenantService.provisionTenantAgentCatalog` and `AgentTemplateResyncService` (`packages/applications`) use to clone a starting catalog into every newly-provisioned tenant. |

So: the ArcaAI half of the ruling was already true and needed no change (kept as-is, verified
2026-08-20). The SYSTEM/Global half is **not yet closed**: SYSTEM's "new tenant" starting
catalog is not an independent, hand-authored generic set — it is *derived* from Global's
`DEFAULT_DEPARTMENTS`, which itself duplicates 11 of ArcaAI's 11 BCMCH specialty codes verbatim.
Correcting this is a real re-architecture, not a seed-data tweak: every one of the 18 codes is a
hard Postgres foreign key target from `PromptTemplate.departmentId` (`prompt-template.prisma:75`,
a real `@relation`, not a soft string reference), is keyed into `GOLDEN_TEMPLATE_SOURCE_BY_CODE`
(`07a-agent-golden-library.ts:77`), and feeds the golden-department/template/agent counts several
tests and `agent-template-resync.service.ts` (production runtime code in
`packages/applications`, not seed-only) assume are stable. Shrinking or renaming the set requires
rewriting the bound `07-prompt-template.ts` rows (≈ 20+), re-deriving the golden library, and
updating every test that pins the current 18-department/13-template/18-agent shape — genuinely a
dedicated follow-up ticket, not something to force through as a drive-by alongside the other
owner decisions in this pass. A follow-up task has been flagged (see this ticket's Change History
for the date) so it is not lost.

**Two other OD-8 sub-items were reviewed and explicitly NOT selected by the owner — left exactly
as they are, kept, owner reviewed 2026-08-20:**

| Item | Evidence | Status |
|---|---|---|
| `password123` for 32 demo accounts (`91-user.ts:804`) | Dev/test-gated; the re-seed *reset* hazard is fixed, the literal remains | **Kept, owner reviewed 2026-08-20 — not selected.** |
| `DEFAULT_TENANT_ID` names **two different tenants** across the chain — Global in `04-department.ts:6` / `07-prompt-template.ts:24`, SYSTEM in `06-stt.ts:33` | Renaming touches exported symbols consumed by e2e specs a sibling agent is editing | **Kept, owner reviewed 2026-08-20 — not selected.** |

The remaining findings below were never part of this owner's decision round and stay open exactly
as originally reported:

| Item | Evidence |
|---|---|
| `91-user.ts:918` swallows per-user errors — a partial identity seed exits 0 | |
| 10 raw API-key literals in `00-constants.ts:298-313`, one not in `_test_` form (`:311`) | Double-gated to dev/test; still a secret-scanner finding |
| `nlp.sentiment` / `nlp.toxicity` have no SYSTEM `AiTaskDefault` row and are super-admin-only | Dormant — no runtime consumer today |
| `11-global-setting.ts:279` (`whisper-large-v3-turbo`) disagrees with `06-stt.ts:1775` (`arcaai-whisper-large-ml-en-gguf`) | Two "default STT" knobs |
| `.env.test` sets `API_GATEWAY_KEY` to a value that is **not** a seeded ApiKey raw value | `.env.dev` correctly uses the SERVICE_ACCOUNT raw key; internal STT calls in `test` would not authenticate |

---

## 6. Verification

All commands run from the repo root on branch `feat/loop`, 2026-08-18.

### 6.1 Mintability sweep (the §2.4 evidence)

An ad-hoc script evaluated every scope in `API_KEY_SCOPE_REGISTRY` against each seeded role's
policy closure (following `parentRoleId`), applying CASL's `manage`⊇all-actions and `all`⊇all-subjects.

Before:

```
### TENANT_ADMIN: 74/96 mintable
   - platform:changelog:read  <-- missing read:ChangelogEntry
### DOCTOR: 29/96 mintable
   - platform:changelog:read  <-- missing read:ChangelogEntry
   - tenant:context-schema:read  <-- missing read:ConsultationContextSchema
```

After:

```
### SUPER_ADMIN: 96/96 mintable
### TENANT_ADMIN: 75/96 mintable
### DEPARTMENT_HEAD: 32/96 mintable
### DOCTOR: 31/96 mintable
### NURSE: 18/96 mintable
```

The sweep is now permanently encoded as `reader-plane-mintability.test.ts`.

### 6.2 Package gates

```
$ pnpm --filter @arcaai/database test
 Test Files  55 passed (55)
      Tests  1346 passed (1346)
   Duration  2.10s

$ pnpm --filter @arcaai/database build
> tsc                       # clean, no output

$ pnpm --filter @arcaai/database typecheck
> tsc --noEmit              # clean, no output

$ pnpm env:sync --check
env:sync --check OK — 6 artifacts match the declared surface (149 keys, bootstrap floor 60 lines).
```

This change contributes **67** of those tests across 3 files, 2 of them new — measured per file:
`bootstrap-admin.test.ts` 12, `reader-plane-mintability.test.ts` 29, and
`seed-apikey-sdk-scopes.test.ts` 5 → 31 (+26).

`pnpm --filter @arcaai/database lint` is **not applicable** — `packages/database` declares no
`lint` script and carries no `eslint.config.*`, so ESLint has no config to resolve there. The
package's gates are `build` / `typecheck` / `test`, all green above.

### 6.3 NOT verified — requires a database reset, which was not consented to

The seed was **not executed against a database**. Running it needs a reset
(`pnpm db:all` re-creates the dev DB with `db push --force-reset`), which is destructive and
outside this session's consent. Everything above is static verification plus unit tests over the
seed data structures.

A human should run, in this order:

```bash
# 1. Dev database — DESTRUCTIVE, recreates the local dev DB from scratch
RUN_SEED=all NODE_ENV=development pnpm db:all

# 2. Same, exercising the new phase (use a real password; it is not stored anywhere else)
BOOTSTRAP_SUPER_ADMIN_EMAIL=ops@example.test \
BOOTSTRAP_SUPER_ADMIN_PASSWORD='<a real passphrase>' \
RUN_SEED=all NODE_ENV=development pnpm db:seed

# 3. Idempotency + the CREATE-ONLY guarantee: re-run 2 and confirm the log says
#    "Bootstrap admin already exists … leaving it untouched"
BOOTSTRAP_SUPER_ADMIN_EMAIL=ops@example.test \
BOOTSTRAP_SUPER_ADMIN_PASSWORD='<a real passphrase>' \
RUN_SEED=all NODE_ENV=development pnpm db:seed

# 4. Test database + the e2e suite (TASK-757 is concurrent — coordinate)
pnpm setup:test && pnpm test:up:api   # terminal 1
pnpm test:e2e                          # terminal 2
```

Expected e2e exposure: specs asserting the old `SDK_ARCAAI` admin scopes or the
`SERVICE_ACCOUNT` `'*'` wildcard. `task-708-apikey-scope-contract.spec.ts:315` uses the
SERVICE_ACCOUNT raw key as `X-Internal-Service-Key` against `/internal/stt/*`, which still holds
`internal:stt:worker` and should pass unchanged.

---

## 7. What a fresh day-1 deploy can and cannot do after this change

**Can:**

- Provision and log in as the first SUPER_ADMIN in a `RUN_SEED="safe"` deployment, by setting two
  environment variables — previously impossible.
- Drive the full clinical SDK path with a seeded SDK key in dev/test: transcription, consultation,
  summary + pre-summary, TTS, the template selector, context-schema discovery, tenant/user
  self-service reads, and the What's New dialog.
- Mint an API key for every business-plane reader surface as a tenant admin **or** a clinician —
  the ceiling no longer contradicts the routes.
- Resolve provider/model selection with no cloud credentials: the local engines seed ENABLED and
  every fail-closed task key a service requests has a SYSTEM `AiTaskDefault`.
- Re-seed safely: no rotated password is reset, and the bootstrap admin is never rewritten.

**Cannot:**

- ~~Administer anything from a machine identity until a human issues a service account~~
  RESOLVED 2026-08-20 (OD-2): setting `BOOTSTRAP_SERVICE_ACCOUNT_SECRET` at seed time gives the
  ArcaAI tenant's seeded `ARCAAI_ADMIN` service account a working, non-recoverable secret with no
  human login required — opt-in, absent by default. Issuing a machine identity for any OTHER
  customer tenant still requires a human SUPER_ADMIN (`POST /admin/service-accounts`); that part
  of OD-2 is unchanged.
- Trust the seeded provider `baseUrl` rows in a cluster without one admin `PUT` (OD-4).
- ~~Rely on platform settings being SYSTEM-owned — they were Global-owned, by runtime design~~
  RESOLVED 2026-08-20 (OD-1): the ranking correction lands in a sibling audit ticket — platform
  settings now resolve SYSTEM-only; GLOBAL is an ordinary customer tenant. `provisionTenantConfigs`
  still clones new-tenant config from GLOBAL rather than SYSTEM, which is a separate, tracked
  defect against the same ruling (see that ticket's README).
- Use `WEBHOOK_ADMIN` for anything (OD-7).
- Get any configuration at all if the deployment does not set `RUN_SEED="safe"` — the default is
  `none`, and `deployment` `db-migrate.yaml` passes no `envFrom`. Guardrail then 503s with
  *"AiTaskDefault for 'guardrail.validate' is missing. Run db:seed."*

---

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-18 | Ticket authored and implemented. Reader-plane abilities granted (`01-policy.ts`); seeded API keys conformed to TASK-757's reserved-scope registry and given the TASK-758 business-plane scopes the SDK actually calls (`02-apikey.ts`); env-driven CREATE-ONLY bootstrap SUPER_ADMIN added (`92-bootstrap-admin.ts`, wired in `index.ts`); re-seed password reset stopped (`91-user.ts`); Global tenant description corrected (`05-tenant.ts`); 67 tests added across 3 files. Eight owner decisions recorded in §5. Status **Review** — the seed has not been executed against a database (§6.3). |
| 2026-08-20 | **OD-1 RESOLVED** by owner ruling (quoted verbatim in §5 OD-1): the runtime cascade is request-tenant → SYSTEM, full stop — GLOBAL never appears in it, and reaches other tenants only by an explicit promotion into SYSTEM. The audit + ranking correction landed in a sibling ticket: `AppSettingsService.PLATFORM_TENANT_IDS` and `SettingsRegistryWriteService`'s own copy now admit SYSTEM only (GLOBAL no longer outranks — or even enters — the platform cache); `ENTITLEMENTS_TENANT_ID` / `RATE_LIMIT_TENANT_ID` repointed to SYSTEM; seeds `11a-platform-knob-settings.ts`, `11c-consultation-gate-settings.ts`, `12-rate-limit-settings.ts`, `15-entitlements.ts` now write their platform row under `SYSTEM_TENANT_ID` (matching the corrected write-lane target); `.claude/rules/09-infrastructure-devops.md` §"Config caches" corrected to name SYSTEM as the sole platform tier. Confirmed NOT a regression: Global's own `tenantSettings(SEED_TENANT_ID, …)` rows in `11-global-setting.ts` (general/feature-flags/admin-menu-order) still resolve correctly through the tenant-scoped `GlobalSettingService` CRUD path — they were never meant to enter the flat platform cache. Confirmed NOT yet fixed, tracked as its own follow-up ticket: `TenantService.provisionTenantConfigs` still clones new-tenant `GlobalSetting` rows from GLOBAL (`__GLOBAL__`) rather than SYSTEM, unlike `provisionTenantModelCatalog`/`provisionTenantPipelineCatalog`/`provisionTenantAgentCatalog`, which already clone from SYSTEM correctly. |
| 2026-08-20 | Four more owner decisions applied. **OD-3 (CORS) RESOLVED — KEEP AS IS**: no code change; the seeded `*.taphuynh.dev`/`*.4bits.vn`/browser-extension origins stay trusted in every environment including production, recorded so the finding stops recurring. **OD-4/OD-5 (localhost endpoints) RESOLVED — KEEP the seed, ADD a runbook**: no change to `17-ai-provider-connection.ts` or `05c-platform-storage-config.ts`; the day-1 operator correction steps are now tracked at `docs/operations/day-one-deployment.md` §3, linked from both OD-4 and OD-5. **OD-8 (departments) PARTIALLY RESOLVED**: re-verified ArcaAI/Global/SYSTEM department seeding is unchanged from the original audit — ArcaAI's 11 BCMCH departments are correctly kept (no action needed); the SYSTEM/GLOBAL half of the owner's ruling ("use different [department sets]") is **not yet closed** — SYSTEM's golden department catalog is *derived* from Global's `DEFAULT_DEPARTMENTS`, which duplicates 11 of ArcaAI's BCMCH codes verbatim, and every one of those 18 codes is a hard FK target from `PromptTemplate.departmentId` plus production code in `packages/applications` (`agent-template-resync.service.ts`) — decoupling it safely is a dedicated follow-up, flagged as its own task rather than risked as a same-session rewrite. The other two OD-8 sub-items (`password123` demo accounts, the ambiguous `DEFAULT_TENANT_ID` symbol) were reviewed and explicitly NOT selected by the owner this round — kept exactly as they are. |
| 2026-08-20 | **OD-2 RESOLVED** by owner ruling: the day-1-no-machine-path posture is unacceptable — CI/automation needs machine access from day one — while TASK-762's DoD (no recoverable secret in seed data) stands unchanged. Resolution: `94-service-account.ts` gained `BOOTSTRAP_SERVICE_ACCOUNT_SECRET`, the same operator-supplied/seed-time-only/never-in-a-tracked-file shape as `BOOTSTRAP_SUPER_ADMIN_PASSWORD`. Set (any `NODE_ENV`) → the value is peppered-HMAC'd via the existing `computeSecretVerifier` (identical construction to `ServiceAccountService.exchangeToken`'s check) and written as `secretVerifier`, so the seeded `ARCAAI_ADMIN` account authenticates at `POST /api/v1/auth/service-token` immediately, no human login or `rotate` call needed. Unset → unchanged TASK-766 behavior (dev/test fixture, else inert CSPRNG verifier with no preimage) — the seed still invents no credential. Scope set is unchanged (`ARCAAI_TENANT_ADMIN_SVC_SCOPES`, tenant-scoped, never super-admin) since the ruling asked to remove the human-activation step, not to widen authority. Validation mirrors the two existing bootstrap credentials: 32-character floor, same well-known-value stop-list checked before length. CREATE-ONLY preserved — this only affects first creation, never an existing row. Tests added: `packages/database/.../seed/__tests__/service-account-seed.test.ts` (new describe block: no-op when unset, well-known-value/length rejection, never-a-literal-in-source check, HMAC construction parity, precedence-over-dev-fixture-in-source, resolved-in-every-environment) and `packages/applications/.../serviceAccount/__tests__/service-account.service.test.ts` (new test: a verifier built the same way the seed builds it authenticates through `exchangeToken`). Operator documentation: `docs/operations/day-one-deployment.md` new §2.4. |

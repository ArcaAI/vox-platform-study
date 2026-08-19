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

### OD-2 — No day-1 service account is seeded (answers the brief's question 1)

**Decision taken: do not seed one.** TASK-762's own definition of done says *"no secret value in
any migration, seed, or fixture"* (§DoD), the secret is shown once and never persisted
recoverably, and `credentialsRef` points at a Vault path an operator provisions. Seeding a usable
service account would require embedding a client secret, contradicting the ticket that created the
model.

**The consequence, stated plainly:** with TASK-757 landing, a fresh deploy has **no machine path
to administration at all** until a human SUPER_ADMIN logs in and issues a service account. That is
by design, but it means the bootstrap admin of §4.3 is a hard prerequisite for automation, not just
for humans. Confirm this is the intended day-1 sequence.

### OD-3 — A developer's personal domain is a seeded trusted CORS origin

`11b-tenant-allowed-origins.ts:209` seeds `https://*.taphuynh.dev:*` and `:215`
`https://*.4bits.vn:*` as ArcaAI-tenant allowed origins — a personal domain and a former vendor
domain, trusted in **every** environment that runs the seed. `:230,236,242` additionally admit
`chrome-extension://*`, `moz-extension://*`, `safari-web-extension://*` — i.e. any installed
browser extension. The BCMCH hosts (`:183,189,195,203`) are legitimately customer-specific but are
equally wrong for a non-BCMCH deploy.

Recommendation: drop the two developer domains and the three extension wildcards from the seed and
re-add them per environment through the admin origin UI. Not done here — trusted-origin policy is a
security decision, and `task-641-allowed-origins-seed-corrections.test.ts` pins the row set
deliberately.

### OD-4 — Provider `baseUrl` values cannot be right in both a laptop and a cluster

`17-ai-provider-connection.ts` seeds `localhost:11434` (ollama), `localhost:1234/v1` (lm-studio),
`http://hope-vllm:8000/v1` and `http://hope-llama-cpp:8080` (k3s Service DNS). The rows are
CREATE-ONLY, so on a fresh cluster the two `localhost` rows are wrong on first boot and an admin
`PUT` is required before the LM Studio-backed `text.live` / `text.finalize` / `guardrail.validate`
defaults resolve to a reachable endpoint. Needs either a documented day-1 operator step or
env-derived seeding.

### OD-5 — `05c-platform-storage-config.ts` persists `http://localhost:9000` when `MINIO_ENDPOINT` is unset

CREATE-ONLY, so the seed will never self-correct it; an operator must edit it in the console.
Consider refusing to create the row when the endpoint is absent in a non-development `NODE_ENV`.

### OD-6 — Should `BOOTSTRAP_SUPER_ADMIN_*` acquire `SettingDescriptor`s?

See §4.3 for why they deliberately do not. If the answer is yes, the password needs a tier that
keeps it out of the readable settings plane.

### OD-7 — `WEBHOOK_ADMIN` now has no reachable surface

Its two scopes are reserved and `WebhookController` is JWT-only. The row is kept with `scopes: []`
(fails closed) because `10-audit-log.ts:133` references its id and a WEBHOOK-type key's purpose is
outbound delivery identity. Decide whether to give it a real inbound capability or retire it.

### OD-8 — Smaller items, reported not fixed

| Item | Evidence |
|---|---|
| `DEFAULT_TENANT_ID` names **two different tenants** across the chain — Global in `04-department.ts:6` / `07-prompt-template.ts:24`, SYSTEM in `06-stt.ts:33` | Renaming touches exported symbols consumed by e2e specs a sibling agent is editing |
| 11 BCMCH/v1-parity departments seeded on the ArcaAI tenant (`04-department.ts:398-609`) | A new customer inherits another hospital's department catalog and prompt bindings |
| `91-user.ts:918` swallows per-user errors — a partial identity seed exits 0 | |
| `password123` for 32 demo accounts (`91-user.ts:804`) | Dev/test-gated; the re-seed *reset* hazard is fixed, the literal remains |
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

- Administer anything from a machine identity until a human issues a service account (OD-2).
- Trust the seeded provider `baseUrl` rows in a cluster without one admin `PUT` (OD-4).
- Rely on platform settings being SYSTEM-owned — they are Global-owned, by runtime design (OD-1).
- Use `WEBHOOK_ADMIN` for anything (OD-7).
- Get any configuration at all if the deployment does not set `RUN_SEED="safe"` — the default is
  `none`, and `deployment` `db-migrate.yaml` passes no `envFrom`. Guardrail then 503s with
  *"AiTaskDefault for 'guardrail.validate' is missing. Run db:seed."*

---

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-18 | Ticket authored and implemented. Reader-plane abilities granted (`01-policy.ts`); seeded API keys conformed to TASK-757's reserved-scope registry and given the TASK-758 business-plane scopes the SDK actually calls (`02-apikey.ts`); env-driven CREATE-ONLY bootstrap SUPER_ADMIN added (`92-bootstrap-admin.ts`, wired in `index.ts`); re-seed password reset stopped (`91-user.ts`); Global tenant description corrected (`05-tenant.ts`); 67 tests added across 3 files. Eight owner decisions recorded in §5. Status **Review** — the seed has not been executed against a database (§6.3). |

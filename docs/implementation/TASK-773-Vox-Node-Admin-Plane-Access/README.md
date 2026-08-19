# TASK-773 — `@arcaai/vox-node` Admin-Plane Access via Service Account

| | |
|---|---|
| **Status** | **Review** — Phases A, B, C, D and E1/E2 complete and boot-verified. E3 (E2E against a running gateway) deferred by owner: to be run once infrastructure is up. |
| **Owner** | Platform / SDK |
| **Date** | 2026-08-19 |
| **Type** | feature (SDK surface + API authorization wiring) |
| **Trigger** | Owner requirement, 2026-08-19: *"the package is for the other backend-side to integrate with our system, we need to support admin access using API key on the `/admin/*`"* |
| **Related** | TASK-757 (admin plane ⇒ JWT-only, policy A2), **TASK-762 (machine identity for administration — the credential this ticket consumes)**, TASK-766 (scope/ability wiring trap), TASK-767 (the `svc:` business-plane precedent this ticket mirrors onto the admin plane), TASK-756 (API-key minting privilege ceiling), TASK-632 (`@arcaai/vox-node` inception) |
| **Owner decisions recorded** | **D-1** credential class = service account · **D-2** coverage = all 70 admin areas · **D-3** three surfaces stay machine-closed · **D-4** SDK family → 3.0.1 in lockstep · **D-5** impersonation not built · **O-1** webhooks opened, monitoring + health closed · **O-2** delivery log exposed via the scope, not the route · **O-3** `:read` scopes made real · **O-4** admin-only read subjects instead of widening shared ones. All 2026-08-19. |

---

## 1. Requirement Analysis

A backend integrator running server-side against HOPE must be able to perform **administration**
(tenant provisioning, user management, entitlements, audit reads, …) using a **non-interactive
machine credential**, through `@arcaai/vox-node`.

### 1.1 The requirement as stated vs. as buildable

The requirement says *"using API key on the `/admin/*`"*. Taken literally that is **not
buildable**, and not because of an implementation gap — it is refused by a deliberate policy
shipped one day earlier:

- **Policy A2 (TASK-757, `276f96a32`)** — `/api/v1/admin/*` is a **JWT-only** plane. All 69 admin
  controllers were swept from class-level `@RequiredScopes` to `@ForbidApiKey()`.
- The 56 `admin:*` scope strings are **reserved, not deleted**: refused at grant time by a DTO
  constraint on create plus a widening-delta check on update, and filtered out of
  `getAvailableScopes` so the console stops advertising them.
- `auditAdminControllersDeclareNoApiKeyScopes` walks `ModulesContainer` at startup and **fails
  boot** on any `admin/`-prefixed route resolving `@RequiredScopes`. It is derived, not
  transcribed, so a newly written admin controller is caught the day it is authored.
- `@ForbidApiKey()` is checked *before* the scope check, so **no scope — including `*` — can
  rescue a forbidden route**. There is no SUPER_ADMIN fast path: A2 is a credential-class
  question, not a privilege one.

That commit's own closing line states the consequence: *"after this there is no machine path to
administration until a TASK-762 service account is issued."*

### 1.2 What the requirement actually needs

The integrator's need is a **machine credential that behaves like an API key** — an opaque
string, set once in server config, sent on every request, no interactive login. That is exactly
what TASK-762 built as the **service account**, the platform's third credential class:

| | Tenant API key | **Service account** | User JWT |
|---|---|---|---|
| Header | `X-API-Key` | **`X-Service-Account-Token`** | `Authorization: Bearer` |
| Scope namespace | `api-key:*` / business `admin:*` (reserved) | **`svc:*`** | — (CASL abilities from roles) |
| Issued by | tenant admin | **SUPER_ADMIN only** | interactive login |
| Reaches `/admin/*` | **never** (A2) | **yes, by design** | yes |
| Obtained | minted once, long-lived | **exchanged** at `POST /api/v1/auth/service-token`, opaque, ~15 min TTL, rotating | login flow |

**D-1 (owner, 2026-08-19): the service account is the credential class.** Re-admitting tenant API
keys to `/admin/*` was considered and rejected — it would require deleting the boot audit,
un-reserving 56 scopes, removing `@ForbidApiKey()` from 69 controllers, and re-opening the
privilege ceiling TASK-756 closed (a *tenant* admin could then mint a key carrying *platform*
admin scope, which is the escalation the third credential class exists to prevent).

For the integrator this is a naming difference, not a workflow difference: one opaque secret in
config, one header. The one genuinely new obligation is the **token exchange** — the credential
is a `(clientId, clientSecret)` pair exchanged for a short-lived token, rather than a single
long-lived string. The SDK absorbs that entirely (§5.3); the integrator still writes two config
values and never thinks about it again.

### 1.3 Scope

**In scope:** wiring the admin plane to accept service accounts (API); service-account
authentication and token lifecycle in `@arcaai/vox-node`; the admin resource surface in the SDK;
docs, versioning, tests.

**Out of scope:** any change to policy A2; any change to tenant API-key capability; the browser
SDK `@arcaai/vox` (JWT/session-based, has its own admin surface via the console); issuance UX
(TASK-762 owns `POST /admin/service-accounts`); new admin *endpoints* — this ticket exposes what
already exists.

---

## 2. Current State Evaluation

Verified against the working tree at `1fb27e185` (2026-08-19).

### 2.1 The credential exists and is complete

`packages/applications/src/services/serviceAccount/` + the third `UnifiedAuthGuard` branch:

- Header constant `SERVICE_ACCOUNT_TOKEN_HEADER = 'x-service-account-token'`
  (`unified-auth.guard.ts:51`).
- Principal shape (`unified-auth.guard.ts:179`): `{ id, clientId, tenantId, workingTenantId,
  scopes, roles, allowedTenantIds? }`.
- Exchange route `POST /api/v1/auth/service-token` (`service-account-token.controller.ts:36`) —
  `@Public()` **plus** a dedicated `ServiceAccountTokenGuard`; boot audit F pins that pairing so
  "public" can never mean "unguarded". Returns an **opaque** token (never a JWT), default 15 min.
- **`workingTenantId` is bound at EXCHANGE time**, not per request (`service-account.service.ts:306`).
  A platform account resolves SYSTEM when it asks for nothing; `50000000-…` ("Global") is
  explicitly refused as a host, per the two-reserved-tenants rule.
- Rotation (two-slot), immediate revocation, and live-token purge on a narrowing update.

### 2.2 The vocabulary exists and is complete

`service-account-scopes.registry.ts` derives, at module load, a `svc:admin:<area>` twin for
**every one of the 56 concrete `admin:*` scopes**, copying each `implies` verbatim. Boot audit D
(`auditSvcScopeCoverage`) already refuses to start if any admin area lacks a `svc:*` scope, if any
`svc:admin:*` maps to no live area, or if any `svc:*` scope resolves to **zero abilities** — the
TASK-766 trap where a scope passes the string-matching guard and is then 403'd by CASL.

**Nothing needs inventing here.** The vocabulary is done and audited.

### 2.3 The gap: no admin route is declared machine-reachable

`enforceServiceAccountScopes` is **deny-by-default** — a route declaring no `svc:*` scope denies
every service account. Today `@RequiredSvcScopes` appears on exactly **five** controllers, all
from TASK-767's business-plane work:

```
service-account.controller.ts        (in a comment only — it @ForbidServiceAccount()s)
streaming/text-proxy.controller.ts   (native summarization)
streaming/transcription-job.controller.ts (native STT)
stt-compat.controller.ts             (compat STT)
text-compat.controller.ts            (compat summarization)
```

**Zero admin controllers.** So a service account today authenticates successfully against
`/admin/*` and is then refused with `no_svc_scopes_declared`. This is the single blocking
prerequisite; no SDK change can work without it.

The codebase already anticipates this exact ticket. Boot audit **G**
(`auditServiceAccountReachableRoutesAreDeclared`) carries a `NOTE ON SCOPE` in its own header:

> *"right now no route in the tree declares `@RequiredSvcScopes` … This audit therefore enforces
> the invariant where it can bite … **The full every-route form belongs with TASK-757's
> admin-plane cutover, when `svc:*` declarations actually land.**"*

That cutover is this ticket.

### 2.4 The controller → scope mapping is recoverable, not guesswork

TASK-757 removed exactly one `@RequiredScopes('admin:<area>')` per admin controller and replaced
it with `@ForbidApiKey()`. The mapping is therefore **mechanically recoverable** from
`git show 276f96a32`, 1:1, across 69 controllers — e.g.
`department.controller.ts: -@RequiredScopes('admin:department:manage') +@ForbidApiKey()`.

The `svc:` declaration to apply is `toServiceAccountScope(<that scope>)`. This is derivation from
a recorded fact, not re-classification, and it makes boot audit D's coverage claim true at the
*route* level as well as the *registry* level.

### 2.5 The admin surface

70 `@Controller('admin…')` declarations; 56 distinct scope areas. Of the routes: **37
controllers** use `@RequiresIfMatch` (ETag/If-Match OCC — 428 on missing, 412 on drift) and **19**
return `PaginatedResponse`. Both contracts are already modelled in vox-node
(`PreconditionRequiredError`, `VersionConflictError`, `If-Match` on summary updates), so the
admin surface reuses them rather than inventing anything.

### 2.6 Routes that must stay machine-closed even under D-2

D-2 is "all 70 areas", but three surfaces are named in the guard's own documentation as wanting
`@ForbidServiceAccount()` independently of scope, and one is already pinned by boot audit E:

| Surface | Why |
|---|---|
| `admin/service-accounts` | **Self-replication.** A machine must not mint another machine. Already carries `@ForbidApiKey()` + `@ForbidServiceAccount()`, pinned by boot audit E. |
| `AdminImpersonationController` | Impersonation is a machine assuming a *human* identity — it defeats the audit attribution TASK-762 added (`AuditLog.responsibleServiceAccountId`, mutually exclusive with `responsibleUserId`). |
| `ConsentGrantController` | Consent is an act of a person. A machine recording consent on a person's behalf is a compliance claim the platform cannot substantiate. |

> **D-3 (owner, 2026-08-19): these three stay machine-closed.** Confirmed at the approval gate —
> what was assumption A-1 is now a decision. It is a *safety carve-out*, not a reduction of D-2:
> the other 67 areas are wired. Each of the three carries `@ForbidServiceAccount()` and is
> deliberately absent from the generated SDK surface (§5, D5), so an integrator gets no method
> that would always 403. Re-opening any of them is a new owner decision, not a code-review call.

### 2.8 The 70 admin controllers do not decompose the way D-2 assumed

Established by the A1 fixture extraction (2026-08-19), cross-checked against `276f96a32` and the
live tree. The arithmetic closes exactly, and it splits **three ways**, not two:

| Group | Count | Disposition |
|---|---|---|
| Carried a class-level `@RequiredScopes('admin:<area>')` that TASK-757 removed | **64** | Mechanically wireable — `@RequiredSvcScopes(toServiceAccountScope(row.adminScope))`. This is the fixture, and the sweep. |
| Machine-CLOSED by owner decision **D-3** | **3** | `ServiceAccountController`, `AdminImpersonationController`, `ConsentGrantController`. Get `@ForbidServiceAccount()`. |
| **No `admin:*` scope to renamespace** | **3** | **Needs an owner decision — see below.** |
| | **70** | |

The third group is the finding. These controllers sit on the admin plane but have nothing for the
`svc:admin:<area>` derivation to consume:

| Controller | Route | What it actually carries |
|---|---|---|
| `WebhookController` | `admin/webhooks` | Was gated by `webhook:event:write` — a `webhook:*` scope, not `admin:*` — which TASK-757 stripped and reserved along with the `admin:*` ones (it does not *carry* the decorator today; corrected 2026-08-19). The `svc:` registry derived only the concrete `admin:*` family, so **no `svc:webhook:event:write` twin existed**. |
| `MonitoringController` | `admin/monitoring` | Never class-level scope-gated at all — `@CanAny` ability decorators only. |
| `AdminHealthServicesController` | `admin/health/services` | Same: `@CanAny`, never scope-gated. TASK-759 moved it here off the public `health` prefix. |

**Why boot audit D did not catch this.** D asserts *"every `admin:*` scope has a `svc:` twin and
vice-versa"* — it reconciles the two **registries**. It says nothing about whether every admin
**controller** is covered by a scope, and these three are precisely the controllers that no
`admin:*` scope names. The gap is real and pre-existing; TASK-773 is simply the first work that
had to enumerate controllers rather than scopes.

**O-1 RESOLVED (owner, 2026-08-19): open `admin/webhooks`; close the other two.**

`admin/webhooks` is opened via a **third derived family** —
`ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES = ['webhook:event:write']` — rather than by stretching
`STANDALONE_FEATURE_SCOPE_SOURCES`, whose name means "standalone *business*-plane features an end
user drives through the SDK (STT, summarization)" and would then carry contents it denies. Each
family keeps a closed source list; assertion D reconciles non-admin `svc:` scopes against their
union and names both constants in the failure, so an undeclared scope is told which family it
should have joined. `svc:webhook:event:write` resolves to `[{ manage, Webhook }]` — the identical
`implies` the API-key path used on the same route.

> **Deliberate and asserted:** `svc:admin:*` does **not** reach webhooks. That wildcard expands
> over the `svc:admin:` prefix, not "the admin plane", so this area is granted explicitly or not
> at all. It surprises people, which is exactly why it carries a test.

`admin/monitoring` and `admin/health/services` are closed with `@ForbidServiceAccount()`. Both are
operator telemetry whose value is in a person looking at it, not rows an integration can act on;
the health fan-out is additionally a 4–6-call outbound SSRF amplifier, which is the last surface
to hand to a credential that can be driven in a loop.

**O-2 RESOLVED (owner, 2026-08-19): expose the delivery log.** `GET admin/webhooks/:id/deliveries`
is `@Authorize(['read','WebhookRunHistory'])`, which `svc:webhook:event:write` does not imply.

Fixed by completing the **scope**, not by widening the **route**: `webhook:event:read` is named
"read webhook events" and the delivery log *is* the event record, so a holder that could read the
subscription but not its deliveries was under-specified. Its `implies` now carries
`read:WebhookRunHistory` alongside `read:Webhook`, it joins
`ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES`, and the route declares the pair.

That choice is the general rule this ticket arrived at, stated once here: **a route decorator is
shared by every principal class, so widening one is never "for machines only"; `implies` reaches
only credentials whose abilities are BUILT from scopes.** Human abilities come from DB policies
(`tenant-full-access` is the sole grantor of `read:WebhookRunHistory`, unchanged), and
`admin/webhooks` is `@ForbidApiKey()`, so no API key can reach the route regardless. Net human
blast radius: zero.

### 2.9 Least privilege is not expressible for four areas (O-3)

Surfaced by the A6 guard-level reachability tests, then confirmed by differencing the registry
against every `@RequiredSvcScopes` declaration in the tree. Of the 55 concrete `svc:admin:*`
scopes, **51 are declared on a route and 4 are not**:

| Orphaned registry scope | The controller declares instead |
|---|---|
| `svc:admin:tenant:read` | `svc:admin:tenant:write` (`TenantController`) |
| `svc:admin:user:read` | `svc:admin:user:write` (`UserController`) |
| `svc:admin:apikey:read` | `svc:admin:apikey:write` (`ApiKeyController`) |
| `svc:admin:role:read` | `svc:admin:role:write` (`RolesController`) |

Every one is the `:read` half of a `:read`/`:write` pair. In each case the controller carries the
`:write` scope at **class level**, covering its read routes and its write routes alike.

**This is inherited, not introduced.** TASK-757's `admin:*` scopes were class-level, so read/write
granularity was already collapsed for API keys; the sweep reproduced the existing gating exactly,
which is the derivation principle working as specified. Boot audit D does not catch it because D
reconciles the two REGISTRIES — it never asks whether a registry scope has a route consumer.

**But the consequence is sharper for the new class.** An operator who grants
`svc:admin:tenant:read`, intending least-privilege read-only tenant access for an integration,
gets a service account that reaches **nothing** — every route on `TenantController` demands
`:write`. To give a machine read access to tenants you must grant `:write`, which also grants
mutation. For a credential handed to a third-party backend, "read-only" being inexpressible is a
more serious property than it was for a human-operated console.

**O-3 RESOLVED (owner, 2026-08-19): make the `:read` scopes real.** Delivered for **two** of the
four. The other two cannot be done at this layer, and the reason is worth recording.

Each read route now declares the **PAIR** — `@RequiredSvcScopes('svc:admin:<area>:read',
'svc:admin:<area>:write')` — at METHOD level, with the class-level `:write` left in place as the
default for every other route. The pair, never `:read` alone: `enforceServiceAccountScopes` is
`required.some(...)`, so declaring only `:read` would have **revoked those routes from every
existing `:write` holder**. The pair leaves `:write` reaching exactly what it reached before and
additionally lets a `:read`-only grant through.

| Area | Read routes demand | `:read` scope implies | Outcome |
|---|---|---|---|
| `admin:role` | `read:Role` OR `manage:Role` | `read:Role` | **done** |
| `admin:apikey` | `read:ApiKey` | `read:ApiKey` | **done** |
| `admin:tenant` | `manage:Tenant` OR `update:Tenant` | `read:Tenant` | **blocked** |
| `admin:user` | `manage:User` | `read:User` | **blocked** |

**Why the last two are blocked, not skipped.** Granting them would reproduce the TASK-766 trap
exactly: the scope gate is string matching, so `svc:admin:tenant:read` would PASS
`enforceServiceAccountScopes` and then be refused by CASL, because `read:Tenant` satisfies neither
`manage:Tenant` nor `update:Tenant`. A credential that looks correctly scoped and 403s anyway is
the worst possible failure to debug — which is the specific outcome boot audit D exists to
prevent. Verified by building the ability exactly as `UnifiedAuthGuard` does
(`policyEngine.buildAbilityFromRules(serviceAccountPolicyRules(scopes))`) and evaluating it
against each route's own metadata:

```
svc:admin:tenant:read  →  [{"action":"read","subject":"Tenant"}]
  FAIL  TenantController.fetchAll     requires ["manage:Tenant","update:Tenant"]
  FAIL  TenantController.fetchById    requires ["manage:Tenant","update:Tenant"]     (+3 more)
svc:admin:user:read    →  [{"action":"read","subject":"User"}]
  FAIL  UserController.fetchAll       requires ["manage:User"]
  FAIL  UserController.fetchById      requires ["manage:User"]                       (+2 more)
svc:admin:apikey:read  →  [{"action":"read","subject":"ApiKey"}]
  PASS  ApiKeyController.fetchAll · fetchById · getUsage · getAvailableScopes
svc:admin:role:read    →  [{"action":"read","subject":"Role"}]
  PASS  RolesController.findAll · findOne · listMembers
```

**O-4 RESOLVED (owner, 2026-08-19): mint admin-only read subjects.** Orphan count is now
**0 of 55** — every concrete `svc:admin:*` scope reaches a route.

The literal fix — accepting `read:Tenant` / `read:User` on those routes — was traced against the
seed first and rejected as an **escalation**, not a widening:

| Ability | Granted by | Who holds it | What accepting it would hand them |
|---|---|---|---|
| `read:Tenant` | `user-profile-own` | **every authenticated user** | `GET /admin/tenants`, `/admin/tenants/:id/usage`, `/admin/tenants/configs` |
| `read:User` | `consultation-department-read` | `DEPARTMENT_HEAD`, `SENIOR_NURSE` | the admin user list, **`/admin/users/export`** (bulk export of every user in the tenant), per-user settings |

Instead, two **admin-plane-only** subjects are minted — `AdminTenantDirectory` and
`AdminUserDirectory` — added to the read routes as an alternative, and `admin:tenant:read` /
`admin:user:read` are mapped onto them. No seeded policy grants either subject, so no human role
gains anything; a service account's abilities are built from its scopes, so it does. Not a new
pattern: `TenantTelemetry` was minted the same way to widen the monitoring and service-release
gates without touching a broad subject.

**Method level on the 7 tenant GETs and 9 user GETs, never class level** — the write routes on
both controllers inherit their class ability, so widening there would have let a read-only token
mutate. Each read route declares the scope pair, for the same `.some()` reason as O-3.

Verified by building the ability exactly as `UnifiedAuthGuard` does and evaluating it per route:

```
:read-only machine        →  7/7 tenant GETs, 9/9 user GETs reachable
:write grants (existing)  →  7/7 and 9/9 still reachable — no regression
read:Tenant   (every authenticated user)        →  0 of 7 reachable
read+list:User (DEPARTMENT_HEAD, SENIOR_NURSE)  →  0 of 9 reachable
```

Boot audit **H** was widened to match, and deliberately not loosened into "any superset". It
permits exactly two shapes: the twin alone (anywhere), or the twin paired with its own `:read`
sibling (**method level only**). The sibling is DERIVED from the row's twin, so an area with no
`:read` half cannot acquire one. Class level is excluded because the pair there would put `:read`
on the DELETE routes too — a read-only token could then mutate, inverting the very decision O-3
exists to serve.

### 2.7 `@arcaai/vox-node` today

Version 3.0.0, zero runtime dependencies, Node ≥ 22 / Bun / Deno / edge.

- `HopeClientOptions`: `{ baseUrl, apiKey?, tenantId?, maxRetries?, timeout?, fetch?, logger? }`.
- `Transport.buildHeaders` sets `X-API-Key` from `config.apiKey`, `X-Tenant-Id` from
  `config.tenantId`, and already supports an async `Authorization: Bearer` token provider
  (`transport.ts:106`) — **the hook a rotating service-account token needs already exists in
  shape**, it just targets the wrong header.
- Resources: `summarization`, `consultations` (+`.summaries`), `jobs`. Three resources, ~15
  methods. The admin surface is roughly **an order of magnitude larger**.
- `core/url.ts` prefix handling is correct and now mirrors the gateway exactly (fixed at
  `1fb27e185`). Admin paths are ordinary `api/v1`-prefixed paths — no exemption interaction.
- **No OpenAPI JSON export exists** in the repo. Swagger is served at `/api/v1/docs` in
  non-production but never written to a file, so there is no artifact to generate from today.

---

## 3. The one genuinely hard design question

**How is a ~350-route admin surface added to a hand-authored, heavily-documented SDK without it
drifting from the API on the first merge?**

vox-node's three existing resources are hand-authored with dense doc comments explaining wire
contracts. That style does not survive ×20 scale — and this repo has already learned the lesson
twice in a fortnight: TASK-757's hand-transcribed audit list silently policed 63 of 65
controllers, and TASK-760's blast-radius table was incomplete *twice*. The house rule that
emerged is **derive, don't transcribe**.

### 3.1 Chosen approach: generate from a cross-checked route manifest

Two sources, each authoritative for a different half, cross-checked against each other:

| Source | Authoritative for | Why it is trustworthy |
|---|---|---|
| **Nest `ModulesContainer` walk** | route existence, path, HTTP verb, `@RequiredSvcScopes`, `@ForbidServiceAccount`, `@RequiresIfMatch` | It is *exactly* what `UnifiedAuthGuard` reads at request time. The boot audits already do this walk (`walkRoutes()` in `service-account-surface-audit.ts`) — proven mechanism, zero new risk. |
| **OpenAPI document** (`SwaggerModule.createDocument`) | request/response **types**, from the class-validator/`@ApiProperty` DTOs | The DTOs are already mandatory: the global pipe runs `forbidNonWhitelisted`, so an undeclared field is rejected at runtime. Declaration is not optional here. |

The generator emits a manifest from the Nest walk and **fails** if the OpenAPI document disagrees
about which routes exist. That disagreement is itself the useful signal — it means a route is
missing its Swagger decorators, which is a documentation defect worth failing on.

**Fallback if OpenAPI fidelity proves poor** (Phase B is a go/no-go spike, §5.2): emit typed
methods with `unknown`-typed bodies from the Nest manifest alone, and hand-type the highest-value
areas. Route *shape* would still be fully derived; only the payload types would be partial. This
degrades gracefully and never blocks the ticket.

### 3.2 What is generated vs hand-authored

- **Generated:** `src/resources/admin/*.ts` (one module per area), the route manifest, request and
  response types, the barrel.
- **Hand-authored, once:** the `AdminResource` base (pagination iterator, If-Match plumbing,
  error mapping), the credential/token lifecycle (§5.3), and `HopeClient` wiring. These are the
  parts that carry judgment; they are small and stable.
- **Zero runtime dependencies preserved** — the generator is a build-time devDependency, exactly
  as `packages/vox-codegen` established for the "same brand, different runtime" case.

---

## 4. Verification Criteria

The ticket is done when all of the following hold, with pasted evidence:

1. Boot audit **G strengthened to its full every-route form** — every route reachable by a
   service-account token declares either a `svc:*` scope or `@ForbidServiceAccount()` — and the
   gateway boots green with it.
2. A service account holding `svc:admin:tenant:read` can `GET /api/v1/admin/tenants` and is
   refused (403) on an area it does not hold.
3. The three §2.6 surfaces refuse a service account with a machine-class denial, not a scope
   denial.
4. `@arcaai/vox-node` authenticates by service account, exchanges and **transparently refreshes**
   the token before expiry, and never logs or exposes the client secret.
5. Generated admin surface compiles, and the generator is **idempotent** — re-running it produces
   a byte-identical tree (a CI drift gate, mirroring `generate-*-check`).
6. OCC round-trip works end to end through the SDK: read → ETag → `If-Match` PATCH → 412 on drift.
7. `pnpm --filter @arcaai/vox-node test lint typecheck build` green; `pnpm --filter @arcaai/api
   test` green; `pnpm api:build` green.
8. E2E: a real service-account token drives at least one read, one paginated list, and one
   OCC-guarded write through a running gateway.

---

## 5. Implementation Plan

TDD throughout (RED observed before GREEN). Phases A and B are API-side and **block** C–E.

### Phase A — Open the admin plane to the machine class *(API; blocking)*

| # | Step | Verify |
|---|---|---|
| A1 | Extract the controller → `admin:*` scope mapping from `git show 276f96a32` into a checked-in fixture (69 rows). It is evidence, not configuration. | Fixture row count matches the commit's controller count. |
| A2 | Apply `@RequiredSvcScopes(toServiceAccountScope(<mapped scope>))` to each admin controller **except** the three in §2.6, which get `@ForbidServiceAccount()`. Class-level, mirroring how `@ForbidApiKey()` was applied. | 67 controllers declare a `svc:` scope; 3 forbid. |
| A3 | Strengthen boot audit **G** to the full every-route form its own `NOTE ON SCOPE` defers to this cutover. Delete the note. | Boot fails on a deliberately un-decorated admin controller; passes on the real tree. |
| A4 | Add audit **H**: every admin controller's `svc:` declaration equals the `svc:` twin of the `admin:*` scope it carried before TASK-757 (reads the A1 fixture). Catches a mis-assignment that G, which only checks *presence*, cannot see. | Boot fails on a deliberately swapped scope. |
| A5 | CASL check: confirm `serviceAccountPolicyRules` yields a non-empty ability set for every newly-declared scope. Audit D already asserts this registry-wide — re-assert it *per route* so the TASK-766 "passes the guard, 403'd by CASL" trap cannot reappear at the route layer. | Every wired route resolves ≥ 1 ability. |
| A6 | Unit tests: per-area reachability (holds scope ⇒ 200; lacks ⇒ 403; three carve-outs ⇒ machine-class denial). | Suite green. |

> **A2 is the whole security surface of this ticket.** It makes 67 administration areas
> machine-reachable in one commit. It should be reviewed as a security change, area by area,
> against the A1 fixture — not skimmed as a mechanical decorator sweep.

### Phase B — OpenAPI export + fidelity spike *(API; go/no-go)*

| # | Step | Verify |
|---|---|---|
| B1 | Add `pnpm api:openapi` — build the Swagger document via `SwaggerModule.createDocument` and write `openapi.json`. No server needed; document generation is offline. | File emitted; route count matches the Nest walk. |
| B2 | **Spike (go/no-go):** measure DTO coverage across the admin surface — what fraction of routes have a typed request body and a typed response. | A number, recorded in §7. |
| B3 | Decide generation fidelity from B2 (§3.1 fallback if poor). Record the decision. | Decision recorded before Phase D starts. |

### Phase C — Service-account credential in the SDK *(vox-node)*

| # | Step | Verify |
|---|---|---|
| C1 | Extend `HopeClientOptions` with `serviceAccount?: { clientId, clientSecret, workingTenantId? }`. **Additive** — existing `apiKey` callers unaffected. | Existing tests unchanged and green. |
| C2 | Reject `apiKey` + `serviceAccount` together at construction. The gateway already 400s on two credentials (`unified-auth.guard.ts:334`); failing at construction turns a runtime refusal into a programming error. | Constructor throws. |
| C3 | `ServiceAccountTokenProvider`: exchange at `POST auth/service-token`, cache, refresh on a **skew margin before expiry**, single-flight so concurrent requests trigger one exchange, and retry once on a 401 (token revoked mid-flight). | Unit tests incl. concurrent-refresh and revoked-mid-flight. |
| C4 | `Transport.buildHeaders` sets `X-Service-Account-Token`. Reuses the existing async-token hook shape (`transport.ts:106`). | Header asserted; `X-API-Key` never co-sent. |
| C5 | **Redaction:** client secret and token never reach `HopeLogger` or any error message. `core/redact.ts` exists — extend its fixture set. | Redaction test over both. |
| C6 | Document that `workingTenantId` binds **at exchange**, not per request — the one place `X-Tenant-Id` intuition from the API-key path misleads. | Doc comment + test pinning the binding point. |

### Phase D — Admin resource surface *(vox-node)*

| # | Step | Verify |
|---|---|---|
| D1 | Generator package (`packages/vox-node-codegen`, following the `vox-codegen` placement precedent): Nest manifest + OpenAPI types, cross-checked per §3.1. | Generator runs offline against the checked-in `openapi.json`. |
| D2 | Hand-author `AdminResource` base: paginated async iteration, `If-Match` plumbing off a prior read's ETag, error mapping (404-over-403 documented as "not yours", 428/412 OCC). | Base-class unit tests. |
| D3 | Generate `hope.admin.<area>` for the 67 wired areas. Each generated module carries its `svc:` scope in a doc comment so an integrator reads the required scope at the call site. | Compiles; surface matches the manifest. |
| D4 | Drift gate: `pnpm --filter @arcaai/vox-node gen:admin:check` fails on any diff, mirroring `generate-*-check`. Wire into `.gitlab/ci/validate.yml`. | Gate fails on a hand-edit; passes clean. |
| D5 | Deliberately **omit** the three carve-out areas from the generated surface, with a comment naming §2.6. A method that always 403s is worse than no method. | Absent from the barrel. |

### Phase E — Docs, versioning, E2E

| # | Step | Verify |
|---|---|---|
| E1 | `packages/vox-node/README.md`: service-account quickstart, credential comparison table, scope→area reference, the `workingTenantId` binding note. | Reviewed. |
| E2 | A `patch` changeset describing the full new surface (the version number does not carry it — see §6.1), then `pnpm changeset:version` per **D-4**. | All EIGHT `fixed`-group packages report 3.0.1; `pnpm changeset:status` clean beforehand. |
| E3 | E2E spec `task-773-service-account-admin.spec.ts`: real token exchange → admin read → paginated list → OCC write → 412 on drift → carve-out refusal. | Suite green against a running gateway. |
| E4 | Update `.claude/rules/08-vox-sdk.md` — the `@arcaai/vox-node` section currently describes an API-key-only, three-resource SDK. | Rule matches reality. |

---

## 6. Decisions Taken at the Approval Gate, and What Remains Open

### 6.1 Resolved

**D-3 — the three §2.6 surfaces stay machine-closed.** See §2.6.

**D-5 — service-account impersonation is NOT built (owner, 2026-08-19).** Raised at the gate and
declined: machines never impersonate, and a human super-admin remains the only path. Recorded here
with what it *would* have cost, so the question is not re-opened from scratch:

- A service account cannot call it today by **two independent gates** — `impersonate` requires the
  caller to be SUPER_ADMIN, and `isSuperAdmin()` is deliberately `false` for machine principals
  (TASK-757 pinned that with a regression test precisely so a future "fix" could not reopen every
  super-admin route).
- It **mints a user JWT** (`createJwt`), time-boxed ~30 min and non-refreshable. Once through, the
  caller authenticates on the *JWT* branch with the **target user's abilities** — entirely outside
  the `svc:` scope system. An impersonation scope would therefore mean "become any non-super-admin
  user for 30 minutes": a service account holding only `svc:admin:user:read` could impersonate a
  tenant admin and perform tenant-admin writes.
- Existing bounds that would have helped: the target may be neither a SUPER_ADMIN nor a service
  account. Attribution mostly works already (`impersonatedBy` lands in `metaData`), but the token
  payload has no shape for a *machine* actor, so that would need adding.

Cost, had it been approved: a new scope, a caller-check change, a token-payload change, and
attribution plumbing — a privilege-boundary redesign, not a decorator.

**D-4 — the SDK family bumps in lockstep to `3.0.1`.**

> **Superseded mechanism (corrected 2026-08-19).** This decision was taken when
> `scripts/publish-sdk.sh <version>` was the only working release path — its own header recorded
> that the CI `publish-sdk` job called Changesets but the repo had no `.changeset/`, so that job
> could not run. Commit `24229e319` fixed exactly that: Changesets is now installed and
> configured, and its `fixed` group holds **all eight** SDK packages (`vox`, `vox-node`, `room`,
> `stt`, `vad`, `noise-filter`, `med-ner`, `pipeline`) in mechanical lockstep. **Use Changesets.**

The release is therefore a `patch` changeset plus:

```
pnpm changeset:version    # bumps all eight to 3.0.1 by the `fixed` group
pnpm changeset:publish
```

Lockstep is now enforced by config rather than by convention — bumping one package bumps all
eight, which `24229e319` introduced precisely because `@arcaai/pipeline` had silently drifted a
full major behind. Note the consequence for D-4: **seven** packages ship a no-op release at 3.0.1,
not one as originally written. That is the intended cost of lockstep, not an oversight.

> **Recorded for the next reader:** `3.0.1` is a PATCH number carrying ADDITIVE functionality
> (a new credential class and a large new resource surface on `vox-node`), which strict semver
> would number `3.1.0`. This is the owner's call and is deliberate. In practice it changes nothing
> for consumers — both `^3.0.0` and `~3.0.0` resolve a patch bump — and the CHANGELOG entry (E2)
> carries the full surface description, so discoverability rests there rather than on the version
> number.

### 6.2 Still open

1. **Rate limiting.** A machine iterating a paginated admin list behaves nothing like a human
   console. `TieredThrottlerGuard` is Redis-backed and tiered — should service accounts get their
   own tier before 67 areas become scriptable? Not a blocker; better decided now than after the
   first integrator saturates a tier.

---

## 7. Implementation Summary

*(Empty — no code written. Populated during Phase 4.)*

---

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-19 | **Created.** Verified against the working tree that policy A2 (TASK-757) structurally forbids the literal requirement — `@ForbidApiKey()` on all 69 admin controllers, 56 `admin:*` scopes reserved and refused at grant time, and a derived boot audit failing startup on any admin route declaring `@RequiredScopes`. Established that TASK-762's service account is the sanctioned machine path and is **complete on both the credential and vocabulary axes** (opaque token on `X-Service-Account-Token`, exchange at `POST /auth/service-token`, all 56 `svc:admin:*` twins derived and audited by assertion D), and that the **only** gap is route declarations: zero admin controllers carry `@RequiredSvcScopes`, and deny-by-default therefore refuses every machine caller. Confirmed boot audit G's own `NOTE ON SCOPE` explicitly defers its full form to this cutover. Established that the controller→scope mapping is mechanically recoverable from `276f96a32`. Recorded owner decisions **D-1** (service account, not API keys) and **D-2** (all 70 areas), and flagged assumption **A-1** (three surfaces stay machine-closed for self-replication, impersonation-attribution, and consent reasons). Sized the SDK gap: vox-node is 3 resources / ~15 methods against a ~350-route admin surface, so the surface is **generated from a cross-checked Nest-metadata + OpenAPI manifest** rather than hand-authored, per the repo's derive-don't-transcribe rule. Status: **Pending** — awaiting the Phase 3 approval gate. |
| 2026-08-19 | **Approval-gate decisions recorded.** **D-3** — the three surfaces in §2.6 (`admin/service-accounts`, `AdminImpersonationController`, `ConsentGrantController`) stay machine-closed; what was assumption A-1 is now a decision, and re-opening any of them is a new owner decision rather than a code-review call. **D-4** — the SDK family bumps in lockstep to **3.0.1** via the existing `scripts/publish-sdk.sh 3.0.1`, which applies one version across every family package; `@arcaai/vox` ships a no-op release at that version, which is the intended cost of lockstep. Recorded that 3.0.1 is a PATCH number carrying additive functionality (strict semver would say 3.1.0) — deliberate, owner's call, and immaterial to consumers since both `^3.0.0` and `~3.0.0` resolve it; the CHANGELOG carries the surface description instead. §6 restructured into resolved decisions vs. the one still-open question (a service-account rate-limit tier). Phase E2 made concrete. Status remains **Pending** — no code written, awaiting go-ahead on Phase A. |
| 2026-08-19 | **Wave 0 delivered; coverage arithmetic corrected; O-1 opened.** Executed in worktree `task-773-svc-admin` per `PARALLEL-EXECUTION.md`. **A1** extracted the 64-row controller→scope fixture from `276f96a32` (`apps/api/src/bootstrap/__tests__/fixtures/task-773-admin-scope-map.ts`) with a colocated test; count independently re-verified against `git show` (64 removed `admin:*` decorators) and against the live `@ForbidApiKey()` set. Its cross-check produced the finding now recorded as **§2.8**: the 70 admin controllers split THREE ways, not two — 64 mechanically wireable, 3 machine-closed by D-3, and **3 with no `admin:*` scope to renamespace** (`WebhookController` carries `webhook:event:write`; `MonitoringController` and `AdminHealthServicesController` were never class-level scope-gated). Boot audit D could not have caught this: it reconciles the two scope REGISTRIES, never controllers-to-scopes. Opened **O-1** — extend the derivation or close the three — which blocks unit A3 (whose strengthened audit G fails the boot on any route declaring neither) but not the 64-controller sweep. **C** delivered the service-account credential in `@arcaai/vox-node`: lazy exchange, single-flight refresh with a clamped skew margin, one-shot recovery from mid-flight revocation, and redaction of both secret and token. Verified independently: 196 tests pass (was 173), `package.json` unchanged with zero runtime dependencies intact, header emitted via a shared `SERVICE_ACCOUNT_TOKEN_HEADER` constant. Two wire findings recorded: the exchange response's `tokenType: 'Bearer'` is misleading — `UnifiedAuthGuard` reads ONLY `x-service-account-token`, so presenting it as `Authorization: Bearer` gets it parsed as a user JWT and 401s, which is why the transport got a second hook rather than reusing the existing bearer one; and supplying `tenantId` alongside `serviceAccount` now throws at construction rather than being silently dropped, since the working tenant binds at exchange. |
| 2026-08-19 | **Phase A complete — the admin plane accepts service accounts.** Waves 1–2 delivered per `PARALLEL-EXECUTION.md`. **A4** added boot audit **H**: fixture-driven, it requires each of the 64 controllers to declare exactly the `svc:` twin of the `admin:*` scope TASK-757 removed from it. Written and observed **RED across all 64 before any sweep agent ran** — that observation is only obtainable before the sweep, which is why the audit was ordered first. It exists because assertion G structurally cannot see a MIS-assignment (G checks presence and registry membership, so a real-but-wrong scope passes it); a paired test drives the same synthetic app through both and shows H throwing where G does not. **A2** swept all 64 declarations across 63 files via six parallel agents on disjoint file lists. Gate: a new `task-773-admin-plane-svc-declarations.test.ts` imports every shipped controller class and reads the declaration back off Nest **metadata** — not source text, since a grep would match a comment or a commented-out line — 65/65 pass; full `apps/api` suite 3725 passed / 10 skipped, zero failures (3660 baseline + 65). **O-1 resolved** (see §2.8): `admin/webhooks` opened through a third derived family `ADMIN_PLANE_PRE_CONVENTION_SCOPE_SOURCES`, with assertion D growing an arm that reconciles non-admin `svc:` scopes against the union of the declared families; `admin/monitoring` and `admin/health/services` closed with `@ForbidServiceAccount()`. **D-5 recorded**: service-account impersonation declined, with its two blocking gates and its real cost written down so the question is not re-litigated from scratch. **O-2 opened** (low priority): the webhook delivery log stays 403 for machines, byte-identical to the API-key path. Corrected a premise in §2.8 — `WebhookController` does not *carry* `webhook:event:write`; TASK-757 stripped it along with the `admin:*` ones. Also landed in this phase: **B1/B2** offline `openapi.json` emission (451 paths / 579 operations; cross-checked against 647 live routes, the 68-route gap being exactly the `@ApiExcludeEndpoint` set — zero drift) with a fidelity spike returning **GO** at 80.5% request-typed / 85.3% response-typed against a 70/70 threshold; and **D2**, the hand-authored `AdminResource` base, which surfaced the load-bearing pagination finding now recorded in its doc comments: the gateway echoes RAW query values for `page`/`limit`, so the obvious read-response-and-increment loop is broken against this API and `listAll` must drive pagination from the request side. |
| 2026-08-19 | **O-3 delivered (2 of 4); Phase E docs; ticket to Review.** Read routes on `RolesController` and `ApiKeyController` now declare the `{:read, :write}` PAIR at method level — the pair rather than `:read` alone because `enforceServiceAccountScopes` is `.some()`, so a lone `:read` would have REVOKED those routes from every existing `:write` grant. `admin:tenant` and `admin:user` are **blocked, not skipped**: their read routes demand `manage`/`update`, which `read:X` does not satisfy, so wiring them would reproduce the TASK-766 trap — a scope that passes the string-matching gate and is then 403'd by CASL. Proven by building the ability exactly as `UnifiedAuthGuard` does and evaluating it per route (evidence in §2.9); opened **O-4** for the CASL widening, which is a privilege-model change affecting every principal class, not a machine-credential one. Orphans 4 → 2 of 55. Boot audit **H** widened to exactly two permitted shapes — the twin alone anywhere, or the twin plus its DERIVED `:read` sibling at METHOD level only — deliberately not "any superset" (which would forfeit mis-assignment detection) and deliberately not class level (which would put `:read` on DELETE routes, inverting the decision). Fixed a separate live defect found by the codegen cross-check: `TenantController.fetchByCodeName` declared `:code-name`, and since path-to-regexp names are `[A-Za-z0-9_]+` the hyphen terminated the name — the route was unreachable at its advertised URL and passed `undefined` at the one that matched; `route-param-names.test.ts` now catches the class of mistake at authoring time. Phase E1/E2 landed: SDK README (credential comparison, the exchange-time tenant binding, `listIterate` over hand-rolled paging, row-as-precondition, the five absent areas), a patch changeset carrying all eight `fixed`-group packages to 3.0.1, and `.claude/rules/08-vox-sdk.md`. Evidence: apps/api **3760 passed / 10 skipped**, bootstrap 378, vox-node 233, `gen:admin:check` no drift, and a real boot with `ENABLE_PRISMA_STUDIO` unset clearing every audit. Status → **Review**. |
| 2026-08-19 | **O-2 and O-4 resolved; orphan count 0 of 55.** Both were the same problem — a `svc:` scope that clears the string-matching gate and is then 403'd by CASL (the TASK-766 trap) — and both are fixed WITHOUT touching a subject humans hold, which is the general rule this ticket settled on: **a route decorator is shared by every principal class, so widening one is never "for machines only"; `implies` reaches only credentials whose abilities are built from scopes.** **O-2**: `webhook:event:read` now implies `read:WebhookRunHistory` (the delivery log IS the event record, so the scope was under-specified rather than deliberately narrow) and the route declares the pair. **O-4**: the literal widening was traced against the seed and rejected — `read:Tenant` is held by *every authenticated user* via `user-profile-own`, and `read:User` by `DEPARTMENT_HEAD`/`SENIOR_NURSE` via `consultation-department-read`, so accepting them would have handed clinicians the admin tenant endpoints and the bulk user export. Two admin-plane-only subjects (`AdminTenantDirectory`, `AdminUserDirectory`) were minted instead, following the existing `TenantTelemetry` precedent, applied at METHOD level on the 7 tenant and 9 user GETs so a read-only token cannot widen into mutation. Verified per route against a real ability: read-only reaches 7/7 and 9/9, `:write` unregressed, and both human abilities reach **0**. The A6 test that asserted a `:read` principal is refused on `GET /admin/tenants` — true when written, and what became O-3 — now asserts both halves reach it, plus a new case pinning that DELETE still demands the write half. Evidence: apps/api 3769 passed / 4 skipped, bootstrap 378, applications apiKey+serviceAccount 440, real boot clean with the studio flag unset. **Follow-up F-1**: the generated artifacts (`route-manifest.json`, `openapi.json`, SDK admin surface) were deliberately NOT regenerated in either commit — the working tree carries uncommitted `workflow-run` controller routes from concurrent work, and regenerating would bake `/admin/workflow-runs/{runId}/gate` and `/gate/approve` into committed artifacts describing uncommitted routes. Consequence is bounded to a stale per-method scope annotation in the SDK; `gen:admin:check` still passes because it regenerates from the committed manifest rather than re-emitting it. Regenerate from a clean tree. |

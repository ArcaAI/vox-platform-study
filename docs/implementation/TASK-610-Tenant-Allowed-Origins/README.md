# TASK-610 — Tenant Allowed Origins (CORS control plane)

| Field | Value |
|---|---|
| **Status** | `Review` — implemented, gates green, runtime-verified against a booted gateway |
| **Type** | `feature` + `bugfix` (closes a live CORS hole and a red test) |
| **Branch** | `dev-2.1` |
| **Owner decisions taken** | Governance = **global-admin only**; production `https://` catch-all = **closed in this ticket** |
| **Related** | TASK-558 lane I (platform knobs → `global-kv`), TASK-310 e-2 (dev CORS pinned to localhost), commit `7703e40f` |

---

## 1. Requirement Analysis

Browser applications must be able to call the gateway from a controlled set of origins, and that
set must be **operable** — changeable by a global admin at runtime, auditable, and per-tenant —
rather than compiled into the gateway.

### Day-1 origins (must be allowed the moment this ships)

| Origin | Owner | Note |
|---|---|---|
| `http://localhost:5173` | SYSTEM (platform) | Local SDK/playground dev. Plain `http` is acceptable **only** because browsers treat `localhost` as a secure context. |
| `https://arcaai-u2204.bcmch.org` | SYSTEM (platform) | |
| `https://arcaai-staging.bcmch.org` | SYSTEM (platform) | |
| `https://mi-preproduction.bcmch.org:4433` | SYSTEM (platform) | Non-standard port — exact origin match required (scheme + host + port). |

All four are platform-operated, so all four are **SYSTEM-tenant** rows. Customer-owned origins are
what the per-tenant lane exists for; none exist yet.

### Functional requirements

1. **FR-1** — Origins are database rows, created/edited/deleted by a global admin, effective on the
   next request with no restart.
2. **FR-2** — An origin row is owned by a tenant (`SYSTEM` = platform-wide).
3. **FR-3** — CORS admits an origin iff it is registered. No wildcard, no scheme-based catch-all, no
   hardcoded hostnames in source.
4. **FR-4** — A request carrying an `Origin` owned by tenant *A* may not act on tenant *B*'s data.
   **This — not CORS — is the isolation control.**
5. **FR-5** — The same registry gates the STT WebSocket handshake, which browsers exempt from CORS.
6. **FR-6** — The gateway must still boot and serve when the table is empty or unreadable
   (bootstrap fallback preserved).

### Non-goals

- Tenant self-service origin registration and domain verification. Deliberately deferred — the
  chosen posture is global-admin-only. The model is shaped so adding a `status` column later is
  additive, not a redesign.
- Reconciling the two write paths over `GlobalSetting` (`registry` namespace vs legacy row CRUD).
- Per-origin rate limiting or per-origin API-key binding.

---

## 2. Current State Evaluation

### 2.1 What exists

| Piece | Location | State |
|---|---|---|
| Origin resolution | [`apps/api/src/cors.config.ts`](../../../apps/api/src/cors.config.ts) | Three hand-written branches keyed on `NODE_ENV` |
| CORS options | [`apps/api/src/main.ts:180`](../../../apps/api/src/main.ts) | `enableCors` with an explicit `allowedHeaders` list |
| Runtime allow-list | `corsAllowedOrigins` `global-kv` descriptor | Registered, seeded, admin-writable, **consulted only in the `production` branch** |
| Live rebinding | [`platform-knobs.binder.ts:48`](../../../apps/api/src/modules/platform-knobs/platform-knobs.binder.ts) | Installs a lazy resolver; picks up settings refreshes automatically |
| Settings refresh | `AppSettingsService` | Push via `app-settings:invalidate`, 45 s cron backstop, both cache lanes swapped atomically |

The runtime-refresh machinery is **already correct and reusable**. This ticket does not rebuild it.

### 2.2 Defects to close

| # | Defect | Evidence |
|---|---|---|
| **D-1** | `cors.config.test.ts` is **red on `dev-2.1`** — commit `7703e40f` changed the dev RegExp without updating the test that pins its source. | `Tests 1 failed \| 17 passed (18)` |
| **D-2** | `compat-playground.taphuynh.dev` is a **source literal** in the dev RegExp. Adding an origin currently requires a code review, build and deploy — the exact §9.2 L1 anti-pattern. | `cors.config.ts:14` |
| **D-3** | Production allows **any** `https://` origin (`https_sdk_allowed`). The allow-list is decorative; `corsAllowedOrigins` changes nothing an operator can observe. | `cors.config.ts:91-100` |
| **D-4** | `If-Match` is absent from `allowedHeaders`, so the SDK's `patchWithIfMatch` fails preflight cross-origin. | `main.ts:185-209` vs `AgenticClient.ts:748` |
| **D-5** | No `exposedHeaders`, so browser JS cannot read `ETag`. `getWithEtag` returns `undefined` → the OCC PATCH sends no validator → `RequiresIfMatchGuard` answers **428**. | zero `exposedHeaders` hits repo-wide |
| **D-6** | `stt-ws.gateway.ts` performs **no origin check**. Browsers do not apply CORS to WebSockets — this is a cross-site WebSocket hijacking surface. | no origin handling in `apps/api/src/modules/streaming/` |
| **D-7** | Format split: the descriptor declares `dataType: 'string[]'` (a registry `PUT` writes `ValueType.Array`, JSON-encoded) but `11a-platform-knob-settings.ts` seeds `ValueType.String` (comma-joined). The binder tolerates both only by accident. | descriptor `:120` vs seed `:65` |
| **D-8** | *(out of scope, flagged)* Commit `7703e40f` edited the already-committed migration `20260803090000_task_586_backfill_cloud_asr_formats`. Environments that already applied it never get the `sarvam-saaras-v4` update, and the checksum drifts. Needs its own roll-forward migration. | commit diff |

### 2.3 Why the naive approach was rejected

Making `corsAllowedOrigins` `maxScope: 'tenant'` does not work:

- **A preflight has no tenant.** `OPTIONS` carries no `Authorization`, no cookies, and none of the
  custom headers (`X-Tenant-Id` is part of what the preflight is *requesting permission to send*).
  Express's `cors` middleware also runs ahead of `UnifiedAuthGuard`. The only tenant-identifying
  datum available at decision time is the `Origin` itself → **the index must be inverted**.
- **The clamp direction cannot be expressed.** Every `maxScope: 'tenant'` key must declare a stricter
  direction in `TENANT_OVERRIDE_CLAMPS`. A tenant adding an origin *widens* the accepted set — the
  precise escalation that table exists to prevent. There is no direction value that fits a list union.

---

## 3. Implementation Plan

### 3.0 Architecture

```
TenantAllowedOrigin rows
        │  (refreshed on app-settings:invalidate + 45s cron)
        ▼
OriginRegistryService  →  Map<origin, ownerTenantId>
        │                                │
        │ pre-auth                       │ post-auth
        ▼                                ▼
CORS callback + WS handshake      OriginTenantBindingGuard
  allow ⟺ index.has(origin)         reject ⟺ owner ∉ {SYSTEM, resolvedTenantId}
  (browser-facing, advisory)        (the actual isolation control)
```

**Two rules that are easy to get wrong and must be encoded as tests:**

1. **A SYSTEM-owned origin is valid for every tenant.** The admin console serves all tenants from one
   origin. Binding `SYSTEM` strictly would break it for everyone. Rule: `owner === SYSTEM` → allow;
   otherwise `owner === resolvedTenantId`.
2. **No `Origin` header → the binding guard does not apply.** Server-to-server and CLI callers send
   no `Origin`; CORS already allows them (`no_origin_provided`). Enforcing the binding there would
   break every internal caller.

### 3.1 Layer 1 — Database (`packages/database`)

New file `src/prisma/db_main/tenant-allowed-origin.prisma`, following the standard field template
(meta → tenant → business → resource-status → audit) and modelled on `tenant-stt-config.prisma`:

| Field | Notes |
|---|---|
| `origin` | Normalized `scheme://host[:port]`, lowercase, no path, no trailing slash |
| `label` | Human name for the admin list ("BCMCH pre-production") |
| `description` | Optional operator note |
| `isPlatform` | Derived convenience for SYSTEM rows; **or** omit and compare `tenantId` to `SYSTEM_TENANT_ID` — decide at implementation, prefer omitting |

Constraints:
- `@@unique([origin], name: "TenantAllowedOrigin_origin_unique")` — **global**, not per tenant. Two
  tenants claiming one origin makes the reverse index ambiguous; the DB must forbid it.
- `@@index([tenantId])`.

Also:
- Add `TenantAllowedOrigin` to `TENANT_SCOPED_MODELS` (`tenant-scope.ts`) — admin CRUD stays
  tenant-filtered.
- Soft delete **applies** (not added to `MODELS_WITHOUT_SOFT_DELETE`); a removed origin should be
  recoverable and auditable.
- Add `TenantAllowedOrigin` to `ResourceType` in **both** `audit.prisma` (+ an `ALTER TYPE … ADD VALUE`
  migration) **and** `packages/domains/src/enums/generated/ResourceType.ts`. Skipping this makes every
  `AuditLog` INSERT throw and turns the originating mutation into a 500 (the TASK-366 failure mode).
- Migration named `<timestamp>_task_610_tenant_allowed_origins`. **New** migration — do not amend any
  existing one.

### 3.2 Layer 2 — Domain (`packages/domains`)

`pnpm gen:model`, then **hand-author** `TenantAllowedOriginEntity` / `Factory` / `EntityMapper` /
`Repository` per `03-domain-layer.md` (`gen:entity`/`gen:factory` only reconcile barrels;
**never run `gen:mapper`**). Mapper carries `FIELDS_NOT_WRITABLE = ['version']` — the model is
OCC-written via the admin PATCH route. Register the repository in `CoreDatabaseModule`
(providers **and** exports). Entity `validate()` enforces the origin grammar.

### 3.3 Layer 3 — Applications (`packages/applications`)

**`OriginNormalizer`** (pure, exhaustively unit-testable) — the single place origin syntax is decided:

- Parse with `new URL()`; reject anything that fails.
- Require `http:` or `https:`; reject `ftp:`, `ws:`, `file:`, `data:`.
- Reject any path, query, fragment, userinfo, or trailing slash.
- Lowercase scheme + host; strip the default port (`:443` on https, `:80` on http) so
  `https://x.org` and `https://x.org:443` cannot both be registered.
- Preserve non-default ports verbatim (`:4433` must survive).
- Reject `*` and any wildcard form outright.
- **Refuse `http://` for non-loopback hosts.** Plain http + `credentials: true` over a network is a
  credential-leak path; `localhost`/`127.0.0.1` is exempt because browsers treat it as a secure context.

**`TenantAllowedOriginService`** — `BaseService`, standard CRUD, `broadcastSysEvent` on every
mutation, cross-tenant reads answer 404. Every write publishes on the settings invalidation channel
so the registry rebuilds on all nodes.

**`OriginRegistryService`** — holds `Map<origin, tenantId>`; rebuilds from
`repository.findAll({})`. Runs **outside** a request CLS scope, so tenant-scope injection is a
pass-through and it legitimately sees every tenant's rows — the same mechanism
`AppSettingsService.refresh()` relies on (`appSettings.service.ts:314`). Encode that constraint as a
comment **and** a test; calling it inside a request scope would silently return only one tenant's rows.

### 3.4 Layer 4 — API (`apps/api`)

1. **`cors.config.ts` rewritten.** `isOriginAllowed` becomes a single registry lookup with no
   `NODE_ENV` branching for the *allow-list* itself. Deleted: the `https://` catch-all (D-3), the
   hardcoded `arcaai.com` domains, the tunnel/preview wildcards, and the
   `compat-playground.taphuynh.dev` literal (D-2).
   **Retained:** a `development`-only loopback allowance, so a fresh clone with an empty database
   still works — the one branch that stays, narrowly scoped and documented.
   **Bootstrap fallback (FR-6):** until the registry has loaded, fall back to `CORS_ALLOWED_ORIGINS`
   exactly as `resolveAllowedOrigins()` does today.
2. **Resolver signature** in `platform-knobs.binder.ts` changes from `() => string | undefined` to
   returning the index.
3. **`OriginTenantBindingGuard`** — runs after `UnifiedAuthGuard`; applies only when an `Origin`
   header is present; allows SYSTEM-owned origins for any tenant; otherwise requires
   `owner === resolvedTenantId`. Mismatch → **404**, consistent with the 404-over-403 posture.
4. **WS handshake** (D-6) — `SttWsGateway` consults the same registry and rejects unregistered origins.
5. **`main.ts` header fixes** — add `'If-Match'` to `allowedHeaders` (D-4); add
   `exposedHeaders: ['ETag']` (D-5).
6. **Admin controller** — `@Controller('admin/allowed-origins')`, class-level `@CanManage('TenantAllowedOrigin')`
   plus an imperative `isSuperAdmin` check carrying the standardized `// AUTH-NOTE:` marker (the
   global-admin-only pattern from `05-nestjs-api.md`: there is no "global admin" *subject*, so the
   decorator alone understates the gate). PATCH carries `@RequiresIfMatch()` + `@ExpectedVersion()`.

### 3.5 Layer 5 — Seed & retirement

- New seed `packages/database/src/prisma/db_main/seed/11b-tenant-allowed-origins.ts` — the four day-1
  origins as SYSTEM rows. Idempotent, **create-only on `value`**, matching `11a`'s contract so
  `pnpm db:seed` is safe against a live database.
- One-time backfill: any existing `CORS_ALLOWED_ORIGINS` / `corsAllowedOrigins` entries become rows.
- `corsAllowedOrigins` is **not deleted** — demoted in its descriptor description to the documented
  bootstrap fallback, which also resolves D-7 by removing the second live format.

### 3.6 TDD test list (write failing first, in this order)

| # | Test | Asserts |
|---|---|---|
| T-1 | `OriginNormalizer` table test | Accepts the four day-1 origins; strips default ports; preserves `:4433`; rejects paths, wildcards, `ftp:`/`ws:`/`file:`, trailing slash, userinfo, and non-loopback `http://` |
| T-2 | Entity `validate()` | Refuses a malformed origin at the domain boundary |
| T-3 | `OriginRegistryService` | Builds the reverse index; rebuilds on invalidation; **duplicate origin across tenants is rejected** |
| T-4 | `cors.config` — **replaces the red D-1 test** | Registered origin allowed; unregistered `https://` origin **denied** (locks D-3 shut); empty registry falls back to `CORS_ALLOWED_ORIGINS`; dev loopback still allowed |
| T-5 | `OriginTenantBindingGuard` | SYSTEM origin + any tenant → allow; tenant-A origin + tenant-B request → 404; **no `Origin` header → pass through** |
| T-6 | `main.ts` CORS options | `allowedHeaders` contains `If-Match`; `exposedHeaders` contains `ETag` |
| T-7 | WS handshake | Unregistered origin rejected; registered accepted |
| T-8 | Service unit tests | Factory used on create; `broadcastSysEvent` on every mutation; cross-tenant read → 404 |
| T-9 | `ResourceType` enum parity | `resourceType.enum-parity.test.ts` stays green |
| T-10 | API e2e cross-tenant | Matches the `task-307-*-cross-tenant.spec.ts` pattern for the new admin resource |

### 3.7 Verification criteria

- `pnpm --filter @arcaai/database test`, `--filter @arcaai/domains build test`,
  `--filter @arcaai/applications build test`, `pnpm api:build`, `pnpm test:unit`, `pnpm test:e2e`,
  `pnpm lint` — all green, output pasted into §5.
- Runtime proof: a browser on `http://localhost:5173` completes a preflight **and** an OCC
  `GET → PATCH` round trip (proves D-4 and D-5 together); an unregistered origin is refused; adding a
  row through the admin API takes effect **without a restart**.

### 3.8 Risks

| Risk | Mitigation |
|---|---|
| Closing the catch-all breaks an unenumerated production caller | Seed every known origin first; ship the registry-miss log line in the same release so a miss is diagnosable in one grep. **This is the accepted cost of the owner's decision — the catch-all is the vulnerability.** |
| An admin empties the registry and locks every browser app out | Empty registry falls back to `CORS_ALLOWED_ORIGINS` (FR-6); every mutation is sys-evented and audited |
| Registry loaded inside a request scope returns one tenant's rows | Comment + dedicated test (§3.3) |
| `ResourceType` enum missed | T-9 parity test is an existing guard |

---

## 4. Parallel Execution Plan (agent team)

### 4.0 The two rules that make this safe

This ticket has a hard layer chain (DB → domain → services → API), so parallelism cannot come from
splitting that chain. It comes from two disciplines:

> **Rule 1 — Contracts are frozen before fan-out.** Every cross-lane type is written verbatim in
> §4.1 below. A lane codes against the contract, never against another lane's progress. No lane
> waits for a signature to be "decided" mid-flight.
>
> **Rule 2 — One owner per file. Shared files belong to the Integrator, never to a lane.** Two agents
> editing one barrel is the single most common way a parallel run produces a broken merge. Lanes
> deliver **leaf files only**; every shared file in §4.4 is edited by exactly one role.

### 4.1 Frozen contracts (written first, by the Integrator, before any lane starts)

```ts
// packages/applications/src/services/origin-registry/origin-normalizer.ts
export interface NormalizedOrigin {
  /** Canonical `scheme://host[:port]` — default ports stripped. */
  origin: string;
  scheme: 'http' | 'https';
  host: string;
  /** null when the port is the scheme default. */
  port: number | null;
}
/** Throws ArgumentInvalidException on any malformed / disallowed origin. */
export function normalizeOrigin(raw: string): NormalizedOrigin;
export function isLoopbackHost(host: string): boolean;
```

```ts
// packages/applications/src/services/origin-registry/IOriginRegistry.ts
export const IOriginRegistry = Symbol('IOriginRegistry');
export interface IOriginRegistry {
  /** Owner tenant id for a registered origin, else null. */
  ownerOf(origin: string): string | null;
  has(origin: string): boolean;
  /** Rebuild from the database. MUST NOT be called inside a request CLS scope (§3.3). */
  refresh(): Promise<void>;
  size(): number;
}
```

```ts
// packages/applications/src/services/origin-registry/IOriginRegistry.ts
export type OriginIndexResolver = () => Pick<IOriginRegistry, 'has' | 'ownerOf'> | null;
```

> **Correction applied during Wave 0.** `OriginIndexResolver` was originally specified to live in
> `apps/api/src/cors.config.ts` — a file §4.4 assigns to **W3-A**. That made the very first lane edit
> another lane's file. The *type* now ships with `IOriginRegistry` (applications), and the *setter*
> `setOriginRegistryResolver(resolver: OriginIndexResolver | null): void` is written by **W3-A** in
> Wave 3 as part of its `cors.config.ts` rewrite, replacing `setPlatformCorsOriginsResolver`. Same
> contract, no contested file.

These three files land in a single **contracts commit** — types and signatures only, no behavior,
`throw new Error('not implemented')` bodies. Everything downstream compiles against them from T=0.

**Invalidation contract (frozen before Wave 2 fanned out).** W2-A and W2-B both touch cache
freshness, so the mechanism is fixed here rather than invented twice:

| Event | Emitter | Listener |
|---|---|---|
| `origin-registry.invalidate` | `TenantAllowedOriginService` (W2-B), after **every** successful mutation | `OriginRegistryService.refresh()` (W2-A) |
| `app-settings.cache-refreshed` | `AppSettingsService`, already emitted on every refresh (local write **or** peer `app-settings:invalidate` fan-out) | `OriginRegistryService.refresh()` (W2-A) |

The first gives the writing node an immediate rebuild; the second gives every OTHER node one on the
next AppSettings refresh. A dedicated Redis channel for sub-second cross-node propagation is a
deliberate follow-up — the failure mode it would fix is "a newly added origin is refused on a peer
node briefly", a visible, self-healing annoyance rather than a security gap.

> **Two corrections from the adversarial review (W4-R).**
>
> 1. **The bound is ~60 s, not ≤45 s.** `DEFAULT_CACHE_REFRESH_INTERVAL = '45 * * * * *'` fires at
>    second 45 of *every minute* — once per minute, not every 45 seconds. Every earlier statement of
>    "≤45 s" in this document was wrong; AppSettings' own comment already said so.
> 2. **That bound was not enforceable at all.** `AppSettingsService` emits
>    `app-settings.cache-refreshed` ONLY on its success path (a failure emits `…cache-error` and
>    rethrows), and the registry had no timer of its own — so a persistently failing AppSettings cache
>    froze the origin index on every node indefinitely, and a REVOKED origin stayed live with nothing
>    to detect it. A freshness guarantee that depends on another service's success path is not a
>    guarantee. The registry now carries its own independent refresh plus a staleness age that a
>    failed refresh reports at `error` level.
>
> The second point is the general lesson: **riding another component's success-only event gives you
> propagation, never a bound.** A backstop has to fire on the failure path too, or it is decorative.

### 4.2 Waves

Lanes inside a wave run concurrently. A wave starts only when the previous wave's gate is green.

**Wave 0 — contracts + schema** *(2 lanes, the only blocking wave)*

| Lane | Scope | Deliverable | Blocks | Tier | Effort |
|---|---|---|---|---|---|
| **W0-A** *(Integrator)* | The three contract files above | Compiling stubs + barrel entries | everything | `sonnet-5` | medium |
| **W0-B** | `tenant-allowed-origin.prisma`, migration `<ts>_task_610_tenant_allowed_origins`, `gen:model` | Applied migration + `TenantAllowedOriginModel` | Wave 1 | `sonnet-5` | high |

**Wave 1 — leaf implementations** *(4 lanes, fully parallel)*

| Lane | Scope | Owns (leaf files only) | Tests | Tier | Effort |
|---|---|---|---|---|---|
| **W1-A** | `OriginNormalizer` — pure, zero deps | `origin-normalizer.ts` | T-1 | `sonnet-5` | medium |
| **W1-B** | CORS request/response headers (D-4, D-5) | *(main.ts is Integrator-owned — W1-B delivers a diff, not a commit)* | T-6 | `haiku-4-5` | default |
| **W1-C** | Domain trio | `TenantAllowedOriginEntity/Factory/EntityMapper/Repository.ts` | T-2 | `sonnet-5` | medium |
| **W1-D** | Day-1 seed | `seed/11b-tenant-allowed-origins.ts` | seed idempotency test | `haiku-4-5` | default |

W1-A and W1-B have **no dependency on Wave 0-B** and may start the instant contracts land.
W1-C and W1-D need the Prisma model.

**Wave 2 — services** *(2 lanes)*

| Lane | Scope | Owns | Tests | Tier | Effort |
|---|---|---|---|---|---|
| **W2-A** | `OriginRegistryService` implementing `IOriginRegistry` | `origin-registry.service.ts` | T-3 | `sonnet-5` | high |
| **W2-B** | `TenantAllowedOriginService` + DTOs + DTO mapper | `services/tenant-allowed-origin/**` | T-8 | `sonnet-5` | medium |

**Wave 3 — API surfaces** *(4 lanes, fully parallel — each consumes `IOriginRegistry` only)*

| Lane | Scope | Owns | Tests | Tier | Effort |
|---|---|---|---|---|---|
| **W3-A** | `cors.config.ts` rewrite; deletes the catch-all, the hardcoded domains, the playground literal | `cors.config.ts`, `__tests__/cors.config.test.ts` | T-4 *(replaces the red D-1 test)* | `opus-5` | high |
| **W3-B** | `OriginTenantBindingGuard` | `guards/origin-tenant-binding.guard.ts` | T-5 | `opus-5` | high |
| **W3-C** | WS handshake origin check (D-6) | `stt-ws.gateway.ts` | T-7 | `sonnet-5` | medium |
| **W3-D** | Admin controller + module | `modules/tenant-allowed-origin/**` | T-10 | `sonnet-5` | medium |

**Wave 4 — integration + adversarial review** *(Integrator, plus one independent reviewer)*

| Lane | Scope | Tier | Effort |
|---|---|---|---|
| **W4-I** *(Integrator)* | Wires every shared file (§4.4), applies W1-B's header diff, runs the full gate, captures evidence | `opus-5` | medium |
| **W4-R** *(adversarial reviewer — must NOT be any lane's author)* | Tries to **defeat** the finished posture: is an unregistered origin genuinely refused; can the binding guard be bypassed (missing `Origin`, casing, default-port aliasing, IDN/punycode homograph); is the WS path really covered; does an empty registry fail open wider than the documented bootstrap fallback | `opus-5` or `fable-5` | xhigh |

### 4.3 Dependency graph

```
W0-A contracts ──┬─────────────────────────────► W1-A ─┐
                 │                                      ├──► W2-A ─┬─► W3-A ─┐
W0-B schema ─────┼──► W1-C domain ──► W2-B ──────┐      │          ├─► W3-B ─┤
                 │                                └─────┴──────────┼─► W3-C ─┼─► W4
                 ├──► W1-D seed ─────────────────────────────────  └─► W3-D ─┘
                 └──► W1-B headers ────────────────────────────────────────────┘
```

W1-B is on the critical path of nothing — it is the shortest lane and the one worth landing first
for an early, independently useful win (it fixes the SDK's OCC round trip on its own).

### 4.4 File ownership — the conflict surface

Every file below is edited by **exactly one** role. A lane that believes it needs to touch an
Integrator-owned file raises it instead of editing it.

| File | Owner | Why it is contested |
|---|---|---|
| `apps/api/src/main.ts` | **Integrator** | W1-B (headers) would collide with nothing else, but main.ts is edited by many tickets — keep it single-owner |
| `apps/api/src/cors.headers.ts` *(new)* | **Integrator** | Created in Wave 1 so D-4/D-5 are testable at all — `corsOptions` lives inside the `bootstrap()` closure and is unreachable from a test. Splits cleanly from `cors.config.ts` (W3-A): that file decides WHICH ORIGINS, this one decides WHICH HEADERS |
| `apps/api/src/app.module.ts` | **Integrator** | W3-B (guard) + W3-D (module) both need a line here |
| `core.database.module.ts` | **Integrator** | W1-C repository registration |
| every `index.ts` barrel | **Integrator** | W1-A, W1-C, W2-A, W2-B all export |
| `extensions/tenant-scope.ts`, `client.ts` | **W0-B** | allow-list entries |
| `audit.prisma` + `enums/generated/ResourceType.ts` | **W0-B** | must move together or every AuditLog INSERT throws |
| `platform-knobs.binder.ts` | **W3-A** | resolver signature swap belongs with the cors.config rewrite |

**Test files are never shared.** Each lane creates its own `*.task610.test.ts`. The one exception is
`cors.config.test.ts`, which already exists and is red — **W3-A owns it outright**, and no other lane
opens it.

### 4.5 Per-lane definition of done

A lane is done when **all** hold. A lane that cannot meet these reports back rather than merging.

- [ ] Its tests were **watched to fail first**, then pass (`01-development-workflow.md` — a test that never failed verifies nothing)
- [ ] Its package builds; `pnpm lint` clean (treat `only-warn` warnings in `packages/*` as errors)
- [ ] It touched **no** file owned by another role (§4.4)
- [ ] It ran **no** `pnpm gen:mapper` — destructive; strips the `_version` OCC guard and clobbers ~24 mappers
- [ ] Handoff note: files created, exports added *(for the Integrator to barrel)*, assumptions made

### 4.6 Isolation & merge

- Lanes that only **create** files (W1-A, W1-C, W1-D, W2-A, W2-B, W3-B, W3-D) need no worktree — file
  ownership already makes them conflict-free.
- Lanes that **rewrite** an existing file (W3-A, W3-C) and W0-B's migration run in worktree isolation.
- ⚠️ **A worktree agent bases off `main`, not the current branch.** This ticket is on `dev-2.1`. Every
  worktree lane must rebase onto `dev-2.1` before delivering, and must not wholesale-copy
  `turbo.json` / `.env*` / `uv.lock` from its base.
- Merge order follows the wave order. The Integrator merges; lanes do not merge each other's work.
- ⚠️ **A package-wide gate is meaningless while a lane in that package is mid-write.** Observed in
  Wave 2: `pnpm --filter @arcaai/applications typecheck` failed with `TS2307` for a service file W2-B
  had not written yet, while W2-A's work was clean. Two lanes writing the same PACKAGE is fine (file
  ownership holds); running a whole-package gate across them is not. Scope verification to the lane's
  own files (`vitest run <lane path>`) until the wave closes, then run the package gate ONCE in the
  Integrator step. Do not treat a transient cross-lane failure as a lane defect — and do not "fix" it.

### 4.7 Integration gate (Wave 4)

Sequential, and the only place "done" is decided:

1. Barrels + module registrations wired; `pnpm build:apps` green
2. `pnpm test:unit` — T-1…T-9 green, and `cors.config.test.ts` **no longer red**
3. `pnpm test:e2e` — T-10 plus the existing `task-307-*-cross-tenant` specs
4. `pnpm lint` clean
5. Runtime proof per §3.7: preflight + OCC `GET → PATCH` round trip from `http://localhost:5173`;
   unregistered origin refused; a row added through the admin API takes effect **with no restart**
6. §5 filled in with pasted output; status → `Review`

### 4.8 Sequencing guard

**Do not close the catch-all until the day-1 seed has run in the target environment.** W3-A's rewrite
and W1-D's seed are independent lanes but must not deploy out of order — seed first, close second.
If both land in one release, the seed migration must be ordered ahead of the gateway rollout.

### 4.9 Model tier & effort policy

Tiers are assigned **per lane, by that lane's complexity and blast radius** — never by which wave it
sits in. A one-line lane in the last wave stays cheap; a security-critical lane in the first wave does
not.

| Complexity | Tier | Effort | Lanes here |
|---|---|---|---|
| Trivial / simple | `haiku-4-5` | default | W1-B, W1-D |
| Moderate | `sonnet-5` | medium | W0-A, W1-A, W1-C, W2-B, W3-C, W3-D |
| Complex | `sonnet-5` | high | W0-B, W2-A |
| Very high | `opus-5` / `fable-5` | high–xhigh | W3-A, W3-B, W4-I, W4-R |

**Why the expensive lanes are expensive.** Three lanes decide whether this ticket is a security fix or
a security regression, and all three fail *silently* when they fail — nothing goes red, the wrong
requests are simply allowed:

- **W3-A** deletes the production catch-all. Too permissive and D-3 survives the ticket that claims to
  close it; too strict and every browser app 4xx's on deploy. It also owns the bootstrap fallback, the
  one path that runs when the database is unreachable.
- **W3-B** is FR-4 — the *actual* tenant-isolation control (CORS is advisory browser behavior and
  proves nothing). It carries two carve-outs that each break the platform if inverted: SYSTEM origins
  valid for all tenants, and no-`Origin` requests exempt.
- **W4-R** is an adversarial pass, not a code review. Its job is to *find the bypass*, so it must be
  independent of every author and reason about attacks the implementers did not enumerate.

**Why the cheap lanes are cheap.** W1-B is a two-line addition to a header array plus one assertion.
W1-D is a four-row seed with `11a-platform-knob-settings.ts` sitting right next to it as a verbatim
template. Both are bounded, both have an obvious oracle, and both get diffed by the Integrator anyway.

**Rules that keep this honest:**

1. **A reviewer is never a cheaper tier than the lane it reviews.** A `haiku` pass must not sign off on
   `opus` security work — it will agree with almost anything plausible.
2. **Escalate on the second failure, never silently.** A lane that misses its §4.5 gate twice moves up
   one tier and records that in §6. Three cheap attempts cost more than one correct expensive one.
3. **Escalate on ambiguity, not on difficulty.** A lane that discovers its spec is underdetermined
   stops and reports — it does not guess at a higher tier. Guessing is what produces confidently wrong
   security code.
4. **Effort is per lane too.** `high` buys deliberation on the three lanes above; `default` on W1-B and
   W1-D is not a cost saving, it is the correct amount of thought for a two-line change.

*Harness mapping:* the `Agent`/`Workflow` `model` parameter accepts `haiku` · `sonnet` · `opus` ·
`fable`. Read the table's `haiku-4-5 → haiku`, `sonnet-5 → sonnet`, `opus-5 → opus`, `fable-5 → fable`.

---

## 4A. Scope extension — wildcard patterns + env-var removal (owner-directed)

Two owner decisions taken after Wave 4, both changing the shipped design.

### 4A.1 `CORS_ALLOWED_ORIGINS` is removed entirely

> "we do NOT use any ENV VARS for CORS values declaration and do NOT control CORS Allowed List using any ENV VARS"

**FR-6 is hereby retired.** The bootstrap fallback is deleted from `cors.config.ts` and the WS
gateway; the variable is removed from `turbo.json#globalEnv`, the API env schema, `.env.sample`, the
`11a` platform-knob seed, and the `corsAllowedOrigins` descriptor.

This is less of a behavior change than it looks: W4-R finding #2 established the fallback was already
**inert** — the var ships empty in both sample files and no env file is read in production. Removing
it formalizes what was already true. The consequence must be stated plainly, though: **an unreachable
database is now fail-closed for every browser origin.** That is the safe direction, and it is now a
hard dependency rather than a soft one.

### 4A.2 Wildcard host patterns are supported

This REVERSES the Wave-1 rule that `normalizeOrigin` rejects every `*`, which W4-R verified as a
security property. It is a deliberate owner trade and carries a real cost, recorded here so nobody
later mistakes it for an oversight:

> A wildcard delegates trust to every subdomain that exists **now or later**, including any with a
> dangling DNS record. A subdomain takeover anywhere under `*.bcmch.org` becomes credentialed CORS
> access for the owning tenant. Exact rows do not have this property, and adding one is a single
> admin API call with no restart.

**Frozen canonical grammar** — every lane codes against this, no lane re-invents it:

```
exact    := <scheme>://<host>[:<port>]          (unchanged — normalizeOrigin's existing output)
pattern  := <scheme>://<hostPattern>:<portPattern>
  scheme      := 'http' | 'https'      http ONLY when hostPattern is loopback
  hostPattern := '*.' <suffix> | <host>
  portPattern := '*' | <digits>        ALWAYS explicit in canonical form
```

A stored value is a pattern **iff it contains `*`** — no schema change, no new column; patterns live
in the same `origin` column and keep the same global-uniqueness guarantee (one row per pattern text).

Canonical seed forms: `https://*.bcmch.org:*` · `https://*.taphuynh.dev:*` · `https://*.4bits.vn:*` ·
`http://localhost:*`

**Match rules** (owner decisions marked):

| Rule | Value | Source |
|---|---|---|
| Scheme | must match exactly; `http` only for loopback | carried over from Wave 1 |
| Port | `*` matches ANY port incl. default/absent | **owner: "https + any port"** |
| Host depth | subdomains at ANY depth, **never the apex** | owner unsure → conservative default; widening later is additive |
| Label boundary | origin host must end with `'.' + suffix` — so `*.bcmch.org` never matches `evilbcmch.org` | security floor |
| Suffix length | `*.` suffix must carry **≥2 labels** — rejects `*.vn`, `*.com` | security floor, non-negotiable |
| Public suffixes | a heuristic `isLikelyPublicSuffix` on top of the ≥2-label floor | see correction below |

> **Correction — this table was wrong when frozen.** It claimed the ≥2-label floor rejects `*.co.uk`.
> It does not: `co.uk` **is** two labels. Lane W5-A caught the error rather than coding to it, and added
> a second check: a 2-label suffix whose TLD is a 2-letter ccTLD and whose second level is a known
> registry label (`co`, `com`, `org`, `ac`, `ne`, `go`, `gov`, `net`, …) is rejected — one rule that
> catches `co.uk`, `com.au`, `co.jp`, `com.vn`, `co.za` without enumerating pairs, while leaving
> `4bits.vn` and `taphuynh.dev` valid. Plus a short deny-list of shared-hosting suffixes
> (`github.io`, `vercel.app`, `pages.dev`, `herokuapp.com`, …).
>
> **Residual risk, stated rather than papered over:** this is partial and cannot be completed by hand.
> Any public suffix outside both sets — an unlisted platform suffix, a PSL private-section entry, a new
> ccTLD second level — is still accepted, and a wildcard over one delegates credentialed CORS to every
> customer of that platform. The complete fix is a maintained public-suffix list (`tldts`/`psl`)
> consulted at WRITE time. Until then, a global admin approving a wildcard must read the suffix.

**Precedence** (must be deterministic — two patterns can legitimately overlap where two exact rows
cannot): exact row beats any pattern → among patterns the LONGEST suffix wins → the `*` allow-all
token ranks BELOW every other pattern → ties break by earliest `id` (UUIDv7), the rule the registry
already uses for duplicates.

### 4A.3 The Global tenant accepts any origin (owner-directed)

> "for global tenant, it should allow any origins, for any environments (hope-v2 dev or hope-v2
> staging or hope-v2 production)"

A `*` row owned by the **Global** tenant (`SEED_TENANT_ID`, `50000000-…-0000`, name "Global" — NOT
System, NOT ArcaAI). Grammar: the literal single character `*`, nothing else; every near-miss
(`**`, `*.`, `https://*`, `*:*`, `"*"`) is rejected so a typo can never silently become allow-all.

**What it grants, stated once and precisely.** The gateway sets `credentials: true` and mounts
`express-session`. An allow-all row means the gateway reflects ANY origin back with credentials, so
any website a Global-tenant user visits can issue authenticated requests to the API **and read the
responses** — a cross-origin read primitive, not merely a write one.

**What confines it — and why that is the whole argument.** `OriginTenantBindingGuard` (FR-4). The `*`
token carries the lowest possible specificity, so it wins only lookups nothing else matches. A
request from `evil.example` resolves owner=Global; carrying an ArcaAI token, the tenants disagree and
the guard answers 404. Every other tenant is untouched, and the exposure is exactly the Global
tenant's own data.

That containment is load-bearing: **this row is defensible only while the binding guard is intact and
correctly ordered.** W4-R already showed the guard silently degrades to a no-op if registered before
`UnifiedAuthGuard` — with a `*` row present, that same misordering stops being a latent weakness and
becomes an open door. Anyone touching guard order must re-read this section.

**Demonstrated consequence — with the `*` row present, nothing is ever "unregistered".** An Integrator
probe over the real eight-row seed set confirms every unmatched origin resolves to Global, including
look-alikes:

```
https://arcaai-u2204.bcmch.org  → ArcaAI     https://bcmch.org      → Global   (apex, not the wildcard)
https://a.b.c.bcmch.org         → ArcaAI     https://evilbcmch.org  → Global   (label-boundary held)
http://localhost:5173           → SYSTEM     http://x.bcmch.org     → Global   (http, so not the wildcard)
https://random.example.com      → Global     http://localhost.evil.com → Global
```

Two things follow, and both are load-bearing:

1. **The look-alike protections still do their real job.** `evilbcmch.org` and `localhost.evil.com`
   are correctly refused by the *.bcmch.org / loopback rules — they fall through to Global rather than
   being mistaken for ArcaAI. Tenant binding is intact; that is what those rules exist for.
2. **CORS is effectively open platform-wide, and `OriginTenantBindingGuard` is the ONLY remaining
   control.** The guard's `unregistered origin → pass through` branch becomes unreachable while this
   row exists, because nothing is unregistered any more. Every origin now carries an owner and is
   actively bound. That is stricter per-request than the old pass-through — but it means the guard is
   carrying the entire isolation posture alone.

Open question for the owner, not blocking: **does the Global tenant hold real patient data, or is it
demo/scratch?** If PHI ever lands there, this row should be revoked (a single soft delete — no deploy,
no restart) or narrowed to explicit origins.

---

## 4B. Many-to-many origins ↔ tenants (owner-directed) — supersedes single ownership

> "different tenant admin can have many tenants, and they also share the same origins"

### 4B.1 The limitation being removed

`origin` carried a GLOBAL unique index, so one origin belonged to exactly one tenant. Two tenants
sharing `http://localhost:5173` was impossible: the second `create` returned 409. The only sharing
mechanism was SYSTEM ownership, which means **every** tenant — there was no way to express "these two
and no others".

That constraint existed for one reason: `ownerOf(origin) → string | null` had to return a SINGLE
answer, because a preflight carries no tenant. The fix is not to relax the index — it is to stop
asking the wrong question. An origin does not have an owner; it has a **set of tenants it may act
on**.

### 4B.2 New model — the row IS the grant

`TenantAllowedOrigin` keeps its shape. Only the uniqueness changes:

```
- @unique(map: "TenantAllowedOrigin_origin_unique")   on origin
+ @@unique([origin, tenantId], map: "TenantAllowedOrigin_origin_tenantId_unique")
```

One row per **(origin, tenant) grant**. `label`/`description` per row is a feature, not redundancy —
each tenant annotates why it uses that origin.

### 4B.3 Resolution becomes a UNION, and precedence disappears

This is the part worth reading twice. With a single owner we needed a tie-break, so §4A.2 froze
"exact beats pattern, longest suffix wins". With a SET, there is nothing to break a tie between:

```
tenantsFor(origin) = ⋃ { row.tenantId : row is exact-equal OR row is a pattern matching origin }
```

- **CORS admission**: `tenantsFor(origin)` is non-empty.
- **Binding guard**: `requestTenant ∈ tenantsFor(origin)` **or** `SYSTEM ∈ tenantsFor(origin)`.

Union is **monotone** — adding a grant can never remove access — which removes a whole class of
surprising shadowing. `patternSpecificity` survives only as a deterministic ordering for logs; it is
no longer on the authorization path. Delete it from the decision, not from the codebase.

**Consequence for the Global `*` row, and it is the right one.** Under most-specific-wins, `*` meant
"origins that nothing else matches may act on Global" — so `https://arcaai-u2204.bcmch.org` could NOT
act on Global, which quietly contradicts "Global allows any origin". Under union it means exactly what
it says: every origin may act on Global. The owner asked for the latter.

### 4B.4 Frozen contract

```ts
export interface IOriginRegistry {
  /** Tenants this origin may act on. EMPTY = unregistered. Contains SYSTEM ⇒ every tenant. */
  tenantsFor(origin: string): ReadonlySet<string>;
  /** CORS admission — registered at all? */
  has(origin: string): boolean;
  /** May `tenantId` be acted on from `origin`? Encapsulates the SYSTEM rule. */
  allows(origin: string, tenantId: string): boolean;
  refresh(): Promise<void>;
  size(): number;
}
```

`ownerOf` is REMOVED. `allows()` exists so the SYSTEM rule has exactly ONE implementation — the guard
and the WS handshake must not each re-derive it. That lesson is already paid for in this ticket: W5-C
first "fixed" an HTTP/WS disagreement by copying the rule into both, and the Integrator had to
consolidate it.

### 4B.5 The two-tenant example this was raised for

`arcaai-dev` needs `localhost:5173` + `arcaai-u2204`; `arcaai-test` needs `localhost:5173` +
`arcaai-staging`. Now expressible exactly — four grant rows, nothing shared with any third tenant:

| origin | tenant |
|---|---|
| `http://localhost:5173` | arcaai-dev |
| `http://localhost:5173` | arcaai-test |
| `https://arcaai-u2204.bcmch.org` | arcaai-dev |
| `https://arcaai-staging.bcmch.org` | arcaai-test |

SYSTEM ownership remains available for genuinely platform-wide origins, but is no longer the ONLY way
to share — which is what made it overused.

---

### 4B.6 Delivered — evidence

| Lane | Change | Evidence |
|---|---|---|
| W6-A | `@@unique([origin, tenantId])`, index-only migration, `findByOrigin` → `findByOriginAndTenant` | domains 1418 · database 892 · 3 gen-checks no drift |
| W6-B | union registry: `tenantsFor` / `has` / `allows`; `ownerOf` removed | 324 tests, RED 31 first |
| W6-C | grants scoped to (origin, tenant); conflict message corrected | 63 tests, RED 30 first |
| W6-D | guard delegates to `allows()`; no `SYSTEM_TENANT_ID` constant left in it | 310 tests, RED 22 first |
| Integrator | seed compound key; 4 test fakes reshaped to `origin → Set<tenantId>` | apps/api 2443 · typecheck clean |

**Proven against the live dev schema** (in a transaction, rolled back — the table still holds its 8
seeded rows):

```
INSERT localhost:5173 → tenant A      ✓
INSERT localhost:5173 → tenant B      ✓     GRANTS FOR localhost:5173 = 2
INSERT localhost:5173 → tenant A      ✗ duplicate key … TenantAllowedOrigin_origin_tenantId_unique
```

Two tenants share an origin; one tenant cannot hold it twice. That is §4B.5's scenario, demonstrated
rather than asserted.

### 4B.7 What this wave changed about earlier decisions

Three things in this document are now WRONG where they were right when written. They are corrected in
place above; listed here so a reader of the history is not misled:

1. **"Global uniqueness is required or the reverse index is ambiguous"** (§3.1, and 20 lines of the
   `.prisma` header). True only while `ownerOf` returned a single tenant. `tenantsFor` returns a set,
   so there is nothing to disambiguate. The schema header was rewritten; leaving a stale rationale
   directly above the constraint it contradicts is how the next reader gets misled.
2. **Precedence — "exact beats pattern, longest suffix wins"** (§4A.2). Off the authorization path
   entirely. Union resolution is monotone, so adding a grant can never remove access.
   `patternSpecificity` survives only to order logs.
3. **The duplicate-origin `logger.error`.** Two tenants sharing an origin was a corruption signal and
   is now ordinary data. Removed — an error that fires constantly trains operators to ignore a channel
   that still carries real failures.

---

## 4C. Origin enforcement is OFF BY DEFAULT (owner-directed)

> "make sure by default (apply to all tenants including SYSTEM, GLOBAL) no origin checks, ALL is
> ALLOWED for calling and using our APIs"

### 4C.1 What was decided

A platform switch `origin.enforcementEnabled` (`global-kv`, `globalOnly`, **default `false`**). While
false, `isOriginAllowed` admits every origin without consulting the registry, `OriginTenantBindingGuard`
passes every request, and the WS handshake accepts every origin. Setting it true restores everything
§3–§4B built, unchanged.

This is a **default**, not a deletion. Every mechanism — the grant table, patterns, the admin screen,
the binding guard, the CSWSH check — stays and is one settings write away from enforcing. That
distinction is the whole point: an unseeded deployment cannot lock itself out, and hardening is an
operator decision rather than a redeploy.

### 4C.2 `credentials: false` — the change that makes this safe rather than reckless

Allow-all origins with `credentials: true` is a **cross-origin read primitive**: any site a logged-in
user visits can issue authenticated requests to the gateway and read the responses, PHI included.
That is not a theoretical concern; it is the standard consequence of reflecting an arbitrary origin
while permitting credentials.

Two facts checked before flipping it:

- **Nothing reads `req.session`.** `express-session` is mounted in `main.ts` and has no consumers.
- **The SDK never sends cookies.** `AgenticClient` sets no `credentials: 'include'`; it authenticates
  with the `Authorization` header, which a hostile page cannot read or forge.

So `credentials: false` costs nothing and removes the exfiltration path: browsers stop attaching
cookies cross-origin, while Bearer-token auth is unaffected. **Open CORS without credentials is an
ordinary public-API posture; open CORS with credentials is a data-leak path.** If a future flow ever
needs cross-origin cookies, enforcement must be turned ON before `credentials` is turned back on.

### 4C.3 What is now load-bearing

With enforcement off, **authentication and tenancy are the only controls left.** Everything this
ticket built is dormant. Specifically:

- D-3's catch-all is closed in code but irrelevant while the switch is off — an unregistered origin is
  admitted by the switch, not by a scheme rule.
- FR-4 (origin↔tenant binding) does not apply. A request from any origin may act on any tenant it can
  authenticate to.
- The WS CSWSH check does not apply. This is the one that would concern me most if `credentials` were
  ever set back to true, because WebSockets are exempt from CORS entirely.

The gateway therefore says so at boot at `warn` level, and the posture appears in the `CORS
configuration` bootstrap log. An operator must never have to read the database to discover the
platform is permissive.

### 4C.4 Turning it on

One settings write — `origin.enforcementEnabled = true` — no redeploy. Before doing so, seed or
register the origins each tenant needs (§4B.5), or browser traffic will start being refused. The
`origin_registry_miss` log reason exists precisely to make that transition diagnosable.

### 4C.5 Delivered — evidence (lane W7)

| Piece | Change |
|---|---|
| Descriptor | `origin.enforcementEnabled` in `platform-ops.descriptors.ts` — `global-kv` · `boolean` · `maxScope: system` · `globalOnly` · `failMode: open-to-default` · **`default: false`**. No env var (§4A.1 stays closed) and **no seeded row**: the descriptor default IS the posture; the registry write lane creates the row on first set. |
| Switch | `setOriginEnforcementResolver` / `isOriginEnforcementEnabled` in `cors.config.ts` — ONE accessor, THREE consumers. Permissive when no resolver is installed, when it resolves anything but `true`, or when it throws (latched warn, so a settings outage cannot flood the log). |
| Binder | `PlatformKnobsBinder.installOriginEnforcementResolver` resolves it through `TenantSettingsService.resolvePlatform`, lazily per call — exactly like `logLevel`, so a settings write applies with no restart. |
| Point 1 | `isOriginAllowed` returns `true` with reason `enforcement_disabled` **before** any registry read. |
| Point 2 | `OriginTenantBindingGuard` rule 0 — pass through, registry never consulted, no 404 on tenant mismatch. |
| Point 3 | `SttWsGateway.isOriginAllowed` accepts, registry never consulted. Imports the accessor rather than re-reading the setting (§4B.4's lesson). |
| Credentials | `buildCorsOptions()` extracted from `main.ts` into `cors.config.ts` (a value inside `bootstrap()`'s closure is untestable) with `credentials: false`. |
| Boot log | `CORS configuration` now carries `originEnforcement` / `policy: allow_all_origins` / `credentials: false` / `enforcementSetting`, and is emitted at **`warn`** while enforcement is off. |

**Cookie-dependence check, before flipping `credentials`** — three greps, all clean: no `req.session`
reader anywhere in `apps/api` (`express-session` is mounted with zero consumers); no
`credentials: 'include'` / `withCredentials: true` in any SDK, package or app; and the SSO legs are
cookie-free too — the OIDC/SAML `state` is a signed JWT carried in the URL
(`federated-auth.service.ts`) and the callback is a top-level navigation, not a CORS fetch. Nothing
browser-facing depends on cross-origin cookies.

**Tests** — RED first (31 failing), then green:

```
apps/api/src                                        171 files · 2469 tests   ✓
packages/applications/.../settings-registry          13 files ·  157 tests   ✓
tsc --noEmit -p apps/api/tsconfig.json                                       ✓
@arcaai/applications typecheck + build                                       ✓
eslint apps/api                          0 errors (65 pre-existing warnings) ✓
```

New suites pin the permissive default (`*.enforcement.task610.test.ts` for cors.config, the guard,
the WS gateway and the binder, plus a descriptor-governance test); the four pre-existing suites arm
`setOriginEnforcementResolver(() => true)` and are otherwise **unchanged** — that pairing is the
regression gate proving the enforced path still behaves exactly as §3–§4B built it. One e2e
assertion was deliberately inverted: `monitoring.spec.ts` now requires
`access-control-allow-credentials` to be ABSENT.

---

## 5. Implementation Summary

*In progress. Waves 0–3 landed and verified; Wave 4 remediation partly outstanding (see §5.3).*

### 5.1 Adversarial review (W4-R) — what it caught that the lanes did not

The lane tiering earned its keep here. Every lane's own suite was green when W4-R started.

| # | Severity | Finding | State |
|---|---|---|---|
| 1 | **HIGH** | `refresh()` runs INSIDE a request CLS scope. `@OnEvent` dispatches synchronously, so a mutation's `origin-registry.invalidate` rebuilt the index inside the writing request's `AsyncLocalStorage` store → tenant-scope narrowed `findAll({})` to the acting tenant → all four SYSTEM day-1 origins dropped out. Production CORS refuses the admin console, and FR-4 stops being enforced for every dropped origin (`ownerOf → null` takes the guard's pass-through branch). | **FIXED** |
| 2 | MEDIUM | FR-6's bootstrap fallback is inert as shipped — `CORS_ALLOWED_ORIGINS` is empty in both sample env files and no env file is read in production. | **SUPERSEDED** — §4A.1 retired FR-6 and the env var outright (lane W5-C); the "deploy it correctly" question this finding raised no longer applies because there is nothing left to deploy |
| 3 | MEDIUM | HTTP and WS disagreed on a present-but-empty registry: HTTP fell back, WS rejected — severing live transcription sessions in exactly the scenario the WS fail-open comment cites. | **FIXED** |
| 4 | MEDIUM | A soft-deleted origin could never be re-registered: `findByOrigin` filters `ENABLED`, the unique index is not partial, so re-adding hits P2002 with a misleading "already registered" and no restore route. | dispatched |
| 5 | MEDIUM | No watchdog: the registry had no timer and rode `app-settings.cache-refreshed`, which fires only on SUCCESS — a persistently failing AppSettings cache froze the index forever and a revoked origin stayed live undetectably. | dispatched |
| 6 | LOW | The seed places `http://localhost:5173` in PRODUCTION as a SYSTEM-owned origin, valid for every tenant. | **ACCEPTED** (§5.3) |
| 7 | LOW | The `main.ts` CORS bootstrap log described the deleted catch-all. | **FIXED** |

**Verdicts.** D-3 (the production `https://` catch-all) is **genuinely closed** — W4-R could not construct an unregistered origin production admits, and refuted `Origin: null`, IDN/punycode homographs, trailing-dot FQDNs, default-port aliasing, uppercase percent-encoding, tab/newline injection, duplicated `Origin` headers, tenant-admin access to the admin surface, and guard ordering. FR-4 held *by construction* but not *in operation* until finding #1 was fixed.

### 5.2 Three lessons worth carrying to the next ticket

1. **A mocked dependency cannot observe an ambient-context defect.** W2-A wrote a 30-line hazard block stating `refresh()` must never run inside a request CLS scope, then shipped code that always did — because its mocked repository could not see CLS narrowing. The test passed *by construction*. The regression test now uses a real `ClsModule`, a real `EventEmitterModule`, and a repository stub that mirrors the tenant-scope contract; against the old code it fails with `expected true to be false` and `expected 1 to be 3`.
2. **Deferral does not escape `AsyncLocalStorage`.** `setImmediate` / `process.nextTick` / `setTimeout` all preserve the store — the obvious fix would have looked right and changed nothing. Only `ClsService#exit()` detaches. Verified at runtime before dispatching the fix.
3. **Fixing "two paths disagree" by copying the rule re-creates the defect.** W3-C's first fix for #3 duplicated `isBootstrapAllowed` into the gateway, with a comment claiming the copy keeps HTTP and WS in agreement. The Integrator consolidated it to a single exported function: the next edit would otherwise have landed on one side only.

### 5.3 Carried forward — NOT fixed in this ticket, deliberately

- ~~**#2 — populate `CORS_ALLOWED_ORIGINS` in the deploy environment.**~~ **SUPERSEDED by §4A.1** (lane W5-C): the owner decided against ANY env-var control of CORS, so FR-6 and the variable are both removed rather than deployed. A gateway that cannot reach the database (or whose `TenantAllowedOrigin` table is empty) now DENIES every browser origin — logged as `origin_registry_unavailable`, distinct from an ordinary per-origin `origin_registry_miss` — with no fallback of any kind. That is the safe direction, and it is now a hard dependency rather than a soft, mis-deployed one.
- **#6 — `http://localhost:5173` stays in the production seed.** The owner named it explicitly as a day-1 required origin. W4-R is right that it is a production allow-list entry with no production purpose; removing it is the owner's call to make, not the reviewer's to impose.
- **Migrations have only been applied via `psql`.** This dev database is `db push`-managed (68 prior migrations absent from `_prisma_migrations`), so `migrate dev` demanded a destructive reset. Both migration folders are hand-authored for CI/prod `migrate deploy` and must get a clean-database `migrate deploy` run before shipping.
- **D-8's revert changes an already-applied migration.** Anyone who ran `db:migrate` since `7703e40f` will hit a checksum mismatch and need `prisma migrate resolve`.
- **Cross-node propagation** remains event + timer, not sub-second. A dedicated Redis channel is
  specified in **TASK-631 — Unified cache-invalidation bus**, deliberately deferred there rather than
  rushed here: it touches `SecretsService` (Vault rotation) and `AppSettingsService`, and a silent
  miss in either is a security event.

### 5.4 The `useClass` aliasing defect (found during the config fetch/cache/refresh review)

`OriginRegistryServiceModule` aliased its symbol token with `useClass` rather than `useExisting`.
**`useClass` CONSTRUCTS A SECOND INSTANCE.** Two live registries resulted: both ran `onModuleInit`,
both answered `@OnEvent('app-settings.cache-refreshed')` — two full table scans per settings refresh —
and since every consumer injects the SYMBOL, the second index was read by nobody.

The dangerous part was the `@Cron` backstop. It registers under the fixed name
`origin-registry-backstop-refresh`, and two instances cannot both hold it; whichever registered first
won. **If that was the phantom, the watchdog whose entire purpose is bounding how long a REVOKED
origin stays live was refreshing an index no request path reads** — a staleness guarantee that
silently did nothing.

Fixed with `useExisting`, verified empirically rather than by inspection: the steady-state refresh
cadence at second `:45` went **2 → 1**.

**The generalisable rule:** `useClass` on a token whose class is ALSO provided directly yields a
duplicate instance, not an alias. Harmless for a stateless helper; a live defect for anything holding
state, scheduling a timer, listening for events, or registering under a fixed name. A repo-wide audit
for the same shape is part of this change.

---

## 6. Change History

| Date | Change |
|---|---|
| 2026-08-07 | **Lane W5-C correction — WS handshake realigned to fail-CLOSED (reverses the "deliberate divergence" in the entry below).** Coordinator review flagged that the same-day fail-open decision left the WORSE asymmetry standing: browsers are exempt from CORS on the WS handshake (D-6) — the actual cross-site WebSocket hijacking surface — so making it the PERMISSIVE path on a registry outage was backwards. Verified before acting, not assumed: `SttWsGateway.handleConnection` requires a single-use `ticket` (`stream-ticket.service.ts`, 30s TTL, GET+DEL from Redis), and the ONLY way a browser client obtains or refreshes one is a prior HTTP round trip to THIS gateway — `POST .../stream/session` (`transcription-job.controller.ts:381`) or `POST .../stream/session/:id/refresh-ticket` (`:538`) — both ordinary `@Authorize()`-gated Nest HTTP routes behind the SAME CORS gate that now denies during a registry outage; confirmed `issueTicket` has exactly these two callers plus `auth.controller.ts`'s `/auth/stream-ticket`, and the SDK's reconnect path (`SttWebSocketClient.attemptReconnect` → `StreamingSessionManager.refreshTicket` → `apiClient.post`) always calls the HTTP endpoint fresh rather than reusing a ticket. So during a registry outage no legitimate browser client can reach the WS handshake at all — it never got past the HTTP ticket call — meaning the earlier fail-open reasoning ("don't sever a live session") bought nothing operationally while leaving the CSWSH surface open. `isOriginAllowed` in `stt-ws.gateway.ts` now DENIES on absent/empty/throwing registry, reusing the exact `origin_registry_unavailable` / `origin_registry_miss` log-reason pair from `cors.config.ts` (added a `reason` field to the WS warn logs to match). The no-`Origin` allowance (non-browser callers) is untouched. TDD: reverted-to-fail-open assertions in `stt-ws.gateway.origin.task610.test.ts` were run FIRST against the new fail-closed code and failed red (3 failures, `client.close` unexpectedly called with `[4401, "Authentication failed"]`), then the tests were rewritten to assert fail-closed + the `reason` fields and re-run green (12/12). Evidence: `npx tsc --noEmit -p apps/api/tsconfig.json` clean; `npx vitest run apps/api/src/__tests__ apps/api/src/modules/streaming apps/api/src/modules/platform-knobs` — 573/573 pass; `pnpm --filter @arcaai/api lint` — no new issues in touched files. |
| 2026-08-07 | **Lane W5-C — `CORS_ALLOWED_ORIGINS` removed entirely (§4A.1).** `isBootstrapAllowed` deleted from `cors.config.ts`; `isOriginAllowed` now DENIES on a `null`-answering registry (unavailable/not-loaded/broken) under a new, distinct log reason `origin_registry_unavailable`, kept separate from the ordinary per-origin `origin_registry_miss` so an operator can tell "the registry is down" from "this origin isn't registered" in one grep. `PlatformKnobsBinder`'s `size() > 0 ? registry : null` collapse is KEPT (not removed) — post-§4A.1 it no longer changes the DENY outcome, only which of the two log reasons fires, and that diagnostic split is worth keeping. `SttWsGateway` — removed the `isBootstrapAllowed` import/wrapper; its `size() === 0` branch now behaves exactly like its (unchanged) absent/throwing-registry branches: ~~ALLOW with a loud log. This is a deliberate, documented DIVERGENCE from the HTTP path's new fail-closed posture — the WS check is CSWSH mitigation on an already-authenticating live audio handshake, where a false negative severs a clinician mid-consultation, versus HTTP CORS gating whether a browser page loads at all; both are advisory/pre-auth, and tenant isolation is enforced downstream by ticket-scoped auth either way, so this was not weakened.~~ **REVERSED same day — see the entry above.** The divergence was wrong: it left the WORSE asymmetry standing (the CSWSH-exempt path became the permissive one), and the clinical-safety rationale did not survive checking how a WS connection is actually obtained (a prior HTTP ticket call, gated by the same now-fail-closed CORS check). `corsAllowedOrigins` removed outright: the `PLATFORM_KNOB_SETTINGS` descriptor, the `11a-platform-knob-settings.ts` seed entry, and the `fail-mode.governance.test.ts` env-name mapping (its registry-membership test would otherwise fail on the deleted key). `turbo.json#globalEnv`, `.env.sample`, `apps/api/.env.sample`, and `env-surface.generated.md` regenerated via `pnpm env:sync`. `main.ts`'s "CORS configuration" boot log no longer prints a bootstrap origin list (there is none); it now reports `unavailableRegistryBehavior: 'deny_all'`. Stale `FR-6`/`CORS_ALLOWED_ORIGINS` comments updated (not just deleted) in `platform-knobs.binder.ts`, `platform-knobs.module.ts`, `app.module.ts`, `origin-tenant-binding.guard.ts`, `apps/api/docs/04-deployment-guide.md`, and the two other test files touching the old fallback (`cors.config.test.ts`, `stt-ws.gateway.origin.task610.test.ts`, `platform-knobs.binder.task610.test.ts`) — rewritten to assert the new fail-closed/fail-open behaviors instead of the retired env var. §5.1 finding #2 and §5.3's matching entry marked SUPERSEDED (nothing left to deploy). Not a migration: existing inert `GlobalSetting` rows for the old `corsAllowedOrigins` key are left in place, harmless — cleanup item, not a code change. |
| 2026-08-04 | Ticket created. Reviewed commit `7703e40f`; recorded D-1…D-8. Owner decisions: global-admin-only governance; production `https://` catch-all closed in this ticket. Plan drafted, pending approval. |
| 2026-08-04 | §4.2 wave tables gained per-lane model tier + effort; Wave 4 split into Integrator (W4-I) and an independent adversarial reviewer (W4-R). Added §4.9 tier policy: assignment by complexity × blast radius, reviewer-never-cheaper-than-author, escalate-on-second-failure, escalate-on-ambiguity-not-difficulty. |
| 2026-08-04 | Added §4 Parallel Execution Plan — frozen cross-lane contracts, 5 waves / 12 lanes, single-owner file map for the shared-file conflict surface, per-lane DoD, worktree/merge discipline, and the seed-before-close sequencing guard. |

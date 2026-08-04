# TASK-610 — Tenant Allowed Origins (CORS control plane)

| Field | Value |
|---|---|
| **Status** | `Pending` — plan awaiting approval |
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
  `pnpm lint` — all green, output pasted into §4.
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

## 4. Implementation Summary

*Not started — plan awaiting approval.*

---

## 5. Change History

| Date | Change |
|---|---|
| 2026-08-04 | Ticket created. Reviewed commit `7703e40f`; recorded D-1…D-8. Owner decisions: global-admin-only governance; production `https://` catch-all closed in this ticket. Plan drafted, pending approval. |

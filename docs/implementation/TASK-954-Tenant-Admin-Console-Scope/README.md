# TASK-954 — Tenant-admin console scope: no platform menus, a working tenant AI-providers screen with the platform fallback read-only, tenant dashboard/monitoring/releases, tenant-only settings

| | |
|---|---|
| **Status** | `Completed` — 2026-09-12 (committed on `dev-2.2`; not pushed) |
| **Type** | `bugfix` (console scope) + `feature` (tenant dashboard, platform-default read) |
| **Branch** | `dev-2.2` |
| **Reported as** | Logged in as the ArcaAI tenant admin: (1) no tenant dashboard, monitoring or release screen; (2) platform menus still visible — Tenants, Tenant storage, Audit logs, AI providers; (3) settings & secrets must be the tenant's only, and anything the tenant admin cannot update or see must not be displayed; (4) per agreement a tenant admin MUST see and configure its own AI providers and see the platform fallback READ-ONLY. |

---

## 1. Requirement Analysis

Four asks, one audience: a `TENANT_ADMIN` session in `apps/admin-console`.

| # | Ask | Reading applied |
|---|---|---|
| R-1 | "Cannot see my tenant dashboard, monitoring or release" | The three Overview screens are tier 10-19 today. Monitoring and Releases are ALREADY gateway-readable by a tenant admin (`read:TenantTelemetry`); the console hides them behind the `(global)` guard. A tenant dashboard does not exist and is built from routes a tenant admin already reaches. |
| R-2 | "Platform menu still visible: tenant, tenant storage, audit log, ai providers" | Tier 10-19 entries whose ability gate a tenant admin's rules happen to match leak into the rail and 404 on click. `/ai-providers` is a tier 20-29 shared screen that is BROKEN for a tenant admin (every card 403s), so it reads as a platform screen. |
| R-3 | "Settings and secrets for my tenant only; what I cannot update or see must not be displayed" | The legacy rows list is already tenant-pinned (TASK-932 R-1), but it lists the tenant's LOCKED rows ("only a super admin may change it") and a cross-tenant Tenant column/filter. The registry catalog is already filtered server-side (8 keys, all writable). |
| R-4 | "See my tenant AI providers, configure them, and see the default platform fallback as READ-ONLY" | Needs the tenant view to actually work (R-2) plus a NEW read of the SYSTEM tier's cloud rows a tenant may inherit — masked, resolution-annotated, read-only. |

Classification: `bugfix` + `feature`. Ticket number assigned as the next free number after TASK-953 (`docs/archive/` is off-limits this sprint and was not consulted).

---

## 2. Current State Evaluation (verified live 2026-09-12, dev stack, seeded `tenant_admin` / `__GLOBAL__`)

### 2.1 The rail leaks tier 10-19 entries to a tenant admin

`visibleNavEntries` (`shared/navigation/nav-config.ts`) applies a ROLE check to tier 50-59 only. Tier 10-19 is ability-gated alone, while the route group `(global)/layout.tsx` 404s every non-elevated session. The seeded `tenant-full-access` policy grants `update:Tenant`, `manage:Storage`, `read:AuditLog` and `read:TenantTelemetry`, so the rail shows:

| Entry | Gate matched by the tenant admin | Click → |
|---|---|---|
| `/tenants` "Tenants" | `update:Tenant` | 404 |
| `/tenants/storage` "Tenant storage" | `read:Storage` (via `manage:Storage`) | 404 |
| `/audit-logs` "Audit logs" | `read:AuditLog` | 404 |
| `/monitoring`, `/releases` | `read:TenantTelemetry` | 404 |

`nav-config.test.ts`'s `TENANT_ADMIN_RULES` fixture is a narrow approximation (7 rules vs 60+ seeded) and was pinning `Tenants` and `Audit logs` as EXPECTED tenant-admin inventory — the test encoded the defect.

The rail and sidebar also judge tiers on `session.user.roles` (the OPERATOR), while the route groups judge `effectiveRoles` (the impersonated target) — TASK-932 aligned the guards but not the nav.

### 2.2 `/ai-providers` is broken for a tenant admin

`toSafeSession.effectiveTenantId` is `workingTenantId ?? null` when not impersonating — and a tenant-bound session never has a working tenant. `useProviderScope` then falls back to `SYSTEM_TENANT_ID`, so every card reads `admin/providers/:service/:provider?tenantId=00000000-…`:

```
GET admin/providers/llm/azure?tenantId=00000000-0000-0000-0000-000000000000  →  403 "You do not have access to this tenant"
GET admin/providers/llm/azure                                                →  200 (placeholder, version 0)
```

The scope badge reads "Tenant configuration — Working tenant". The screen test's `TENANT_SESSION` fixture carries `effectiveTenantId: 'tnt-1'` — a shape `toSafeSession` never produces for a tenant admin.

### 2.3 No platform-fallback read exists for a tenant

`GET admin/providers/:service` under a tenant scope returns the TENANT's rows only (`isVisibleToTier`), and a tenant may not address `?tenantId=SYSTEM` (403). The cascade (`cascadeRows`) already reads the SYSTEM tier on a tenant's behalf for resolution, but nothing projects it to the console. The seeded platform rows: `llm` azure/bedrock/openai/anthropic/vertex + built-in engines; `stt` azure-speech/azure-foundry/sarvam/openai; `tts` azure/sarvam/… (all cloud rows currently disabled, keyless).

### 2.4 Dashboard / monitoring / releases

| Route | Backend gate | Tenant admin today |
|---|---|---|
| `admin/platform/{metrics,sockets,consumption}` | `manage:PlatformMetrics` | 403 — platform-wide numbers, correctly closed |
| `admin/monitoring/*`, `admin/health/services` | `manage:all` OR `read:TenantTelemetry` | 200 |
| `admin/service-releases/*` | same | 200 |
| `admin/queues/health/redis` (the Redis card on Monitoring) | `manage:all` | 403 |
| `admin/tenants/:id/usage` (own tenant) | `manage`/`update:Tenant` | 200 — users, departments, storage, transcription minutes, summaries 24h, consultations |
| `admin/audit-logs` | `read:AuditLog`, tenant-scoped | 200 |

So a tenant dashboard needs NO new backend: usage stats + service health + the tenant's own recent admin activity.

### 2.5 Settings & secrets

`GET admin/settings` for the tenant admin returns 18 rows for `__GLOBAL__` (13 for ArcaAI), of which 6 are `locked` (`stt/default-stt-model`, `stt/vad-sensitivity`, `ux-constants/*`) — displayed, un-editable ("only a super admin may change it"). The screen renders a Tenant column and a Tenant filter chip (`admin/tenants` → the tenant's own row only). Reveal/rotate are already `manage:all`-gated in the drawer. The registry catalog (`admin/settings/catalog`) already returns 8 tenant-writable keys and nothing else.

---

## 3. Implementation Plan

Owner rules honoured: tenant → SYSTEM is a CONFIGURATION cascade (the platform-default read is exactly that, read-only), 404-over-403 for cross-tenant, no new env/config, `AiProviderConnection` three-state semantics unchanged.

### 3.1 Gateway (`packages/applications`, `apps/api`)

| Step | Change | Test (RED first) |
|---|---|---|
| G-1 | `AiProviderConnectionService.listPlatformDefaults(service, tenantId?)` — built on the ONE cascade (`cascadeRows`): the SYSTEM tier's CLOUD BYO rows for the service, masked through the existing mapper, each annotated with `resolution` ∈ `inherited · overridden · vetoed · not-entitled · not-configured · off`, plus `entitled`. SYSTEM tier as the caller → 400 (top of the cascade). | `__tests__/ai-provider-connection.platform-defaults.task954.test.ts` |
| G-2 | `GET admin/providers/:service/platform-defaults` on `ProviderConnectionController`, declared BEFORE `:service/:provider`; `@CanRead('GlobalSetting')`; tenant admins pinned by `resolveScopedTenantId`. | controller unit test |
| G-3 | `GlobalSettingService.fetchAll/fetchAllByTenantId`: a non-super-admin caller's list EXCLUDES `locked` rows (server-side, so counts and pages agree). | `globalSetting.service.list.test.ts` |
| G-4 | Regenerate the five artifacts: `api:build`, `api:route-manifest`, `api:openapi`, `api:portal`, `vox-node gen:admin`; run the `:check` gates. | — |
| G-5 | e2e `apps/api/tests/e2e/task-954-tenant-admin-scope.spec.ts`: platform-defaults for a tenant admin (200, cloud only, no key material, resolution), SYSTEM 400, foreign tenant 403; locked rows absent from the tenant admin's list and present for a super admin. | live gateway |

### 3.2 Admin console (`apps/admin-console`)

| Step | Change | Test |
|---|---|---|
| C-1 | `server/safe-user.ts`: `effectiveTenantId` of a NON-elevated, non-impersonating session is its own tenant. | `safe-user.test.ts` |
| C-2 | `nav-config.ts`: tier 10-19 requires an elevated effective role (mirrors `(global)/layout.tsx`); `/dashboard`, `/monitoring`, `/releases` re-tiered to 20-29 (`/dashboard` gains `read:TenantTelemetry`). Rail + sidebar judge `effectiveUser.roles`. | `nav-config.test.ts` (fixture widened to the seeded grant set), shell tests |
| C-3 | Move `(global)/{dashboard,monitoring,releases}` → `(shared)/…`. Dashboard page renders `PlatformDashboard` (elevated) or the new `TenantDashboard`; Monitoring page passes `platformOps` so the Redis card (manage:all) is not rendered for a tenant admin. | screen tests |
| C-4 | `features/platform`: `TenantDashboard` — usage tiles (`admin/tenants/:id/usage`), services strip, recent tenant admin activity; no platform-wide metrics. | `tenant-dashboard.test.tsx` |
| C-5 | `features/ai-providers`: tenant scope = own tenant with its name; `admin/providers/:service/platform-defaults` client/hook/types; `PlatformDefaultsPanel` (read-only) at the top of every tenant tab; card hint when the row is "use platform default"; tenant wording on the screen. | screen/tab tests |
| C-6 | `features/settings`: Tenant column + filter only for an elevated session. | `settings-screen.test.tsx` |

### 3.3 Verification criteria

- Tenant admin rail: Overview (Dashboard, Monitoring, Releases) · Tenancy (Tenant profile, Departments) · Platform Ops (Tenant settings, Settings rows & secrets, Storage browser) · AI Platform (AI providers) · … · Playground. NO Tenants, Tenant storage, Audit logs, Entitlements, Billing, or any other tier 10-19 entry.
- `/ai-providers` as a tenant admin: every card loads (own tenant), scope badge names the tenant, each tab shows the platform defaults read-only with a resolution per provider.
- `/dashboard`, `/monitoring`, `/releases` render for a tenant admin; Monitoring shows no Redis card.
- `/settings` as a tenant admin: only the tenant's unlocked rows; no Tenant column/filter.
- Gates: `pnpm --filter @arcaai/applications test` (targeted), `pnpm test:unit` (api, targeted), `pnpm --filter @arcaai/admin-console test lint typecheck build`, the five-artifact regeneration + `:check` gates, the new e2e spec against a live gateway.

---

## 4. Implementation Summary

### 4.1 What changed

**Gateway**

| File | Change |
|---|---|
| `packages/applications/src/services/ai-provider-connection/dto/platform-default-connections.response.ts` (new) | `PlatformDefaultConnectionResponse` (= the masked row + `resolution`) and `PlatformDefaultConnectionsResponse` (`service`, `tenantId`, `entitled`, `connections[]`); `PLATFORM_DEFAULT_RESOLUTIONS` = `inherited · overridden · vetoed · not-entitled · not-configured · off`. |
| `…/IProviderConnectionService.ts`, `…/ai-provider-connection.service.ts` | `listPlatformDefaults(service, tenantId?)` — built on `cascadeRows` (the ONE cascade), one entry per `CLOUD_BYO_PROVIDERS[service]` provider (placeholder where SYSTEM has no row), nothing decrypted, SYSTEM tier → 400. `platformDefaultResolution` orders the verdict exactly as the cascade decides: override → veto → entitlement → row state. |
| `apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts` | `GET admin/providers/:service/platform-defaults` — `@CanRead('GlobalSetting')`, declared BEFORE `:service/:provider` so the static segment is not captured as a provider read; tenant admins pinned by `resolveScopedTenantId`. |
| `packages/applications/src/services/globalSetting/globalSetting.service.ts` | `fetchAll` (pinned caller) and `fetchAllByTenantId` (non-super-admin) exclude `locked` rows — server-side, so `count` and pages agree with the screen. A super admin acting on a working tenant keeps them. |
| `apps/api/route-manifest.json`, `apps/api/openapi.json`, `apps/admin-console/src/server/api-docs/openapi.{admin,business}.json`, `packages/vox-node/src/resources/admin/{admin-namespace,ai-provider,schemas}.ts` | The five regenerated artifacts (`hope.admin.aiProvider.listPlatformDefaults` is now on the SDK). |

**Admin console**

| File | Change |
|---|---|
| `src/server/safe-user.ts` | `effectiveTenantId` of a non-elevated, non-impersonating session is its OWN tenant (was `null`, which sent every tenant-scoped screen to the SYSTEM tier). |
| `src/shared/navigation/nav-config.ts` | Tier 10-19 requires an elevated effective role (mirrors `(global)/layout.tsx`); `/dashboard`, `/monitoring`, `/releases` re-tiered to 20-29, `/dashboard` gains `read:TenantTelemetry`. Counts now 22/12/19/5. |
| `src/shared/layout/{domain-rail,app-sidebar}.tsx` | Judge tiers on `session.effectiveUser.roles` (the impersonated target while impersonating), the same identity the route groups judge. |
| `src/app/(console)/(global)/{dashboard,monitoring,releases}` → `(shared)/…` | Moved. `dashboard/page.tsx` renders `PlatformDashboard` for an elevated session, `TenantDashboard` otherwise (server-decided from `effectiveRoles`); `monitoring/page.tsx` passes `platformOps`. |
| `src/features/platform/components/tenant-dashboard.tsx` (new), `api/{types,client,hooks,keys}.ts` | Tenant Dashboard: usage tiles (`admin/tenants/:id/usage`), services strip, tenant footprint, recent admin activity with no `/audit-logs` link. `ServicesStrip` and `RecentActivityCard({ auditLogsHref? })` exported from `platform-dashboard.tsx` for reuse. |
| `src/features/monitoring/components/monitoring-screen.tsx`, `api/hooks.ts` | `platformOps` prop: the Redis tile + card (`manage:all`) are not rendered, and `useRedisHealth(enabled)` never issues the read, on a tenant-scoped screen. |
| `src/features/ai-providers/components/use-provider-scope.ts` | Tenant tier resolves `effectiveTenantId ?? effectiveUser.tenantId`; the label comes from the tenant catalog; `elevated` added so the wording can tell "clear the working tenant" (elevated) from "your own tenant" (tenant admin). |
| `src/features/ai-providers/components/platform-defaults-panel.tsx` (new), `provider-credentials-tab.tsx`, `provider-credential-card.tsx`, `ai-providers-screen.tsx`, `api/{types,client,hooks,keys}.ts` | The read-only "Platform defaults" table at the top of every tenant tab (one read per tab, shared with the cards), a per-card hint under "Use platform default" saying whether the default exists, tenant wording on the screen. Never rendered on the platform tier. |
| `src/features/settings/components/settings-screen.tsx` | The cross-tenant Tenant column + filter render for an elevated session only. |

Docs: this README. The rule text in `13-nextjs-apps.md` ("`(global)` = tier 10–19, `(shared)` = 20–29") is unchanged and now true of the Overview screens again.

### 4.2 Decisions taken (assumptions the owner may overrule)

| # | Decision | Why |
|---|---|---|
| A-1 | `/audit-logs`, `/tenants`, `/tenants/storage` stay tier 10-19 and are simply hidden from a tenant admin. | The ask was "SHOULD NOT" be visible. The gateway does serve a tenant-scoped audit log to a tenant admin (`read:AuditLog`), so a tenant audit screen is a one-line re-tier if wanted later; it is not done here because it was not asked. |
| A-2 | The Dashboard route splits on the EFFECTIVE ROLE, not on the working tenant. | A super admin keeps the platform dashboard whether or not a working tenant is selected (unchanged behaviour); only a non-elevated session gets the tenant dashboard. The working-tenant rule (R-12) is kept for CONFIGURATION screens. |
| A-3 | Locked settings rows are excluded SERVER-side for a non-super-admin list. | "Must not be displayed" is only reliable when the count and the page agree; the by-id read of a locked row stays 200 (the caller holds `read`). |
| A-4 | The platform-default projection exposes the masked row (endpoint/region/deployment/extras, ceilings, `hasKey`) plus the verdict — the same masked DTO a super admin sees, never the key. | The endpoint is what makes a fallback legible; the key never leaves the gateway (raw-body e2e assertion). |
| A-5 | Domain names in the rail ("Platform Ops", "AI Platform") are unchanged. | Only the tier label "Platform" (10-19) reached a tenant admin; with tier 10-19 gone from the rail, the remaining domains hold tenant entries only. Renaming domains per audience is a design call not taken here. |
| A-6 | Verified with the seeded `tenant_admin` / `__GLOBAL__`, not the ArcaAI admin. | `arcaai_admin` does not accept the seed password on this dev DB (the owner's own credential); both hold the identical `TENANT_ADMIN` role and policy set, so the console behaves the same. Note the `__GLOBAL__` tenant holds no `platformDefaultCredential` entitlement in the dev seed, so every platform default reads "Not in your plan" — an accurate statement of the entitlement, not a defect. |

### 4.3 Evidence

| Gate | Result |
|---|---|
| `packages/applications` — `vitest run src/services/{ai-provider-connection,globalSetting}/__tests__/` | 24 files, **404 passed** (9 new in `ai-provider-connection.platform-defaults.task954.test.ts`; 4 legacy expectations updated for the locked-row rule) |
| `apps/api` — `vitest run` (full) | **298 files passed, 2 skipped · 4407 tests passed, 4 skipped** (4 new controller cases) |
| `pnpm api:build` | exit 0 (12 tasks) |
| `pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin` | 517 paths · 664/200 portal ops · 49 areas/424 routes/430 schemas |
| `pnpm api:openapi:check && pnpm api:portal:check && pnpm --filter @arcaai/vox-node gen:admin:check` | all "no drift" / OK |
| `apps/admin-console` — `pnpm test` (full) | **320 files, 2923 tests passed** (new: `tenant-dashboard.test.tsx`; extended: nav-config, safe-user, breadcrumbs, monitoring-screen, settings-screen, ai-providers-screen, provider-credentials-tabs, nav-shell-fixture) |
| `pnpm --filter @arcaai/admin-console typecheck` / `lint` | exit 0 / exit 0 |
| `pnpm --filter @arcaai/admin-console build` (`next build`) | exit 0 |
| Live gateway (rebuilt dist on port 8869, dev DB, `tenant_admin`) | `GET admin/providers/llm/platform-defaults` → 200, 5 SYSTEM-owned masked entries with `resolution`, raw body carries no `encryptedApiKey`/`vault:`; `?tenantId=SYSTEM` → 403; `GET admin/settings?limit=200` → 12 rows (was 18), 0 locked |
| Live console (`next start` on 5177 → 8869, `tenant_admin`) | Rail: Dashboard · Tenant profile · Settings registry · AI providers · Agents · Patient consent · Users · Playground; Overview sidebar = Dashboard/Monitoring/Releases; Platform Ops sidebar = Settings registry/Settings rows & secrets/Storage browser. `/dashboard` = Tenant Dashboard ("Global"); `/monitoring` = 3 tiles, no Redis; `/ai-providers` = "Tenant configuration — Global", read-only Platform defaults table per tab, cards load; `/settings` = 12 rows, no Tenant column; `/tenants` and `/audit-logs` = "Page not found". |
| Playwright e2e against 8869 (`RESET_DB=false SKIP_DB_PRECHECK=true`, `--workers=1`, gateway started with `RATE_LIMIT_ENABLED=false` — the dev throttler 429s the per-test logins; `.env.test` disables it the same way) | `task-954-tenant-admin-scope` + `tenant-dashboard-sources` + `task-932-settings-visibility` + `task-932-providers`: **57 passed, 2 skipped** (the two env-gated internal weight-fetch cases). The new spec alone, on the throttled gateway: 10 passed. |

### 4.4 Not done / follow-ups

- Committed on `dev-2.2` as one ticket commit; not pushed.
- The ArcaAI tenant's platform-default entitlement is whatever the seed/entitlements say; if the owner expects "Serving you" on the ArcaAI providers screen, that is an entitlement/seed question, not a console one.
- The `alaas-postgres` / `alaas-redis` containers hold ports 5433/6380, so `pnpm setup:test` cannot bring up the isolated test stack while they run (it would validate against the ALaaS database). The e2e run used a second gateway on 8869 against the dev stack instead; the test containers that had been created were removed with `pnpm infra:test:down`.

---

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-12 | Ticket opened; requirement analysis, live current-state evaluation and plan written. |
| 2026-09-12 | Implemented G-1…G-5 and C-1…C-6; all unit/typecheck/lint/build gates green; five artifacts regenerated; live gateway + console verified as `tenant_admin`; e2e 57/57 on the related specs (see §4.3). Helper gateway (8869) and console (5177) stopped afterwards; the partially-created test containers were removed. |

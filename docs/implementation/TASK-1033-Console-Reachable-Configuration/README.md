# TASK-1033 — Every editable setting is reachable from the admin console

| Field | Value |
|---|---|
| Status | **Review** — merged on `dev-2.2`, verified locally; not pushed, cluster value not yet set |
| Type | feature (console) + bugfix (misleading registry provenance) |
| Branch | `dev-2.2` |
| Rules | 00, 01, 04, 05, 07, 10, 11, 13 |

## Requirement Analysis

Owner, 2026-10-02: *"platform admin MUST be able to manage configuration from admin-console"* —
then, same session: *"platform admin MUST NOT be able to change the secrets in vault."*

Trigger: presigned checkpoint downloads pointed at `https://hope-minio:9000/...` (in-cluster
host). The fix already exists (TASK-984 `storage.platformDefault.publicEndpoint`, signed for the
admin origin and routed by the `hope-minio-presigned` IngressRoute), but the Settings registry
screen showed the key as a dead end:

> Dedicated service — not editable here … Currently answered by code default · no row stored at this scope

Two defects in that one message:

1. **Dead end.** It says a dedicated screen owns the write but never says which one.
2. **False provenance.** `db-config` keys live in their own table (`TenantStorageConfig` SYSTEM
   row), not `GlobalSetting`, so "code default · no row stored" is reported even when the
   dedicated row IS set.

### Owner decisions in force

| # | Decision |
|---|---|
| OD-A | Vault (`vault-kv`) and per-tenant `db-secret` secrets stay **locked for everyone, platform admin included** — TASK-932 R-6/D-6 stands; no Vault policy change. |
| OD-B | `env`-tier bootstrap settings stay **read-only** (process-lifetime; change by redeploy). |
| OD-C | Every OTHER setting must have a working edit path reachable from the console, including reset-to-default where a default exists. |

## Current State Evaluation

| Tier | Keys | Write path today | Console today |
|---|---|---|---|
| `global-kv` | most | registry write lane | editable + reset ✅ |
| `db-config` | `storage.platformDefault.{provider,endpoint,publicEndpoint,region,forcePathStyle,containerPrefix}` | `PUT admin/tenant-storage-configs/platform` (If-Match, SUPER_ADMIN) | registry: dead end + wrong provenance ❌; `/tenants/storage` (no working tenant): only `publicEndpoint` editable, no reset |
| `entitlement` | `entitlements.featurePlatformDefaultCredential` | entitlements matrix | registry: dead end ❌ |
| `redis-flag` | kill-switches | kill-switch surface | registry: dead end ❌ |
| `vault-kv`, `db-secret`, `secret` | 22 + per-tenant | none (by OD-A) | locked with reason ✅ (wording kept) |
| `env` | bootstrap | none (by OD-B) | locked with reason ✅ |

Relevant code:
- `packages/applications/src/services/settings-registry/setting-lock.ts` — derived locks (unchanged).
- `apps/admin-console/src/features/settings-registry/components/governance.ts` — `TIER_BLOCK` dead-end text.
- `apps/admin-console/src/features/storage/components/platform-storage-default-panel.tsx` — SYSTEM row panel.
- `packages/applications/src/services/tenant-storage-config/platform-storage-settings.resolver.ts` — reads the `db-config` storage keys from the SYSTEM row.

## Implementation Plan

### 1. Owner route on the descriptor (backend, `@arcaai/applications`)
- Add optional `consoleRoute?: string` + `consoleRouteLabel?: string` to `SettingDescriptor`.
- Set it on every `db-config`, `entitlement`, `redis-flag` descriptor (storage → `/tenants/storage`, entitlement → plan matrix route, kill-switches → their surface).
- `SettingsRegistry.register` refuses a `db-config`/`entitlement`/`redis-flag` descriptor without `consoleRoute` (same fail-at-boot posture as the `failMode` rule) — a new dedicated key can never ship as a dead end.
- Catalog item DTO carries `consoleRoute` / `consoleRouteLabel`.

### 2. True provenance for `db-config` keys (backend)
- The catalog/effective-value read for `storage.platformDefault.*` resolves through `PlatformStorageSettingsResolver` (the same reader the runtime uses) and reports `source: 'dedicated-row'` with the row version, instead of "code default · no row".

### 3. Console — registry screen
- `governance.ts`: the `db-config`/`entitlement`/`redis-flag` block renders an **"Edit in <label> →"** link (`next/link`, plain href — no cross-feature import) from the catalog item.
- Drawer provenance line uses the new `dedicated-row` source.

### 4. Console — platform storage panel (`/tenants/storage`, no working tenant)
- Make all six `storage.platformDefault.*` non-secret fields editable (provider, endpoint, public endpoint, region, path-style, container prefix) in one If-Match form; `credentialsRef` stays read-only (it is a Vault path — OD-A).
- **Reset to default** per field = send `null` (absent → bootstrap/env tier answers), behind a confirm dialog that states the effect ("every tenant without its own storage config uses the bootstrap endpoint on the next file operation").
- Keep the existing rule that the panel never CREATES a half-filled SYSTEM row silently: creating requires provider + endpoint together.

### 5. Locked tiers (wording only)
- Unchanged behaviour. `env` items show the effective value with credentials masked (if not already) and "change by redeploy".

### TDD test list (RED first)
| # | Test | File |
|---|---|---|
| T1 | `register` throws for a `db-config` descriptor without `consoleRoute` | `settings-registry/__tests__/registry.test.ts` |
| T2 | every registered `db-config`/`entitlement`/`redis-flag` descriptor has a `consoleRoute` that exists in `nav-config.ts` | `apps/admin-console/.../governance.test.ts` (route-inventory parity) |
| T3 | catalog reports `dedicated-row` + version for `storage.platformDefault.publicEndpoint` when the SYSTEM row sets it | `settings-registry/__tests__/catalog.*.test.ts` |
| T4 | `writeBlockFor` on a `db-config` item returns a link target; vault-kv/env still locked (OD-A/OD-B regression lock) | `governance.test.ts` |
| T5 | `PUT admin/tenant-storage-configs/platform` with a field `null` clears it; tenant admin still 403 | applications service test + controller test |
| T6 | platform panel edits endpoint/region/path-style; reset sends `null` after confirm; 412 → toast + refetch | `platform-storage-default-panel.test.tsx` |
| T7 | `setting-lock.ts` unchanged: vault-kv write → `SETTING_TIER_LOCKED` for SUPER_ADMIN | existing test, kept green |

### File order
1. `registry.types.ts`, `settings-registry.ts` (T1) → descriptors (`storage`, `entitlements`, kill-switch) → catalog DTO + provenance (T3)
2. tenant-storage-config service/DTO null-clear (T5)
3. `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin` (only if a DTO shape changed)
4. console: `governance.ts` + drawer (T2, T4) → platform panel (T6)

### Verification
- `pnpm --filter @arcaai/applications build test`, `pnpm api:build`, `pnpm test:unit` (api), `pnpm --filter @arcaai/admin-console build lint test`
- Runtime: `next-dev-loop` — registry key `storage.platformDefault.publicEndpoint` shows the stored value and an "Edit in Tenant storage →" link; set it to the admin origin; a checkpoint download URL then starts with that origin. Both themes, axe 0.

## Implementation Summary

Delivered in two parallel lanes (worktrees), merged into `dev-2.2`:

| Lane | Model tier (rule 14 §1) | Branch → merge |
|---|---|---|
| Backend (registry, descriptors, catalog, storage resolver) | opus — multi-file, the contract the console depends on | `task-1033/be` (`c3ed4b7f5`) → `14a01558f` |
| Console (governance links, provenance, storage panel) | sonnet — standard UI against a fixed contract | `task-1033/ui` (`e7aedf7c0`, `5fec80ca3`) → `a77911350` |

Orchestrator follow-ups on `dev-2.2`: `06a995480` (pin `If-Match: "0"` on create — the lane omitted the header, which the gateway answers with 428), `6cbea2447` (owner link opens `?tab=configs`), `325bae9eb` (drawer shows the dedicated-row value).

What changed:
- `SettingDescriptor.consoleRoute` / `consoleRouteLabel`; `SettingsRegistry.register` refuses a `db-config` / `entitlement` / `redis-flag` descriptor without one. Storage keys → `/tenants/storage?tab=configs`, entitlement → `/entitlements`. No `redis-flag` keys are registered today.
- Catalog item carries `consoleRoute`, `consoleRouteLabel`, `dedicatedRow: { value, version } | null` (SYSTEM `TenantStorageConfig` row via `PlatformStorageSettingsResolver.dedicatedRowValues()`; credentials pointer never included). `getCatalog()` is now async.
- Console: "Edit in <screen> →" link instead of the dead-end sentence; provenance "Stored on the dedicated row: <value> · v<n>"; the platform storage panel edits provider/endpoint/publicEndpoint/region/forcePathStyle/containerPrefix in one If-Match form with per-field confirmed Reset to default (`null` clears; verified already supported by the PUT — T5 passed first run, no production change).
- Unchanged by design (OD-A/OD-B): `vault-kv`, `db-secret`, `secret`, `env` remain locked for SUPER_ADMIN (`setting-lock.ts` untouched; `settings-registry-write.lock-and-reset.test.ts` already pins it).

### Evidence (2026-10-02, merged tree)
- `pnpm --filter @arcaai/applications build` OK · `pnpm api:build` OK · `pnpm --filter @arcaai/admin-console build` OK
- applications `settings-registry` + `tenant-storage-config`: `Test Files 62 passed (62) · Tests 626 passed (626)`
- api `settings-catalog` + `tenant-storage-config`: `Tests 46 passed (46)` (catalog) / `57 passed` (both)
- console `settings-registry` + `storage`: `Tests 189 passed (189)`; `lint` clean (`--max-warnings 0`), `typecheck` clean
- `api:openapi:check` OK · `api:portal:check` no drift · `vox-node gen:admin:check` no drift
- Runtime (local `api:dev` + `next dev`, super admin, no working tenant): registry drawer shows `Edit in Tenant storage →` (`href=/tenants/storage?tab=configs`); saving `publicEndpoint` → PUT 200, catalog `dedicatedRow {value, version: 2}`; Reset → confirm dialog → PUT 200, `publicEndpoint: null`, other fields untouched (v3); `minio.secretKey` / `storage.platformDefault.credentials` still `locked`, no link. Light + dark rendered; axe on the registry page with the drawer open: 0 violations.
- Pre-existing, out of scope: 2 `no-silent-catch` warnings in `tenant-storage-config.service.ts` (lines 142, 293; file not touched).

### Rollout (dev cluster)
After push + promotion, a platform admin sets **Tenant storage → Configs → Public download endpoint = `https://admin.taphuynh.dev`** (no working tenant). The `hope-minio-presigned` IngressRoute already routes signed requests on that host.

## Change History
| Date | Change |
|---|---|
| 2026-10-02 | Ticket opened; OD-A (Vault locked), OD-B (env read-only), OD-C (everything else console-reachable). Plan written. |
| 2026-10-02 | Both lanes merged; three orchestrator fixes; gates + runtime verified locally. Status → Review. |

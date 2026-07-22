# Traceability — Admin Console

The Next.js 16 admin console (`apps/admin-console`, port 5176): the shared data-grid
infrastructure, the console chrome / account surfaces, the tier 50–59 playground, and the
**authoritative feature inventory** mapping every `apps/admin-console/src/features/*` directory
to the domain file that owns its capability rows (or marking it console-only chrome / shared).
Migrates legacy matrix row **37** and closes the Wave-1 "10+ console features have no matrix
home" gap by giving every feature a row here or an owning-file pointer.

Route paths for gateway calls are relative to `/api/v1`. Console routes are shown with their
route group → audience tier (rule 13: `(global)` = 10–19, `(shared)` = 20–29, `(tenant)` =
30–49, `playground` nested under `(tenant)` = 50–59 via a nav-level role check). Test shorthand
is defined in [`index.md`](./index.md#test-location-shorthand). `—` means verified-absent.

## Capabilities

### AC1 — Admin console data grids (personalized columns, typed filters, offset/cursor pagination) — legacy row 37

| Field | Value |
|---|---|
| App / service | `apps/admin-console` + `packages/ui` |
| Key modules | `packages/ui/src/components/data-grid` (`VirtualizedDataGrid`, `data-grid-faceted-filter`, `data-grid-pagination`, `data-grid-toolbar`, `data-grid-skeleton`); `apps/admin-console/src/shared/data` (`admin-data-grid.tsx`, `filter-bar.tsx`, `grid-persistence.ts`, `grid-url-state.ts`, `envelopes.ts`, `name-with-id.tsx`); filter bracket grammar in `packages/applications/src/common/paginatedQueryParamConverters.ts` |
| Prisma models | `UserSettings` (persisted grid layout under namespace `ui.data-grid/<gridId>`) |
| Key API endpoints | `GET/PATCH /user/me/settings` (layout persistence); list reads go through the existing `/admin/*` offset + cursor endpoints of each domain |
| Console | shared infrastructure consumed by every data-grid screen (tenants, users, audit-logs, queues, transcription-jobs, ...) — no route of its own |
| Tests | unit(ui): `packages/ui/src/components/data-grid/__tests__/*`; unit(console): `apps/admin-console/src/shared/data/__tests__/*`; e2e: `data-grid-filter-grammar.spec.ts` |

### AC2 — Account & tenant profile (self-service chrome)

| Field | Value |
|---|---|
| App / service | `apps/admin-console` (over `user/me/*` + `tenant/me*`) |
| Key modules | `apps/admin-console/src/features/account` (`account-screen`, `tenant-profile-screen`, `tenant-settings-tab`; `lib/config-categories`) |
| Prisma models | — (reads/writes via `GET/PATCH /user/me/{settings,preferences}` and `GET/PATCH /tenant/me/config` — see [`tenancy-provisioning.md`](./tenancy-provisioning.md)) |
| Console | routes `/account`, `/tenant-profile` (tier 20–29, shared) |
| Tests | unit(console): `account/components/__tests__/{account-screen,tenant-profile-screen,tenant-settings-tab}.test.tsx`, `account/lib/__tests__/config-categories.test.ts` |

### AC3 — SDK playground (tier 50–59)

The five playground screens ship under `(console)/(tenant)/playground/*`, gated at the nav level
by a role check (rule 13 — no route group of their own). Two of the five are backed by capability
rows in other files; the three below are console-only demo surfaces composing the SDK + backend
services.

| Field | Value |
|---|---|
| App / service | `apps/admin-console` + `@arcaai/vox` SDK (see [`sdk.md`](./sdk.md)) |
| Key modules | `apps/admin-console/src/features/playground-consultation` (`consultation-demo-screen`, `documentation-review-panel`), `playground-dna-style` (`my-dna-style-screen`, `generate-pane`, `impersonation-gate-panel`), `playground-llm` (`playground-llm-screen`, `providers-card`, `guardrails-tab`, `ner-tab`, `output-pane`), `playground-shared` (`playground-canvas`, `playground-persona-bar`, `persona-control`, `run-bar` — shared chrome) |
| Prisma models | — (console; composes consultation / summarization / DNA / SMR / guardrail / NLP gateway surfaces documented in their own domain files) |
| Console | routes `/playground/{consultation,dna-writing-style,llm}` (tier 50–59); `playground-shared` is cross-playground chrome with no route. `/playground/{live-transcription,voice-profiles}` are owned by [`transcription.md`](./transcription.md) |
| Tests | unit(console): `playground-consultation/components/__tests__/{consultation-demo-screen,documentation-review-panel}.test.tsx` + `api/__tests__/{client,streams}`; `playground-dna-style/components/__tests__/my-dna-style-screen.test.tsx` + `api/__tests__/*`; `playground-llm/components/__tests__/{playground-llm-screen,guardrails-tab,ner-tab}.test.tsx` + `api/__tests__/*`; `playground-shared/components/__tests__/{canvas,persona-control,playground-persona-bar}.test.tsx` |

## Console feature inventory

Every `apps/admin-console/src/features/*` directory, mapped to the domain file that owns its
capability rows (or marked console-only). "Owned here" = a capability row in AC1–AC3 above.

| Feature dir | Route(s) | Tier | Owning traceability file |
|---|---|---|---|
| `account` | `/account`, `/tenant-profile` | 20–29 | **admin-console.md** (AC2) |
| `agentic-policy` | `/agentic-policy` | 10–19 | [`harness.md`](./harness.md) (H6) |
| `agents` | `/agents` | 30–49 | [`summarization.md`](./summarization.md) |
| `ai-models` | `/ai-models` | 10–19 | [`ai-models-providers.md`](./ai-models-providers.md) |
| `ai-operations-metrics` | `/ai-operations/metrics` | 10–19 | [`ai-models-providers.md`](./ai-models-providers.md) (M7) |
| `ai-operations-runs` | `/ai-operations/runs` | 10–19 | [`ai-models-providers.md`](./ai-models-providers.md) (M7) |
| `ai-services` | `/ai-services` | 10–19 | [`platform-ops.md`](./platform-ops.md) (PO7) |
| `ai-task-defaults` | `/ai-configuration` | 30–49 | [`ai-models-providers.md`](./ai-models-providers.md) |
| `api-keys` | `/api-keys` | 20–29 | [`auth-identity.md`](./auth-identity.md) |
| `audio-pipelines` | `/audio/pipelines` | 30–49 | [`transcription.md`](./transcription.md) |
| `audit-logs` | `/audit-logs` | 10–19 | [`platform-ops.md`](./platform-ops.md) (PO1) |
| `auth` | `/login`, `/register`, `/reset-password`, `/verify-email` | (auth) | [`auth-identity.md`](./auth-identity.md) |
| `consultation-review` | `/consultation-review` | 30–49 | [`consultation.md`](./consultation.md) |
| `consultations` | `/consultations` | 30–49 | [`consultation.md`](./consultation.md) |
| `db-studio` | `/db-studio` (`/pstudio` redirects) | 10–19 | [`platform-ops.md`](./platform-ops.md) (PO6) |
| `departments` | `/departments` | 30–49 | [`tenancy-provisioning.md`](./tenancy-provisioning.md) (TP5) |
| `dna-writing-styles` | `/dna-writing-styles` | 30–49 | [`summarization.md`](./summarization.md) |
| `entitlements` | `/entitlements` | 10–19 | [`tenancy-provisioning.md`](./tenancy-provisioning.md) (TP3) |
| `harness-ops` | `/harness/workflows`, `/harness/observability` | 30–49 | [`harness.md`](./harness.md) (H2/H5) |
| `harness-policy` | `/harness/policy` | 30–49 | [`harness.md`](./harness.md) (H2) |
| `identity-providers` | `/identity-providers` | 30–49 | [`auth-identity.md`](./auth-identity.md) |
| `monitoring` | `/monitoring` | 10–19 | [`platform-ops.md`](./platform-ops.md) (PO4) |
| `pipeline-policy` | `/harness/pipeline-policy` | 30–49 | [`harness.md`](./harness.md) (H3) |
| `platform` | `/dashboard` | 10–19 | [`platform-ops.md`](./platform-ops.md) (PO4) |
| `playground-consultation` | `/playground/consultation` | 50–59 | **admin-console.md** (AC3) |
| `playground-dna-style` | `/playground/dna-writing-style` | 50–59 | **admin-console.md** (AC3) |
| `playground-live-transcription` | `/playground/live-transcription` | 50–59 | [`transcription.md`](./transcription.md) |
| `playground-llm` | `/playground/llm` | 50–59 | **admin-console.md** (AC3) |
| `playground-shared` | — (playground chrome) | 50–59 | **admin-console.md** (AC3) |
| `playground-voice-profiles` | `/playground/voice-profiles` | 50–59 | [`transcription.md`](./transcription.md) |
| `queues` | `/queues`, `/queues/[name]`, `/schedulers` | 10–19 | [`platform-ops.md`](./platform-ops.md) (PO5) |
| `rate-limits` | `/rate-limits` | 10–19 | [`platform-ops.md`](./platform-ops.md) (PO3) |
| `rbac` | `/rbac/roles`, `/rbac/policies` | 20–29 | [`auth-identity.md`](./auth-identity.md) |
| `settings` | `/settings` | 20–29 | [`tenancy-provisioning.md`](./tenancy-provisioning.md) (TP6) |
| `storage` | `/tenants/storage` | 10–19 | [`storage.md`](./storage.md) (S2) |
| `storage-browser` | `/storage` | 30–49 | [`storage.md`](./storage.md) (S3) |
| `tenant-tts-config` | `/tts-config` | 30–49 | [`tts.md`](./tts.md) (T3) |
| `tenants` | `/tenants`, `/tenants/[id]` | 10–19 | [`tenancy-provisioning.md`](./tenancy-provisioning.md) (TP1) |
| `tools-mcp` | `/tools-mcp` | 10–19 | [`harness.md`](./harness.md) (H7) |
| `transcription-jobs` | `/audio/transcription-jobs` | 30–49 | [`transcription.md`](./transcription.md) |
| `users` | `/users`, `/users/[id]` | 20–29 | [`tenancy-provisioning.md`](./tenancy-provisioning.md) (TP4) |

## Honest notes / gaps

- **The inventory is the coverage guarantee.** Every one of the 41 `features/*` directories appears exactly once above; no feature is rowless. The `(global)/dashboard` route is backed by the `platform` feature dir (`features/platform/components/platform-dashboard.tsx`), inventoried above and owned by [`platform-ops.md`](./platform-ops.md) (PO4).
- **Playground split.** Of the five tier-50–59 playground features, `playground-live-transcription` and `playground-voice-profiles` are owned by [`transcription.md`](./transcription.md) (they exercise real STT surfaces); the other three plus `playground-shared` are console-only demo surfaces owned in AC3.
- **`storage` vs `storage-browser`.** Both point at [`storage.md`](./storage.md) but are distinct features: `storage` is bucket/config/key administration (tier 10–19), `storage-browser` is the object data plane (tier 30–49).
- **No route of their own.** `playground-shared` (playground chrome) and the AC1 data-grid infrastructure have no console route; they are shared modules consumed by other features.

Last verified: 2026-07-22

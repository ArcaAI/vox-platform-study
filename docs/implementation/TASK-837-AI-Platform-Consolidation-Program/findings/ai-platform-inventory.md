# AI Platform Surface — Evidence-Based Inventory

Repo: `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2`, branch `dev-2.2`. Read-only audit — no files edited.

Authoritative route source: `apps/admin-console/src/shared/navigation/nav-config.ts`.

## Scope note (read this before the table)

Filtering `NAV_ENTRIES` for `domain === 'ai-platform'` (nav-config.ts:97,111) yields **14 entries**,
all confirmed by:

```
apps/admin-console/src/shared/navigation/nav-config.ts:238,248,261,293,311,328,337,349,358,367,376,388,406,795
```

Three routes named in the task's SCOPE list are **not** in the `ai-platform` domain, per the file itself:

| Route | Actual `domain` | Actual label | Evidence |
|---|---|---|---|
| `/rate-limits` | `platform-ops` | "Rate limits" | nav-config.ts:270-277 |
| `/credential-policy` | doesn't exist — the real route is `/security-policy`, `domain: 'identity-access'`, label "Credential policy" | nav-config.ts:283-290 |
| `/storage-browser` | doesn't exist — the real route is `/storage`, `domain: 'platform-ops'`, label "Storage browser" | nav-config.ts:579-588 |

Also: `/ai-model-defaults` (tenant) **no longer exists as a screen**. It is a `permanentRedirect('/ai-configuration')` stub (`apps/admin-console/src/app/(console)/(tenant)/ai-model-defaults/page.tsx`), confirmed dead by `nav-config.test.ts:128-130` (`expect(NAV_ENTRIES.some(e => e.route === '/ai-model-defaults')).toBe(false)`).

I have reported all 14 true `ai-platform` entries in full, and included `/rate-limits`, `/security-policy`, `/storage`, `/ai-model-defaults` as **adjacent** rows (flagged) since the task explicitly asked about them and they matter to Q2/Q4/Q5.

**Authorization signal is nearly uniform**: 13 of the 14 `ai-platform` entries (everything except `/ai-configuration`) are gated by the identical `required: [['manage', 'all']]` — the nav domain grouping carries no differentiating authorization information; every global AI-platform screen requires exactly the same ability.

---

## A. THE INVENTORY TABLE

Legend: **CONFORMS** = uses `ScreenTemplate` for the page frame and `DetailDrawer` (not a bespoke Sheet/Dialog) for any record create/edit surface. **DEVIATES** = bespoke Dialog/Sheet used for record create/edit instead of `DetailDrawer` (short confirmations in a `Dialog` are fine per `11-ux-ui-principles.md` §Dialogs & Modals and are not counted as deviations).

### 1. `/ai-models` — AI models

- **Files**: page `apps/admin-console/src/app/(console)/(global)/ai-models/page.tsx`; feature `apps/admin-console/src/features/ai-models/`
- **Tier / abilities**: `10-19` / `[['manage','all']]` (nav-config.ts:238-245)
- **Does**: Full CRUD grid over the platform's AI model catalog (name, provider, slug, taskType, capabilities), plus a "Discovery" drawer that live-probes LM Studio/Ollama through the TEXT service and lets an operator register a discovered-but-unregistered model. (`ai-models-screen.tsx:42-268`, `discovery-drawer.tsx`, `model-form-sheet.tsx`)
- **Endpoints**: `GET/POST admin/ai-models`, `GET admin/ai-models/list`, `GET admin/ai-models/:id`, `GET admin/ai-models/slug/:slug`, `PATCH admin/ai-models/:id` (If-Match OCC), `DELETE admin/ai-models/:id`, `GET admin/ai-models/discovery`, `POST admin/ai-models/discovery/register` (`ai-models/api/client.ts:7-52`)
- **Backend**: `AiModelAdminController` @ `admin/ai-models` (`apps/api/src/modules/ai-model/ai-model-admin.controller.ts:21-33`, gate `manage:all`), `AiModelDiscoveryController` (`ai-model-discovery.controller.ts:19-27`)
- **Prisma model**: `AiModel` (`packages/database/src/prisma/db_main/stt.prisma:114`)
- **Real/stub**: Real, full CRUD, no TODOs found.
- **Overlap**: `AiModel` rows are the picker source for `/ai-task-defaults`, `/ai-configuration` (Models tab), `/ai-runtime-profiles` (`modelSlug`), and MLflow's registry covers the *same conceptual space* (model inventory) but is a different, unrelated system (see Q2/assessment). `admin/ai-models/discovery` is also called (read-only) by `/ai-services/lm-studio` and `/ai-services/vllm`.
- **Template conformance**: `ScreenTemplate` (ai-models-screen.tsx:16,203). Record edit via `DetailDrawer` (`model-form-sheet.tsx:16,308`); discovery via `DetailDrawer` (`discovery-drawer.tsx:10,137`). **CONFORMS**.

### 2. `/ai-task-defaults` — AI task defaults (platform)

- **Files**: page `apps/admin-console/src/app/(console)/(global)/ai-task-defaults/page.tsx`; feature `apps/admin-console/src/features/ai-task-defaults/` (component `ai-task-defaults-platform-screen.tsx`)
- **Tier / abilities**: `10-19` / `[['manage','all']]` (nav-config.ts:248-255)
- **Does**: Edits the **SYSTEM-tenant** rows of 5 `AiTaskDefault` keys only — `guardrail.validate`, `guardrail.pii`, `guardrail.pii.spans`, `nlp.ner`, `nlp.classification` — i.e. the platform-default model every tenant inherits absent its own choice (`ai-task-defaults-platform-screen.tsx:1-104`, explicit `tenantId={SYSTEM_TENANT_ID}` on every `TaskDefaultCard`).
- **Endpoints**: `GET admin/ai-task-defaults?tenantId=`, `GET admin/ai-task-defaults?taskKey=&tenantId=`, `GET/PUT admin/ai-task-defaults/row?taskKey=&tenantId=`, `GET admin/ai-task-defaults/options?taskKey=` (`ai-task-defaults/api/client.ts:13-55`)
- **Backend**: `AiTaskDefaultAdminController` @ `admin/ai-task-defaults` (`apps/api/src/modules/ai-task-default/ai-task-default-admin.controller.ts:19-56`). Writes to `nlp.*`/`harness.*` keys are SUPER_ADMIN-only (service-enforced 403, `SUPER_ADMIN_ONLY_TASK_PREFIXES`); `guardrail.pii`/`guardrail.pii.spans` are SUPER_ADMIN-only by exact key.
- **Prisma model**: `AiTaskDefault`
- **Real/stub**: Real. Inline card editor per task key (`task-default-card.tsx`), no drawer needed (single-field model picker + save).
- **Overlap**: **Same controller, same Prisma model, same endpoint family as `/ai-configuration`'s "Models" tab** — only the `tenantId` differs (SYSTEM here vs. caller's working tenant there) and the key subset differs (5 SUPER_ADMIN keys here vs. `text.*`/other tenant-writable keys there, with the same 5 surfaced read-only there). See Q2.
- **Template conformance**: `ScreenTemplate` (ai-task-defaults-platform-screen.tsx:7,43). No drawer/dialog (inline card form). **CONFORMS**.

### 3. `/ai-runtime-profiles` — AI runtime profiles

- **Files**: page `.../(global)/ai-runtime-profiles/page.tsx`; feature `apps/admin-console/src/features/ai-runtime-profiles/`
- **Tier / abilities**: `10-19` / `[['manage','all']]` (nav-config.ts:261-268)
- **Does**: CRUD over the hyperparameter/capacity/timing plane keyed by `(provider, modelSlug)` — temperature, top_p, max_tokens, context_length, max/rpm/tpm concurrency, timeout, keep-alive, and a free-form `extraJson` (engine-specific knobs) — via a create/edit `DetailDrawer`; a "resolve" read shows the merged effective cascade. (`runtime-profiles-screen.tsx:140-258`, `runtime-profile-drawer.tsx`)
- **Endpoints**: `GET admin/ai-runtime-profiles`, `GET admin/ai-runtime-profiles/row?provider=&modelSlug=`, `GET admin/ai-runtime-profiles/resolve?...`, `PUT admin/ai-runtime-profiles/row` (If-Match OCC), `DELETE admin/ai-runtime-profiles/row` (`ai-runtime-profiles/api/client.ts:14-79`)
- **Backend**: `AiRuntimeProfileController` @ `admin/ai-runtime-profiles` (`apps/api/src/modules/ai-runtime-profile/ai-runtime-profile.controller.ts:31-114`)
- **Prisma model**: `AiRuntimeProfile` (`packages/database/src/prisma/db_main/ai-runtime-profile.prisma:16-57`) — `@@unique([tenantId, provider, modelSlug])`, SYSTEM-tenant-only rows, `modelSlug=""` sentinel for the provider-level default.
- **Real/stub**: Real. Shipped TASK-799 Phase 4 specifically because the 5 backend routes had shipped with **no console screen** for a period (comment at `ai-runtime-profiles/page.tsx:6-11`).
- **Overlap**: None with the other AI Platform screens' *writes* (own table), but its *consumer* is the exact same request path `TextRequestEnrichmentService` uses to enrich the TEXT `/generate` call — see Q3. `modelSlug` values reference `AiModel.slug` (no FK, house convention).
- **Template conformance**: `ScreenTemplate` (runtime-profiles-screen.tsx:14,173). `DetailDrawer` (runtime-profile-drawer.tsx:12,206). **CONFORMS**.

### 4. `/agentic-policy` — Agentic policy

- **Files**: page `.../(global)/agentic-policy/page.tsx`; feature `apps/admin-console/src/features/agentic-policy/`
- **Tier / abilities**: `10-19` / `[['manage','all']]` (nav-config.ts:293-300)
- **Does**: Three tabs — "Global default" (edits the SYSTEM-tenant GLOBAL-DEFAULT `HarnessPolicy` row: safety criteria, sensor thresholds, MCP-tools kill-switch, prompt tier — inherited by every tenant absent its own policy), "Engine kill-switch" (toggles the live-documentation engine on/off, a Redis-backed flag, not Prisma), "Agentic context" (reads the settings-registry catalog/one setting by key). (`agentic-policy-screen.tsx:39-139`)
- **Endpoints**: `GET/PATCH admin/harness/policy/global` (If-Match OCC), `GET/PATCH admin/harness/live/config`, `GET admin/settings/catalog`, `GET admin/settings/registry/:key` (`agentic-policy/api/client.ts:20-70`)
- **Backend**: `HarnessAdminController` @ `admin/harness` (`apps/api/src/modules/harness-admin/harness-admin.controller.ts:73-156,617-640`)
- **Prisma model**: `HarnessPolicy` (policy/global tab); `live/config` is a **Redis kill-switch** (`redis-flag` config tier per `09-infrastructure-devops.md`), not Prisma; settings-registry reads are `GlobalSetting`-backed.
- **Real/stub**: Real, working editor with OCC.
- **Overlap**: `HarnessPolicy` (SYSTEM row) is also the data `/ai-services` → "Instructions" tab *reads a projection of* (see below) — same underlying policy object, two different screens.
- **Template conformance**: `ScreenTemplate` (agentic-policy-screen.tsx:10,86,94,106). No drawer/dialog needed (inline tab forms). **CONFORMS**.

### 5. `/ai-services` — AI services

- **Files**: page `.../(global)/ai-services/page.tsx`; feature `apps/admin-console/src/features/ai-services/`
- **Tier / abilities**: `10-19` / `[['manage','all']]` (nav-config.ts:311-318)
- **Does**: Three READ-ONLY status tabs — "Guardrail" (proxied health + read-only medical-validation config), "NLP" (proxied health), "Instructions" (the tenant-resolved effective agentic instruction set — prompt tier, judge-prompt pin, sensor thresholds, safety criteria — described in the backend as "a READ PROJECTION OF the harness policy itself"). No writes anywhere on this screen. (`ai-services-screen.tsx:38-71`, `guardrail-panel.tsx`, `nlp-panel.tsx`, `instructions-panel.tsx`)
- **Endpoints**: `GET admin/ai-services/guardrail/status`, `GET admin/ai-services/guardrail/config`, `GET admin/ai-services/nlp/status`, `GET admin/agentic/instructions` (`ai-services/api/client.ts:13-36`)
- **Backend**: `AiServiceAdminController` @ `admin/ai-services` (guardrail/nlp — pure proxies to the Python services' own `/health` endpoints, `apps/api/src/modules/ai-service-admin/ai-service-admin.controller.ts:37-68`); `AgenticAdminController` @ `admin/agentic` for `instructions` (`apps/api/src/modules/agentic-admin/agentic-admin.controller.ts:33-45`, gated `@CanManage('HarnessPolicy')` — deliberately NOT its own subject, "the instructions document is not a separate resource — it is a READ PROJECTION OF the harness policy itself")
- **Prisma model**: none of its own for guardrail/nlp status (live upstream health documents, proxied verbatim); "Instructions" tab derives from `HarnessPolicy` (SYSTEM + tenant resolution).
- **Real/stub**: Real, but intentionally read-only (an ops status board, not a config editor).
- **Overlap**: "Instructions" tab and `/agentic-policy`'s "Global default" tab are two different views into the same `HarnessPolicy` concept (one edits the SYSTEM row, one shows the tenant-resolved effective projection). `guardrail/config` here vs. `/ai-configuration`'s guardrail model *selection* (via `AiTaskDefault`) are also two different facets of "guardrail configuration" living on two different screens.
- **Template conformance**: `ScreenTemplate` (ai-services-screen.tsx:6,38). No drawer/dialog (pure read tabs). **CONFORMS**.

### 6. `/ai-services/lm-studio` — LM Studio

- **Files**: page `.../(global)/ai-services/lm-studio/page.tsx`; feature `apps/admin-console/src/features/inference-engines/` (shared `EngineScreen` component, `provider="lm-studio"`)
- **Tier / abilities**: `10-19` / `[['manage','all']]` (nav-config.ts:328-335)
- **Does**: Three tabs — "Server" (reachability/health), "Models on server" (live model list from `admin/ai-models/discovery?provider=lm-studio`), "Artifacts in MinIO" (a **filtered, read-only** listing of the `hope-models` bucket for this engine's artifact prefix). READ-ONLY throughout — page-level comment: "the console reports engine state and never mutates the workload." (`engine-screen.tsx:187-334`, tabs at lines 214-216)
- **Endpoints**: `GET admin/ai-models/discovery?provider=`, `GET admin/providers/llm/:provider`, `GET storage/buckets/hope-models/files?prefix=` (`inference-engines/api/client.ts:30,41,52`)
- **Backend**: `AiModelDiscoveryController` (see #1); `AiProviderConnectionController` @ `admin/providers` (GET only from this screen — see Q4); `StorageController` @ `storage` (`apps/api/src/modules/storage/storage.controller.ts:52`)
- **Prisma model**: reads `AiModel` (via discovery), `AiProviderConnection` (status only), no MinIO/Prisma model of its own — object listing is live S3/MinIO, not a DB table.
- **Real/stub**: Real, deliberately read-only.
- **Overlap**: Same `admin/ai-models/discovery` endpoint as `/ai-models`'s discovery drawer; same `admin/providers/llm/:provider` resource that `/ai-configuration`'s Providers tab *writes*; same `storage/buckets/hope-models/files` family the generic `/storage` browser uses (with an explicit in-screen pointer: "Uploads are a storage operation — use the storage browser," `engine-screen.tsx:316`).
- **Template conformance**: `ScreenTemplate` (engine-screen.tsx:13,187). No drawer (nothing to edit). **CONFORMS**.

### 7. `/ai-services/vllm` — vLLM

- Same component (`EngineScreen`, `provider="vllm"`), same file, same endpoints, same everything as #6 except the `provider` prop and per-engine metadata in `engine-meta.ts`. (`.../(global)/ai-services/vllm/page.tsx`)
- **Tier / abilities**: `10-19` / `[['manage','all']]` (nav-config.ts:337-344)
- **Overlap**: Identical to #6 — this and LM Studio are the same screen twice, by design ("A SIBLING ROUTE... the two share one screen component," `vllm/page.tsx:9-16`).
- **Template conformance**: **CONFORMS** (identical to #6).

### 8. `/ai-services/mlflow` — MLflow

- **Files**: page `.../(global)/ai-services/mlflow/page.tsx`; feature `apps/admin-console/src/features/mlflow/`
- **Tier / abilities**: `10-19` / `[['manage','all']]` (nav-config.ts:349-356)
- **Does**: Read-only native proxy over MLflow's own REST verbs — tabs "Registered models," "Model versions," "Experiments," "Access & embedding." Explicitly the *external* model-registry-of-record for metadata/lineage; comment: "MLflow holds metadata and lineage; served weights live in the `hope-models` bucket" (`ai-service-admin.controller.ts:101-102`). (`mlflow-screen.tsx:231-401`)
- **Endpoints**: `GET admin/ai-services/mlflow/status`, `/registered-models`, `/model-versions`, `/experiments` (`mlflow/api/client.ts:15-34`)
- **Backend**: `AiServiceAdminController` (same controller as #5) via `MlflowProxyClient` — pure upstream pass-through, "Response shape is UPSTREAM-OWNED and passed through verbatim" (`ai-service-admin.controller.ts:89`).
- **Prisma model**: **None.** MLflow is an external tracking server; nothing here is HOPE's own database.
- **Real/stub**: Real, deliberately read-only, and deliberately NOT an iframe (comment: MLflow frame-denies by default and has no browser-reachable URL — this is a from-scratch native re-implementation of an MLflow viewer through the gateway).
- **Overlap**: Conceptually the same territory as `/ai-models` (both are "what models exist") but a **completely disjoint system** — no shared Prisma model, no cross-linking in the UI. This is a major source of the PO's "what is this for" confusion (see assessment).
- **Template conformance**: `ScreenTemplate` (mlflow-screen.tsx:14,231). No drawer (read-only). **CONFORMS**.

### 9. `/ai-operations/runs` — AI operations — runs

- **Files**: page `.../(global)/ai-operations/runs/page.tsx`; feature `apps/admin-console/src/features/ai-operations-runs/`
- **Tier / abilities**: `10-19` / `[['manage','all']]` (nav-config.ts:358-365)
- **Does**: Two tabs behind a `WorkingTenantGate` — "Trajectory" (session list → ordered step timeline per agentic session, with cancel/signal actions proxied to Temporal for HARNESS_DOC runs) and "Gate queue" (the clinician review queue). (`ai-operations-runs-screen.tsx:20-106`)
- **Endpoints**: `GET admin/agent-trajectory/sessions`, `GET admin/agent-trajectory/sessions/:id/steps`, `GET admin/harness/gate-queue`, `POST admin/harness/workflows/:id/cancel`, `POST admin/harness/workflows/:id/signal` (`ai-operations-runs/api/client.ts:20-43`)
- **Backend**: `AgentTrajectoryController` @ `admin/agent-trajectory` (`apps/api/src/modules/agent-trajectory/agent-trajectory.controller.ts:38-66`, gate `@CanRead('AgentTrajectory')`); `HarnessAdminController` (gate-queue/cancel/signal, same controller as #4)
- **Prisma model**: `AgentTrajectoryStep` (`packages/database/src/prisma/db_main/agent-trajectory.prisma:76` — "sessions" are a grouping of steps by `sessionId`, not a separate table); gate-queue/cancel/signal act on Temporal workflows via `HarnessOpsClient`, not Prisma directly from the gateway.
- **Real/stub**: Real.
- **Overlap**: **Identical data source to `/ai-operations/metrics`** — both read `admin/agent-trajectory/sessions`, `/steps`, and `admin/harness/gate-queue`. This screen is the raw session browser; metrics is the aggregated KPI dashboard over the same rows. Tenant-scoped (`WorkingTenantGate`) despite living at tier `10-19`.
- **Template conformance**: `ScreenTemplate` (ai-operations-runs-screen.tsx:9,67). Action confirmation via bespoke `Dialog` for "Signal workflow" (`signal-dialog.tsx:6,79`) — a short single-action confirmation with a payload field, judged an acceptable `Dialog` use per `11-ux-ui-principles.md` (not a record edit). **CONFORMS**.

### 10. `/ai-operations/metrics` — AI operations — metrics

- **Files**: page `.../(global)/ai-operations/metrics/page.tsx`; feature `apps/admin-console/src/features/ai-operations-metrics/`
- **Tier / abilities**: `10-19` / `[['manage','all']]` (nav-config.ts:367-374)
- **Does**: Read-only KPI dashboard behind `WorkingTenantGate` — median TTFT, avg tokens/s, regeneration rate, stop-reason histogram — all *derived/aggregated* from the same trajectory steps `/ai-operations/runs` browses raw. (`ai-operations-metrics-screen.tsx:1-196`)
- **Endpoints**: `GET admin/agent-trajectory/sessions`, `GET admin/agent-trajectory/sessions/:id/steps`, `GET admin/agent-trajectory/metrics/generation`, `GET admin/harness/gate-queue` (`ai-operations-metrics/api/client.ts:19-36`)
- **Backend**: Same `AgentTrajectoryController`/`HarnessAdminController` as #9, plus `GET admin/agent-trajectory/metrics/generation` (`agent-trajectory.controller.ts:47-63`, aggregates `GenerationStats` server-side).
- **Prisma model**: `AgentTrajectoryStep` (same table as #9).
- **Real/stub**: Real.
- **Overlap**: See #9 — same underlying data, different presentation. Explicitly documented as a sanctioned "super-admin screen over per-tenant data" instance in `13-nextjs-apps.md` §Sub-pattern (alongside `/ai-operations/runs` and the Instructions tab of `/ai-services`).
- **Template conformance**: `ScreenTemplate` (ai-operations-metrics-screen.tsx:10,159). No drawer (pure dashboard). **CONFORMS**.

### 11. `/ai-operations/consumption` — Consumption & cost

- **Files**: page `.../(global)/ai-operations/consumption/page.tsx`; feature `apps/admin-console/src/features/consumption-cost/`
- **Tier / abilities**: `10-19` / `[['manage','all']]` (nav-config.ts:376-383)
- **Does**: Read-only usage/cost dashboard behind `WorkingTenantGate` — usage summary, cost-per-encounter, top-tenants-by-usage — all metered-AI reporting. (`consumption-cost-screen.tsx:40-105`)
- **Endpoints**: `GET admin/usage/summary`, `GET admin/usage/cost-per-encounter`, `GET admin/usage/top-tenants` (`consumption-cost/api/client.ts:10-22`)
- **Backend**: `AdminUsageController` @ `admin/usage` (`apps/api/src/modules/admin-usage/admin-usage.controller.ts:38`, gate `@CanManage('UsageAnalytics')`), via `IUsageAnalyticsService`.
- **Prisma model**: usage-ledger rollups (`AiUsageRollupHourly`/`AiUsageRollupDaily`, `packages/database/src/prisma/db_main/usage-ledger.prisma:273,324`) and/or `AiUsageEvent` (:51) via the analytics service.
- **Real/stub**: Real.
- **Overlap**: Lives in the same backend **directory** as `/ai-operations/reconciliation` (`apps/api/src/modules/admin-usage/`) but a **different service and different Prisma model family** — `IUsageAnalyticsService` (internal reporting) vs. `IShadowMeteringService` (vendor-bill drift audit). Two screens under `/ai-operations/*` that sound adjacent are backed by unrelated logic.
- **★ Undocumented rule instance**: this screen ALSO wraps its body in `WorkingTenantGate` (`consumption-cost-screen.tsx:41-49`, description: "Metered AI consumption and cost are tenant-scoped. Pick a working tenant to view its usage.") — a 4th live instance of the "super-admin screen over per-tenant data" sub-pattern that `13-nextjs-apps.md` §Sub-pattern does **not** list (it names only `/ai-operations/runs`, `/ai-operations/metrics`, and the Instructions tab of `/ai-services`). The `top-tenants` panel is itself cross-tenant (per the client.ts comment) yet is trapped behind the same tenant-picker gate as the two tenant-scoped panels, since the gate wraps the whole screen body rather than per-panel.
- **Template conformance**: `ScreenTemplate` (consumption-cost-screen.tsx:12,65). No drawer (pure dashboard). **CONFORMS**.

### 12. `/ai-operations/reconciliation` — Provider reconciliation

- **Files**: page `.../(global)/ai-operations/reconciliation/page.tsx`; feature `apps/admin-console/src/features/reconciliation/`
- **Tier / abilities**: `10-19` / `[['manage','all']]` (nav-config.ts:388-395), explicitly **not** tenant-gated (platform-wide vendor bills)
- **Does**: Read-only audit trail of provider-reconciliation sweep runs + a "Run now" button. See **Q1** below for full mechanics.
- **Endpoints**: `GET admin/usage/reconciliation/runs`, `GET admin/usage/reconciliation/latest`, `POST admin/usage/reconciliation/run` (`reconciliation/api/client.ts:6-22`)
- **Backend**: `AdminReconciliationController` @ `admin/usage/reconciliation` (`apps/api/src/modules/admin-usage/admin-reconciliation.controller.ts:9-67`, gate `@CanManage('UsageAnalytics')`), via `IShadowMeteringService` / `ShadowMeteringService`.
- **Prisma model**: `ProviderReconciliationRun` (`packages/database/src/prisma/db_main/usage-ledger.prisma:384`).
- **Real/stub**: Real, fully wired end to end (trigger → sweep → persisted audit rows → screen).
- **Overlap**: Same backend directory as #11 (`admin-usage/`), unrelated Prisma model and service — see #11.
- **Template conformance**: `ScreenTemplate` (reconciliation-screen.tsx:16,81). No drawer (read-only + one action button). **CONFORMS**.

### 13. `/tools-mcp` — Tools & MCP

- **Files**: page `.../(global)/tools-mcp/page.tsx`; feature `apps/admin-console/src/features/tools-mcp/`
- **Tier / abilities**: `10-19` / `[['manage','all']]` (nav-config.ts:406-413)
- **Does**: Full CRUD grid over the registry of external MCP tool servers the clinical-documentation harness may call — name, base URL, transport, Vault-path `authRef` (never the secret itself), tool allow-list, PHI boundary flag, enabled kill-switch. See **Q6** below.
- **Endpoints**: `GET/POST admin/mcp-servers`, `GET admin/mcp-servers/:id`, `PATCH admin/mcp-servers/:id` (If-Match), `DELETE admin/mcp-servers/:id` (If-Match) (`tools-mcp/api/client.ts:12-38` — delete via the generic `request()` helper, `deleteMcpServer` at the bottom of the file)
- **Backend**: `McpAdminController` @ `admin/mcp-servers` (`apps/api/src/modules/mcp-admin/mcp-admin.controller.ts:15-45`)
- **Prisma model**: `McpServer` (`packages/database/src/prisma/db_main/mcp-server.prisma:31-60`) — a standard tenant-scoped, soft-deleted, OCC-versioned config model; SYSTEM-tenant-owned rows, SYSTEM-shared-read so every tenant's harness run can resolve a server it references.
- **Real/stub**: Real, full CRUD with OCC, not a stub.
- **Overlap**: None with the other 13 screens' Prisma models — this is a genuinely standalone resource, but see Q6 for why it still sits in this domain.
- **Template conformance**: `ScreenTemplate` (tools-mcp-screen.tsx:13,72,80,129). Create/edit uses a **bespoke `Dialog`**, not `DetailDrawer` — `mcp-server-form-dialog.tsx:6,277-309` (`<Dialog><DialogContent className="flex h-[70vh] flex-col sm:max-w-[50vw]">`). This is a full record create/edit form (name/URL/transport/authRef/allow-list/PHI-boundary/enabled), which per `11-ux-ui-principles.md` §Detail Surface belongs in the console-wide `DetailDrawer` ("Do NOT hand-roll a feature-specific Sheet for record detail. Dialogs stay for SHORT confirmations..."). **DEVIATES** (bespoke `Dialog` used for record create/edit instead of `DetailDrawer`).

### 14. `/ai-configuration` — AI Configuration (tenant)

- **Files**: page `apps/admin-console/src/app/(console)/(tenant)/ai-configuration/page.tsx`; feature `apps/admin-console/src/features/ai-task-defaults/` (component `tenant-ai-configuration-screen.tsx`)
- **Tier / abilities**: `30-49` / OR of `[['read','AiTaskDefault'],['read','TenantSttConfig'],['read','TenantTtsConfig'],['read','GlobalSetting']]` (nav-config.ts:795-805)
- **Does**: The single tenant AI hub, four tabs (`tenant-ai-configuration-screen.tsx:21-118`):
  - **Models** — tenant's own `text.*` summarization model selection (primary + fallback, one-action default-provider control) **plus** a read-only "effective models" table across every `AiTaskKey` (showing what the tenant inherits for the SUPER_ADMIN-only keys) **plus** a read-only `HarnessPolicy` summary card.
  - **Speech** — tenant STT fallback config (pipeline, auto-switch, failure threshold), OCC-edited. Backed by `TenantSttConfig`.
  - **Voice** — tenant TTS config (voices, routing, bindings), OCC-edited. Backed by `TenantTtsConfig`.
  - **Providers** — the one BYO cloud-credential editor (LLM/STT/TTS), backed by `AiProviderConnection` via `admin/providers/:service/:provider`. See Q4.
  Successor to the retired `/ai-model-defaults` screen (page comment, `ai-configuration/page.tsx:9-11`).
- **Endpoints**: Models tab reuses `admin/ai-task-defaults` (same as #2, tenant-scoped instead of SYSTEM); Speech/Voice tabs hit `tenant-stt-config`/`tenant-tts-config` feature APIs (not separately audited here — outside the `ai-platform` nav domain); Providers tab hits `admin/providers/:service/:provider` (`ai-providers/api/client.ts:15,26-44`).
- **Backend**: `AiTaskDefaultAdminController` (Models tab, tenant-scoped via `resolveScopedTenantId`); `AiProviderConnectionController` @ `admin/providers` (Providers tab, PUT/DELETE, `apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts:62`); Speech/Voice tabs' own controllers (`tenant-stt-config`, `tenant-tts-config` modules) not detailed here.
- **Prisma model**: `AiTaskDefault` (Models), `TenantSttConfig` (Speech), `TenantTtsConfig` (Voice), `AiProviderConnection` (Providers).
- **Real/stub**: Real, working, consolidates three formerly-standalone retired screens (`/stt-config`, `/tts-config`, `/ai-providers` — none present in current `nav-config.ts`).
- **Overlap**: Models tab = same controller/model as `/ai-task-defaults` (#2), different tenant scope. Providers tab = the **only** write path for `AiProviderConnection`; `/ai-services/lm-studio` and `/ai-services/vllm` (#6/#7) read the same resource read-only.
- **Template conformance**: `ScreenTemplate` (tenant-ai-configuration-screen.tsx:8,62). Wrapped in `WorkingTenantGate` + `TenantScopeBanner` (correct tier-30-49 posture). No dedicated drawer at the hub level; the sub-tabs' own edit surfaces were not individually audited (outside domain scope) except Providers, which is inline tab content, not a drawer/dialog. **CONFORMS** at the screen-frame level.

---

### Adjacent rows (asked about in SCOPE, but NOT `domain: 'ai-platform'`)

### 15. `/rate-limits` — Rate limits (`domain: 'platform-ops'`)

- **Files**: page `.../(global)/rate-limits/page.tsx`; feature `apps/admin-console/src/features/rate-limits/`
- **Tier / abilities**: `10-19` / `[['manage','all']]` (nav-config.ts:270-277)
- **Does**: Four tabs — Policy (enable/disable + per-tier overrides), Rules (create/edit/delete `RateLimitRule` rows — tenant×route, tenant, or platform×route precedence), Plans (view/edit per-entitlement-plan baseline), Explain (dry-run "what would this route/tenant be limited to" tool). (`rate-limits-screen.tsx:373-536`, tabs at 391-394)
- **Endpoints**: `GET/PUT admin/rate-limit`, `PUT admin/rate-limit/enabled`, `PUT admin/rate-limit/tiers/:tier`, `PUT admin/rate-limit/routes/:routeId`, `GET/POST admin/rate-limit/rules`, `DELETE admin/rate-limit/rules/:id`, `GET admin/rate-limit/routes`, `GET admin/rate-limit/explain`, `GET admin/rate-limit/plans`, `PATCH admin/rate-limit/plans/:plan` (`rate-limits/api/client.ts:19-85`)
- **Backend**: `RateLimitAdminController`-family @ `admin/rate-limit` (`apps/api/src/modules/admin-rate-limit/rate-limit-admin.controller.ts`)
- **Prisma model**: `RateLimitRule` (`packages/database/src/prisma/db_main/rate-limit.prisma:29`) for Rules; tier/enabled baselines are `GlobalSetting` rows (`rate-limit.*` namespace, `packages/applications/src/services/rate-limit/rate-limit.constants.ts`); Plans reads `PlanEntitlement`/`TenantEntitlement`.
- **Real/stub**: Real, full CRUD.
- **Template conformance**: `ScreenTemplate` (rate-limits-screen.tsx:23,373). Record create/edit via **bespoke `Dialog`s**, not `DetailDrawer`: `RuleDialog`/`EditRuleDialog` (`rate-limit-rules-panel.tsx:45,87,183,209`), `PlanDialog` (`rate-limit-plans-panel.tsx:28,62`), `OverrideDialog` (`rate-limits-screen.tsx:55,82`). All four edit a persisted multi-field resource, not a short confirmation. **DEVIATES**.

### 16. `/security-policy` ("Credential policy") — `domain: 'identity-access'`

- **Files**: page `.../(global)/security-policy/page.tsx`; feature `apps/admin-console/src/features/security-policy/`
- **Tier / abilities**: `10-19` / `[['manage','all']]` (nav-config.ts:283-290)
- **Does**: One inline form — password min length/rotation window/character-class requirements + machine-secret entropy — read/write as a single object. (`security-policy-screen.tsx:83-118`)
- **Endpoints**: `GET/PUT admin/security/policy` (`security-policy/api/client.ts:6-14`)
- **Backend**: `SecurityPolicyController` @ `admin/security/policy` (`apps/api/src/modules/security-policy/security-policy.controller.ts:29-33`) — explicitly a **facade over 8 `GlobalSetting` keys** ("a credential policy is only meaningful as a whole... rather than reconstruct it from eight reads"). SUPER_ADMIN-only enforced imperatively (all 8 keys are `globalOnly` descriptors), not by the `@CanManage('GlobalSetting')` decorator itself.
- **Prisma model**: `GlobalSetting` (8 rows).
- **Real/stub**: Real.
- **Template conformance**: `ScreenTemplate` (security-policy-screen.tsx:16,107,144). Inline form, no drawer/dialog needed. **CONFORMS**.

### 17. `/storage` ("Storage browser") — `domain: 'platform-ops'`, tier `30-49`

- **Files**: page `apps/admin-console/src/app/(console)/(tenant)/storage/page.tsx`; feature `apps/admin-console/src/features/storage-browser/`
- **Tier / abilities**: `30-49` / `[['read','Storage'],['manage','Storage']]` (nav-config.ts:579-588)
- **Does**: Generic MinIO/S3 bucket + object browser and manager — list/create/update/delete buckets, list/upload/download/delete objects — tenant-scoped via the working-tenant header. See **Q5**.
- **Endpoints**: `GET/POST storage/buckets`, `GET/PATCH/DELETE storage/buckets/:name`, `GET storage/buckets/:name/files?prefix=`, `GET/DELETE storage/buckets/:name/files/:key`, `GET storage/health` (`storage-browser/api/client.ts:36-82`)
- **Backend**: `StorageController` @ `storage` (`apps/api/src/modules/storage/storage.controller.ts:52`) — same controller family the LM Studio/vLLM "Artifacts" tabs read from.
- **Prisma model**: bucket metadata is `StorageBucket`-shaped config (per `tenant-bucket`/`tenant-storage-config` modules); objects themselves are live MinIO/S3 listings, not a Prisma table.
- **Real/stub**: Real, full CRUD.
- **Template conformance**: `ScreenTemplate` (storage-browser-screen.tsx:12,95). `ObjectDetailDrawer` uses `DetailDrawer` correctly (`object-detail.tsx:3,26`). **CONFORMS**.

---

## B. ANSWERS TO Q1–Q6

### Q1 — What is "Provider reconciliation"?

**It is a billing/usage drift auditor between HOPE's own internal metering ledger and each cloud vendor's own usage/cost report — NOT a model-catalog diff.** It has nothing to do with `AiModel` rows or a provider's live model list.

- **The two sources of truth it compares** (`packages/applications/src/services/metering/reconciliation/shadow-metering.service.ts:265-345`, method `reconcileProviders`):
  1. **The internal ledger control total** — `this.cloudLedgerControlTotal(reconciler.provider, window)` (line 279), aggregated from HOPE's own usage tables, filtered to `deployment: CLOUD` only (BYOK/self-hosted usage is explicitly excluded — rule 2 in the doc comment at lines 252-262).
  2. **The vendor's own control total** — `reconciler.fetchControlTotal(window.start, window.end)` (line 280), one adapter per cloud provider in `provider-reconciler-registry.ts`, gated on (a) whether a client is implemented and (b) whether a read-only usage/cost credential is present in Vault kv-v2 (`provider-reconciler-registry.ts:1-29`). Only a **platform-wide, org-level** total is ever requested — "No cloud vendor exposes per-tenant cost" (line 22).
  - `computeDrift(...)` (imported from `./drift-math`) compares the two and flags `breachesThreshold` (line 288).
- **Who triggers it**: an operator via `POST admin/usage/reconciliation/run` — the screen's "Run now" button (`reconciliation-screen.tsx:76-79`) — OR a self-scheduling cron that ships **OFF by default** (`shadow-metering.service.ts:49-58`, `SHADOW_METERING_ENABLED_KEY`). The controller doc comment confirms: "Provided because the scheduled sweep ships OFF, so without it the audit trail stays empty until an operator enables the cron" (`admin-reconciliation.controller.ts:55-58`).
- **What it writes**: `persistRuns(results)` (`shadow-metering.service.ts:345,381-390`) creates a `ProviderReconciliationRun` row per (provider, window) attempt via `ProviderReconciliationRunFactory` — **every** attempt, including `skipped` (no credential/client) and `failed` (transport error), because "the gap is the point" (controller comment, `admin-reconciliation.controller.ts:34`). It is explicitly **alert-only and never writes to the ledger**: "Alert, never auto-correct (rule 5). A breach emits; nothing writes to the ledger. The ledger is append-only and is corrected by a compensating event, never by a reconciler deciding the vendor is right" (`shadow-metering.service.ts:258-262`; the screen's status footer echoes this verbatim: `reconciliation-screen.tsx:107-110`).
- **Prisma model**: `ProviderReconciliationRun` (`packages/database/src/prisma/db_main/usage-ledger.prisma:384`), SYSTEM-tenant-owned platform rows.
- **Read-only surface**: there is deliberately no create/edit/delete route on the run trail itself — "the trail is the control that answers an invoice dispute, and one that can be rewritten after the fact answers nothing" (`admin-reconciliation.controller.ts:12-14`).

### Q2 — `/ai-models` vs. `/ai-model-defaults` (retired) vs. `/ai-task-defaults` vs. `/ai-configuration`

| Screen | Prisma model | Scope | What it actually is |
|---|---|---|---|
| `/ai-models` (global, 10-19) | `AiModel` | Platform-wide catalog | The **inventory of servable models** — provider, slug, taskType, capabilities. This is the picker source everything else selects *from*. Full CRUD + live-discovery register. |
| `/ai-model-defaults` (tenant, 30-49) | — | **RETIRED** | A dead-end screen that is now a `permanentRedirect('/ai-configuration')` (`ai-model-defaults/page.tsx:1-12`). Confirmed gone from `NAV_ENTRIES` by `nav-config.test.ts:128-130`. |
| `/ai-task-defaults` (global, 10-19) | `AiTaskDefault` | SYSTEM-tenant rows, 5 specific task keys (`guardrail.validate`, `guardrail.pii`, `guardrail.pii.spans`, `nlp.ner`, `nlp.classification`) | Edits the **platform-default** "which model backs task X" binding for the SUPER_ADMIN-only keys — what every tenant inherits absent its own opinion (`ai-task-defaults-platform-screen.tsx:12-14`). |
| `/ai-configuration` (tenant, 30-49) | `AiTaskDefault` (Models tab) + `TenantSttConfig` + `TenantTtsConfig` + `AiProviderConnection` | Caller's working tenant | A **4-tab hub**: Models tab is the tenant's OWN writable `text.*` selection plus a read-only view of the effective (tenant-or-SYSTEM-resolved) value for every other `AiTaskKey`, including the 5 keys `/ai-task-defaults` edits. Speech/Voice/Providers tabs are unrelated resources folded in for "one authoritative editor per resource" reasons. |

**Where they overlap**: `/ai-task-defaults` and the **Models tab of `/ai-configuration`** are the **same backend controller** (`AiTaskDefaultAdminController` @ `admin/ai-task-defaults`, `apps/api/src/modules/ai-task-default/ai-task-default-admin.controller.ts`) and the **same Prisma model** (`AiTaskDefault`). The only difference is the `tenantId` the write targets (SYSTEM vs. caller tenant, via `resolveScopedTenantId`, line 17) and which task-key prefixes each screen's UI happens to expose (the controller comment at lines 32-41 spells out exactly which key groups are writable from where: `nlp.*`/`harness.*`/`guardrail.pii*` = SUPER_ADMIN-only i.e. `/ai-task-defaults`; `text.*` and `guardrail.validate`/`guardrail.safety`/`guardrail.groundedness` = tenant-writable i.e. `/ai-configuration`). **This is one resource split across two screens by tenant scope, not two different resources** — which is exactly the kind of thing that reads as "two screens do the same thing" to a PO scanning the nav rail.

### Q3 — What is an "AI runtime profile"?

- **The model**: `AiRuntimeProfile` (`packages/database/src/prisma/db_main/ai-runtime-profile.prisma:16-57`) — one row per `(tenantId, provider, modelSlug)`, SYSTEM-tenant-only in practice. `modelSlug = ""` is a sentinel meaning "provider-level default" (deliberately not `null`, to keep the compound unique index sane under Postgres NULL semantics — comment at lines 5-9).
- **The fields**: `temperature`, `topP`, `maxTokens`, `contextLength` (n_ctx for GGUF engines / request budget for API engines), `maxConcurrent`, `tpmLimit`, `rpmLimit`, `timeoutS`, `keepAliveSeconds`, and an engine-specific `extraJson` blob (`n_threads`, `n_gpu_layers`, `num_predict`, etc.). All numeric fields are nullable = "no opinion, fall through the cascade" (schema comment, line 12).
- **The cascade**: "explicit request params → `AiTaskDefault.configJson` → profile(modelSlug) → profile(provider default, "") → service env default" (schema header comment, lines 11-12). `GET admin/ai-runtime-profiles/resolve` (`ai-runtime-profile.controller.ts:64-77`) is a debug read that shows exactly this merge.
- **Who consumes it at runtime**: `TextRequestEnrichmentService.applyTextRuntimeProfile()` (`packages/applications/src/services/text-request/text-request-enrichment.service.ts:216-249`), called from `TextProxyController` (the gateway's proxy for `apps/text`'s `/generate`) and the prompt-template test bench. It calls `aiRuntimeProfileService.resolveProfile(provider, model)` and injects `temperature`/`top_p`/`max_tokens`/`context_length`/`timeout_s`/`keep_alive_seconds`/`extra` into the outgoing body **only for fields the caller did not already set** ("CALLER WINS", line 208) and **fails open** on any resolver error ("FAIL-OPEN... the request proceeds on the service's own env defaults," lines 209, 240-247). Model **identity** (which model to call) is deliberately NOT this service's concern — that comes from `HarnessPolicyService` or `IAiTaskDefaultService` depending on caller (comment, lines 20-22).
- In short: `/ai-runtime-profiles` is the console screen for a hyperparameter/capacity/timing injection plane that sits **downstream of** model selection (`AiTaskDefault`/`AiModel`) and is consumed exactly once, at the TEXT-proxy boundary.

### Q4 — Provider credential configuration: how many places, today?

**Exactly one place actually writes a credential-bearing connection: `/ai-configuration` → "Providers" tab** (`features/ai-providers/components/provider-credentials-tabs.tsx`), via `PUT/DELETE admin/providers/:service/:provider` → `AiProviderConnectionController` (`apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts:62`) → `AiProviderConnection` (`packages/database/src/prisma/db_main/ai-provider-connection.prisma:51`).

Two OTHER screens **read** the same resource but never write it:
- `/ai-services/lm-studio` and `/ai-services/vllm` call `GET admin/providers/llm/:provider` only (`inference-engines/api/client.ts:41`) — no `PUT`/`DELETE` anywhere in that client file. Page comment confirms: "READ-ONLY: the console reports engine state and never mutates the workload" (`lm-studio/page.tsx:8`).

`/ai-models`'s create/edit form (`model-form-sheet.tsx`) has **no** credential/apiKey/secret field at all — `AiModel` is catalog metadata, not a credential holder.

So: **1 write surface, 2 read-only mirrors of the same table, 0 credential fields anywhere else in the domain.**

### Q5 — Is there a Model Store screen (MinIO/S3 files)?

There is **no dedicated "model store" screen inside the `ai-platform` domain.** What exists:

1. **`/storage` ("Storage browser")** — `domain: 'platform-ops'`, tier `30-49` (nav-config.ts:579-588) — the **generic** tenant-scoped MinIO/S3 bucket + object browser/manager (list/create/delete buckets; list/upload/download/delete objects), backed by `StorageController` @ `storage`. This is the only place uploads/deletes of model weight files actually happen.
2. Inside `/ai-services/lm-studio` and `/ai-services/vllm` (domain `ai-platform`), a third tab **"Artifacts in MinIO"** shows a **read-only, prefix-filtered** listing of one fixed bucket, `hope-models` (`inference-engines/api/client.ts:15,22,52` — `MODEL_ARTIFACT_BUCKET = 'hope-models'`), via the exact same `storage/buckets/:name/files` endpoint `/storage` uses. It explicitly defers uploads to the real browser: "Uploads are a storage operation — use the storage browser" (`engine-screen.tsx:316`).
3. `hope-models` is a real, infra-provisioned bucket (MinIO policies at `infrastructure/docker/minio/policies/hope-models-reader.json` / `hope-models-publisher.json`, referenced in `infrastructure/docker/docker-compose.yml`), not something conjured client-side.
4. Separately, `/ai-services/mlflow` is a metadata/lineage registry (experiment/run/version tracking) — explicitly **not** the file store: "MLflow holds metadata and lineage; served weights live in the `hope-models` bucket" (`ai-service-admin.controller.ts:101-102`).

So today an operator wanting to see actual `.gguf`/weight files has to know to either open the generic `/storage` browser and navigate to the `hope-models` bucket by hand, or open the *specific* engine screen (LM Studio/vLLM) to see a pre-filtered view of the same bucket — there is no unified "Model Store" screen tying `AiModel` (catalog row) ↔ MLflow (lineage) ↔ `hope-models` bucket (actual bytes) together.

### Q6 — What is `/tools-mcp` today?

**A real, working, full-CRUD registry — not a stub.** It manages `McpServer` rows: the external MCP (Model Context Protocol) tool servers the clinical-documentation harness (`apps/harness`) is allowed to call out to over the streamable-HTTP MCP transport, as part of the "Agentic SOTA Program, Phase 5" (schema header, `packages/database/src/prisma/db_main/mcp-server.prisma:2-3`).

- **Real model, real fields**: `name`, `description`, `baseUrl`, `transport` (currently only `"streamable-http"` supported), `authRef` (a **Vault path only** — "NEVER secret material — the harness resolves the actual token from Vault at call time," schema lines 44-46), `toolAllowlist` (JSON array), `phiBoundary` (`"external"` default / `"in-boundary"` — governs whether the harness's PHI-egress guard screens outbound tool args fail-closed), and an `enabled` per-server kill-switch (schema lines 26-31, 47-52).
- **Real backend**: `McpAdminController` @ `admin/mcp-servers` (`apps/api/src/modules/mcp-admin/mcp-admin.controller.ts:15-45`) with full `GET`/`GET :id`/`POST`/`PATCH :id`/`DELETE :id`, `If-Match` OCC on writes, WRITES SUPER_ADMIN-only (service-enforced 403), reads SYSTEM-shared so every tenant's harness run can resolve a server it references.
- **Real console screen**: `tools-mcp-screen.tsx` — full data-grid CRUD (create/edit/delete buttons wired to mutations, `tools-mcp-screen.tsx:103-113,135-165,210-215`).
- **Caveat**: the schema itself documents that write-capable MCP tool invocation is deliberately unimplemented — "All tools are READ-ONLY in this ticket (write-capable MCP is a future ticket behind an explicit human-approval-gate design)" (schema, line 29) — meaning the *registry* is fully real, but the harness's actual *use* of these servers is currently read-only tool calls by design, not that the console screen is a stub.

---

## C. OVERLAP MAP (grouped by shared backend resource)

1. **`AiTaskDefault`** (3 screens): `/ai-task-defaults` (SYSTEM-tenant, 5 SUPER_ADMIN keys, full write) · `/ai-configuration` → Models tab (caller tenant, `text.*`+`guardrail.validate/safety/groundedness` writable, all 17 `AiTaskKey`s readable) · `/ai-models` is the picker source both select from (not itself writing `AiTaskDefault`, but load-bearing to both — the "Manage models" button on `/ai-task-defaults` links directly to `/ai-models`, `ai-task-defaults-platform-screen.tsx:52-58`).

2. **`AgentTrajectoryStep`** (2 screens, same rows, different lens): `/ai-operations/runs` (raw session/step browser + cancel/signal) · `/ai-operations/metrics` (aggregated KPIs: TTFT, tok/s, regen rate) — both call `GET admin/agent-trajectory/sessions`, `/steps`, and `GET admin/harness/gate-queue`.

3. **`HarnessPolicy`** (3 surfaces, 2 screens): `/agentic-policy` → "Global default" tab (writes the SYSTEM row) · `/ai-services` → "Instructions" tab (reads a tenant-resolved *projection* of the same policy: prompt tier, judge pin, thresholds, safety criteria) · `/ai-configuration` → Models tab's `EffectiveHarnessPolicyCard` (a third, read-only view of the same policy).

4. **`AiProviderConnection`** (3 screens, 1 write path): `/ai-configuration` → Providers tab (the only `PUT`/`DELETE`) · `/ai-services/lm-studio` and `/ai-services/vllm` (both `GET`-only, via `admin/providers/llm/:provider`).

5. **`admin-usage` module, 2 unrelated Prisma families sharing one backend directory**: `/ai-operations/consumption` (usage rollups: `AiUsageRollupHourly`/`AiUsageRollupDaily`/`AiUsageEvent`, via `IUsageAnalyticsService`) and `/ai-operations/reconciliation` (`ProviderReconciliationRun`, via `IShadowMeteringService`) — co-located in `apps/api/src/modules/admin-usage/` but functionally disjoint.

6. **`hope-models` MinIO bucket** (3 access points, 1 storage resource): `/storage` (full CRUD, generic) · `/ai-services/lm-studio` "Artifacts in MinIO" tab (read-only, prefix-filtered) · `/ai-services/vllm` "Artifacts in MinIO" tab (read-only, prefix-filtered) — all three call the same `storage/buckets/:name/files` endpoint family.

7. **`AiModel`** (4+ touchpoints, 1 owning screen): `/ai-models` (full CRUD + discovery/register) is the only writer. `/ai-task-defaults`, `/ai-configuration` (Models tab), and `/ai-runtime-profiles` all reference `AiModel.slug` as a foreign value (no FK, "house slug-reference convention") without owning it. `/ai-services/lm-studio` and `/ai-services/vllm` call the same `admin/ai-models/discovery` endpoint the `/ai-models` discovery drawer uses.

8. **`GlobalSetting`** (3 screens, disjoint key namespaces, same table): `/security-policy` (8 `security.*`-family keys, facaded as one object) · `/rate-limits` (`rate-limit.*` tier-baseline keys) · `/agentic-policy` "Agentic context" tab (reads via `admin/settings/catalog`/`registry/:key`, the generic settings-registry surface all of the above ultimately sit on top of).

9. **Conceptually adjacent, technically disjoint "what models exist" screens** (no shared Prisma model, but the same subject matter to a reader of the nav rail): `/ai-models` (HOPE's own routing catalog, `AiModel`) vs. `/ai-services/mlflow` (external lineage/metadata registry, zero Prisma model, pure proxy) vs. `/ai-services/lm-studio` + `/ai-services/vllm` "Models on server" tabs (live engine-reported model lists, via `admin/ai-models/discovery`).

---

## D. TEMPLATE CONFORMANCE

Counting the 14 true `ai-platform`-domain screens plus the 3 adjacent rows explicitly asked about (17 total):

- **`ScreenTemplate` usage**: 17 / 17 CONFORMS. Every screen audited imports and wraps its page frame in `ScreenTemplate` (`@/shared/page/screen-template`). No hand-rolled page frame found anywhere in this domain.
- **`DetailDrawer` vs. bespoke Dialog/Sheet for record create/edit**: **15 CONFORMS / 2 DEVIATES**.

**DEVIATES list**:

| Screen | What deviates | Evidence |
|---|---|---|
| `/tools-mcp` | MCP-server create/edit is a bespoke `Dialog` (`mcp-server-form-dialog.tsx`), not `DetailDrawer` | `mcp-server-form-dialog.tsx:6,277-309` |
| `/rate-limits` | Rate-limit rule create/edit (`RuleDialog`/`EditRuleDialog`), plan edit (`PlanDialog`), and tier/route override edit (`OverrideDialog`) are all bespoke `Dialog`s, not `DetailDrawer` | `rate-limit-rules-panel.tsx:45,87,183,209`; `rate-limit-plans-panel.tsx:28,62`; `rate-limits-screen.tsx:55,82` (adjacent, `platform-ops` domain, included because it was in SCOPE) |

Every other create/edit surface found in this domain (`/ai-models` — `model-form-sheet.tsx` + `discovery-drawer.tsx`; `/ai-runtime-profiles` — `runtime-profile-drawer.tsx`; `/storage` — `object-detail.tsx`'s `ObjectDetailDrawer`) correctly uses `DetailDrawer`. Screens with no create/edit surface at all (read-only dashboards/status boards: `/ai-services`, `/ai-services/mlflow`, `/ai-services/lm-studio`, `/ai-services/vllm`, `/ai-operations/metrics`, `/ai-operations/consumption`, `/ai-operations/reconciliation`) or with a single inline form on the page body itself (`/security-policy`, `/agentic-policy`, `/ai-task-defaults`'s per-key cards) need no drawer and are counted CONFORMS by default (no violation possible).

`/ai-operations/runs`' `signal-dialog.tsx` (a `Dialog` for the single "signal workflow" action) is judged an acceptable `Dialog` use — a short, single action with a payload field, not a persisted-record edit form — per `11-ux-ui-principles.md` §Dialogs & Modals's carve-out for short confirmations.

---

## E. DEAD/STUB LIST

**None of the 14 `ai-platform`-domain screens are stubs.** All 14 nav entries carry `implemented: true` (confirmed by direct read of every entry, nav-config.ts:238-407, 795-806), and a repo-wide grep for `TODO|not yet implemented|coming soon|placeholder only|NotImplementedException` across all 14 feature directories returned zero hits.

The only genuinely dead artifact touching this surface is the **retired `/ai-model-defaults` redirect page** (`apps/admin-console/src/app/(console)/(tenant)/ai-model-defaults/page.tsx`) — not a screen anymore, just a one-line `permanentRedirect('/ai-configuration')` kept alive "for one release" per its own comment, and explicitly asserted absent from `NAV_ENTRIES` by `nav-config.test.ts:128-130`. It was in the task's SCOPE list as if it were a live tenant screen; it is not.

Three screens are **deliberately read-only** rather than incomplete — worth distinguishing from a stub: `/ai-services` (guardrail/nlp/instructions status), `/ai-services/mlflow`, `/ai-services/lm-studio`, `/ai-services/vllm` (engine health + discovery + artifact listing). Each carries an explicit code comment stating the read-only posture is intentional, not a missing write path.

---

## F. ASSESSMENT — why this surface reads as chaotic (5 points)

1. **One ability gates thirteen different resources.** 13 of the 14 `ai-platform` screens (everything except `/ai-configuration`) share the exact same `required: [['manage', 'all']]` gate (nav-config.ts, every entry from line 238 to 406). The nav domain and the authorization model carry zero correlated information — a screen's presence in "AI Platform" tells you nothing about what it reads, writes, or who else can touch the same data. Grouping-by-label is the only organizing principle left, and the labels ("AI models" / "AI task defaults" / "AI Configuration" / "AI runtime profiles") are similar enough to be genuinely confusable even to someone who built the system, which is exactly the PO's complaint.

2. **One resource, `AiTaskDefault`, is split across two nav entries by tenant scope alone**, with no in-UI signal that they are the same table (Q2). A user has to already know the tenant-vs-SYSTEM cascade to understand why editing "AI task defaults" (global) and "AI Configuration → Models" (tenant) both change what a `guardrail.pii` lookup resolves to. The platform-tier screen even needs a "Manage models" escape-hatch link back to `/ai-models` (`ai-task-defaults-platform-screen.tsx:52-58`) because the three concepts — catalog (`AiModel`), binding (`AiTaskDefault`), and hyperparameters (`AiRuntimeProfile`) — are three separate screens with no visual thread connecting them.

3. **"Model" means at least four unrelated things in this one nav domain**: HOPE's own routing catalog (`/ai-models` → `AiModel`), an external metadata/lineage system with zero shared schema (`/ai-services/mlflow`, pure proxy, no Prisma model at all), a live engine-reported inventory (`/ai-services/lm-studio`+`/vllm` "Models on server" tabs, via discovery), and raw weight files in a bucket (`hope-models`, surfaced piecemeal in both `/storage` and the two engine screens' "Artifacts" tabs). None of these four cross-link to each other in the UI (Q5), so "what is the model store" has four plausible, mutually inconsistent answers depending which screen you happened to open — this is precisely the confusion the PO is reporting, just one level up from "Provider reconciliation."

4. **Similar-sounding neighbours are backed by unrelated services with no shared code**, purely by nav-label proximity: `/ai-operations/consumption` and `/ai-operations/reconciliation` sit in the same URL family and the same backend directory (`admin-usage/`) but are `IUsageAnalyticsService` (internal reporting) vs. `IShadowMeteringService` (vendor-bill drift auditor) — genuinely different tools that happen to both touch "usage." "Provider reconciliation" itself is the sharpest case: its label reads like a model-catalog concept ("reconcile the provider's models") but it is actually a billing auditor (Q1) — the name collides with `AiProviderConnection` (credentials) and `AiModel.provider` (catalog field) without being either.

5. **The `DetailDrawer`/`Dialog` convention is inconsistently applied even within this one domain** (§D): `/ai-models` and `/ai-runtime-profiles` do full-record CRUD correctly through `DetailDrawer`, while `/tools-mcp` and `/rate-limits` do full-record CRUD through bespoke `Dialog`s of varying sizes (`sm:max-w-[50vw]` vs `sm:max-w-md` vs `sm:max-w-[46rem]`) with no shared component between them. A user moving between "AI Platform" screens gets a different interaction pattern for what is, in every case, "edit a database row" — reinforcing the sense that each screen was built independently rather than to one house standard, even though the underlying primitives (`ScreenTemplate`, `DetailDrawer`) exist and are used correctly elsewhere in the same domain.

Additionally, one small but concrete documentation-drift finding surfaced during this audit: `13-nextjs-apps.md` §Sub-pattern lists exactly 3 "super-admin screen wrapping `WorkingTenantGate`" instances, but a 4th (`/ai-operations/consumption`) does the same thing and is undocumented there (§Table row 11) — a minor sign that this surface has grown faster than its own governing rule file has been updated.

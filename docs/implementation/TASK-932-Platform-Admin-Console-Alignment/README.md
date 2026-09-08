# TASK-932 — Platform-admin console alignment: settings visibility & feature matrix, Platform Ops regrouping with platform-wide gates, built-in integrations & weight store, cross-tenant storage, realtime-consultation seed realignment + browser e2e

| | |
|---|---|
| **Status** | `In Progress` — owner go 2026-09-09; wave 1 running (lanes N, S, P, T, W) |
| **Branch** | `dev-2.2` (merge target for every lane) |
| **Classification** | `feature` + `bugfix` + `refactor` (console, gateway, applications, seeds, e2e) |
| **Owner request** | 2026-09-09 — the sixteen items in §1.1, then start the dev stack, reset the dev DB (consent given for `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`), and prove everything in a browser, including ≥5 seeded ArcaAI consultation workflows in the playground |
| **Related** | TASK-862 (one provider screen), TASK-860 (model registry platform-only), TASK-870 (config governance), TASK-890 (OD-A/OD-B/OD-L/OD-P — Hope provider, platform settings), TASK-891 (realtime scribe: OD-1…OD-5, open item F-1), TASK-930 (agent/workflow platform commitments) |

---

## 1. Requirement Analysis

### 1.1 What the owner asked for (2026-09-09), decomposed

| Id | Area | Requirement (owner's words, condensed) | Kind |
|---|---|---|---|
| R-1 | Settings registry | Platform settings MUST NOT be shown to any tenant admin — platform settings are for the platform admin only | bugfix (visibility) |
| R-2 | Nav | Move **Platform Ops** before **AI Platform** | chore |
| R-3 | Platform Ops · integrations | Built-in inference services depend on integrations: the platform admin can **configure** or **reset to the default** the API/secret of LM Studio, Ollama, vLLM, llama.cpp (local LM Studio runs on `localhost:1234`) | feature |
| R-4 | Platform Ops · gates | Hide **MCP server**, **MLflow**, **Agentic policy** using platform-wide settings | feature |
| R-5 | Platform Ops · storage | Storage must NOT require a working tenant for a platform admin; with none selected it MUST show all MinIO buckets | bugfix |
| R-6 | Settings registry · writes | The platform admin cannot update/change any setting today; bootstrap, credential and data-plane settings must be un-editable for everyone, platform admin included | bugfix + hardening |
| R-7 | Settings registry · UX | Rows render badly; no responsive best practice | bugfix (UX) |
| R-8 | Settings registry + rows | Remove all "Feature Flags"; consolidate into one place; a **matrix of checkboxes** to manage feature availability per tenant, with **reset to the SYSTEM default** | feature |
| R-9 | Nav | Menu order does not match what the platform admin sees; make the navigator tree explicit and verified; tenant admins auto-hide what they cannot open | bugfix + test |
| R-10 | Knowledge & Agents | Move **Tools & MCP** to Platform Ops; hide it with a platform-wide setting | chore + feature (same gate as R-4) |
| R-11 | AI providers · weight store | The **S3 / MinIO weight store** is the built-in, global-wide default; only the platform admin sees/controls it. Today it shows "no key · Disabled for this tenant". Review with LM Studio and the AI models registry | bugfix |
| R-12 | AI providers · scope | The "Platform default / ‹tenant›" tab must not exist; the working tenant decides what a platform admin vs a tenant admin sees and configures | bugfix (design) |
| R-13 | AI providers | Remove **Speech & Voice** | chore |
| R-14 | Workflow & Harness | Hide the whole menu with a platform-wide setting | feature (same gate mechanism) |
| R-15 | Seeds | Agents and workflows must be based on **version 3** of the department instruction prompt templates; prompts/instructions may be realigned to the agent + workflow architecture | refactor (content) |
| R-16 | E2E | Start the dev stack, reset + reseed the dev DB, and prove in a browser: (a) ≥5 seeded ArcaAI consultation workflows — department-driven workflow pick, visit type, summary language, previous case notes → pre-summary while recording starts; transcript; partial summaries (translate → summarise with previous context → department SOAP template) with NER highlights; stop → finalise + redact with the clinician's DNA writing style; (b) realtime transcription with a selectable language | verification |

### 1.2 Owner rules this plan inherits (verified in the repo and in prior session transcripts)

- Built-in providers (LM Studio, Ollama, transformers + Hugging Face, llama.cpp, vLLM) are platform-managed; **only the platform super admin manages them** (owner, 2026-08-24; TASK-890 OD-L "Hope provider"). BYO keys are per tenant and affect that tenant only (owner, 2026-09-05).
- Settings/configuration exist for platform admins to control platform behaviour (owner, 2026-09-05). Platform-tier `GlobalSetting` rows are super-admin-only and global-wide effective (TASK-890 OD-P).
- Resolution order is tenant → SYSTEM, two tiers; entitlements bound, never supply (rule 00 §Configuration Principles). Content is cloned, configuration cascades (rule 00, TASK-890 OD-M).
- Realtime scribe: no dropdowns — the workflow names the ASR, partial/finalise and DNA-redaction agents; default language EMPTY (code-switch); per-agent reasoning block (TASK-891 OD-1…OD-5). Model registry is platform-admin-only, SYSTEM rows only (TASK-860 §3.1).
- Pre-production posture: a redundant old-architecture surface is removed completely, not dual-homed (TASK-888 precedent).

---

## 2. Current State Evaluation (eight read-only discovery lanes, 2026-09-09)

### 2.1 Navigation (`apps/admin-console/src/shared/navigation/nav-config.ts`)

- Rail domains in declaration order (`NAV_DOMAINS`, L108-118): Overview · Tenancy · **AI Platform** · Knowledge & Agents · Clinical · Workflow & Harness · Identity & Access · **Platform Ops** · Playground. `order` is documentation only; render order = array order (`app-sidebar.tsx:53-60`, `domain-rail.tsx:65`). Inside a domain the sidebar groups by tier (`NAV_SECTIONS`) and keeps declaration order.
- The only gates are ability (`isGranted`, L928) and the playground role check (L923). **No platform-wide setting hides any nav group or item today** (descriptors grep: zero hits for nav/menu/visible).
- Misplaced against the request: `/tools-mcp` (knowledge-agents), `/ai-services/mlflow` and `/agentic-policy` (ai-platform); `/ai-configuration` "Speech & Voice" (ai-platform, tier 30-49, deprecated R4 — the Speech tab is a retirement notice, the Voice tab is links).
- Tests: `nav-config.test.ts` (905 lines), `app-sidebar.test.tsx`, `domain-rail.test.tsx`, e2e `tests/e2e/app-shell.spec.ts`.

### 2.2 Settings registry and settings rows

- Catalog read (`apps/api/src/modules/settings-catalog/settings-catalog.controller.ts:38-40`) filters only `globalOnly` for non-elevated callers. A tenant admin therefore still receives every **system-only** descriptor (`maxScope: 'system'`, categories Bootstrap, Credentials, Platform Operations, Service Runtime, STT/TTS runtime…) — visible, un-writable rows. This is R-1.
- Write lane (`settings-registry-write.service.ts:147-261`): only `global-kv` is writable; `env`/`vault-kv`/`db-secret`/`entitlement`/`db-config` are refused with 400; `system` scope needs a super admin; `tenant` scope needs a CUSTOMER working tenant (`targetTenantFor`, L358-377). There is **no reset/delete** in the lane. The console GET defaults `scope=system` for the ETag row; the drawer renders "View" for every non-`global-kv` tier. The reported "platform admin cannot change any setting" must be reproduced in the browser before it is fixed (candidates: ETag scope mismatch when a working tenant is selected → 412/428; `targetTenantFor` refusing a reserved tenant; a drawer state that never enables Save).
- Registry screen renders one plain `<Table>` per category (`settings-registry-screen.tsx:57-125`); no responsive treatment beyond the primitive's `overflow-x-auto`. The `/settings` screen already uses `AdminDataGrid` (faceted, virtualised, nuqs) — the model to converge on.
- Feature flags today: `feature-flags.descriptors.ts` = 5 `tier: 'env'`, `editableBy: 'none'`, category "Feature Flags" (`registration.selfSignupEnabled`, `workflowExposure.enabled`, `liveDoc.groundedness.enabled`, `harness.claimCheck.enabled`, one removed); `redis-flag` tier has **zero** descriptors; the legacy `GlobalSetting` namespace `feature-flags` carries 5 dead advisory keys (`advisory-feature-flags.ts`, seed `11-global-setting.ts`) plus two enforced ones (`enable-consultation-sharing`, `enable-local-raw-capture`). Per-tenant feature availability already exists as a tri-state on `TenantEntitlement` (`Boolean?` = inherit/grant/deny) — but entitlements bound, they never supply (rule 09), so they are not the store for feature *configuration*.
- Tests: 31 backend suites, console unit tests, API e2e `settings-registry-write.spec.ts`, `task-890-platform-settings-gate.spec.ts`; **no console e2e for `/settings-registry`**.

### 2.3 Platform Ops — integrations, storage, MCP/MLflow/Agentic policy

- Engine endpoints are **SYSTEM `AiProviderConnection` rows** (`seed/17-ai-provider-connection.ts`: ollama `:11434`, lm-studio `lmStudioBaseUrl()` = `SEED_LMSTUDIO_BASE_URL` or `http://hope-lmstudio:1234/v1`, vllm, llama-cpp; create-only seed, placeholder key `not-needed`). `apps/text` resolves the base URL only from the gateway-injected `provider_overrides` (`connection.py:55-72`) — a deleted SYSTEM row is a 503, so **DELETE is not a reset**. No reset endpoint exists; the `inference-engines` screens are read-only and `/ai-providers` lists no engine provider (`provider-meta.ts:26-62`). **No console screen can edit a built-in engine's endpoint/key today.**
- Storage: `/storage` (tier 30-49) wraps `WorkingTenantGate` (`storage-browser-screen.tsx:210-220`). The backend already serves an unscoped super admin cross-tenant (`tenant-bucket.service.ts:62-74` → `findAllCrossTenant`), and `IS3Service.listAllBuckets()` exists unused (`s3.service.ts:646-666`).
- MCP / MLflow / Agentic policy: purely nav-ability-gated. `HarnessPolicy.mcpToolsEnabled` (per-tenant, OD-11) gates the harness *runtime* MCP path, not the screen.

### 2.4 AI providers and the weight store

- The "Platform default / ‹tenant›" control is `ScopeControl` (`scope-control.tsx:56-59`, `use-provider-scope.ts`): a `?scope=` toggle on the screen, independent of the working tenant. TASK-862 §3.1 intended "super admin with no working tenant edits SYSTEM; with a working tenant edits that tenant" — the toggle contradicts it. This is R-12.
- Provider classes exist server-side (`constants.ts:274-286`: `cloud-byo` · `cloud-platform` · `engine-served` · `platform-self-host`; `CLOUD_BYO_PROVIDERS['model-registry'] = []`), but the console renders every card in `PROVIDERS_BY_SERVICE` regardless of scope and labels the SYSTEM row with tenant wording (`STATE_LABEL`, `provider-credential-card.tsx:53-57`) — hence "no key · Disabled for this tenant" on `model-registry:s3` (seeded `enabled:false`, blank). This is R-11.
- `model-registry:s3` is the credential for *fetching* weights on demand (`apps/stt/.../model_credentials.py`, `GET /internal/model-registry-credential`, funded by the model row's owner = SYSTEM). Serving pods read `s3://hope-models` through the s3fs mount; LM Studio (`engine-served`) never uses it. The AI models registry (`/ai-models`) is already SYSTEM-only and measures bucket availability.
- "Speech & Voice" is `/ai-configuration` (`features/tenant-stt-config`), deprecated R4 pending the `TenantSttConfig` binding.

### 2.5 Seeds, prompts v3, agents, workflows

- v3 lives in `seed/07b-arcaai-clinical-content-v3.ts` and is wired by `07b-arcaai-clinical-templates.ts` as 22 department × visit-type SUMMARY templates + 1 tenant PRE_SUMMARY, `approvedVersionNumber = 3`. The 22 ArcaAI department agents (`29-arcaai-agents-and-workflows.ts`) bind v3. The Global/SYSTEM `general-medicine-summarization` agent binds a different v1 template.
- The 11 ArcaAI workflows (`arcaai-<code>-consultation`) are: trigger → ASR (realtime/perTurn) → NER → `core.condition` on visit type → per-visit-type realtime summary agent → `casenote-finalization` (durable/onEnd) → human review → output. **Gaps vs R-16:** no pre-summary node (and `Department.preSummaryPromptId` is null for every ArcaAI department, so the v3 PRE_SUMMARY is bound nowhere); no explicit translation directive / summary-language variable; `casenote-finalization` has no DNA-style input; no `documentTemplateSlug` on the department workflows' realtime nodes (only the two generic visit-type shapes from TASK-891 exist); assignments are unqualified (`selectorKey: ''`).
- Realtime lane = `LiveDocumentationService` (gateway, Redis, non-Temporal): ~3 finals / 5 s idle cadence, single-flight flush, previous running note folded into the next prompt, NER via `apps/nlp`, template via `resolveForGeneration(tenantId, slug)`, finalise via `SummaryService` where `dna_style_text` is injected when a `dnaStyleId` resolves (`resolveEffectiveDnaStyleId`, `summary.service.ts:1917`) — the clinician's own report is not auto-resolved although `DnaWritingStyleService.getEffectiveStyleText(doctorId)` exists. Node cadences are `once | perTurn | onEnd` (`node-config-schemas.ts:1345`).
- Playground: no visit-type control (derived from `parentConsultationId`), no summary-language control (`Consultation.language` column exists; `OpenConsultationRequest` has no `language`), no "previous case notes" field before start; the live-transcription screen has **no language selector** although the transport carries `language`.

### 2.6 Dev stack and e2e harness

- `pnpm stack:dev` supervises api, stt, stt-worker, text, guardrail, nlp, harness, worker, admin (5176). `dev-doctor` requires LM Studio at `localhost:1234`. `scripts/dev-service.sh` defaults `LM_STUDIO_MODEL=gemma-4-e4b-it-qat` (retired) while the seed expects `gemma-4-e2b-it-qat` — export `LM_STUDIO_MODEL=gemma-4-e2b-it-qat` locally.
- Reset: `RUN_SEED=all NODE_ENV=development pnpm db:all` (destructive `db push --force-reset` + seed + Temporal orphan cleanup). Prisma's AI-agent guard requires `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` = the exact consent text of the user's message (no newlines/quotes) — see §4.4.
- Browser e2e: `apps/admin-console/tests/e2e` (Playwright; `auth.setup.ts` logs in `super_admin`/`password123`; specs skip when the stack is down; `impersonateUser`/`selectWorkingTenant` helpers). No fake-microphone project exists at app level (package-level configs do use `--use-fake-device-for-media-stream`); WAV fixtures exist under `apps/stt/tests/e2e/fixtures/clinical/`.

### 2.7 R-6 reproduced in the browser (orchestrator, 2026-09-09, primary checkout, live stack)

Logged in as `super_admin` with **no working tenant**, `/settings-registry` lists 215 keys ("166 editable here"). Clicking **Edit** on `consultation.realtime.textTimeoutMs` opens the drawer in an error state: *"Couldn't load this data — Platform admins must pass ?tenantId to scope this request."* Network: `GET /api/hope/admin/settings/registry/consultation.realtime.textTimeoutMs?scope=system → 400` with body `{"message":"Platform admins must pass ?tenantId= to scope this request.","code":"HTTP.BAD_REQUEST"}`. Source: `apps/api/src/shared/tenant-scope.ts:33` (`resolveScopedTenantId`) called from `settings-registry-write.controller.ts` / `settings-catalog.controller.ts` for the effective read — a super admin with no working tenant is refused even though `scope=system` names the SYSTEM row unambiguously.

After selecting the working tenant **ArcaAI**, the same drawer loads (`200`) and the save works: `PUT …/registry/consultation.realtime.textTimeoutMs → 200` (system scope, "stored row v1"). So the platform admin can write only after picking a customer tenant, and the write still lands on the **platform** row — the drawer never offered the tenant scope. Two defects for Lane S: (a) `scope=system` must resolve `SYSTEM_TENANT_ID` for an elevated caller with no working tenant (`?tenantId` is for tenant scope only); (b) with a customer working tenant selected, the drawer must default to (or offer) the tenant scope and label the platform write explicitly. The value was left at `60001` on the dev DB (reset in wave 3).

---

## 3. Target Design

### 3.1 Navigation tree (R-2, R-9, R-10, R-13, R-14 — Lane N)

Rail order becomes: **Overview · Tenancy · Platform Ops · AI Platform · Knowledge & Agents · Clinical · Workflow & Harness · Identity & Access · Playground.** Every `NavEntry` gains an explicit `order` within its domain; `NAV_ENTRIES` is re-declared in that order and a test asserts *rendered* order (sidebar per tier) equals the declared inventory for a super admin and for a tenant admin. The inventory below is the contract (tier in brackets; `⚑` = behind a feature gate, §3.3):

| Domain | Entries in order |
|---|---|
| Overview | Dashboard, Monitoring, Releases |
| Tenancy | Tenants, Entitlements & plans, Tenant storage, Billing & invoices [10-19] · Tenant profile [20-29] · Departments [30-49] |
| **Platform Ops** | Feature availability (new, §3.3), Rate limits, AI operations — runs, AI operations — metrics, Consumption & cost, Queues & jobs, Schedulers, Audit logs, Database Studio, Agentic policy ⚑, MLflow ⚑ [10-19] · Settings registry, Settings rows & secrets, Tools & MCP ⚑ [20-29] · Storage browser [30-49] |
| AI Platform | AI models, AI services, LM Studio, vLLM, Ollama, llama.cpp [10-19] · AI providers [20-29] |
| Knowledge & Agents | Agents, Prompt templates, Context Schemas, Document Templates, Knowledge Base, DNA writing styles, Workflow Studio, Workflow Assignments [30-49] |
| Clinical | Patient consent, Transcription jobs, Consultations |
| Workflow & Harness ⚑ (whole domain) | Harness policy, Harness observability, Harness workflows, Workflow Runs |
| Identity & Access | Security policy [10-19] · Users, Roles, Policies, API keys [20-29] · Identity providers, Allowed origins [30-49] |
| Playground | unchanged |

- `/ai-configuration` ("Speech & Voice"): nav entry removed; the page becomes a one-release `redirect('/agents?task=SPEECH_TO_TEXT')` (comment names the release it is deleted in); `features/tenant-stt-config/**` and its tests are deleted (pre-production posture). The backend `TenantSttConfig` deprecation is unchanged (R4).
- Tenant admins: unchanged mechanism (ability + tier); the new gates apply on top, so a hidden feature disappears for every audience.

### 3.2 Platform-wide visibility gates (R-4, R-10, R-14)

Four **feature-availability keys** (settings registry, `tier: 'global-kv'`, `maxScope: 'tenant'`, `globalOnly: true`, `failMode: 'open-to-default'`, `killSwitch: true`, `default: false`, `category: 'Feature Availability'`):

| Key | Gates |
|---|---|
| `console.tools.mcp.enabled` | nav `/tools-mcp` + its route page (404 when off) |
| `console.mlflow.enabled` | nav + route `/ai-services/mlflow` |
| `console.agenticPolicy.enabled` | nav + route `/agentic-policy` |
| `console.workflowHarness.enabled` | the whole `workflow-harness` domain (+ routes `/harness/*`, `/workflow-runs*`) |

Resolution is the standard tenant → SYSTEM cascade (`TenantSettingsService`): a platform admin with no working tenant sees the SYSTEM value; with a working tenant, that tenant's effective value; a tenant admin its own. The console reads them once per session through `GET admin/settings/features/effective` (caller-scoped, `read:GlobalSetting`, returns `{ key, value, sourceScope }[]` for every `Feature Availability` key) via `useFeatureGates()`; `visibleNavEntries/visibleNavDomains` take the gate map as a third input. Backend routes stay ability-gated — the gate is a console visibility/route decision, not an authorisation boundary (documented in rule 13 §Routing).

### 3.3 Feature availability matrix (R-8) — replaces every "Feature Flags" surface

- **Screen** `/features` (Platform Ops, tier 10-19, `manage:all`, `(global)` group): rows = feature keys (category `Feature Availability`, grouped by sub-area), columns = **Platform default (SYSTEM)** then one column per customer tenant (Global playground included, SYSTEM excluded). Cell = tri-state checkbox (`aria-checked="mixed"` = inherits the platform default, rendered with the inherited value ghosted; checked/unchecked = explicit tenant override). Row menu: "Reset all tenants to platform default"; cell menu: "Reset to platform default". Edits batch into one save (`PUT admin/settings/features/matrix`, one approval, ETag per row). Sticky first column, horizontal scroll container; below `md` the matrix degrades to a tenant picker + list. Skeleton per rule 10, axe 0, both themes.
- **Endpoints** (`SettingsCatalogModule`, all `@ForbidApiKey()`, svc scope `svc:admin:settings:manage`): `GET admin/settings/features/effective` (§3.2); `GET admin/settings/features/matrix` (super admin: descriptors + SYSTEM value + per-tenant `{ value | null, version }`); `PUT admin/settings/features/matrix` (super admin; body `cells: [{ key, tenantId | 'system', value | null, expectedVersion? }]`; `value: null` = reset); `DELETE admin/settings/registry/:key?scope=tenant` (reset a single tenant override — the write lane gains `reset()`; system-scope rows cannot be deleted, only rewritten to the descriptor default).
- **Consolidation:** `feature-flags.descriptors.ts` is dissolved — `registration.selfSignupEnabled`, `workflowExposure.enabled`, `liveDoc.groundedness.enabled` migrate to `global-kv` feature-availability keys (their `targetTier` already says so) and their three TS consumers read through `AppSettings`/`TenantSettings` (the `LiveDocumentationService` constructor read becomes a per-flush read); `harness.claimCheck.enabled` is not a feature — it is re-categorised `Service Runtime` and stays `env` (Python worker offload knob). `consultation.realtime.graphExecutor.enabled` moves into the category. The legacy `GlobalSetting` namespace `feature-flags`: the 5 dead advisory rows leave the seed and `advisory-feature-flags.ts` is deleted; `enable-consultation-sharing` / `enable-local-raw-capture` become `consultation.sharing.enabled` / `consultation.localRawCapture.enabled` feature keys with their consumers repointed (lane S proves each consumer; a consumer that cannot be repointed in the wave is reported, not silently left). The registry screen no longer has a "Feature Flags" category; the `/settings` screen no longer shows the advisory marker.

### 3.4 Settings registry — visibility, writes, UX (R-1, R-6, R-7)

- **Tenant visibility (server-side):** a non-elevated caller's catalog = descriptors with `maxScope ∈ {tenant, department, doctor}` and not `globalOnly` (keys a tenant can hold an opinion on). Every other descriptor is platform-only: absent from the catalog, and `GET/PUT admin/settings/registry/:key` answer **404** for it (404-over-403 for the *catalog*; writes at system scope stay 403 as today). The console title reads "Tenant settings" for a tenant admin.
- **Locked tiers:** `env` (Bootstrap), `vault-kv`/`db-secret` (Credentials), and the data-plane transport keys (storage/MinIO, Redis, Qdrant, Temporal, database URLs) are declared `editableBy: 'none'` and rendered with a lock badge + reason ("Bootstrap/credential/data-plane — managed by deployment, not editable here"), for every audience including the platform admin. The write lane keeps refusing them (400 → clearer `SETTING_TIER_LOCKED` message).
- **Platform-admin writes:** reproduce the failure in the browser first (§4.3 step 1), then fix the actual cause; the expected behaviour is: SYSTEM scope editable with no working tenant, tenant scope editable when a customer working tenant is selected, ETag row follows the selected scope, and a stale row yields an inline 412 with "Reload". e2e `task-932-settings-registry.spec.ts` pins it.
- **UX:** the screen becomes an `AdminDataGrid` (omni-search; facets category · tier · scope · editable; group-by category; virtualised; nuqs URL state), columns Key (mono, truncate + tooltip) · Label · Tier (badge) · Max scope · Effective value (preview) · Source · Action (Edit / View / Locked). The drawer keeps its editor; locked keys show the reason instead of a form. Skeleton on load; empty state; both themes; axe 0.

### 3.5 AI providers — scope by working tenant, built-in integrations, weight store (R-3, R-11, R-12 — Lane P)

- **Scope:** `ScopeControl` and `?scope=` are removed. Scope = the shell's working tenant: elevated + none → **SYSTEM (platform tier)**; elevated + working tenant → that tenant (with the "Acting on: ‹Tenant›" mutation banner); tenant admin → own tenant. `useProviderScope` collapses to this rule.
- **Platform view (SYSTEM)**, grouped:
  1. **Built-in inference services** — LM Studio, Ollama, vLLM, llama.cpp (`engine-served`): endpoint, optional API key, enabled, readiness (from `GET admin/ai-services/readiness`), **Test**, **Reset to default**. Copy never says "for this tenant".
  2. **Platform default cloud connections** — the cloud rows on SYSTEM (shared fallback per TASK-862 / OD-Q): key, endpoint, enabled/disabled.
  3. **Model registry (built-in)** — Hugging Face token; **S3 / MinIO weight store**: endpoint + access key id + secret, default state "Using platform storage credentials", **Reset to default**. Status derives from the row + readiness, never from the tenant three-state.
- **Tenant view:** only `cloud-byo` providers per service (tabs with no BYO provider — Rerank, Model registry — are not rendered); three-state control unchanged (`Use platform default · Bring your own · Disable for this tenant`).
- **Backend:** `GET admin/providers/:service` / `:provider` for a **customer** tenantId filter out non-`cloud-byo` providers (a direct GET on one → 404); `POST admin/providers/:service/:provider/reset` (SYSTEM only, super admin, `@ForbidApiKey`) restores the row from `BUILT_IN_CONNECTION_DEFAULTS` — a new leaf module `packages/types/src/built-in-provider-defaults.ts` shared by `seed/17-ai-provider-connection.ts` and the service (k3s Service URLs for the engines, `SEED_LMSTUDIO_BASE_URL` still honoured at seed time; weight store = "platform storage" marker). `resolveCredential('model-registry','s3', SYSTEM)` on a keyless **enabled** row resolves to the platform storage credentials (SYSTEM `TenantStorageConfig` → bootstrap `MINIO_*`) and reports `source: 'platform-storage'`; the seed flips `model-registry:s3` to `enabled: true`, keyless. Card wording and the `provider-meta.drift.test.ts` fixture cover `model-registry`.
- **LM Studio locally:** the platform admin sets the LM Studio endpoint to `http://localhost:1234/v1` on this screen (or the reseed passes `SEED_LMSTUDIO_BASE_URL`); readiness then lists the loaded models (`admin/ai-models/discovery`). The AI models registry stays platform-only and unchanged.
- **Speech & Voice:** removed per §3.1 (page redirect owned by Lane N; feature folder deletion owned by Lane P).

### 3.6 Storage browser — cross-tenant for an unscoped platform admin (R-5 — Lane T)

- `WorkingTenantGate` is replaced by a scope banner: elevated + no working tenant → **all buckets** (registered `TenantBucket` rows across tenants + physical MinIO buckets from `IS3Service.listAllBuckets()`, each flagged `registered | unregistered`, with a Tenant column); elevated + working tenant → that tenant's buckets; tenant admin → own. File browsing stays available on registered buckets; unregistered physical buckets are listed read-only with a "Register" deep link to `/tenants/storage`.
- Backend: `GET storage/buckets?includePhysical=true` (super admin without `X-Tenant-Id` only; otherwise 400) merges `findAllCrossTenant` with `listAllBuckets()`; cross-tenant e2e pins that a tenant admin still gets only its own rows.

### 3.7 Seeds and the realtime consultation flow (R-15, R-16a — Lane W)

Content stays on v3 (the department bodies are the department's clinical instruction); the **operating frame** is supplied by the workflow and the realtime lane. Changes, all ArcaAI (11 departments) with SYSTEM/Global kept consistent:

| Step | Design |
|---|---|
| Pre-summary | New agent `case-notes-pre-summary` (TEXT_GENERATION, `lms-gemma-4-e2b-it-qat`) bound to the v3 PRE_SUMMARY template with `instruction.variables` → `trigger.context.*` (department, visit type, safe demographics, previous visits, language). Node `n_presummary` (`core.agent`, `execution: { lane: 'realtime', cadence: 'onStart' }`) — `onStart` is added to the cadence enum (`@arcaai/workflow-contract`, harness parity fixture/registry) and to `LiveDocumentationService.start`, which runs it once over the consultation's CASE_NOTE context items in parallel with the ASR session and emits a `presummary` event + persists the PRE_SUMMARY context item. `Department.preSummaryPromptId` is set to the tenant PRE_SUMMARY template for all 11 departments so the legacy read path agrees. **Fallback if `onStart` cannot land in the wave:** the playground calls the existing pre-summary generation path at recording start; the lane reports which shipped. |
| Partial summary | The department realtime agents keep their v3 bodies; the realtime frame (prompt assembly) states the operating steps: transcript may be code-switched / non-English → translate to English internally → merge with the previous partial summary → write in `{{summary_language}}` → fill the SOAP template `{{document_template}}` (section ids from the department template) → output section patches. `documentTemplateSlug` is set on every department workflow's realtime summary nodes → new per-department `DocumentTemplate` rows `arcaai-<dept>-soap-{new-visit,revisit}` seeded in `27-document-template-library.ts` from the two visit-type shapes + specialty sections derived from the v3 bodies. |
| Summary language | `OpenConsultationRequest.language?` (BCP-47) → `Consultation.language`; the playground gains a "Summary language" select (en / ml / …, from the STT language catalogue's language list); STT language mode stays the separate channel (TASK-891 OD-1). |
| Visit type | Playground "Visit type" control: New visit · Revisit (pick the parent consultation of the same patient) → `parentConsultationId`; the platform pair is unchanged (OD-3). |
| NER | `n_ner` unchanged (medical-ner via `apps/nlp`); highlights already render. |
| Finalise + DNA | `casenote-finalization` instruction gains the DNA block (`{{dna_style_text}}`, redaction rules) resolved from the signed-in clinician's effective report (`DnaWritingStyleService.getEffectiveStyleText(doctorId)`) when no explicit `dnaStyleId` is given — TASK-891 F-1 closed as **finalise only**. `08-dna-writing-style.ts` seeds an approved report for every `arcaai_doctor*` user (dev/test). |
| Assignments | Department-scope rows stay unqualified (the graph branches on visit type); the tenant default stays `arcaai-gen-consultation`. The TASK-891 open item (caller-selected slug bypasses the visit-type shape) is recorded, not fixed here — the tests use the assigned workflow. |
| Live transcription | Language select added to the screen (`useArcaSttLanguageModes()`), passed to `startLiveStt({ language })` and the batch tab (R-16b). |

### 3.8 Browser e2e (R-16 — Lane E, after merge)

Playwright in `apps/admin-console/tests/e2e`, new project `chromium-audio` (`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>`; fixture copied from `apps/stt/tests/e2e/fixtures/clinical/*.wav`, PCM WAV). Specs (`task-932-*.spec.ts`), all skip-gated on the stack:

| Spec | Proves |
|---|---|
| `nav-tree` | super-admin rail/sidebar order = §3.1 inventory; tenant admin (impersonated `arcaai_admin`) sees only its tier/ability entries; gated entries appear/disappear when the matrix toggles them |
| `settings-registry` | tenant admin sees no platform key; platform admin edits a `global-kv` key at system scope (200, ETag round-trip) and a tenant override; locked tiers render locked and 400 on a forced PUT |
| `feature-matrix` | tri-state cells, batch save, reset to platform default, effective value visible in the tenant column |
| `ai-providers` | no scope toggle; platform view shows built-ins + weight store ("platform storage"), reset restores the default endpoint; tenant view shows only BYO providers; `model-registry` 404 for a tenant |
| `storage-browser` | unscoped platform admin lists buckets across tenants (+ physical); working tenant narrows; tenant admin own only |
| `consultation-scribe` × 5 (GEN, SURG, RHEUM, NEUR, BREN) | login as the department's clinician (impersonation), open with department + visit type + summary language + previous case notes → workflow = `arcaai-<dept>-consultation`; start recording (fake mic) → pre-summary rendered; transcript rows; ≥1 partial summary with SOAP sections + NER chips; stop → final note with `redactionApplied`/DNA provenance |
| `live-transcription` | language selectable, session opens, partial/final rows arrive |

---

## 4. Implementation Plan — team, tiers, waves

### 4.1 Lanes (one writer per worktree, rule 14 §3)

| Lane | Scope | Owns (nothing else) | Tier / effort | Gates |
|---|---|---|---|---|
| **N** nav & gates | §3.1, §3.2 console half | `shared/navigation/**`, `shared/layout/{app-sidebar,domain-rail}*`, `shared/auth/hooks` (add `useFeatureGates`), route pages for gated screens + `(tenant)/ai-configuration/page.tsx` (redirect), retired-route tests, `nav-config.test.ts` | `sonnet` / high | `pnpm --filter @arcaai/admin-console lint typecheck test` |
| **S** settings & matrix | §3.2 backend, §3.3, §3.4 | `packages/applications/src/services/settings-registry/**`, `apps/api/src/modules/settings-catalog/**`, `seed/11-global-setting.ts`, console `features/settings-registry/**`, `features/settings/**`, new `features/feature-availability/**`, `(global)/features/page.tsx`, the three flag consumers | `opus` / high | applications + api unit, `pnpm api:build`, console gates |
| **P** providers & integrations | §3.5 | `packages/applications/src/services/ai-provider-connection/**`, `apps/api/src/modules/ai-provider-connection/**`, `apps/api/src/modules/internal/model-registry-credential*`, `packages/types/src/built-in-provider-defaults.ts`, `seed/17-ai-provider-connection.ts`, console `features/ai-providers/**`, delete `features/tenant-stt-config/**` | `opus` / high | applications + api unit, `pnpm api:build`, console gates |
| **T** storage | §3.6 | `packages/applications/src/services/tenant-bucket/**`, `apps/api/src/modules/storage/**`, console `features/storage-browser/**` | `sonnet` / medium | applications + api unit, console gates |
| **W** seeds & realtime | §3.7 | `seed/{00-constants,04-department,07b-*,08-dna-writing-style,25-agents,27-document-template-library,28-workflow-library*,29-arcaai-*}.ts` + seed tests, `packages/workflow-contract/**` + harness interpreter parity, `packages/applications/src/services/consultation/**`, `dna-writing-style/**`, `apps/api/src/modules/consultation/**`, console `features/playground-consultation/**`, `features/playground-live-transcription/**`, `packages/agentic-sdk-v2` open-session input | `opus` / high | database seed tests, applications + api unit, harness `pnpm harness:test` (parity fixture), console gates |
| **E** e2e | §3.8 | `apps/admin-console/tests/e2e/task-932-*.spec.ts`, `playwright.config.ts` (audio project), fixtures | `sonnet` / high | `pnpm admin:test:e2e` against the live stack |
| **V** review | two reviewers per merged wave with distinct lenses: (1) tenancy/authorisation (404-over-403, SYSTEM writes, cascade), (2) console rules (10/11/13, a11y) | read-only | `opus` / medium | findings are data; orchestrator re-verifies |

Orchestrator (this session, `fable`): worktrees, merges into `dev-2.2`, artifact regeneration (`pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin`), `pnpm install`, DB reset/seed, Docker infra, dev stack, final browser verification, ticket README.

### 4.2 Contracts fixed before spawning (INTERFACES)

- Feature-gate keys and the `GET admin/settings/features/effective` response shape (§3.2) — S implements, N consumes (N mocks in unit tests).
- `BUILT_IN_CONNECTION_DEFAULTS` shape and the reset route (§3.5) — P.
- `OpenConsultationRequest.language`, the `onStart` cadence, the `presummary` SSE event, `documentTemplateSlug` per department (§3.7) — W (self-contained).
- Nav inventory (§3.1) — N; P deletes the Speech & Voice feature folder only.

### 4.3 Waves

| Wave | Work | Exit criteria |
|---|---|---|
| 0 | Plan committed; five worktrees off `dev-2.2` with `pnpm install` + env files copied; briefs issued | branches exist, `pnpm typecheck` green in each |
| 1 | N, S, P, T, W in parallel. Step 1 of S is the browser reproduction of R-6 (against the running stack) recorded in the README before the fix | each lane's gates green with pasted output; unit tests added first (TDD) |
| 2 | Orchestrator merges in order T → N → P → S → W (smallest blast radius first), re-runs gates after each merge, regenerates the five artifacts, runs `pnpm verify` scope-limited; V reviewers on the merged tree; fixes applied by the owning lane | `pnpm lint:all`, `typecheck:all`, affected unit suites, drift checks green |
| 3 | DB reset + reseed (§4.4), `pnpm stack:dev`, `stack:dev:doctor`; Lane E writes and runs the specs; orchestrator drives the playground in the Browser pane for the five departments and the live-transcription language check; screenshots + SSE evidence captured into the README | all `task-932-*` specs green; runtime evidence pasted |

### 4.4 Runtime procedure (orchestrator, primary checkout)

```bash
# prerequisites: LM Studio running on :1234 with gemma-4-e2b-it-qat loaded
export LM_STUDIO_MODEL=gemma-4-e2b-it-qat SEED_LMSTUDIO_BASE_URL=http://localhost:1234/v1
pnpm infra:dev:up && pnpm stack:dev:doctor
# destructive dev-DB reset — consent value = the owner's consent sentence (Prisma requires the exact user text)
PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="you are allowed to reset database (using PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=true)" \
RUN_SEED=all NODE_ENV=development pnpm db:all
pnpm stack:dev            # api, stt, stt-worker, text, guardrail, nlp, harness, worker, admin(5176)
pnpm admin:test:e2e       # task-932-* specs; then the manual browser pass
```

### 4.5 Verification criteria (definition of done)

- [ ] Tenant admin (`arcaai_admin`) catalog contains zero `maxScope: 'system'` / `globalOnly` keys; direct GET on one → 404 (unit + e2e).
- [ ] Platform admin edits a `global-kv` key at system scope and a tenant override in the browser; locked tiers un-editable for everyone (unit + e2e).
- [ ] No "Feature Flags" category, no `feature-flags` namespace rows, no `advisory-feature-flags.ts`; the matrix toggles a gate and the nav reacts without reload of the session (e2e).
- [ ] Rail order and per-domain order match §3.1 for both audiences (unit + e2e); Speech & Voice gone, `/ai-configuration` redirects.
- [ ] `/ai-providers`: no scope toggle; platform view built-ins + weight store with reset; tenant view BYO only; `model-registry` 404 for a tenant (unit + API e2e + console e2e).
- [ ] `/storage`: cross-tenant + physical buckets for an unscoped platform admin; tenant isolation preserved (API e2e cross-tenant).
- [ ] Seed proof after reset: 11 department workflows carry `n_presummary` + `documentTemplateSlug`; 22 department SOAP templates; `case-notes-pre-summary` agent assigned; DNA reports for the ArcaAI clinicians; `pnpm --filter @arcaai/database test` green; harness parity fixture green.
- [ ] Five department consultations in the browser: workflow picked by department, pre-summary shown while recording, transcript, partial SOAP + NER, final note redacted with DNA provenance — screenshots and event logs in §6.
- [ ] Live transcription with a selected language.
- [ ] Five artifacts regenerated and drift checks green; `pnpm lint:all`, `pnpm typecheck:all` green; ticket README updated.

---

## 5. Decisions taken by this plan (owner may override before "go")

| # | Decision | Alternative rejected |
|---|---|---|
| D-1 | The four console gates default to **hidden** (`false`) until enabled on the matrix (platform default or per tenant) — "hide these using platform-wide settings" read literally. | Default visible, opt-out — leaves the screens visible on day one. |
| D-2 | Gates are console visibility + route 404 only; backend admin routes stay ability-gated (`harness.mcpToolsEnabled` remains the runtime MCP gate). | Vetoing the API routes — an authorisation change for API/SDK users that the request did not ask for. |
| D-3 | Feature availability is a **configuration** cascade (SYSTEM default, tenant override, reset = delete the override), stored as `global-kv` feature keys — not an entitlement column. | `TenantEntitlement` tri-state columns — entitlements bound, they never supply (rule 09). |
| D-4 | Three TS-consumed env flags migrate to `global-kv`; `harness.claimCheck.enabled` stays `env` (Python runtime knob) and is re-categorised. | Migrating the Python one too — needs the effective-config client and a worker restart contract. |
| D-5 | Tenant catalog = keys with a tenant-or-deeper `maxScope`; platform-only keys are 404 for a tenant admin. | Client-side hiding — the data still leaks over the wire. |
| D-6 | Speech & Voice: console removal now (redirect + feature folder deleted); backend `TenantSttConfig` stays on its R4 schedule. | Dropping the model/routes in this ticket — a schema change outside the request. |
| D-7 | Weight store default = the platform storage credentials; the SYSTEM row is enabled + keyless; explicit key = override; reset = back to keyless. | Requiring a key on the row — duplicates the bootstrap MinIO credential in Vault-Transit. |
| D-8 | Built-in engine defaults live in one leaf module used by seed and service; reset restores them; local LM Studio is configured on the screen (or `SEED_LMSTUDIO_BASE_URL` at seed time). | New `LMSTUDIO_BASE_URL`-style env vars — the "env is bootstrap only" rule. |
| D-9 | Pre-summary is a realtime `onStart` agent node; the legacy endpoint is the recorded fallback. | Keeping pre-summary legacy-only — contradicts "capabilities are agents/workflows". |
| D-10 | DNA redaction at finalise only (TASK-891 F-1). | Live redaction — a different lane, not requested. |
| D-11 | Storage cross-tenant view includes physical unregistered buckets, read-only. | Registered rows only — "show all MinIO buckets" says physical. |
| D-12 | Model tiers per §4.1; the deciding verifications (merged-tree review, runtime pass) stay with the orchestrator. | Whole fleet at `opus`. |

## 6. Implementation Summary

_Pending — filled per wave with pasted gate output and runtime evidence._

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-09 | **Lane T merged** (`3f7914449`, three commits on `task-932/storage`): `GET storage/buckets?includePhysical=true` (unscoped super admin only; `tenantId`, `tenantName`, `registered`, `physicalMissing` on each row; byte-identical without the flag), `listFiles` opened cross-tenant through the existing `@TenantOwnedResource({ scope: 'super-admin' })` mechanism, console `AllTenantsBody` replaces the working-tenant gate for elevated sessions with no tenant (read-only browse; mutations stay tenant-bound), e2e `task-932-storage-cross-tenant.spec.ts` (API) + `task-932-storage-browser.spec.ts` (console). Lane finding: `@/test/render.tsx` uses `NuqsTestingAdapter` without `hasMemory`, so URL-state writes do not persist across re-renders in tests (worked around locally; harness fix is a follow-up). Merged-tree gates: tenant-bucket tests 0, applications build 0, `api:build` 0, storage module tests 0, console lint 0 / typecheck 0; the full console suite then failed ONE repo-wide canon test (`emphasis-canon.test.ts`: `text-primary` used as emphasis on the "Register" link in `all-tenants-panel.tsx:141`) — fixed by the orchestrator (`text-foreground`), emphasis-canon + storage-browser tests 22 passed. |
| 2026-09-09 | **Lane P merged** (`ae51343fe`, four commits on `task-932/providers`): `ScopeControl` deleted, scope = working tenant; platform tier renders Built-in inference services / Platform default cloud connections / Model registry sections; tenant tier renders only `cloud-byo` cards; backend filters platform-only providers for customer tenants (`GET :service/:provider` → 404); `POST admin/providers/:service/:provider/reset` (super admin, `AUTH-NOTE`) restores `BUILT_IN_CONNECTION_DEFAULTS` (`built-in-defaults.ts`; parity with seed 17 pinned by `tests/contracts/built-in-provider-defaults.contract.test.ts`); `model-registry:s3` seeded enabled + keyless and resolved to the platform storage credentials (`platform-storage-credential.ts`, `source: 'platform-storage'`); `features/tenant-stt-config/**` deleted; e2e `task-932-providers.spec.ts` (API) + `task-932-ai-providers.spec.ts` (console). Lane deviations accepted: engine resets restore the `not-needed` placeholder key (a keyless engine row is dropped by the text fold → 503); `platformDefaultWhenBlank` on the two model-registry requirement entries; `resetRow` bypasses requirement checks for the shipped `llama-cpp` row; TTS self-host engines get no card (out of brief). Merged-tree gates: ai-provider-connection + contract tests 287 passed; applications build 0; database tests 0; `api:build` 0; api module tests 0; console lint 0 / typecheck 0 / tests 2682 passed. Needs the wave-3 reseed for `model-registry:*` rows on an existing DB. |
| 2026-09-09 | **Lane N merged** (`678695988`, six commits on `task-932/nav`): rail order Overview · Tenancy · Platform Ops · AI Platform · …; `NavEntry.order` + `gate`, `shared/feature-gates/` (`useFeatureGates`, `FeatureGateBoundary`), four gated screens, Speech & Voice retired (`/ai-configuration` → `/agents?task=SPEECH_TO_TEXT`), e2e `task-932-nav-tree.spec.ts`. Orchestrator follow-ups `57cdc9f17`: `/ai-model-defaults` repointed to avoid a two-hop redirect; rule 13 §Routing gained the feature-gate paragraph. Merged-tree gates: console lint exit 0, typecheck exit 0, `pnpm --filter @arcaai/admin-console test` → 297 files / 2676 tests passed. Lane deviation noted: it built `dist/` for `@arcaai/ui` and the SDK chain locally (gitignored) so the app tests could load, and it used `git stash` once to bisect a pre-existing failure — the stash stack was left clean (`stash@{0}` is an older unrelated entry). Known pre-existing: `tests/e2e/app-shell.spec.ts:96` still expects the retired Workbench link (fix in wave 3). |
| 2026-09-09 | Owner said **go**. Plan committed at `46aedc4f3`; five worktrees `../hope-v2-task-932-{nav,settings,providers,storage,seeds}` on `task-932/*` off `dev-2.2`, env files copied, `pnpm install` run by the orchestrator. R-6 reproduced live (§2.7) before Lane S started. |
| 2026-09-09 | Ticket opened. Eight read-only discovery lanes (`sonnet`) mapped nav, settings registry, platform-ops, providers/weight store, seeds/prompts v3, playground/realtime lane, dev-stack/e2e harness, and prior owner statements (2026-08-24, 2026-09-05 transcripts; TASK-890 OD-A/B/L/P; TASK-891 OD-1…OD-5). Plan §3–§5 written; status `Review` pending the owner's go-ahead. |

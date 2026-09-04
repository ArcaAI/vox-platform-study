# TASK-862 — AI Provider consolidation: one BYO-key screen, provider cascade wired to Agents & Workflows, Provider Reconciliation removed

| | |
|---|---|
| **Status** | Review |
| **Type** | refactor + removal |
| **Program** | [TASK-859 — AI Platform Consolidation](../TASK-859-Ai-Platform-Consolidation-Program/README.md) |
| **Packages** | `packages/database` (`ai-provider-connection`, `ai-task-default`, `ai-runtime-profile`, `ai-routing-policy`, `tenant-tts-config`, `usage-ledger` reconciliation), `packages/domains`, `packages/applications` (`ai-provider-connection`, `ai-task-default`, `ai-runtime-profile`, `ai-routing-policy`, `tenant-tts-config`, `metering/reconciliation`), `apps/api` (matching modules), `apps/guardrail` (`core/tenant_config.py`), `apps/text` (Sarvam LLM gap), `apps/admin-console` (`ai-providers`, `ai-platform`, `ai-task-defaults`, `ai-runtime-profiles`, `tenant-tts-config`, `reconciliation`), `packages/vox-node` (generated) |
| **Depends on** | TASK-860 (platform default per task moves to the registry) |
| **Blocks** | TASK-863 (agent credential derivation) |
| **Rules** | `02`, `04`, `05`, `06`, `09` §Tenant-first resolution & BYO, `13` |
| **Created** | 2026-09-04 |

## 1. Requirement Analysis

Owner directive (2026-09-04):

> I still see the Reconsolidate Provider, it's such weird thing and we need to remove completely. AI provider is where tenant admin can bring-his-own API key for cloud services such as Azure, OpenAI, Sarvam. Review the frontend and backend implementation to ensure we have Provider implementation that works with Agent and Workflow. One AI Provider screen. Remove completely all other duplicate, redundant screens/interfaces.

Restated:

| # | Requirement |
|---|---|
| R-1 | **Provider Reconciliation** (`/ai-operations/reconciliation`, `ProviderReconciliationRun`, the vendor-billing comparison) is removed completely — not deprecated. |
| R-2 | **One AI Provider screen**: a tenant admin brings their own key/endpoint for Azure (OpenAI + Speech), OpenAI, Sarvam (and the other cloud providers the adapters support); a super admin edits the SYSTEM (platform default) tier on the same screen. Every other screen or route that reads or writes provider connections is removed. |
| R-3 | The provider cascade (tenant → SYSTEM, three states: absent / enabled+keyed / disabled=veto; funding derived from the tier) is the **single** credential source for Agents (TASK-863) and Workflow nodes (TASK-864). |
| R-4 | Everything that duplicates "which provider/model serves task X" is folded: `AiTaskDefault` strangler finished, `AiRuntimeProfile` retired, `/ai-platform` hub dissolved, TTS/STT credential facades removed. |

## 2. Current State Evaluation

Verified 2026-09-04.

### 2.1 The credential store is already unified and correct

`AiProviderConnection` (`ai-provider-connection.prisma:51-98`): one row per `(tenantId, service, provider)`; `service ∈ llm|stt|tts|embeddings|rerank|vector|model-registry` (plain text, governed by `PROVIDER_SERVICES`); `encryptedApiKey` is Vault-Transit ciphertext never returned by any DTO (`hasKey` only); resolution `enabled tenant row → enabled SYSTEM row → fail closed`; a disabled tenant row is a **veto**. `CLOUD_BYO_PROVIDERS` (`constants.ts:75-101`) bounds what a tenant may hold: `llm: azure|bedrock|openai|anthropic|vertex`, `stt: azure-speech|sarvam|openai`, `tts: azure|sarvam`, `embeddings: azure|openai`, `vector: qdrant`. Funding is derived (`row.tenantId === SYSTEM → 'platform'`). Delivery to Python: the **fold** (`provider_overrides` injected on outbound text/tts requests), the **pull** (`apps/stt` calls `EffectiveConfigService`), and **per-activity resolve** (harness `GET /internal/harness/provider-credential`, credential discarded after use for replay safety).

### 2.2 Where the duplication actually is

| Surface | What it does | Verdict |
|---|---|---|
| `/ai-platform` (tier 20-29) — tabs Providers · Tasks · Model catalogue · Model store · Engines | a hub that replaced 14 routes; Providers tab mounts `features/ai-providers` (the real editor); Tasks tab edits `AiRoutingPolicy` + tenant `text.*` `AiTaskDefault`; Catalogue/Store register `AiModel` (second writer, TASK-860); Engines duplicates `/ai-services/*` | **Dissolve**: Providers → `/ai-providers`; Tasks → registry platform defaults (TASK-860) + Agents (TASK-863); Catalogue/Store → `/ai-models`; Engines → `/ai-services/*` |
| `admin/ai-providers` controller (llm-only alias of `admin/providers`) | legacy alias, no console caller | remove |
| `admin/tts-config/credentials/:provider`, `admin/stt-config/credentials/:provider[/test]` | second write paths into `AiProviderConnection`; console hooks already dead | remove; generalise the only test-connection route into `POST admin/providers/:service/:provider/test` |
| `AiTaskDefault` (+ `/ai-task-defaults` redirect, `ai-task-defaults-platform-screen.tsx` orphaned, `AiTaskDefaultService` ~40 readers, guardrail's SQL read) | retired by owner decision OD-3 (2026-09-01); survives as a write-through projection | **finish the strangler**: repoint guardrail SQL + TS readers to `AiRoutingPolicy`, delete service/controller/screen/vox-node resource, drop table |
| `AiRuntimeProfile` + `/ai-runtime-profiles` (no nav entry, seeded empty, SUPER_ADMIN-only) | hyper-parameters + concurrency per provider/model | **retire**: generation hyper-parameters live on the Agent (TASK-863); connection-level ceilings (`maxConcurrent`, `rpmLimit`, `tpmLimit`, `timeoutS`) move onto `AiProviderConnection` |
| `TenantTtsConfig` + `/ai-configuration` Voice tab | per-tenant voice/language routing spec; credential half already moved | **retire** with TASK-863: a TTS Agent + assignment expresses voice, language, format, speed; `/ai-configuration` closes (its Speech tab retires under TASK-861) |
| `AiRoutingPolicy` + Tasks tab | the provider-configuration table with a DB-enforced default election per `(tenant, taskKey)` | **keep the table and service** for non-agent tasks (guardrail, NER/classification defaults, harness judge, embeddings); **no tenant screen** — SYSTEM election is edited from the registry ("platform default for task"), tenant choice is the Classify node / agent guard config |
| Provider reconciliation (`ProviderReconciliationRun`, `provider-reconciler*.ts`, `admin/usage/reconciliation`, `/ai-operations/reconciliation`) | compares the platform ledger's CLOUD total with vendor usage APIs, alert-only, manual trigger only | **remove completely** (§3.4) |
| Shadow metering (same folder, internal ledger-vs-meter diff, cron) | unrelated to vendors | keep |

### 2.3 Provider ↔ Agent/Workflow linkage today

Nodes bind by reference only (`providerConfigRef.routingPolicyId` xor `taskKey`; `llmBinding.modelSlug`), never a literal (`FORBIDDEN_CONFIG_KEYS`). The harness resolves per activity through `_llm_policy.get_policy(task_key)` — the retired `AiTaskDefault` overlay. There is no agent-level binding because there is no Agent (TASK-863).

### 2.4 Adapter facts that shape the screen

| Provider | LLM (`apps/text`) | STT (`apps/stt`) | TTS (`apps/tts`) |
|---|---|---|---|
| Azure OpenAI / Azure Speech / Azure Foundry | `azure_openai.py` | `azure_speech_loader.py`, `azure_foundry_loader.py`, streaming `azure_asr.py` | `azure_speech.py` |
| OpenAI | `openai.py` | `openai_loader.py`, `openai_asr.py` | — |
| Sarvam | **none** (translation-only adapter) — yet an `llm:sarvam` SYSTEM connection is seeded (`17-ai-provider-connection.ts:319-332`) | `sarvam_loader.py`, `sarvam_asr.py` | `sarvam.py` |
| Bedrock, Anthropic, Vertex | live and registered (`main.py:76-106`); the TS `constants.ts:71-73` comment claiming Anthropic/Vertex are not functional is stale | — | — |
| self-host (LM Studio, vLLM, llama.cpp, Ollama) | SYSTEM-only rows with a placeholder key | — | — |

Cloud calls are made **from the Python services** with gateway-resolved credentials; the gateway never opens a vendor connection. This is kept (TASK-860 D-6) and stated as OD-1 below.

## 3. Target Design

### 3.1 The one screen: `/ai-providers` (tier 20-29, `manage:AiProviderConnection`)

- Rows grouped by **service** (Text generation · Speech-to-text · Text-to-speech · Embeddings · Vector store · Model registry) × **provider**; each row shows tier (tenant / platform default / not configured), `hasKey`, endpoint/region/deployment, enabled/veto state, and the **three-state control**: *Use platform default* (row absent) · *Bring your own* (enabled + key) · *Disable for this tenant* (veto).
- Super admin with no working tenant edits the SYSTEM tier; with a working tenant edits that tenant's rows — the same screen, the "Acting on: «Tenant»" banner on mutations (rule 12 §5).
- **Test connection** on every provider (`POST admin/providers/:service/:provider/test`): ephemeral, never persisted; per-provider probe (Azure OpenAI: list deployments; Azure Speech: token; OpenAI: models; Sarvam: a 1-second STT/TTS call).
- Connection-level ceilings (`maxConcurrent`, `rpmLimit`, `tpmLimit`, `timeoutS`) editable per row (moved from `AiRuntimeProfile`).
- "Used by" panel: agents (TASK-863) and workflow definitions bound to a model of this provider, from the FK reverse lookups — the answer to "what breaks if I disable this".
- Entitlement gates surface as disabled controls with the reason (`featurePlatformDefaultCredential`, BYO allowed providers).

### 3.2 Backend changes

| Area | Change |
|---|---|
| `AiProviderConnection` | add `maxConcurrent Int?`, `rpmLimit Int?`, `tpmLimit Int?`, `timeoutS Int?`; `ResourceType` unchanged |
| `ProviderConnectionController` (`admin/providers`) | add `POST :service/:provider/test`; remove the `admin/ai-providers` alias controller |
| `ProviderCredentialResolver` (rename of `resolveTenantCloudOverrides` + `resolveConnection`) | one exported resolver used by: the request fold (text/tts), the STT pull, the harness per-activity route, **and** `AgentResolverService` (TASK-863). Returns `{ override, fundingTier, connectionId }`; the ledger stamps `AiDeploymentKind`/`AiCostBasis` from `fundingTier` |
| `AiTaskDefault` | repoint `apps/guardrail/core/tenant_config.py` SQLAlchemy mapping to `AiRoutingPolicy ⋈ AiModel` (by `modelId`); repoint the TS readers of `AiTaskDefaultService.getEffective` to `AiRoutingPolicyService.resolveDefault(taskKey)`; delete service, controller, console screen, `vox-node/src/resources/admin/ai-task-default.ts` (generated); drop table (migration) |
| `AiRuntimeProfile` | delete service/controller/screen/domain trio; drop table; the TEXT-side ceiling descriptors stay in the settings registry |
| `AiRoutingPolicy` | keep; `AiRoutingPolicyService.resolveDefault(tenantId, taskKey)` becomes the only "default model for a non-agent task" resolution; SYSTEM election written from the registry's *platform default for task* action (TASK-860) via `setDefault`; the tenant-scoped CRUD routes stay for API/SDK use but lose their screen |
| `TenantTtsConfig` | deprecated (TASK-863 TTS agent + assignment replace it); `admin/tts-config/**` routes carry `Deprecation` headers; dropped after the window |
| Seeds | `17-ai-provider-connection.ts`: remove `llm:sarvam` (no adapter); keep SYSTEM cloud rows disabled + self-host rows enabled; `16-ai-task-default.ts` deleted (rows already live in `AiRoutingPolicy` seed — verify `ai-routing-policy` seed exists, else create `16-ai-routing-policy.ts` from the registry's `isPlatformDefaultFor`); `18-ai-runtime-profile.ts` deleted; `19-tenant-tts-config.ts` deleted with TASK-863; `11d-tts-engine-flags.ts` retained (engine registration flags, a different plane) |
| `constants.ts` | Anthropic/Vertex comment corrected; `CLOUD_BYO_PROVIDERS.llm` gains nothing for Sarvam |
| Sarvam LLM | **not added** — no product need; the connection row is removed |

### 3.3 Reconciliation removal (complete, ordered)

1. `usage-ledger.prisma:384-435` `ProviderReconciliationRun` → drop migration (shadow-DB workflow).
2. Domain trio + `core.database.module.ts:19,261` registration; `client.ts:155` and `tenant-scope.ts:231-236` entries.
3. `packages/applications/src/services/metering/reconciliation/`: delete `provider-reconciler.ts`, `provider-reconciler-registry.ts`, `provider-reconciliation-window.ts`, `dto/provider-reconciliation-run.response.ts`, their tests; edit `shadow-metering.service.ts` (strip `reconcileProviders`, `persistRuns`, `cloudLedgerControlTotal`, `findReconciliationRuns`, `findLatestReconciliationPerProvider`, registry/repository wiring), `IShadowMeteringService.ts`, `shadow-metering.constants.ts` (`PROVIDER_DRIFT_DETECTED_EVENT`), `dto/drift-report.ts` (keep `TenantDriftReport`/`ShadowMeteringSweepResult`), barrel.
4. `apps/api/src/modules/admin-usage/admin-reconciliation.controller.ts` deleted; `admin-usage.module.ts` registration removed; `openapi/tags.ts:370-373` reworded.
5. Console: `features/reconciliation/**`, `app/(console)/(global)/ai-operations/reconciliation/page.tsx` (a one-release `redirect('/ai-operations/consumption')` stub), nav entry `nav-config.ts:375-382`, nav tests.
6. Regenerate `vox-node` admin (`usage.ts` loses `latest/run/runs`), `route-manifest.json`, `openapi.json`, portal.
7. Docs: `api-controller-inventory.md:172,1361-1372`, `api-controller-groupings.md:145,234`, `consultation-session-workflow/assessment/evidence/surfaces.md:76`.

No seeds, no `ResourceType`, no e2e spec exist for it; the generated authz matrix self-updates.

### 3.4 Console removals and redirects

| Route | Action |
|---|---|
| `/ai-platform` | one-release `redirect('/ai-providers')`; feature folder deleted after the Providers tab code moves to `features/ai-providers` as a full screen |
| `/ai-providers` | **new route page** (`(shared)/ai-providers/page.tsx`) hosting the existing `provider-credentials-tabs.tsx` + test-connection + ceilings + used-by |
| `/ai-task-defaults` | stub deleted (its window has passed once this ships) |
| `/ai-runtime-profiles` | deleted (no nav entry existed) |
| `/ai-configuration` (Speech & Voice) | one-release `redirect('/agents')` after TASK-861/863 land |
| `/ai-operations/reconciliation` | one-release `redirect('/ai-operations/consumption')` |
| `/ai-services`, `/ai-services/{lm-studio,vllm,mlflow}` | keep (read-only engine status; vLLM subject to TASK-860 OD-1) |
| Nav | `AI Platform` domain lists: AI models (10-19) · AI providers (20-29) · AI services (10-19) · Agentic policy (10-19); `Knowledge & Agents`: Agents · Workflow Studio · Assignments · Prompt templates · Context schemas · Document templates · Knowledge base |

### 3.5 Deprecations (mark now, remove in release +2)

`admin/ai-providers` alias, `admin/{tts,stt}-config/credentials/**`, `AiTaskDefault` (table + service + `vox-node` resource), `AiRuntimeProfile` (all layers), `TenantTtsConfig` (all layers, with TASK-863), `/ai-platform`, `/ai-configuration`, `features/ai-task-defaults`, `features/ai-runtime-profiles`, `features/tenant-tts-config`, `features/tenant-stt-config`, `AiProviderConnection.service = 'model-registry'` rows for `s3` (the publisher uses the bucket reader/publisher credentials from the deployment, not a tenant-style connection — owner to confirm) — recorded in the register.

## 4. Implementation Plan

| # | Step | RED test | Files |
|---|---|---|---|
| 1 | Reconciliation removal (§3.3) end to end, artifacts regenerated | `pnpm test:unit` green with the folder gone; `api:openapi:check`, `gen:admin:check` | listed in §3.3 |
| 2 | `AiProviderConnection` ceilings migration; `ProviderCredentialResolver` extraction with `fundingTier` | resolver tests: tenant wins, SYSTEM fallback, veto, entitlement gate, funding derived | `packages/database`, `packages/applications/src/services/ai-provider-connection/**` |
| 3 | `POST admin/providers/:service/:provider/test` + per-provider probes (ephemeral); remove `admin/ai-providers` alias and the two credential facades | controller tests; e2e `task-862-provider-test.spec.ts` | `apps/api/src/modules/ai-provider-connection/**`, `tenant-{tts,stt}-config/**` |
| 4 | `AiTaskDefault` strangler completion: guardrail SQL repoint, TS readers repoint, delete service/controller/screen/vox-node resource, drop table | `pnpm guardrail:test` (tenant_config on routing policy), applications tests for every repointed reader | `apps/guardrail/src/guardrail/core/tenant_config.py`, `packages/applications/**`, `apps/api/**`, `apps/admin-console/**` |
| 5 | `AiRuntimeProfile` removal (all layers) | build green with the trio gone | — |
| 6 | Console: `/ai-providers` route + screen (§3.1); `/ai-platform` → redirect; nav rewrite; redirect tests | screen tests, axe 0, both themes, `next-dev-loop` runtime pass | `apps/admin-console/src/{app,features,shared/navigation}/**` |
| 7 | Seeds (§3.2) + seed tests (no `llm:sarvam`; SYSTEM cloud rows disabled; no `AiTaskDefault`/`AiRuntimeProfile` seeding) | seed tests | `packages/database/src/prisma/db_main/seed/**` |
| 8 | Docs: `data-and-domain-model.md` (unique key `(tenant, service, provider)`; `AiRoutingPolicy` section; `AiTaskDefault` removed), `model-and-config-plane.md` §3–5, `api-controller-inventory.md` (`AiRoutingPolicyAdminController` entry), rule `09` BYO paragraph, deprecation register | — | docs |

### Verification criteria

- Gates green; `grep -rn "reconcil" apps packages --include=*.ts --include=*.tsx --include=*.py` returns only shadow-metering and pipeline-template-resync hits.
- Live proof: as a tenant admin, add an Azure OpenAI key on `/ai-providers`, test connection OK, publish an LLM agent on an Azure model (TASK-863) → invocation bills as `BYOK`/`BYOK_NOTIONAL`; disable the row → invocation fails closed with `PROVIDER_VETOED`; delete the row → the SYSTEM key serves and bills `CLOUD`/`INTERNAL`.
- No route under `/ai-platform`, `/ai-task-defaults`, `/ai-runtime-profiles`, `/ai-operations/reconciliation` renders a screen.

## 5. Decisions taken (owner may override)

| # | Decision | Alternative rejected |
|---|---|---|
| OD-1 | Cloud vendor HTTP calls stay in the Python services with gateway-resolved credentials ("governed by the gateway"). | Moving them into NestJS — duplicates STT streaming sessions and the text adapter set; the security property (no client ever holds a vendor key) already holds. |
| D-2 | `AiRoutingPolicy` survives as the non-agent task-default table; its tenant screen does not. | Retire it too — guardrail/NER defaults would have no home. |
| D-3 | `AiRuntimeProfile` retired; ceilings move to the connection, hyper-parameters to the agent. | Keep a third place for tuning knobs. |
| D-4 | Sarvam LLM connection removed rather than an adapter added. | Adding a Sarvam generate adapter — no product requirement and no catalogue model. |

## 6. Open questions for the owner

1. Confirm OD-1.
2. `model-registry` connections (`huggingface`, `s3`): keep on `/ai-providers` as SYSTEM-only rows (recommended for the HF token) or move the S3 credential entirely to deployment secrets?
3. Should tenant admins see the read-only engine screens (`/ai-services/*`) or stay super-admin-only (current)?

## 7. Implementation Summary

Implemented 2026-09-04 on branch `task-862-ai-providers` (worktree `hope-v2-task-862`, base `dev-2.2` @ `1896ebc03`), seven commits, TDD per step. Gates run package-scoped (no root aggregates, no DB, no e2e — orchestrator surfaces).

| Step | Outcome |
|---|---|
| 1 Reconciliation removal | `ProviderReconciliationRun` model + domain trio + allow-list entries gone; `metering/reconciliation/` keeps ONLY the shadow-metering sweep (`provider-reconciler*`, `provider-reconciliation-window`, the run DTO, `reconcileProviders`/`persistRuns`/`cloudLedgerControlTotal`/`find*Reconciliation*` and `PROVIDER_DRIFT_DETECTED_EVENT` deleted); `AdminReconciliationController` + query DTO deleted (`ShadowMeteringServiceModule` stays imported in `AdminUsageApiModule` — it is what registers the sweep); boot-audit lists 70→67; `admin-usage` tag reworded; console `features/reconciliation` deleted, `/ai-operations/reconciliation` → one-release `redirect('/ai-operations/consumption')`, nav entry removed. |
| 2 Ceilings + resolver | `AiProviderConnection.{maxConcurrent,rpmLimit,tpmLimit,timeoutS}` (entity validates positive integers; factory/mapper/DTOs/service carry them); **`ProviderCredentialResolver.resolve(service, provider, tenantId): Promise<{ override, fundingTier, connectionId } \| null>`** built on the service's now-public `cascadeRows`/`toOverrideEntry` (same tier reads and decrypt as the request fold — funding cannot fork); `ProviderVetoedException` (extends `ProviderCredentialVetoedException`, 409) on a disabled tenant row; `QuotaExceededException` (403) when the entitlement gate suppresses a cloud SYSTEM tier; exported from the applications barrel + module. `constants.ts` Anthropic/Vertex note corrected. |
| 3 Test route + facades | `POST admin/providers/:service/:provider/test` → `ProviderConnectionProbe` (auth probes: OpenAI/Anthropic/Azure OpenAI deployments/Azure Speech STS/Qdrant/HF whoami; reachability: Sarvam, Foundry, self-host; SSRF guard, SYSTEM may probe in-cluster http; omitted fields fall back to the stored row, stored key decrypted for the probe only). `admin/ai-providers` alias controller deleted (e2e specs repointed to `admin/providers/llm`); `admin/{tts,stt}-config/credentials/**` + their service methods/DTOs/console hooks deleted; `@ApiDeprecated` decorator (`Deprecation`/`X-Deprecation-Notice`/`Link`/optional `Sunset` + `deprecated: true` on the operation) on every `admin/tts-config` route. |
| 4 AiTaskDefault facade + guardrail | `AiRoutingPolicyService.resolveDefault(tenantId, taskKey, { systemOnly?, noWiden? })` added; `AiTaskDefaultService` reads through it and `upsertRow` writes ONLY the elected `AiRoutingPolicy` row (OCC on that row's version; `AiTaskDefaultRepository` no longer injected) — the table is neither read nor written; token/interface/DTOs kept and `@deprecated TASK-862 — removed in R3`; controller routes carry `@ApiDeprecated`. `apps/guardrail/core/tenant_config.py` selects `AiRoutingPolicy ⋈ AiModel` by `modelId` (elected + ACTIVE; a DISABLED or `enabled=false` tenant row is a veto), tuning read off the winning row's `configJson`; `AiRuntimeProfileRead` gone. |
| 5 AiRuntimeProfile removal | Prisma model, domain trio, service module, controller, console feature/route, e2e spec, scope `admin:ai-runtime-profile:manage`, tag, boot-audit rows removed. Consumers edited: `EffectiveConfigService` now serves `runtimeProfiles` (the wire `apps/text` reads for pool limits) from the SYSTEM `llm` connection CEILINGS (provider-level, hyper-parameter fields null); `TextRequestEnrichmentService.applyTextRuntimeProfile` is a deprecated no-op (callers in prompt-management/summary/live-documentation left untouched); `TextProxyController`/`AiInferenceController` no longer inject the profile service. One migration `…_task_862_provider_consolidation` (add 4 columns, drop `AiRuntimeProfile`, drop `ProviderReconciliationRun`). |
| 6 Console | New `/ai-providers` screen (`features/ai-providers`): tier control (moved from the hub; every read/write carries `?tenantId=`), 7 service tabs × provider cards with the three-state badge, ceilings, "Test connection", "Use platform default" (remove), OCC; "Used by" panel = routing bindings of the tier (403 → "managed by the platform"; agents/workflows placeholder). `/ai-platform` → `redirect('/ai-providers')`, `features/ai-platform` + `ai-task-defaults` + `ai-runtime-profiles` deleted (this also removes the base build/lint failures in `huggingface-fetch-drawer.tsx` and `ai-platform-screen.test.tsx`); `/ai-task-defaults` stub and `/ai-runtime-profiles` route deleted; Speech & Voice screen relocated to `features/tenant-tts-config/components/speech-and-voice-screen.tsx` (deprecated); task-key lockstep test moved to `shared/catalog/__tests__`; nav per §3.4 (see Change History). axe 0 violations on the new/relocated screens in both themes. |
| 7 Seeds | `16-ai-task-default.ts` → **`16-ai-routing-policy.ts`** (the twelve SYSTEM elections as `AiRoutingPolicy` rows, CREATE-ONLY, model bound by FK, unresolvable slug skipped = fail closed); `18-ai-runtime-profile.ts` deleted; `llm:sarvam` row removed from `17-…`; seed tests repointed. |
| 8 Docs | `data-and-domain-model.md` §5.7, `model-and-config-plane.md` §1/§3–5, `api-controller-inventory.md` (+ `AiRoutingPolicyAdminController`), `api-controller-groupings.md`, `surfaces.md`, deprecation register rows. |

### Gates (package-scoped, all green at the final commit)

- `pnpm --filter @arcaai/database test` — 79 files / 1842 tests; `gen:model:check`, `gen:entity:check`, `gen:factory:check` no drift, coverage OK.
- `pnpm --filter @arcaai/domains build && test` — 158 files / 1881 tests.
- `pnpm --filter @arcaai/applications build && test` — 646 files / 10 948 tests (the only failure seen, `task-724-stt-realtime-untouched.grep-gate`, is a `git status` gate that is green on the committed tree).
- `pnpm api:build` — green; targeted `vitest` over `ai-provider-connection`, `admin-usage`, `ai-task-default`, `tenant-{tts,stt}-config`, `streaming`, `ai-inference`, `internal`, `bootstrap`, `openapi` — green.
- `pnpm --filter @arcaai/admin-console build lint test` — build green (Next 16), lint 0 warnings, 254 files / 2258 tests; `tsc --noEmit` clean.
- `pnpm guardrail:test` — 426 passed.

### Not done in this wave (orchestrator follow-ups)

- **Artifacts** (orchestrator-owned): `pnpm api:route-manifest && api:openapi && api:portal && pnpm --filter @arcaai/vox-node gen:admin` — the generated `vox-node/src/resources/admin/{usage,ai-runtime-profile,ai-provider-connection…}.ts`, `openapi.json`, `route-manifest.json` and the console's `api-docs/openapi.*.json` are stale until regenerated.
- **`AiTaskDefault` table drop + reader repoint** (deviation 1): the 17 DI consumers of `IAiTaskDefaultService` (listed in the return contract) still call the facade.
- **gemma-4 `reasoning_effort: none`**: the retired runtime-profile seed row was the ONLY path that switched gemma-4 thinking off on the realtime nodes; until TASK-863 seeds it on the agent's parameters, TEXT requests carry only caller-set parameters (documented in `model-and-config-plane.md` §5).
- e2e specs repointed but not run (`admin-providers`, `ai-provider-connections*`, `byo-llm-credentials`); no `task-862-provider-test.spec.ts` was written (no live gateway in the worktree).

## 8. Change History

| Date | Change |
|---|---|
| 2026-09-04 | Ticket created from the TASK-859 review. |
| 2026-09-04 | Implemented (steps 1–8, see §7). **Deviations imposed for parallel safety:** (1) `AiTaskDefault` is NOT dropped — `AiTaskDefaultService` is a facade over `AiRoutingPolicyService.resolveDefault`, no table reads/writes, token kept, everything `@deprecated … removed in R3`; (2) `AiRuntimeProfile` and `ProviderReconciliationRun` removed in this wave including the drop migration (`ResourceType.AiRuntimeProfile` enum member left — a Postgres enum value removal is a rewrite); (3) migration authored via `prisma migrate diff` against `dev-2.2`'s schema, never applied; (4) the `/ai-providers` "Used by" panel lists routing-policy bindings only (agents arrive with TASK-863); (5) `ProviderCredentialResolver` exported with the agreed signature. **Further deviations:** the effective-config `runtimeProfiles` wire is KEPT and served from SYSTEM connection ceilings (apps/text's pool limits read it — dropping it would have silently removed provider limits); `TextRequestEnrichmentService.applyTextRuntimeProfile` kept as a deprecated no-op because prompt-management/summary/live-documentation (not this ticket's files) still call it; a `16-ai-routing-policy.ts` seed was CREATED (README §3.2 said "verify a routing seed exists, else create") — a cold seed would otherwise have no SYSTEM task default and every guardrail/NER task would fail closed; the Sarvam probe is a reachability HEAD (no 1-second STT/TTS call — the vendor has no auth-only route and a real call needs audio); the probe runs from the gateway (metadata calls, OD-1 is about inference). **Nav (§3.4):** `/ai-platform` → `/ai-providers` (20-29, `read|manage:GlobalSetting`, domain `ai-platform`); `/ai-operations/{runs,metrics,consumption}` → `platform-ops`; `/tools-mcp`, `/workflow-studio`, `/workflow-studio/assignments` → `knowledge-agents`; `/ai-configuration` stays in `ai-platform` (deprecated, R4); the retired `/agents` comment block left byte-identical for TASK-863. |

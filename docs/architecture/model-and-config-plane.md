# HOPE Model & Configuration Plane

|           |                      |
| --------- | -------------------- |
| **Owner** | Platform / Inference | **Introduced** 2026-07-21 · **Last verified** 2026-07-21 |

Authoritative reference for how HOPE decides **which model runs a task, where its
provider lives, how it is authenticated, how long it stays resident, and how an
admin changes any of that at runtime without a redeploy**. This is the config /
model plane that sits underneath the AI services described in
[overview.md](./overview.md); the persisted models are catalogued in
[data-and-domain-model.md](./data-and-domain-model.md#57-ai-config-plane).

The plane is a **control plane in Postgres, read at request time by the gateway,
and either injected into (or polled by) the stateless Python services**. No
Python service reads Postgres directly; each either receives resolved values from
the gateway on the request path or polls a service-token-authenticated internal
endpoint for its own service-level knobs.

---

## 1. Layers at a glance

| Layer                         | Persisted in                                         | Resolved by                                         | Consumed by                                              |
| ----------------------------- | ---------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| Settings registry / catalog   | descriptor code + `GlobalSetting` (`global-kv` lane) | `EffectiveSettingsService` (registry-key addressed) | admin console (catalog), internal effective-config route |
| Task → model selection        | `AiTaskDefault`                                      | `AiTaskDefaultService.getEffective`                 | gateway proxies to guardrail / nlp / smr / harness       |
| Provider location + auth      | `AiProviderConnection`                               | provider resolver (tenant → SYSTEM → env)           | gateway inference proxies                                |
| Hyperparameters / concurrency | `AiRuntimeProfile`                                   | injection-time cascade                              | gateway inference proxies                                |
| Model registry + discovery    | `AiModel` (+ live server enumeration)                | `AiModelDiscoveryService` (merge view)              | admin registration, pipeline / task references           |
| Model source resolution       | `AiModel.sourceUri` / `localPath`                    | each service's `resolve_model_dir`                  | stt, guardrail, nlp, harness                             |
| Model lifecycle / retention   | `global-kv` settings keys                            | internal effective-config route                     | in-process model caches (all services)                   |
| Pipeline governance           | `AsrPipeline` (template lineage)                     | pipeline service (clone / resync)                   | stt pipeline reader                                      |
| Per-tenant TTS spec           | `TenantTtsConfig` (+ BYO credential)                 | `TenantTtsConfigService`                            | gateway → tts (stateless)                                |
| External identity             | `TenantIdentityProvider` (+ federation)              | `idp-resolver`                                      | auth (OIDC login)                                        |
| External tools                | `McpServer`                                          | harness at call time                                | harness MCP transport                                    |

Every model row follows the standard field template (uuid v7 id, `_version` OCC,
`tenantId`, soft-delete `resourceStatus`, audit columns) unless it is explicitly
telemetry (see [data model §5.10](./data-and-domain-model.md#510-agentic-telemetry--evaluation)).
The reserved SYSTEM tenant `00000000-0000-0000-0000-000000000000` owns every
platform-default row.

---

## 2. Settings registry, catalog & effective config

The **settings registry** is a single queryable catalog assembled from
descriptor arrays that feature modules contribute
(`packages/applications/src/services/settings-registry/registry.ts` →
`HOPE_SETTINGS_REGISTRY`). Descriptor groups currently registered: pipeline
toggles, TTS, entitlements, model defaults, agentic-context knobs, platform-ops
(rate limiting, audit retention, agent-trajectory retention), and stt / nlp
service-runtime knobs. Registering a key at its current runtime default changes
no behaviour — it only makes the key **catalogable and admin-addressable**.

Each descriptor carries a `tier`, a `sensitivity` (`secret` keys are never
resolvable through a read surface), and scope rules (`globalOnly` keys are
system-scoped, never tenant-set).

### Resolution — first-set-wins cascade

`walkCascade` (`settings-registry/scope-cascade.ts`) is the dependency-free
primitive: walk the caller-ordered tiers deepest → shallowest and return the
**first tier that supplies a set value**, else the code default. `false` / `0` /
`""` count as _set_; only `null` / `undefined` mean "inherit". Tier ordering and
max-scope filtering are the caller's responsibility.

`EffectiveSettingsService` (`settings-registry/effective-settings.service.ts`) is
the registry-key-addressed read facade — "what is the effective value of key `K`
for this context, and which tier set it?". It delegates to the existing per-tier
resolvers (pipeline toggles via `ConfigResolver`, `models.*` via
`AiTaskDefaultService`, KV lane via `AppSettingsService`) rather than
re-implementing data access, and **refuses `secret`-sensitivity keys** so a
secret value can never leak through a config read. It returns the value plus the
`sourceScope` that supplied it (audit/debug trace).

### Serving config to the Python services

Service-level knobs (not per-request model selection) are pulled by each Python
service over an internal, service-token-authenticated route:

```
GET /api/v1/internal/effective-config?service=<name>
```

`effective-config.controller.ts` (guarded by `InternalServiceTokenGuard`, `@Public()`
so the boot-time route-permission audit passes, excluded from public Swagger).
`<name>` ∈ `smr`, `stt`, `nlp`, `guardrail`, `harness`, `tts`; an unknown
service is a 400. If the control plane is unreachable a service keeps its own
env/bootstrap value — **a degraded control plane never changes behaviour**.

The admin console reads/writes the catalog through the gateway's
`settings-catalog` module (catalog endpoint + registry-write controller with the
standard `_version` / `If-Match` OCC path).

---

## 3. Task → model selection (`AiTaskDefault`)

`AiTaskDefault` is the per-`(tenant, taskKey)` "default model for task X"
selector — the generalization of `HarnessPolicy.smrProvider/smrModel` to
non-pipeline AI tasks. `taskKey` examples: `guardrail.validate`, `nlp.ner`,
`nlp.classification`, `smr.*`, `harness.*`. `modelSlug` references `AiModel.slug`
within `[tenant, SYSTEM]` scope (no FK — the house slug-reference convention).

Resolution (`AiTaskDefaultService.getEffective`): **tenant row → SYSTEM row →
consuming service's env fallback**.

**Governance:** every task-key prefix (`guardrail.`, `nlp.`, `smr.`, `harness.`)
is **super-admin-only** — writes are gated by an `isSuperAdmin` service-layer
guard (`SUPER_ADMIN_ONLY_TASK_PREFIXES` in
`packages/applications/src/services/ai-task-default/constants.ts`). Tenants only
_consume_ the SYSTEM-row platform default; no task key is tenant-admin editable
and runtime resolution ignores per-tenant override rows. This mirrors the
imperative privilege pattern documented in the API gateway rules — the
permission decorator says `manage`, but the real gate is "super admin only".

The gateway's `ai-inference` proxy (user-plane `/ai/*` over Guardrail + NLP)
resolves the effective task-default model, validates any caller-supplied model
override against the registry, and forwards it alongside a resolved runtime
profile.

---

## 4. Provider location & BYO credentials (`AiProviderConnection`)

`AiProviderConnection` records **where a serving provider lives and how to
authenticate to it** — one row per `(tenant, provider)`, the SYSTEM row being the
platform default. It generalizes the earlier per-tenant TTS credential model to
all LLM providers. `provider` is a validated string (no Prisma enum, per the
`AiModel.provider` convention): `ollama`, `lm-studio`, `azure`, `bedrock`,
`built-in`, `sarvam`, `vllm`, `llama-cpp`. Provider-specific location columns:
`baseUrl` (ollama / lm-studio / vllm / llama-cpp / azure endpoint), `region`
(bedrock), `apiVersion` / `deploymentName` (azure), plus a validated `extraJson`.

**Credential handling (data class 2 — per-tenant secret as ciphertext in a DB
column):** `encryptedApiKey` is Vault-Transit ciphertext written through the
shared secret-field utility; plaintext is never stored and **no read DTO ever
returns it** (a `hasKey` boolean only). `keyVersion` tracks the Transit key
generation for rotation.

**Boundary:** tenant rows are allowed **only for cloud API providers** (azure,
bedrock) — the service layer returns 403 otherwise; self-host engines
(ollama / lm-studio / vllm / llama-cpp / built-in) are SYSTEM-only. This is a
403 privilege boundary, not the 404-over-403 cross-tenant posture.

**Resolution:** tenant row (enabled) → SYSTEM row → service env fallback.
`AiProviderConnection` is a SYSTEM-shared read model (`SYSTEM_SHARED_READ_MODELS`):
every tenant's resolver may read the SYSTEM catalog row, but the widening is
`[caller, SYSTEM]` only and never exposes another tenant's BYO row.

BYO cloud-credential admin flows live under the gateway's
`ai-provider-connection` module (`apps/api/src/modules/ai-provider-connection/`).

---

## 5. Hyperparameters & concurrency (`AiRuntimeProfile`)

`AiRuntimeProfile` holds hyperparameters, context budget and concurrency limits
**per provider** (`modelSlug = ""`, the provider-level default) or **per model**
(`modelSlug = AiModel.slug`). Numeric fields (`temperature`, `topP`, `maxTokens`,
`contextLength`, `maxConcurrent`, `tpmLimit`, `rpmLimit`, `timeoutS`,
`keepAliveSeconds`) are all nullable — null means "no opinion, fall through the
cascade" — plus an engine-specific `extraJson` (`n_threads`, `n_gpu_layers`,
`num_predict`, …).

`modelSlug` uses an **empty-string sentinel** for the provider default rather
than null, because Postgres treats NULLs as distinct in unique indexes (which
would allow duplicate provider-default rows and break the compound-unique
upsert).

This program keeps runtime profiles **super-admin-only and SYSTEM-tenant-only**
(hyperparameters are a platform concern); `tenantId` is retained for the house
template and forward compatibility.

**Injection cascade** (highest → lowest precedence):

```
explicit request params → AiTaskDefault.configJson → profile(modelSlug)
                        → profile(provider default, "") → service env default
```

---

## 6. Model registry, discovery & source resolution

### 6.1 Registry (`AiModel`)

`AiModel` is the standalone registry for every model the platform knows about —
ASR / VAD / denoise engines and admin-selectable LLM / guardrail / NLP / TTS
task models. Models are referenced **by slug** in pipeline YAML and by
`AiTaskDefault.modelSlug`; there are no FK relations. Classification is by
`category` / `taskType` / `modelType` enums; serving models additionally carry a
nullable `provider` and `architecture`.

### 6.2 Discovery hub

`AiModelDiscoveryService` / `AiModelDiscoveryController` (gateway `ai-model`
module) produce a **merge view** of registered `AiModel` rows against models
enumerated live from server-managed providers
(`DISCOVERABLE_AI_MODEL_PROVIDERS = ['ollama', 'lm-studio', 'vllm', 'llama-cpp']`).
Each entry carries a status:

| Status                         | Meaning                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `registered`                   | governance row exists and the model is present on its server |
| `discovered`                   | live on a server but not yet a governance row                |
| `registered-missing-on-server` | governance row exists but the server no longer serves it     |

Explicit **register** promotes a discovered model into a governance row.
`normalizeModelSlug` deterministically lowercases and hyphen-collapses the
server's model name (`llama3.1:8b-instruct-q4_K_M` → `llama3-1-8b-instruct-q4-k-m`);
there is deliberately **no collision suffixing** — a taken slug surfaces as an
actionable 400 so the admin names the row on purpose.

### 6.3 Source resolution

`AiModel.sourceUri` follows a scheme grammar honoured by every service's
`resolve_model_dir` (stt, guardrail, nlp, harness):

| Scheme                                   | Behaviour                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `hf:<org>/<repo>` or bare `<org>/<repo>` | HuggingFace Hub snapshot; honours `HF_HUB_OFFLINE`                      |
| `file:///abs/path`                       | verified in place, never copied                                         |
| `s3://bucket/prefix`                     | downloaded once into the service cache, single-flight + SHA256-verified |

Anything else is a hard `ModelSourceError` — never a silent fallback
(`azure-blob://` is deferred). `AiModel.localPath` is an operator/admin override
with the **highest precedence**, ahead of scheme dispatch (air-gapped hosts,
pre-staged NFS mounts); a set-but-missing `localPath` falls through to scheme
dispatch with a warning. `checksum` (SHA256) is verified for single-file
artifacts (GGUF / ONNX) after download and on first use of a pre-existing cache
entry — a mismatch is a hard error and the model is never served; on directory
snapshots it is a documented no-op.

---

## 7. Model lifecycle & retention

Every in-process model is loaded **on first request** and released after an
**idle TTL** (default **600 s**, clamped to `[60 s, 3600 s]`). Models in active
use are _pinned_ and never evicted. Retention is set from the admin console
(settings registry), served over the internal effective-config route, and
applied within one refresh window (~60 s).

Keys are `globalOnly`, `tier: global-kv`, system-scoped:

| Key                             | Default                                         | Meaning                                           |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| `<svc>.modelCache.ttlSeconds`   | 600                                             | idle TTL before eviction (clamped `[60, 3600]`)   |
| `<svc>.modelCache.maxModels`    | stt 5 · nlp 3 · guardrail 2 · harness 1 · tts 2 | max resident models (LRU beyond it)               |
| `<svc>.modelCache.vramBudgetMb` | 0 (unset)                                       | optional VRAM bound (NVML hosts only)             |
| `stt.modelCache.maxMemoryMb`    | 10000                                           | stt only — MB-estimate budget                     |
| `smr.modelCache.ttlSeconds`     | 600                                             | not a cache — forwarded to server-managed engines |

`<svc>` ∈ `stt`, `nlp`, `guardrail`, `harness`, `tts`. **Key prefix ≠ service
name for tts:** the service registers/polls as `tts` but its settings live
under the `tts` prefix — both spellings are load-bearing. The operator runbook is
[operations/inference/model-retention.md](../operations/inference/model-retention.md).

---

## 8. Pipeline template governance (`AsrPipeline`)

The nine SYSTEM-tenant `AsrPipeline` rows are **templates**
(`sourceTemplateSlug = null`, `templateLocked = false`). At tenant provisioning
each template is **cloned into the tenant**; every copy records the template's
slug in `sourceTemplateSlug` (provenance survives clone chains) and is
`templateLocked = true`.

A `templateLocked` copy is **read-only for content edits and delete** — the
application layer returns 403 _"clone to customize"_ — while enable/disable and
set-default remain available. `templateLocked` is absent from every request DTO,
so the gateway's whitelist pipe rejects any attempt to flip it over the API.

- **Clone** (`POST /api/v1/admin/audio/pipelines/:id/clone`) makes a new,
  unlocked, editable copy that keeps the source's template provenance.
- **Resync** (`POST /api/v1/admin/tenants/:id/pipelines/resync`, the
  `TenantPipelineResyncController`) fast-forwards _pristine_ locked copies to the
  template's current config and never touches unlocked rows; it reports
  `{ added, fastForwarded, skipped }`.

The `[tenantId, templateLocked]` index backs the per-tenant locked-copy sweep.

---

## 9. Adjacent plane surfaces

- **Per-tenant TTS** (`TenantTtsConfig` + `TenantTtsProviderCredential`): one
  DB-backed, tenant-admin-editable TTS spec per tenant (SYSTEM row = platform
  default; null/`[]` inherits; every value clamped to `PLATFORM_TTS_LIMITS`),
  resolved by the gateway and injected into the stateless tts service. BYO
  provider keys are Vault-Transit ciphertext and are **not** SYSTEM-shared.
- **External identity** (`TenantIdentityProvider` + `FederatedIdentity` +
  `TenantIdentityProviderDomain`): per-tenant OIDC federation (v1); client
  secret + directory credentials are Vault-Transit refs. Home-realm discovery
  routes a verified email domain to exactly one provider. The `idp-resolver`
  service backs OIDC login. SAML lands on the same table via a follow-up ticket.
- **External tools** (`McpServer`): super-admin-managed registry of MCP tool
  servers the harness may call. SYSTEM-only rows + SYSTEM-shared read; **no
  secret material in the DB** (`authRef` is a Vault path only, resolved at call
  time). `phiBoundary` defaults to `"external"` so an unmarked server is treated
  as cloud egress and the harness PHI-egress guard screens outbound tool args
  fail-closed. `enabled` is a per-server kill-switch; the whole feature is
  additionally gated off by `HarnessPolicy.mcpToolsEnabled` (default off). All
  tools are read-only.

---

## 10. Program status & open tails

Verified status on the last-verified date:

| Area                                                                                                                                                                         | State                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Config-plane core, service adoption, BYO creds, source resolution, discovery hub, lifecycle/retention, pipeline governance, governance-console IA, retention-client adoption | Landed on `fix/2605-review`                                                                       |
| Agentic-loop completion                                                                                                                                                      | Review — the agentic loop is complete except for the owner/hardware-gated pass (GPU, credentials) |
| End-to-end validation                                                                                                                                                        | **Pending** — the program closeout / e2e gate has not run                                         |

Two runtime tails are honest limitations, not doc drift:

- **Streaming Sortformer diarization is unvalidated pending GPU.** The NeMo
  loader is implemented but the weights are not staged and there is no CPU/ONNX
  path, so the live diarizer degrades to "no labels" — today's default
  diarization-off behaviour (see [overview §3.5](./overview.md#35-speaker-diarization--voice-profile-enrollment)).
- **The ECAPA-TDNN (192-dim) speaker-embedding cutover is not applied.** Voice
  profiles run on the 256-dim default embedding model; the cutover is a config +
  `vector(192)` migration + re-enroll step.

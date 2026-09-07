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
| Task → model selection        | `AiRoutingPolicy` (elected `isDefault` row)          | `AiRoutingPolicyService.resolveDefault` (TASK-862)  | gateway proxies to guardrail / nlp / text / harness; guardrail's own SQL read |
| Provider location + auth + ceilings | `AiProviderConnection`                          | `ProviderCredentialResolver` (tenant → SYSTEM, veto, entitlement gate) | gateway inference proxies, agents (TASK-863), workflow nodes |
| Hyperparameters               | the Agent (TASK-863); connection CEILINGS live on `AiProviderConnection` | agent resolver / `runtimeProfiles` on the effective-config pull | Python services (pool limits), agents |
| Model registry + discovery    | `AiModel` (+ live server enumeration)                | `AiModelDiscoveryService` (merge view)              | admin registration, pipeline / task references           |
| Model source resolution       | `AiModel.sourceUri` / `localPath`                    | each service's `resolve_model_dir`                  | stt, guardrail, nlp, harness                             |
| Model lifecycle / retention   | `global-kv` settings keys                            | internal effective-config route                     | in-process model caches (all services)                   |
| Pipeline governance           | `AsrPipeline` (template lineage)                     | pipeline service (clone / resync)                   | stt pipeline reader                                      |
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
`AiRoutingPolicyService.resolveDefault`, KV lane via `AppSettingsService`) rather than
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
`<name>` ∈ `text`, `stt`, `nlp`, `guardrail`, `harness`, `tts`; an unknown
service is a 400. If the control plane is unreachable a service keeps its own
env/bootstrap value — **a degraded control plane never changes behaviour**.

The admin console reads/writes the catalog through the gateway's
`settings-catalog` module (catalog endpoint + registry-write controller with the
standard `_version` / `If-Match` OCC path).

---

## 3. Task → model selection (`AiRoutingPolicy`)

**TASK-862 finished the `AiTaskDefault` strangler.** The per-`(tenant, taskKey)`
"default model for task X" is the ELECTED `AiRoutingPolicy` row (`isDefault =
true`, at most one per selection — a DB-enforced partial unique index), which
binds a catalogue model by FK (`modelId`) and, optionally, a provider connection
by FK (`providerConnectionId`). `AiTaskDefault` is neither read nor written any
more and is dropped in R3.

Resolution — `AiRoutingPolicyService.resolveDefault(tenantId, taskKey)`:
**tenant elected row → SYSTEM elected row → null**, widening only on ABSENCE.
`getEffective` is the richer read for the router (match predicate, funded and
gated fallback chain). `AiTaskDefaultService` survives one release as a FACADE
over `resolveDefault` (reads) and the elected row (writes) so its ~17 DI
consumers keep compiling while they are repointed.

`apps/guardrail` — the one Python service with a sanctioned direct SQL read —
selects `AiRoutingPolicy ⋈ AiModel` by `modelId` (tenant → SYSTEM, a DISABLED or
switched-off tenant row is a VETO, fail-closed) and takes its judge tuning
(`temperature` / `maxTokens` / `timeoutS`) off the winning row's `configJson`.

**Governance:** `nlp.*` / `harness.*` keys are super-admin-only to write and
resolve SYSTEM-only; `text.*` and `guardrail.*` accept tenant writes, and
`guardrail.*` carries the platform floor (a tenant write must name a SYSTEM
catalogue model). The SYSTEM election is edited from the model registry's
"platform default for task" action (TASK-860); tenant choice for agentic tasks
moves to the Agent (TASK-863). There is no tenant screen for routing policies.

---

## 4. Provider location, BYO credentials & ceilings (`AiProviderConnection`)

`AiProviderConnection` records **where a serving provider lives, how to
authenticate to it, and how hard it may be driven** — one row per
`(tenant, service, provider)`, the SYSTEM row being the platform default.
`service` is the capability discriminator (`llm | stt | tts | embeddings |
rerank | vector | model-registry`); `provider` is capability-scoped (`azure` is
Azure OpenAI under `llm`, Azure Speech under `stt`). Location columns:
`baseUrl`, `region`, `apiVersion`, `deploymentName`, plus a validated
`extraJson`. **Ceilings** (TASK-862, moved here from the retired
`AiRuntimeProfile`): `maxConcurrent`, `rpmLimit`, `tpmLimit`, `timeoutS` —
nullable, a positive integer is a hard cap. The SYSTEM `llm` rows' ceilings are
what the effective-config pull serves to `apps/text` as `runtimeProfiles`
(provider-level, `modelSlug: ''`), so the provider pool keeps its limits.

**Credential handling (data class 2):** `encryptedApiKey` is Vault-Transit
ciphertext; plaintext is never stored and **no read DTO ever returns it**
(`hasKey` only). `keyVersion` tracks the Transit key generation.

**Three states, per `(service, provider)`:** no row = no opinion, the platform
default may serve (subject to `featurePlatformDefaultCredential`); enabled +
keyed = the tenant's own credential wins and SYSTEM is not consulted;
**disabled = a VETO** that blocks the platform key too and never falls through
to another provider. Tenant rows are allowed **only for the cloud BYO providers
listed per service** (`CLOUD_BYO_PROVIDERS`); self-host engines, `rerank` and
`model-registry` are SYSTEM-only (403, a privilege boundary — not the
404-over-403 cross-tenant posture).

**The resolver — `ProviderCredentialResolver.resolve(service, provider,
tenantId)`** (TASK-862, exported from `@arcaai/applications`): returns
`{ override, fundingTier, connectionId } | null`; throws
`ProviderVetoedException` (409) on a disabled tenant row and
`QuotaExceededException` (403) when the entitlement gate suppresses a cloud
provider's SYSTEM tier; `null` = no row at either tier holds a credential.
`fundingTier` is DERIVED from the row that supplied the credential and is what
the usage ledger stamps `BYOK` vs `CLOUD` from — never a call-site stamp. The
request fold (text/tts), the STT pull, the harness per-activity route and the
Agent resolver (TASK-863) all stand on the same two-tier cascade.

**Surface:** `admin/providers/:service/:provider` (GET/PUT/DELETE, OCC
`If-Match`) plus `POST …/test` — an ephemeral probe that never persists (a real
auth-only call where the vendor exposes one, a reachability smoke test
otherwise; omitted fields fall back to the stored row so a write-only key can be
re-tested). The console screen is `/ai-providers` (tier 20-29; the SYSTEM tier
and the working tenant are a control on one screen). The `admin/ai-providers`
alias and the `admin/{tts,stt}-config/credentials/**` facades were removed.

---

## 5. Hyperparameters & concurrency — retired `AiRuntimeProfile`

`AiRuntimeProfile` was **dropped by TASK-862** (D-3). Its two halves went to
their owners:

- **connection-level ceilings** (`maxConcurrent`, `rpmLimit`, `tpmLimit`,
  `timeoutS`) → `AiProviderConnection` (§4), per tier;
- **generation hyper-parameters and engine ride-alongs** (`temperature`,
  `topP`, `maxTokens`, `contextLength`, `keepAliveSeconds`, `extraJson` such as
  gemma-4's `reasoning_effort`) → the Agent's parameters (TASK-863).

`TextRequestEnrichmentService.applyTextRuntimeProfile` is a deprecated NO-OP
until its call sites are removed; the TEXT-side generation floors stay in the
settings registry (`text-generation.descriptors.ts`). Until TASK-863 lands, a
TEXT request carries only the parameters its caller set — the gemma-4
`reasoning_effort: none` extra that the retired seed row supplied must be
re-seeded on the gemma-4 agent's parameters.

---

## 6. Model registry, discovery & source resolution

### 6.1 Registry (`AiModel`) — one catalogue, SYSTEM-owned (TASK-860)

`AiModel` (`packages/database/src/prisma/db_main/ai-model.prisma`) is the
platform catalogue of the shared model bucket. Since TASK-860 its rows live
**only in the SYSTEM tenant**: `AiModelService` pins `tenantId = SYSTEM` on
every write, refuses a non-platform-admin caller with `403` (a privilege
boundary, not the 404-over-403 cross-tenant posture), and writes through the
unscoped base-client lane so a super admin's elevated working tenant never
rewrites the row. Tenants READ the catalogue through the tenant-scope
extension's shared-read widening; the per-tenant clones the seed used to
materialise are gone (soft-deleted by the TASK-860 migration + seed sweep).

Rows are organised the way the Hugging Face Hub is:

| Facet | Column | Notes |
|---|---|---|
| task (`pipeline_tag`) | `taskType` (enum) | the DTO derives the kebab-case `pipelineTag` from `MODEL_TASK_TYPE_TO_PIPELINE_TAG`; the HOPE extensions `GUARDRAIL` / `SPEAKER_*` map onto the nearest Hub tag |
| serving library (`library_name`) | `libraryName` | the loader is selected by this, from the closed `AI_MODEL_LIBRARIES` vocabulary (`packages/applications/src/services/ai-model/constants.ts`, mirrored by the seed's `shared.ts`, parity-pinned by `tests/contracts/ai-model-providers.contract.test.ts`) |
| owning workload | `servedBy` | `stt` · `nlp` · `tts` · `lmstudio` · `text` · … — cloud rows are governed by the gateway and executed by the owning service |
| deployment | `deploymentKind` + `wireModelId` | `CLOUD` rows carry the vendor wire id and are `NOT_APPLICABLE` for availability |
| card metadata | `license`, `gated`, `baseModel`, `languages`, `hfRevision` | mirrored from the Hub |
| bucket identity | `bucketPrefix`, `primaryObject`, `manifestDigest` | written by the publisher; `localPath` is **derived** (`/mnt/models-bucket/` + prefix [+ primary object]) and never typed |
| measured availability | `availability`, `availabilityCheckedAt`, `availabilityDetail` | written by the inventory job and the publisher only |
| platform default | `isPlatformDefaultFor: AiTaskKind[]` | at most one enabled row per task; `PATCH admin/ai-models/:id/platform-default` clears the previous holder (the SYSTEM `AiRoutingPolicy` election it seeds is TASK-862's) |

Models are still referenced **by slug** in pipeline YAML and by
`AiTaskDefault.modelSlug`; `AiRoutingPolicy.modelId` is the one FK.
`downloadStatus` / `downloadedAt` / `fileSizeMb`, free-text `localPath`, the
cloud `AiModelFormat` pseudo-values and `AiModelSource.MLFLOW`/`GITHUB` are
deprecated (register: TASK-860, removed in R3).

The seeded catalogue (`seed/06-ai-models.ts`) is exactly the owner's 35 rows
(README §3.6 of TASK-860); everything else is in `RETIRED_AI_MODEL_SLUGS`.

### 6.2 One publisher, one inventory

**Publisher.** `POST admin/ai-models/:id/download` (path kept for the frozen
contract; the action is *publish to bucket*) enqueues `DownloadAiModel`. The
processor fetches the weights from `sourceUri` (Hub or `s3://`, with the SYSTEM
`model-registry/huggingface` token for gated/private repos), content-addresses
them, and publishes them under the layout `infrastructure/docker/minio/README.md`
§5 prescribes — flat `<slug>/<version>/` for GGUF / CT2 / ONNX / pth, a verbatim
HF cache `hf/hub/models--<org>--<repo>/{refs/main, snapshots/<sha>/}` for the
transformers family (no symlinks — s3fs cannot follow them). It writes
`bucketPrefix` / `primaryObject` / `manifestDigest` / `hfRevision`, the derived
`localPath` and `availability = AVAILABLE` back; `sourceUri` keeps the Hub
identity. The deployment repo's `hope-models-publish.yaml` is to become a
bootstrap wrapper over this code path (cross-repo follow-up).

**Inventory.** `ModelInventoryService` (`POST admin/ai-models/inventory`, and
hourly when `modelRegistry.inventory.enabled` is on) lists the bucket once,
verifies every row's `bucketPrefix` + `manifestDigest` + manifest objects, stamps
`AVAILABLE` / `MISSING` / `PARTIAL` / `NOT_APPLICABLE`, and lists the
manifest-bearing prefixes no row references ("In bucket, not registered →
Register", which creates the row with its `bucketPrefix`). Availability is a
FACT about the bucket, so an admin edit never sets it.

### 6.3 Discovery hub — read-only

`AiModelDiscoveryService` / `AiModelDiscoveryController` still produce the
**merge view** of registry rows against models enumerated live from
server-managed providers (`DISCOVERABLE_AI_MODEL_PROVIDERS = ['ollama',
'lm-studio', 'vllm', 'llama-cpp']`), tagged `registered` / `discovered` /
`registered-missing-on-server` with the engine's load state. Since TASK-860 it
is **read-only**: `POST admin/ai-models/discovery/register` answers `410 Gone`
(deprecated, removed in R3). Registration happens from the catalogue —
`POST admin/ai-models`, optionally with an inventory-reported `bucketPrefix`.

### 6.4 Source resolution

`AiModel.sourceUri` follows a scheme grammar honoured by every service's
`resolve_model_dir` (stt, nlp, tts, harness — `tests/contracts/source-resolver-parity.contract.test.ts`
keeps the four copies in step):

| Scheme                                   | Behaviour                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `hf:<org>/<repo>` or bare `<org>/<repo>` | HuggingFace Hub snapshot; honours `HF_HUB_OFFLINE` (cache read before any raise) |
| `file:///abs/path`                       | verified in place, never copied                                         |
| `s3://bucket/prefix`                     | downloaded once into the service cache, single-flight + SHA256-verified |

Anything else is a hard `ModelSourceError` — never a silent fallback
(`azure-blob://` is deferred). The derived `localPath` keeps the **highest
precedence**, ahead of scheme dispatch, and may name a FILE (the primary object
of a whisper.cpp / llama.cpp row) or a directory — every resolver checks
`exists()`, not `is_dir()`. A set-but-missing path falls through to scheme
dispatch with a warning. `checksum` (SHA256) is verified for single-file
artifacts after download and on first use of a pre-existing cache entry.

Loader coverage per library (TASK-860 §3.5): `deepfilternet3` fails closed
when the package is absent (`ModelLoadError`, never a silent no-op);
Nemotron/Parakeet transducer checkpoints load through transformers
`AutoModelForRNNT` behind a version gate (`RNNT_MIN_TRANSFORMERS`); Kokoro loads
`KModel(config, model)` + voice `.pt` paths from `TTS_KOKORO_MODEL_PATH` (the
published prefix) instead of `HF_HOME`; Indic Parler ships as the tts
`[indic-parler]` image variant; SpeechBrain treats a local source as its own
`savedir`.

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
| `text.modelCache.ttlSeconds`     | 600                                             | not a cache — forwarded to server-managed engines |

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

- **Per-tenant TTS**: RETIRED (TASK-879/888). There is no per-tenant TTS spec
  row any more. The gateway resolves the tenant's TEXT_TO_SPEECH `Agent` per
  request and pushes a `ResolvedTtsSpec` to the stateless tts service; BYO
  provider keys live on `AiProviderConnection(service='tts')` with every other
  vendor credential.
- **Registry resolve for the durable lane** (TASK-890 black-box F11): the harness
  interpreter's `core.classify` node does not read Postgres. It resolves a catalogue model by
  slug over `GET /api/v1/internal/harness/models/resolve?tenantId&slug[&taskType]`
  (`HarnessServiceTokenGuard`), which applies the same visibility rule as the tenant catalogue —
  the tenant's own BYO row first, the SYSTEM row on absence — and answers 404 for a foreign,
  unknown or disabled slug. The response carries `taskType`, `sourceUri`, `servedBy` and
  `provider`, which is what the node then dispatches on (`TOKEN_CLASSIFICATION` → nlp
  `/classify/tokens`, `TEXT_CLASSIFICATION` → `/classify/text`).
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

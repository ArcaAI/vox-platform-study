# TASK-958 — Multiple provider connections per tenant: a tenant admin holds several accounts of one vendor and binds agents (and, through them, workflows) to any of them

| | |
|---|---|
| **Status** | `In Progress` — plan approved by the owner 2026-09-12; lanes running in worktrees (§4.9) |
| **Type** | `feature` (schema + domain + services + API + Python wire + console) |
| **Branch** | `dev-2.2` |
| **Reported as** | "A tenant admin cannot configure multiple providers — for example two OpenAI providers. The tenant admin must be able to utilize different providers for building tenant agents and workflows." Raised after the TASK-890 answer that two Azure deployments on ONE resource are expressible only as two declared models on ONE connection. |
| **Reverses** | TASK-952 owner decision **D-4** ("Two accounts per vendor — accept `@@unique([tenantId, service, provider])`. Not in scope.", `docs/implementation/TASK-952-Provider-Extras-And-Inert-Config-Planes/README.md:107`). This ticket is the owner reopening that decision. |

---

## 1. Requirement Analysis

| # | Requirement | Reading applied |
|---|---|---|
| R-1 | A tenant admin can hold MORE THAN ONE connection for the same `(service, provider)` — two OpenAI accounts, two Azure OpenAI resources, two Sarvam keys — each with its own endpoint, key, api-version, region, ceilings, and a tenant-chosen name. | Today the DB refuses this outright: `@@unique([tenantId, service, provider])` (`packages/database/src/prisma/db_main/ai-provider-connection.prisma:105-108`). Everything above the schema — repository, service signatures, routes, console cards, SDK methods, catalogue ids, BYO model slugs — is a projection of that key. |
| R-2 | A tenant admin can USE any of those connections when building tenant agents — primary model and fallback chain — and therefore in workflows, which reach a provider only through `core.agent` nodes. | Binding must become connection-aware. The model row already carries `AiModel.sourceConnectionId` (TASK-890 §3.1); the resolvers ignore it and resolve by `model.provider` string. |
| R-3 | The platform cascade is untouched: tenant → SYSTEM on absence, the SYSTEM tier stays ONE row per provider, and the tenant's "disabled = veto" posture survives. | Multiplicity is a TENANT-tier property. The platform default is a per-provider concept and stays so. |
| R-4 | Usage from account #2 must be attributable — a tenant that brought two keys must be able to see which one a generation spent. | The ledger has no connection column today; `(provider, deployment kind)` is the finest grain. Scope is an owner call (OQ-5). |

Out of scope, stated so it is not silently pulled in: a tenant-writable `AiRoutingPolicy` (super-admin-only by TASK-881, unchanged); binding a SYSTEM catalogue model to a NON-default tenant connection (OQ-3, deferred); multiplicity for the integration services `embeddings | rerank | vector | model-registry` (D-9).

Ticket number: first drafted as TASK-956, renumbered to TASK-958 the same day — a parallel session had already committed TASK-956 (`ba08d8f88`, Tenant profile Settings tab) and opened TASK-957 (agent/workflow usage metering review). `docs/archive/` is off-limits this sprint and was not consulted.

---

## 2. Current State Evaluation (read 2026-09-12 on `dev-2.2` @ `47b568beb`)

Three read-only sweeps (gateway, Python wire, console/SDK); load-bearing lines re-verified by hand.

### 2.1 Identity is the tuple, end to end

| Surface | Where | How a connection is identified |
|---|---|---|
| DB constraint | `ai-provider-connection.prisma:105-108` | `@@unique([tenantId, service, provider])` |
| Repository | `packages/domains/src/repositories/generated/core/AiProviderConnectionRepository.ts:41-70` `findByTenantServiceProvider` (`findFirst`); `:82-101` tombstone lookup on the same triple | triple |
| Service | `packages/applications/src/services/ai-provider-connection/ai-provider-connection.service.ts` — `getRow` `:159`, `upsertRow` `:407`, `deleteRow` `:533`, `resetRow` `:594`, `resolveConnection` `:674`, `findRow` `:691` | every signature is `(service, provider, tenantId?)`; no id-addressed method exists |
| Cascade reader | same file `:1018-1025` `readTier` | `findByTenantServiceProvider` then `row ? [row] : []` — an array shape that can only ever hold one element |
| Three-state doc | `.../ai-provider-connection/constants.ts:174-179` `CONNECTION_ENABLED_SEMANTICS` | "Three states, **per (service, provider)**" |
| Routes | `apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts:84-306` | `GET :service`, `GET :service/platform-defaults`, `GET/PUT/DELETE :service/:provider`, `PUT :service/:provider/models`, `POST :service/:provider/{reset,test}` |
| Response DTO | `.../dto/ai-provider-connection.response.ts:41-102` | the ROW DTO carries `tenantId/service/provider/…/version` and **no `id`** (the `id` at `:15` belongs to the nested `ConnectionModelResponse`); a client can only address a row by the tuple |
| Seed | `packages/database/src/prisma/db_main/seed/17-ai-provider-connection.ts:809-810` | create-only, `findFirst({ tenantId, service, provider })` |
| Console | `apps/admin-console/src/features/ai-providers/components/provider-credentials-tab.tsx:73` `key={meta.id}`; query keys `api/keys.ts:12-30` nest `tenantId → service → provider` | provider id |
| SDK (generated) | `packages/vox-node/src/resources/admin/ai-provider.ts` — `getOne/upsert/remove/declareModels/reset/testConnection(service, provider, …)` | provider id |
| Routing policy promote | `packages/applications/src/services/ai-routing-policy/ai-routing-policy.service.ts:725-730` | re-resolves `providerConnectionId` by `findRow(service, provider, targetTenantId)` even though it holds the source id |

### 2.2 Binding resolves by provider NAME; `sourceConnectionId` is provenance only

The runtime chain for every capability is `Agent.modelId → AiModel row → AiModel.provider (string) → ProviderCredentialResolver.resolve(service, provider, tenantId) → the single row`:

- `packages/applications/src/services/agent/agent-resolver.service.ts:166-191` materialises models by id/slug and never reads `sourceConnectionId`; `:274-282` `providerOverrideFor` does `resolved.overrides[provider]`.
- `packages/applications/src/services/agent/text-agent-resolver.service.ts:262-289` `fundingFor` → `this.credentials.resolve('llm', provider, tenantId)`.
- `packages/applications/src/services/agent/tts-agent-resolver.service.ts:150,196-235` and `packages/applications/src/services/stt/agent-resolver/asr-agent-resolver.service.ts:126-235` — same for `tts` / `stt`.
- `AiModel.sourceConnectionId` (`ai-model.prisma:118-119`, `onDelete: Restrict`) is written at declaration (`byo-model-declaration.ts:177`) and read only by the soft-delete cascade guard (`ai-provider-connection.service.ts:347,553`) and a backfill script. `ProviderCredentialResolver` returns `connectionId` (`provider-credential-resolver.ts:20-23,93`) and no caller ever passes one IN.
- `AiRoutingPolicy.providerConnectionId` is the one real by-id binding in the codebase, but the whole `AiRoutingPolicyService` is super-admin-only (`ai-routing-policy.service.ts:118-125` and every method), so it cannot be the tenant-admin mechanism.

Consequence today: a SYSTEM catalogue `azure` model bound by a tenant agent is served through the tenant's `(llm, azure)` connection whenever one is enabled — `text-generation-spec.ts:136-144` `overrideForModel` already branches on `model.tenantId === SYSTEM_TENANT_ID` for exactly that case.

### 2.3 The override fold has one slot per provider

`resolveTenantCloudOverrides` builds `ProviderOverrides = Record<providerName, entry>` and writes `overrides[row.provider] = entry` (`ai-provider-connection.service.ts:753`; type at `IProviderConnectionService.ts:59-104`). Every producer keys the same way: `text-request-enrichment.service.ts:118`, `text-compat.controller.ts:216,838`, `tts-provider-classification.ts:77-79`, `live-documentation.service.ts:5755`.

Who walks each fallback chain decides whether that is a WIRE problem:

| Plane | Chain walked by | Wire shape today | Collision for two same-provider candidates? |
|---|---|---|---|
| Text (LLM) | **Gateway** — `live-documentation.service.ts:5592` builds `[primary, ...chain]` and issues ONE `apps/text` request per candidate with `provider_overrides: { [candidate.provider]: overrideEntry }` taken from `candidate.providerOverride` (`:5744-5755`). `apps/text` itself knows only a single `fallback_provider: str | None` (`apps/text/src/text/models/requests.py:265`). | one entry per request | **No wire change needed** — the per-candidate override is already the shape; only the FOLD must pick the candidate's connection. |
| TTS | **`apps/tts`** — `ResolvedTtsSpec.fallback.chain` (`apps/tts/src/tts/spec.py:184-189`), each `ResolvedTtsCandidate.connection` carries non-secret `provider/base_url/region/timeout_s/funding` (`spec.py:117-129`) and the engine cache key folds them in (`routing/router.py:90-113`) — but the SECRET is read from the flat map: `(provider_overrides or {}).get(name, {})` (`routing/router.py:242`). | flat, provider-keyed | **Yes** — two `azure` candidates read the same entry. Untested (`tests/unit/test_router.py` never chains two same-name engines). |
| STT | **`apps/stt`** cloud loaders — `apps/stt/src/stt/models/cloud_asr.py:68` `provider_overrides.get(provider_key)`; per-loader keys `openai_loader.py:29`, `sarvam_loader.py:33`, `azure_speech_loader.py:81`, `azure_foundry_loader.py:49`. | flat, provider-keyed | **Yes**, same shape. |
| Harness / guardrail / NLP relays | forward a provider-keyed blob to `apps/text` (`harness/core/provider_credentials.py:291-318`, `guardrail/core/tenant_config.py:1163-1179`); harness fetches credentials by `GET /provider-credential?service&provider&tenantId` (`harness/services/api_client.py:584-587`). | flat, provider-keyed | Not a collision (one credential per call) but cannot NAME a connection. |

`apps/text`'s SDK client cache is keyed `(provider, base_url, credential fingerprint)` (`apps/text/src/text/providers/clients.py:104-124`; pinned by `test_provider_overrides.py::test_two_tenants_do_not_share_a_client`), so two accounts do not collide in-process once distinct overrides reach it.

### 2.4 Slugs and the catalogue collapse connections

- BYO model slug is `<provider>-<slugify(wireModelId)>` (`byo-model-declaration.ts:112-119`). Two OpenAI connections both declaring `gpt-5.4-mini` would both generate `openai-gpt-5-4-mini`; the only guard is `BYO_SLUG_SHADOWS_PLATFORM` against a SYSTEM slug.
- Catalogue picker id is `byo:<service>:<provider>` (`packages/applications/src/services/ai-model/aiModel.service.ts:81-83,780`), the `Map` at `:770-793` holds one entry per provider, and `CatalogueProvider.connectionId: string | null` is singular (`apps/admin-console/src/shared/catalog/hooks.ts:131`).
- `ModelPicker` (`apps/admin-console/src/features/agents/components/model-picker.tsx:70-72,97`) labels a provider entry `name (BYO)` and never renders a connection; the fallback `<Select>` (`create-agent-wizard.tsx:323-338`, `agent-detail.tsx:525-526`) lists model NAMES only.
- Workflows reach a provider only transitively: `core.agent` → Agent (`node-registry.ts:242-244`); the reference-only contract forbids provider/model/endpoint literals on every other node (`node-config-schemas.ts:729-732`). `core.classify.modelSlug` (`:1138-1144`) is the one direct model reference, a plain slug string — unaffected as long as slugs stay unique.

### 2.5 Attribution cannot tell two accounts apart

`AiUsageEvent` stores `provider` and `deployment: AiDeploymentKind` (`packages/database/src/prisma/db_main/usage-ledger.prisma:78,82`), no connection id; the price book resolves on `(plane, capability, provider, model, unit)`. Python attribution is `(provider, funding)` only: `apps/text/src/text/routing/usage.py:68-85`, `apps/stt/src/stt/transcription/batch_service.py:185-224`. No `connection_id` exists in any of the six services.

### 2.6 What already exists that the fix can stand on

- `AiModel.sourceConnectionId` FK with `Restrict` — "the row IS the deployment" (TASK-890 §3.7a).
- `ProviderCredentialResolver.ResolvedProviderBinding.connectionId` — returned, unused.
- Per-candidate `providerOverride` on `ResolvedTextCandidate`, and `candidateEndpointKey` already folding `base_url`/`deployment_name` in (`text-generation-spec.ts:205`).
- `ResolvedTtsCandidate.connection` non-secret metadata and the connection-aware engine cache key in `apps/tts`.
- The response DTO exposes the tuple only (no row `id`); adding `id` + `slug` to it is additive.
- No entitlement key exists for connection count (`entitlements.constants.ts:153-163`); adding one is new plumbing, not a change.

### 2.7 Tests that pin today's shape (must move, not be deleted)

`packages/database/src/prisma/db_main/seed/__tests__/config-plane-seed.test.ts:421-427` ("one row per (tenant, service, provider)"); `packages/applications/src/services/ai-provider-connection/__tests__/*.test.ts` (all fixtures one row per triple; cascade test `:343-393`); `apps/api/tests/e2e/{ai-provider-connections,ai-provider-connections-cross-tenant,admin-providers,task-932-providers,byo-llm-credentials,task-890-byo-models}.spec.ts`; `apps/text/.../test_azure_deployment_precedence_task890.py`; `apps/stt/tests/unit/test_task799_byok_credentials.py` (1:1 format → override-key map); `apps/harness/.../test_task858_text_provider_overrides.py`; console `features/ai-providers/**/__tests__`, `model-picker.task890/952.test.tsx`, `provider-meta.drift.test.ts`, `provider-services.drift.test.ts`.

---

## 3. Design

### 3.1 Decisions proposed (D-n) — each is an owner call unless marked mechanical

| # | Decision | Proposal | Why this shape |
|---|---|---|---|
| **D-1** Identity | Add `slug String` (tenant-chosen, `^[a-z0-9][a-z0-9-]{1,62}$`, immutable after create), `name String?` (display label), `defaultForProvider String?`. Unique becomes `(tenantId, service, slug)`; a second unique `(tenantId, service, defaultForProvider)` gives "exactly one default per provider" for free (NULLs are distinct in Postgres, so non-default rows carry `NULL`). Backfill every existing row `slug = provider`, `defaultForProvider = provider`. | Every existing row keeps addressing by the same string it is addressed by today, so nothing that works now breaks. The partial-unique trick is expressible in Prisma; a `WHERE isDefault` index is not. |
| **D-2** Routes | `:service/:provider` becomes `:service/:slug` on every existing route. `PUT :service/:slug` gains optional `provider` (required when `slug` is not itself a `CLOUD_BYO_PROVIDERS` id; defaults to `slug` otherwise), `name`, `isDefault`. Setting `isDefault: true` flips the default atomically (transaction clears the sibling). `DELETE` of a default that has siblings → **409 `CONNECTION_IS_DEFAULT`**. `GET :service` already returns an array. No new resource, no `/:id` routes. | Backward compatible by construction (D-1); `vox-node` regenerates with a renamed positional parameter and identical values. The controller's `:service` guard and the platform-defaults route stay where they are. |
| **D-3** Binding rule | "**The model row names the connection.**" Resolution: `model.sourceConnectionId` set → THAT connection (enabled + keyed, else the candidate fails closed and the chain walks on); `null` (a SYSTEM catalogue row) → the tenant's DEFAULT connection for `model.provider` → SYSTEM row. A tenant admin picks a connection by declaring models on it and binding those. | Uses the FK TASK-890 already put there; the default path is byte-for-byte today's cascade, so platform behaviour and every existing agent are unchanged. |
| **D-4** Override fold | `ProviderOverrideEntry` gains `connection_id` and `connection_slug`. Text plane: no wire re-keying (one candidate per request, §2.3) — the fold must read the CANDIDATE's connection (via D-3), not `resolveTenantCloudOverrides(service, tenantId)[provider]`. TTS + STT: each spec candidate carries `connection_key` (= `slug` for tenant rows, = `provider` for platform rows) and `provider_overrides` is keyed by `connection_key`; readers do `.get(candidate.connection_key or provider)`. | For every default/platform case `connection_key == provider`, so existing payloads and the parity fixtures are unchanged; only a non-default candidate produces a new key. Additive on both sides. |
| **D-5** Model slugs + catalogue | `byoModelSlug(connectionSlug, wireModelId)`; catalogue provider id `byo:<service>:<connectionSlug>`; `CatalogueProvider` gains `connectionSlug`, `connectionName`, `isDefault`; one picker entry per CONNECTION, labelled `"<name or slug> · <Provider> (BYO)"`. | Default connections keep `slug == provider`, so no existing model slug, agent binding or picker id changes. |
| **D-6** Three-state semantics | Evaluated on the tenant's DEFAULT connection for the provider — the only row the provider-name cascade sees. A NON-default row's `enabled = false` disables bindings to that row only (fail closed → next candidate); it never vetoes the provider. `CONNECTION_ENABLED_SEMANTICS` and the rules text are updated to say so. | Keeps R-3 exactly; gives a non-default row an unambiguous meaning. |
| **D-7** Attribution (OQ-5) | `AiUsageEvent.connectionId String?` (+ index); `ProviderOverride.connection_id` carried through `apps/text` `_used_byok_credential`, `apps/stt` `resolve_usage_attribution`, `apps/tts` usage emit; consumption screen gets a "Connection" column on BYO rows. Price book unchanged (still per provider/model). | Without it R-4 is unmet and two keys are indistinguishable on every cost surface. Small, additive, nullable. |
| **D-8** Entitlement (OQ-4) | New limit key `maxAiProviderConnections` (per tenant, all services), `null` = unbounded in every seeded plan, enforced by `assertQuantityQuota` on create only. | Entitlements bound, never supply; unbounded default = zero behaviour change. |
| **D-9** Scope of multiplicity | Non-default rows allowed for `llm | stt | tts` only (the `BYO_DECLARABLE_SERVICES`). `embeddings | rerank | vector | model-registry` → service-layer **400 `CONNECTION_MULTIPLICITY_UNSUPPORTED`** on a non-default row. SYSTEM tier → **400** on `slug != provider` or a non-default row (platform default is per provider). | A second row nothing can address is worse than a named refusal (same reasoning as `BYO_DECLARABLE_SERVICES`). |
| **D-10** Console | Tenant tier of `/ai-providers`: each provider becomes a card GROUP — default card + "Add another <Provider> connection" (dialog: slug, name) + one card per sibling with a `Default` badge and a "Make default" action; `ConnectionModelsEditor` per card; `UsedByPanel` per connection (agents via `model.sourceConnectionId`, routing rows via `providerConnectionId`). `ModelPicker`: one provider entry per connection (D-5); fallback select shows `Model · Connection`. Platform tier: unchanged. Workflow studio: unchanged (transitive via agents). | One home per fact; the tenant sees "which key" at the two points it matters — where it is entered and where it is bound. |
| **D-11** Routing-policy promote (mechanical) | `promote` targets the target tenant's DEFAULT connection (D-3 rule), unchanged behaviour for every existing tenant. | — |

### 3.2 Open questions for the owner (OQ-n)

| # | Question | Recommendation |
|---|---|---|
| OQ-1 | Route identity: slug in the existing path (D-2) or a new id-addressed `admin/provider-connections/:id` resource? | Slug in path. Zero breakage for existing callers, one route family, and a human-readable key in the URL a tenant admin can recognise. |
| OQ-2 | Default marker: `defaultForProvider` column (D-1) or the convention "the row whose `slug == provider` is the default"? | The column. The convention cannot re-point the default without renaming, and slug is immutable. |
| OQ-3 | May a tenant bind a SYSTEM catalogue model (e.g. the platform's `gpt-5.4` row) to a NON-default connection — i.e. add `connectionId` to `Agent` / `AgentModelFallback`? | **Defer.** Declaring `gpt-5.4` on connection #2 achieves the same routing with the FK that already exists; a second binding surface doubles the picker and the resolver rules. Revisit if tenants ask for it. |
| OQ-4 | Entitlement cap: none, per tenant, or per (tenant, service)? | Per tenant, `null` default (D-8). |
| OQ-5 | Ledger attribution (D-7) in this ticket or a follow-up? | In this ticket. It is the only way R-4 is verifiable, and it is the smallest lane. |
| OQ-6 | Deleting a default with siblings: refuse (409) or auto-promote the oldest sibling? | Refuse. An automatic promotion silently changes which key every SYSTEM-model agent spends. |
| OQ-7 | `slug` immutable after create? | Yes. It is embedded in model slugs (D-5) and in `connection_key` on the wire; renaming would re-key bindings. Rename is `name`, which is free text. |

### 3.3 Not changed by this ticket

`AiRoutingPolicy` authorization; the SYSTEM tier shape; the `agentic.*` legacy node vocabulary (dormant, TASK-890 parked it); `core.classify.modelSlug`; the price book; the deprecation register (nothing is removed — `:provider` → `:slug` is a rename of a path parameter whose values are unchanged for every existing row).

---

## 4. Implementation Plan

Layer order per `01-development-workflow.md`: Database → Domain → Services → API → Python → Console → Docs. Lanes B/C/D can run in parallel worktrees once Lane A is merged and the interface contract (§4.1) is committed — write the contract first, then spawn (`14-multi-agent-worktrees.md` §3).

### 4.1 Interface contract (COMMITTED before any lane starts — lanes code against THIS, never against each other's branch)

**Schema (Lane A):**

```prisma
// AiProviderConnection — additions
slug               String   // ^[a-z0-9][a-z0-9-]{1,62}$ ; IMMUTABLE after create ; backfill = provider
name               String?  // display label, <= 120 chars
defaultForProvider String?  // = provider on the tenant's DEFAULT row for that provider ; NULL on every sibling
@@unique([tenantId, service, slug],               map: "AiProviderConnection_tenant_service_slug_key")
@@unique([tenantId, service, defaultForProvider], map: "AiProviderConnection_tenant_service_default_key")
// AiProviderConnection_tenant_service_provider_unique is DROPPED ; the (service, provider), (provider), (tenantId, service) indexes stay

// AiUsageEvent — addition
connectionId String?
@@index([connectionId], name: "AiUsageEvent_connectionId_idx")
```

Entity: `slug`, `name`, `defaultForProvider` props + derived `isDefault` getter. Repository: add `findByTenantServiceSlug(service, slug, tenantId, tx?)`, `findAllByTenantServiceProvider(service, provider, tenantId, tx?)` (non-deleted, default first), `findDefaultByTenantServiceProvider(service, provider, tenantId, tx?)`; keep `findByTenantServiceProvider` as a `@deprecated` alias of the default lookup (removed in R4); rename `findDeletedByTenantServiceProvider` → `findDeletedByTenantServiceSlug`.

**Gateway DTOs (Lane B1 owns; Lane D codes against them):**

- `AiProviderConnectionResponse` += `id: string`, `slug: string`, `name: string | null`, `isDefault: boolean`.
- `UpsertAiProviderConnectionRequest` += `provider?: string` (REQUIRED when `slug` is not a `CLOUD_BYO_PROVIDERS[service]` id; on update must equal the row's provider), `name?: string | null`, `isDefault?: boolean` (`true` flips the default in one transaction; `false` on the current default → 400).
- `CatalogueProviderResponse` += `connectionSlug: string | null`, `connectionName: string | null`, `isDefault: boolean | null` (all `null` for the `hope` group). `id` = `byo:<service>:<connectionSlug>`. Label = `name ?? (slug === provider ? <provider label> : slug)`, so every existing default row keeps today's label and id.
- Routes keep their shape; the `:provider` segment reads as `:slug` on all six routes. `GET :service` returns every row of the tenant, default first, then `createdAt`.

**Error codes** (shape: `new ConflictException({ code, message, ...detail })` / `new BadRequestException({ code, message })`, exactly like `BYO_SLUG_SHADOWS_PLATFORM` at `ai-provider-connection.service.ts:308-316`):

| HTTP | `code` | When |
|---|---|---|
| 400 | `CONNECTION_SLUG_INVALID` | slug fails the pattern |
| 400 | `CONNECTION_PROVIDER_REQUIRED` | new slug that is not a provider id, and no `provider` in the body — also on `POST :service/:slug/test`, where the probe has no vendor to select (G1/F3) |
| 400 | `CONNECTION_SLUG_RESERVED` | (G1/F2) a CREATE whose slug impersonates another vendor's provider id (`PUT tts/azure {provider:'sarvam'}`) or takes a literal route segment (`platform-defaults`); carries `slug`, `provider`, `service`, `reason` (`provider-id` \| `route-segment`) |
| 400 | `CONNECTION_MULTIPLICITY_UNSUPPORTED` | a non-default row on `embeddings` / `rerank` / `vector` / `model-registry` |
| 400 | `PLATFORM_CONNECTION_PER_PROVIDER` | SYSTEM tier: `slug !== provider`, or a non-default row |
| 409 | `CONNECTION_PROVIDER_IMMUTABLE` | PUT on an existing slug with a different `provider` — and (G1/F3) `POST :service/:slug/test` whose body `provider` contradicts the saved row |
| 409 | `CONNECTION_IS_DEFAULT` | DELETE of the default while siblings exist |
| 409 | `BYO_SLUG_TAKEN` | a declared model's slug already exists on ANOTHER connection of the same tenant (carries `slug`, `otherConnectionSlug`) |
| 409 | `QUOTA_EXCEEDED` (existing) | `maxAiProviderConnections` reached on create |

**Wire (Lanes B1/B2 ↔ Lane C):**

- `ProviderOverrideEntry` (TS, `IProviderConnectionService.ts`) and `ProviderOverride` (py, `apps/text/src/text/models/requests.py`) += `connection_id?: string`, `connection_slug?: string`. Adapters ignore both.
- **Text plane**: `provider_overrides` stays keyed by provider name — one candidate per request (§2.3). No re-keying.
- **TTS**: `TtsSpecConnection` (TS `packages/types/src/tts-spec.ts`; py `apps/tts/src/tts/spec.py`) += `connectionId: string | null` / `connection_id`, `connectionSlug` / `connection_slug`. `ResolvedTtsCandidate` += `connectionKey: string` / `connection_key` — `slug` for a tenant row, `provider` for a SYSTEM row. `providerOverrides` is keyed by `connectionKey`. Reader: `overrides.get(candidate.connection_key) or overrides.get(engine_name)` (legacy payloads still resolve).
- **STT**: the same three fields on every runnable ASR candidate (`AsrSpecCore` primary + each `kind: 'model'` fallback entry), `connectionKey` / `connection_key`; `provider_overrides` keyed by it; loaders: `overrides.get(spec.connection_key) or overrides.get(override_key)`. The TS type and `tests/contracts/resolved-asr-spec.fixture.json` are Lane B2's; the pydantic mirror (Lane C) accepts the fields as optional with `None` defaults so the unchanged fixture still round-trips.
- **Usage attribution, Python → gateway**: everywhere the usage stats carry `byok: bool` today (`apps/text/src/text/routing/streaming.py:105`, `api/endpoints/generate.py:586,787`, `api/endpoints/judge.py:311`; `apps/stt` `resolve_usage_attribution`; the `apps/tts` usage emit) += `connection_id: str | None` = the `connection_id` of the override entry that served (`None` for a platform credential). Gateway side (Lane B2): `consultation/summary/text-usage.ts:178` and the STT/TTS usage-event builders write it to `AiUsageEvent.connectionId`.

**Entitlement (Lane B1):** `PlanEntitlementValues.maxAiProviderConnections: number | null` — per tenant, all services, `null` = unbounded in every seeded plan; enforced on CREATE only via `assertQuantityQuota`.

### 4.2 Lane A — Database + Domain (`packages/database`, `packages/domains`) — blocking

Migration `task_958_provider_connection_multiplicity` (authored against a shadow DB per `02-database-prisma.md`; never against the dev DB):

1. `AiProviderConnection`: add `slug`, `name`, `defaultForProvider`; backfill `slug = provider`, `defaultForProvider = provider`; drop `AiProviderConnection_tenant_service_provider_unique`; add `@@unique([tenantId, service, slug], map: …)` and `@@unique([tenantId, service, defaultForProvider], map: …)`; keep the `(service, provider)` and `(tenantId, service)` indexes.
2. `AiUsageEvent`: add `connectionId String?` + index (D-7).
3. `pnpm gen:model`; hand-edit entity/factory/mapper (keep `FIELDS_NOT_WRITABLE = ['version']`); repository: add `findByTenantServiceSlug`, `findAllByTenantServiceProvider`, `findDefaultByTenantServiceProvider`; keep `findByTenantServiceProvider` as a thin alias of the default lookup for one release with a `@deprecated` note. `gen:entity` / `gen:factory` `:check` green ("no drift", "schema coverage OK").
4. Seed: `17-ai-provider-connection.ts` writes `slug`/`defaultForProvider`; the seed test's "one row per triple" assertion becomes "one DEFAULT per (tenant, service, provider) and unique slugs".

Gates: `pnpm --filter @arcaai/database test`, `pnpm --filter @arcaai/domains build test`, migration diff prints "empty migration" after deploy.

### 4.3 Lane B — Application services + API (`packages/applications`, `apps/api`)

1. `AiProviderConnectionService`: every public method takes `(service, slug, tenantId?)`; `upsertRow` validates slug shape, infers `provider` (D-2), enforces D-9 and the SYSTEM-tier rules, flips the default in a transaction, refuses default-delete with siblings (OQ-6); `readTier` returns ALL tenant rows for the provider and the cascade picks the DEFAULT (`defaultForProvider`) — removing the latent first-row non-determinism noted in §2.1; `resolveConnection` / `ProviderCredentialResolver.resolve` gain an optional `connectionId` argument and the by-id lookup; `resolveTenantCloudOverrides` folds only DEFAULT rows (unchanged wire for every consumer that still resolves by name).
2. Binding (D-3): `AgentResolverService.providerOverrideFor`, `TextAgentResolverService.fundingFor`, `AsrAgentResolverService`, `TtsAgentResolverService.connectionFor` resolve `model.sourceConnectionId` first; `text-generation-spec.ts` `candidateEndpointKey` adds `connection_id`; TTS/ASR spec builders stamp `connection_key` and key `provider_overrides` by it (D-4).
3. `byo-model-declaration.ts`: slug from `(connectionSlug, wireModelId)`; `declareModels(service, slug, …)`; the shadow guard also refuses a slug another tenant connection already minted (`CONNECTION_SLUG_TAKEN` on the model, 409).
4. `aiModel.service.ts` catalogue: one `byo:<service>:<connectionSlug>` entry per connection with `connectionSlug/connectionName/isDefault`.
5. `ai-routing-policy.service.ts` `promote`: default connection (D-11).
6. Entitlement `maxAiProviderConnections` (D-8): constant, descriptor, `assertQuantityQuota` on create.
7. Ledger (D-7): `AiUsageEvent.connectionId` written from the `connection_id` the Python usage payload carries; consumption DTOs expose it.
8. Controller: `:provider` → `:slug` on all six routes; DTO decorators; `@ApiOperation` text; error responses. Regenerate and commit the five artifacts: `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin`.
9. Rules/docs (`00-project-context.md` reference-implementation paragraph, `09-infrastructure-devops.md` §Tenant-first, `constants.ts` `CONNECTION_ENABLED_SEMANTICS`, the service README).

Gates: `pnpm --filter @arcaai/applications build test`, `pnpm api:build`, `pnpm test:unit`, boot smoke (`GET /health` on a booted gateway — the admin route audit is boot-time), `pnpm api:openapi:check`, `pnpm api:portal:check`, `pnpm --filter @arcaai/vox-node gen:admin:check`, `pnpm test:e2e` (the provider + BYO specs in §2.7 plus the new ones in §4.7, run with `RESET_DB=false` on seeded infra).

### 4.4 Lane C — Python wire (`apps/tts`, `apps/stt`, `apps/text`)

1. `apps/tts`: `TtsSpecConnection` + `ResolvedTtsCandidate.connection_key`; `routing/router.py:242` reads `.get(candidate.connection_key or name)`; usage emit carries `connection_id`. Test: a chain of two `azure` candidates with different keys builds two engine instances and the fallback spends the SECOND key.
2. `apps/stt`: `cloud_asr.py:68` and the four loaders read `connection_key` first; `resolve_usage_attribution` returns `connection_id`; contract fixture parity test updated.
3. `apps/text`: `ProviderOverride.connection_id/connection_slug` (optional, ignored by adapters); `_used_byok_credential` returns the id alongside funding. No re-keying (§2.3).
4. `apps/harness` / `apps/guardrail`: none — they still resolve one credential by provider name, which resolves to the DEFAULT connection (D-3). Note it in the ticket so nobody "fixes" it.

Gates: `pnpm tts:test`, `pnpm stt:test`, `pnpm text:test`, `pnpm <svc>:lint`, `pnpm <svc>:typecheck`; run from the primary checkout or with the worktree guard green.

### 4.5 Lane D — Admin console (`apps/admin-console`)

1. `/ai-providers` tenant tier (D-10): card groups, add-connection dialog, default badge/make-default, per-card models editor, per-connection used-by; query keys gain a `slug` level; `api/hooks.ts` + `types.ts` follow the contract; drift tests updated.
2. `ModelPicker` and the fallback selects: connection-aware labels (D-5/D-10).
3. Consumption screen: "Connection" column on BYO rows (D-7).
4. Runtime verification via `next-dev-loop` as the ArcaAI tenant admin; both themes; axe 0 violations.

Gates: `pnpm --filter @arcaai/admin-console build lint test`.

### 4.6 TDD test list (RED first, one behaviour each)

Database/domain: (1) migration backfills `slug = provider`, `defaultForProvider = provider` for every existing row; (2) two rows `(t, llm, openai)` with distinct slugs insert; (3) two DEFAULT rows for one provider are refused by the DB; (4) seed test — one default per triple, unique slugs.

Applications: (5) `upsertRow(llm, 'openai-research', { provider: 'openai', name })` creates a non-default sibling; (6) `upsertRow(llm, 'foo')` with no `provider` → 400 `CONNECTION_SLUG_INVALID`-style refusal (not a known provider id); (7) `isDefault: true` on the sibling clears the previous default in one transaction (`_version` bumped on both); (8) `deleteRow` on the default with a sibling → 409 `CONNECTION_IS_DEFAULT`; (9) SYSTEM tier refuses `slug != provider` and non-default rows (400); (10) `embeddings` non-default row → 400 `CONNECTION_MULTIPLICITY_UNSUPPORTED`; (11) cascade with two tenant rows picks the DEFAULT, deterministically; (12) a disabled NON-default row does not veto the provider — the platform default still serves a SYSTEM-model agent; (13) a disabled default with an enabled sibling → the veto holds (D-6); (14) `declareModels` on two OpenAI connections both declaring `gpt-5.4-mini` yields two rows with distinct slugs (`openai-gpt-5-4-mini`, `openai-research-gpt-5-4-mini`) and distinct `sourceConnectionId`; (15) text resolver: a model with `sourceConnectionId = #2` produces a candidate whose `providerOverride.connection_id` is #2 and whose key is #2's; (16) a chain `[model@#1, model@#2]` yields two candidates with DIFFERENT `candidateEndpointKey`s (real HA, not a retry); (17) a SYSTEM model bound by the tenant resolves through the DEFAULT connection (unchanged behaviour pin); (18) catalogue: two `byo:llm:*` provider entries with `connectionSlug/connectionName/isDefault`; (19) entitlement quota refuses the N+1th connection when a cap is set, ignores `null`; (20) `AiRoutingPolicyService.promote` re-points to the target's DEFAULT; (21) ledger write stores `connectionId` from the usage payload.

API e2e: (22) `PUT admin/providers/llm/openai` (no `provider` in body) still creates/updates the default row — legacy-shape regression pin; (23) `PUT admin/providers/llm/openai-research { provider: 'openai' }` → 200, `GET admin/providers/llm` lists both with `isDefault` correct; (24) cross-tenant: another tenant's slug → 404; (25) API key → 403 (class-level `@ForbidApiKey()`, via the route-authz matrix — no hand-written test); (26) `DELETE` default with sibling → 409; (27) super admin on SYSTEM: sibling → 400; (28) end-to-end: two BYO OpenAI connections, an agent with primary on #1 and fallback on #2, `POST agents/:slug/invoke` with #1's key revoked at the vendor stub → the response is served and the ledger row carries #2's `connectionId`.

Python: (29) TTS chain of two `azure` candidates with distinct `connection_key`s spends distinct keys; (30) STT loader reads `connection_key` before `provider_key`, and the legacy payload (no key) still resolves; (31) ASR spec parity fixture still round-trips; (32) `apps/text` `_used_byok_credential` returns `(funding, connection_id)`; existing `test_azure_deployment_precedence_task890.py` unchanged and green.

Console: (33) tenant tier renders a card per connection under the OpenAI group with the default badge; (34) add-connection dialog validates slug shape and posts `provider`; (35) `ModelPicker` shows two OpenAI entries labelled by connection name; (36) fallback select label includes the connection; (37) drift tests updated for the new hook signatures; (38) axe 0 violations on `/ai-providers` and the agent wizard.

### 4.7 Verification criteria (definition of done)

- Every gate in §4.2–§4.5 green with pasted output; the five API artifacts committed together; `pnpm verify` green outside the excluded workspaces.
- Live, as the ArcaAI tenant admin on the dev stack: two OpenAI connections created and named; a model declared on each; an agent bound primary → #1, fallback → #2; an invocation observed spending #1; #1 disabled → the next invocation spends #2 (ledger `connectionId` differs); the platform-default panel unchanged; a super admin on the platform tier sees no change.
- Rules updated (`00`, `09`, `constants.ts` doc string); TASK-952 D-4 marked reversed by TASK-958 in ITS README's change history; this README's §5 filled with evidence.

### 4.8 Estimate (dev-days, single writer per lane)

| Lane | Days |
|---|---|
| A — DB + domain + seed + migration | 1 |
| B — services + resolvers + catalogue + controller + artifacts + e2e | 4 |
| C — Python wire (tts, stt, text) + contracts | 1.5 |
| D — console | 3 |
| Ledger column + consumption column (D-7) | 1 |
| Docs + rules + live verification | 1 |
| **Total** | **≈ 11.5** (lanes B/C/D overlap after A) |

### 4.9 Lanes, tiers and file ownership (one writer per file — anything outside a lane's list is a request to the orchestrator)

| Lane | Worktree / branch | Tier | Owns | Must NOT touch |
|---|---|---|---|---|
| **A** DB + domain | `../hope-v2-t958-a` · `task-958/a-db-domain` | opus | `packages/database/**` (schema, migration, seed + seed tests, client allow-lists), `packages/domains/**` | applications, api, apps, console; the dev/test DB (`db:push` is the orchestrator's) |
| **B1** connection service + API | `../hope-v2-t958-b1` · `task-958/b1-connection-api` | opus | `packages/applications/src/services/ai-provider-connection/**`, `.../entitlements/**`, `.../ai-routing-policy/ai-routing-policy.service.ts` (promote only), `apps/api/src/modules/ai-provider-connection/**`, `apps/api/tests/e2e/{ai-provider-connections*,admin-providers,task-932-providers,byo-llm-credentials,task-890-byo-models}.spec.ts`, the five API artifacts, `.claude/rules/00-project-context.md` + `09-infrastructure-devops.md` (the two paragraphs on connection semantics) | `services/agent/**`, `services/stt/**`, `services/ai-model/**`, `services/consultation/**`, console, Python |
| **B2** binding + catalogue + ledger | `../hope-v2-t958-b2` · `task-958/b2-binding-catalogue` | opus | `packages/applications/src/services/agent/**`, `.../stt/agent-resolver/**`, `.../ai-model/**`, `.../consultation/summary/text-usage.ts` (+ the STT/TTS usage-event builders), `.../consultation/live-documentation/live-documentation.service.ts` (the fold at `:5744-5755` only), `packages/types/src/{asr-spec,tts-spec}.ts`, `tests/contracts/**`, new e2e `apps/api/tests/e2e/task-958-multi-connection-invoke.spec.ts` | B1's folders, console, Python |
| **C** Python wire | `../hope-v2-t958-c` · `task-958/c-python-wire` | opus | `apps/tts/**`, `apps/stt/**`, `apps/text/**` | `apps/harness`, `apps/guardrail`, `apps/nlp`, any TypeScript, `uv.lock` (no dependency changes expected) |
| **D** console | `../hope-v2-t958-d` · `task-958/d-console` | opus | `apps/admin-console/**` | everything else |
| **Orchestrator** | primary checkout, `dev-2.2` | — | merges (in this order: A → C/D as they land → B1 → B2), `pnpm install` per worktree, env-file copies, the shadow DB, `db:push` on dev + test DBs, e2e runs against a live gateway, the console runtime pass, §5 of this README | — |

Sequencing: **Wave 1** = A ∥ C ∥ D (C and D compile against the contract, not against A). **Wave 2** = B1 after A merges. **Wave 3** = B2 after B1 merges (it consumes B1's `ProviderOverrideEntry` fields and the by-id credential lookup). Reviewers with distinct lenses (correctness / cross-tenant security / does-it-reproduce) run on the merged tree before the live pass.

Tier rationale (`14-multi-agent-worktrees.md` §1): every lane is a multi-file change whose verdict is acted on (a migration, a resolver, a wire contract, a screen), so none is downshifted; discovery already happened at sonnet in Phase 2.

---

## 5. Implementation Summary

_Not started. Filled in at Phase 4/5 with what changed, decisions taken, evidence, and follow-ups._

---

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-12 | Ticket created. Three read-only sweeps (gateway identity surfaces, Python override keying, console/SDK) + hand verification of the load-bearing lines. Requirement analysis, current-state evaluation, design (D-1…D-11), open questions (OQ-1…OQ-7), lane plan and TDD list written. Status `Pending` — awaiting owner approval of §3 before Phase 4. One explorer claim refined on verification: the text fallback chain is walked by the GATEWAY (one request per candidate), so `apps/text` needs no wire re-keying. Confirmed the row DTO carries no `id` (the `id` at `:15` is the nested model DTO's). |
| 2026-09-12 | Owner approved the plan. Renumbered TASK-956 → TASK-958 (collision with a parallel session's `ba08d8f88`). §4.1 made concrete (schema, DTOs, error codes, wire fields, usage attribution, entitlement); §4.9 added (lanes, tiers, worktrees, file ownership, sequencing). Status `In Progress`. |
| 2026-09-12 | Wave 1 + 2 merged on `dev-2.2`: A `537cb5d75` (+ `a9c528140` rename follow-up), D `676a227ba`, C `8e40843c0`, B1 `5181c1ac1`. Post-merge gates green for A (database 1771, domains 1953, three gen checks, applications typecheck), D (console typecheck/lint/2934 tests/build), C (tts 436, text 1679, stt unit 3350 with the one pre-existing MinIO env-leak failure, stt integration 12). Dev DB migrated by applying the migration SQL (22 rows backfilled; `db:push` in sync). B1 deferred the entitlement seed columns (`PlanEntitlement`/`TenantEntitlement.maxAiProviderConnections`) — opened as follow-up Lane E. B2 and E next. |
| 2026-09-12 | **Follow-up fix (Lane E spillover).** Lane E wired `maxAiProviderConnections` through `EntitlementsService.toPlanResponse` / `toTenantResponse` and pinned the read-back with a round-trip test, whose comment recorded that its two siblings `maxWorkflowDefinitions` and `monthlyWorkflowInvocations` had no such pin. They did not: both are accepted by the request DTOs, declared on the response DTOs, and written to the `PlanEntitlement` / `TenantEntitlement` rows, but NEITHER response mapper read them back — so a super admin set either value, reloaded, and saw nothing. Both mappers now emit them (`packages/applications/src/services/entitlements/entitlements.service.ts`), pinned by five new round-trip tests in `entitlements.service.test.ts` (plan write-and-echo ×2, plan null-clear, tenant override write-and-echo, tenant first-create) and the stale comment corrected. Mapper-only: the two fields were already in the response DTOs, so `openapi.json` and the other four API artifacts are unchanged — no regeneration. The resolver (`resolve-entitlements.ts`) always handled both correctly, so no enforcement behaviour changed; only the read-back did. |
| 2026-09-12 | **Console follow-up (three unsurfaced limits).** The gateway supports `maxWorkflowDefinitions`, `monthlyWorkflowInvocations` and `maxAiProviderConnections` end to end (request DTOs accept them, the service writes them, and since `15bfb7f1b` / Lane E both response mappers read them back) — but the admin console had no reference to any of the three outside the vendored `openapi.*.json` artifacts, so a platform admin could neither see nor edit them on the plans matrix or in a tenant override. All three now ride the existing limit pattern rather than a new one: added to `EntitlementLimits` in `apps/admin-console/src/features/entitlements/api/types.ts` (which both the plan PATCH body and the tenant PUT body extend), to `LIMIT_FIELDS` in `components/plan-meta.ts` (empty input = unlimited, the same sentinel the older limits use), and to `OVERRIDE_KEYS` in `components/tenant-override-panel.tsx` — each placed beside the neighbours it sits next to in the response DTOs. The plan-editor skeleton's hard-coded row count became `LIMIT_FIELDS.length + 2` so it keeps matching the form it stands in for. Two colocated tests pin the behaviour (plan editor seeds and PATCHes all three, including the empty→`null` unlimited path; the override document exposes all three keys), both seen RED against the unchanged source first. **No wire change**: the three fields were already in the request/response DTOs and in `openapi.json`, so none of the five API artifacts move. |
| 2026-09-12 (late) | B2 merged `0cfe82680` (binding via `sourceConnectionId`, ASR/TTS `connectionKey`, catalogue per connection, ledger `connectionId`); Lane C follow-up `2519f77f6` (STT teardown response models declare `connection_id`). Merged-tree gates: five artifact checks, applications build/lint, api lint green; workspace `test:unit` 25505 passed with 11 ordering-only failures in `ai-model/publish` (pass in isolation) and the pre-existing environmental `audit-correlation` Vault timeout (fails at Lane A's base too). E2E on the live test gateway (8968, fresh test DB seeded from the ledger): 49 passed / 1 failed (B2's invoke spec GETs an unsaved sibling — 404 is final, spec fix in G2b). Three read-only reviews (correctness / tenancy+secrets / wire contract): no cross-tenant read found; CONFIRMED defects triaged into fix lanes — **G1** (soft-deleted default keeps its marker and wedges the provider via the unique index → clear on tombstone + data migration; reserved slugs `CONNECTION_SLUG_RESERVED` incl. provider ids of any service and `platform-defaults`; probe `provider` field; seed-test tautology), **G2a** (wire key namespaced `provider:slug` for siblings; failed-closed sibling still stamps its key with no map entry; STT batch credential pull enumerates every connection; TTS usage classification by `X-Tts-Connection-Id`; WS usage-frame guard; `AGENT_CONNECTION_UNAVAILABLE` fail-closed for the invoke/bench planes; doc comments: a platform credential carries the SYSTEM row id), **G2b** (Python readers strict when a key is declared; console labels SYSTEM ids `Platform · provider`; dialog sends `provider` on test + client-side reserved-slug check; invoke spec fix), **F** (console runtime verification via Playwright against the live app). Deferred to **G3** after the TASK-959 STT/harness lanes merge (file overlap): per-span `(connection_key, connection_id)` in STT streaming teardown (an azure span can be attributed to an openai sibling after failover); harness `text_client.py` must prefer `spec.provider_override`; `agent.controller.ts` TTS classification header pass-through. Coordination with sessions hope-v2-4b (TASK-959), hope-v2-40 (console entitlements follow-up `473027c0f`), hope-v2-51 (gone). |
| 2026-09-12 | **Console follow-on: the entitlements screen gets its first axe scans.** `98d6e2a2c` surfaced the three caps but the screen had no accessibility scan of its own, and an axe-clean entitlements screen was a stated gate for that work. Two scans added to `entitlements-screen.test.tsx` — the plans grid (whole container) and the plan editor (scoped to the dialog, as every other open-overlay scan in this app is: Radix marks the page behind a modal `aria-hidden` while trapping focus in JS, which axe reads statically as hidden-but-focusable). Both pass against `98d6e2a2c` unchanged, so the gate was already met in fact; these keep it met. Test-only, no source change. Gates: `@arcaai/admin-console` test 324 files / 2963 tests passed, lint exit 0, `next build` exit 0. **Process note:** this change was built twice. A session working from the mapper-fix handoff and a chip-spawned follow-up task implemented the same three fields independently and within the hour — same files, same placement, even the same `LIMIT_FIELDS.length + 2` skeleton fix. The duplicate was caught by the announce-before-merge protocol only because a third session happened to know about both; a chip-spawned task does not announce, does not receive cross-session messages, and does not appear in `ListAgents`, so it is invisible to that protocol by construction. A follow-up filed in a change-history row should name the FILES it will touch, and anyone picking one up should grep the change history for their paths before starting — that binds the check to the files rather than to the sessions. |
| 2026-09-12 | **Console salvage + label correction.** The duplicate console implementation (built in parallel with `98d6e2a2c`, never merged) held three things that commit did not, now on `dev-2.2` as `1b4021090`: the only client-boundary coverage these caps have (`entitlements-api.test.ts` — both tiers serialize all three, the tenant one with an explicit `null` for inherit, which also pins the request DTO types); doc comments on `EntitlementLimits` for the semantics the field names leave implicit; and the plan-editor label, now **Max published workflow definitions** — the cap counts PUBLISHED definitions only (the gateway DTO says so on both tiers), so the shorter label implied drafts counted against it. The duplicate branch is deleted; nothing unique remains on it. **Process note (second one, same root cause):** committing this with `git add -A` in the SHARED primary checkout swept an uncommitted TASK-959 text-lane file into the commit. Repaired forward-only in `a0b4a1e` style — the file reverted to its committed state in a follow-up commit and its in-flight content put straight back into the working tree as the uncommitted change it was, byte-identical, with no `reset`/`--amend` on shared history. The rule this earns: in the shared primary, stage explicit paths, never `-A`/`-u`/`commit -a` — `git status` is another session's workbench, not your staging area. |
| 2026-09-12 | **Console follow-up, part 2 (the five monthly service allowances).** The same gap as the row above, for the remaining limits the gateway carries: `monthlySttSessionSeconds`, `monthlyLlmTokens`, `monthlyTtsCharacters`, `monthlyNlpTextUnits` and `monthlyEmbeddingTokens`. All five were already symmetric across all eight service sites (meter map, capability row, plan write, plan create, clear, tenant update, and BOTH response mappers via `toAllowanceNumber`), and all five already appeared as rows in the tenant card's **Meters (this period)** list — which is rendered key-driven, so an admin could read the USAGE of an allowance whose LIMIT no console surface would let them set. They now join `LIMIT_FIELDS` and `OVERRIDE_KEYS` behind the same empty-means-unlimited sentinel as every other limit, with doc comments (per `1b4021090`'s convention) on the two whose unit the field name leaves implicit: LLM tokens are every billable kind summed, TTS characters are Unicode code points. They are `BigInt` columns on the gateway and `number | null` on the wire, so the form needs no special handling. **The override-document test changed shape**: instead of naming individual keys it now asserts every `LIMIT_FIELDS` key is a key of the override JSON — the two lists are hand-maintained and have drifted apart twice, so the invariant is worth more than the enumeration. Evidence: the plan-editor test went RED at runtime (no 'Monthly STT session seconds' label) and the client-boundary test RED under `tsc` (four TS2353s — that test pins request-DTO TYPES, which vitest strips, so typecheck is its real gate). Green after: admin-console lint clean, typecheck clean, 324 files / 2966 tests, `next build` exit 0. No wire change; no API artifact moves. |
| 2026-09-13 | **Console follow-up, part 3 (the plan form gets sections).** At 18 limits the plan editor was one flat 2-column grid, so a ceiling that blocks the next create sat indistinguishable beside an allowance that resets monthly. It is now three `FieldSet`s — **Quantity ceilings**, **Monthly meters**, **Tiers**. The split is NOT a display choice: `MeterCapabilityKey` (`packages/applications/src/services/entitlements/enforcement.ts`) names exactly nine rolling monthly meters (429 against a window that resets), every other limit is a point-in-time quantity (409 against a count that does not), and it is the same division the tenant card already renders as "Quantities" and "Meters (this period)". `LIMIT_GROUPS` is DERIVED by filtering `LIMIT_FIELDS` on a new required `group` field, so a new limit is classified once, on the field, and can neither vanish from the form nor appear twice; `LIMIT_FIELDS` remains the single source for seeding, saving and the skeleton count, so save/seed behaviour is unchanged. The third section exists because the two tier inputs live in the same form and would otherwise read as meters. Semantics: shadcn `FieldSet`/`FieldLegend` render real `<fieldset>`/`<legend>`, so each section is an ARIA group named by its legend rather than a visual heading — pinned by a test that reaches the fields through `getByRole('group', { name })`, and confirmed by the plan-editor **axe scan added in `cf98ce319`, which passes over the grouped form**. Four new tests, all seen RED first. Green: lint, typecheck, 325 files / 2981 tests, build exit 0. **Not verified in a browser** — jsdom settles structure and a11y but not spacing; the section rhythm (12px legend, 16px between fields, 24px between sections) is asserted by construction only. |

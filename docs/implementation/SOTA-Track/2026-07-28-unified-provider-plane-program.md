# Program — Unified Provider-Connection Plane + LLM Provider Expansion

- **Program status**: Planned (2026-07-28)
- **Branch of record**: `thuynh/2607`
- **Author**: platform review (multi-agent exploration, opus-4-8)
- **Child tickets**: TASK-569 … TASK-576 (8 tickets, 3 waves)
- **Related prior programs**: [Agentic Platform Program Plan](2026-07-20-agentic-platform-program-plan.md) (delivered the Config-Plane: TASK-524/525/526), [Config-Plane assessment](assessment-config-plane-2026-07-22.md)

This document is the **single source of truth** for the frozen contracts (§4), the file-ownership matrix (§6), and the wave/dependency plan (§7). Every child ticket references this file rather than restating the contracts, so the team stays consistent and the lanes never collide. **Read this before opening any child ticket.**

---

## 1. Executive summary

HOPE lets tenant admins bring their own provider keys (BYOK) for three AI capabilities. On `thuynh/2607` **all three are implemented and working**, but each was built in its own era with its own tables and its own service, producing **three parallel credential mechanisms** for what is fundamentally one concern ("this tenant's key for this provider on this capability"):

| Capability | Credential table(s) | Service | Providers |
|---|---|---|---|
| LLM (SMR) | `AiProviderConnection` | `AiProviderConnectionService` | `azure`, `bedrock` |
| STT | `TenantSttConfig` + `TenantSttProviderCredential` | `TenantSttConfigService` | `azure-speech`, `sarvam`, `openai` |
| TTS | `TenantTtsConfig` + `TenantTtsProviderCredential` | `TenantTtsConfigService` | `azure`, `sarvam` |

The owner directive is to **unify** these into one provider-connection plane and to **broaden** the LLM provider set (OpenAI / Anthropic / Vertex). This program does both, plus closes the two outstanding BYOK owner-verification tails, structured so a **team of agents can execute the lanes simultaneously without overlapping files**.

**Nothing here removes a shipped capability.** Unification is an internal consolidation: the wire shape the Python services consume is unchanged (§4 C4), so `apps/smr`, `apps/stt`, and `apps/tts` are largely untouched by the unification itself; the work is at the gateway + application-service + admin-API + console layers.

---

## 2. Findings (code-verified 2026-07-28 on `thuynh/2607`)

### 2.1 LLM BYOK — complete (azure + bedrock)

- **DB**: `packages/database/src/prisma/db_main/ai-provider-connection.prisma` — model `AiProviderConnection`, `@@unique([tenantId, provider])`, `encryptedApiKey Bytes?` + `keyVersion` (Vault-Transit ciphertext), SYSTEM row = platform default. In both `TENANT_SCOPED_MODELS` and `SYSTEM_SHARED_READ_MODELS` (`packages/database/src/extensions/tenant-scope.ts`).
- **Domain**: hand-authored entity/factory/mapper (with the `FIELDS_NOT_WRITABLE = ['version']` OCC guard)/repository under `packages/domains/src/*/generated/core/AiProviderConnection*`; registered in `CoreDatabaseModule`; `ResourceType.AiProviderConnection` present in the domain enum + `audit.prisma` (parity holds).
- **App service**: `packages/applications/src/services/ai-provider-connection/` — CRUD + OCC, `resolveConnection(provider, tenantId)` cascade (tenant → SYSTEM → env), Vault encrypt/decrypt (no plaintext-at-rest fallback), masked DTO (`hasKey` only, no reveal route), tenant-vs-SYSTEM 403 guard. `CLOUD_BYO_PROVIDERS = ['azure','bedrock']` (`.../constants.ts:19`).
- **Admin API**: `apps/api/src/modules/ai-provider-connection/ai-provider-connection.controller.ts` — `@Controller('admin/ai-providers')`, `GET`/`GET :provider`/`PUT :provider`/`DELETE :provider`, write-only key, `@RequiresIfMatch()` OCC.
- **Runtime**: `apps/api/src/modules/streaming/smr-proxy.controller.ts:237` resolves `resolveTenantCloudOverrides(tenantId)` and injects `body.provider_overrides`; `apps/smr` consumes it in `apps/smr/src/smr/providers/azure_openai.py` and `bedrock.py` (request-scoped clients). Wire shape: `{ [provider]: { api_key, base_url?, region?, api_version?, deployment_name? } }`.
- **Console**: `apps/admin-console/src/app/(console)/(tenant)/ai-configuration` → `features/ai-task-defaults/components/byo-credential-card.tsx` (cards for azure/bedrock) + `features/ai-task-defaults/api/providers-*.ts`.
- **Outstanding**: owner runtime verification only (TASK-524 README §9.8 — never booted, `byo-llm-credentials.spec.ts` env-gated/skipped, migration not applied to test DB, Vault round-trip mocked). **No code gap.**
- **SMR provider adapters present**: `apps/smr/src/smr/providers/` = `azure_openai.py`, `bedrock.py`, `ollama.py`, `vllm.py`, `llama_cpp.py`, `openai_compat.py`, `base.py`. `AI_MODEL_PROVIDERS` (`packages/database/src/prisma/db_main/seed/ai-models/shared.ts`) = `ollama, lm-studio, azure, bedrock, built-in, sarvam, vllm, llama-cpp`. **No `openai` / `anthropic` / `vertex` as tenant-BYO LLM providers.**

### 2.2 STT BYOK — complete (TASK-567, committed as HEAD `f1bb341c`)

- **DB**: `packages/database/src/prisma/db_main/tenant-stt-config.prisma` — `TenantSttConfig` (per-tenant spec incl. `fallbackPipelineId`, `autoSwitchEnabled`) + `TenantSttProviderCredential` (`@@unique([tenantId, provider])`, `encryptedApiKey`, `keyVersion`, `enabled`).
- **App service**: `packages/applications/src/services/tenant-stt-config/` — `BYO_STT_PROVIDERS = ['azure-speech','sarvam','openai']` (`platform-limits.ts:15`), `CLOUD_STT_PROVIDERS` set (`platform-limits.ts:40`), credential set/mask/resolve mirroring TTS.
- **Engines**: net-new **Sarvam** and **OpenAI** ASR engines added to `apps/stt` (Azure Speech / Foundry already existed); credential injection at streaming session-create + batch worker pull.
- **Fallback**: `TenantSttConfig.fallbackPipelineId` + in-session `EngineSwitchController` (one-way primary→fallback), manual `SWITCH_TO_FALLBACK` control action, gateway `POST …/session/:id/switch-to-fallback`, SDK `useArcaSttProvider` + `switchToFallback()`, `provider_switched` status frame (zero WS-protocol change).
- **Admin API + console**: `apps/api/src/modules/tenant-stt-config/`, `apps/admin-console/src/app/(console)/(tenant)/stt-config` + `features/tenant-stt-config/`.
- **Outstanding** (TASK-567 README, status *Review*): (1) **rule-12 design gate open** on the `stt-config` screen — needs an approved Figma frame OR a recorded owner waiver; (2) migration not applied to test DB; (3) authored fallback e2e (`stt-fallback-cross-tenant.spec.ts`) not run against a live stack.

### 2.3 TTS BYOK — complete (TASK-496)

- **DB**: `packages/database/src/prisma/db_main/tenant-tts-config.prisma` — `TenantTtsConfig` (per-tenant spec: voices, `routingEn/Ml` ordered fallback chains, `allowedProviders`) + `TenantTtsProviderCredential` (`provider ∈ azure|sarvam`, `endpoint`, `encryptedApiKey`, `keyVersion`, `enabled`; `@@unique([tenantId, provider])`).
- **App service**: `packages/applications/src/services/tenant-tts-config/tenant-tts-config.service.ts` — `setCredential` (`:344`), `maskCredential` (`:430`), `resolveProviderOverrides(tenantId)` (`:405`, fail-open per credential).
- **Runtime**: gateway injection at `apps/api/src/modules/speech/speech-proxy.controller.ts:70` and `apps/api/src/modules/speech/tts-ws.gateway.ts:135`; the stateless `apps/tts` never touches Postgres/Vault.
- **Console**: `apps/admin-console/src/app/(console)/(tenant)/tts-config` + `features/tenant-tts-config/`.

### 2.4 The redundancy, precisely

`TenantTtsProviderCredential` and `TenantSttProviderCredential` are **field-for-field subsets** of `AiProviderConnection` (`tenantId`, `provider`, `endpoint`/`baseUrl`, `encryptedApiKey`, `keyVersion`, `enabled`, plus the standard meta/status/audit columns). The only reason they are separate tables is the **provider-name collision**: `azure` means *Azure OpenAI* in the LLM table but *Azure Speech* in STT; `sarvam` means *Sarvam LLM* vs *Sarvam ASR*. TASK-567 §2 explicitly rejected reuse for that reason and chose separate tables. The unification resolves the collision structurally with a `service` discriminator (§3).

The three **non-credential spec** tables (`TenantSttConfig`, `TenantTtsConfig`, and STT's `AsrPipeline`) are **not** redundant — they hold capability-specific config (voices, routing, fallback pointer, pipeline YAML) and **stay as they are**. This program unifies **credentials/connections only**.

---

## 3. Target architecture — the unified plane

Add a `service` discriminator to `AiProviderConnection` and re-key it. One row = "tenant T's connection to provider P for capability S".

```
AiProviderConnection
  service   String   // 'llm' | 'stt' | 'tts'   (validated string, no Prisma enum — AiModel.provider convention)
  provider  String   // capability-scoped provider id (see C5)
  ...existing columns unchanged (baseUrl, region, apiVersion, deploymentName, encryptedApiKey, keyVersion, enabled, extraJson)
  @@unique([tenantId, service, provider])   // was [tenantId, provider]
```

`(service='stt', provider='azure-speech')` and `(service='llm', provider='azure')` are now distinct rows — collision gone. The service becomes the **one** credential store; `TenantSttProviderCredential` and `TenantTtsProviderCredential` are migrated in and retired. `TenantSttConfig` / `TenantTtsConfig` keep only their non-credential spec columns.

**Why this shape, not a new generic table**: `AiProviderConnection` already carries every needed column, the Vault crypto core, the masked-read DTO, the OCC guard, the cascade resolver, and the 403 governance. Adding one column reuses all of it. A greenfield table would re-implement all of that and force a bigger migration.

---

## 4. Frozen contracts (do not diverge — lanes build against these)

These are FROZEN by TASK-569 and published here so TASK-570/571/572 develop concurrently against mocks and rebase only at merge.

- **C1 — DB shape.** `AiProviderConnection` gains `service String` (default `'llm'` for the additive migration's backfill), unique key `@@unique([tenantId, service, provider])`, `service` added to the tenantId index → `@@index([tenantId, service])`, and a `@@index([service, provider])`. All other columns unchanged.

- **C2 — Service interface** (`IProviderConnectionService`, renamed from `IAiProviderConnectionService`; the old symbol stays exported as a deprecated alias for one release):
  ```ts
  list(service: ProviderService, tenantId: string): Promise<ProviderConnectionResponse[]>       // masked
  getRow(service: ProviderService, provider: string, tenantId: string): Promise<ProviderConnectionResponse>
  upsertRow(service, provider, dto, tenantId, expectedVersion): Promise<ProviderConnectionResponse>
  deleteRow(service, provider, tenantId, expectedVersion): Promise<void>
  resolveTenantCloudOverrides(service: ProviderService, tenantId: string): Promise<Record<string, ProviderOverride>>  // decrypted, gateway-only
  resolveConnection(service: ProviderService, provider: string, tenantId: string): Promise<ResolvedConnection | null> // cascade tenant→SYSTEM→null
  ```
  `type ProviderService = 'llm' | 'stt' | 'tts'`. Every method is `service`-first. Fail postures unchanged: credential *injection* fails **open per credential** with a non-secret warn (`{tenantId, service, provider, keyVersion}`); provider/model *selection* stays **fail-closed**.

- **C3 — REST.** `@Controller('admin/providers')`, routes `GET :service`, `GET :service/:provider`, `PUT :service/:provider`, `DELETE :service/:provider`. Masked (`hasKey` only, no reveal route). `PUT` carries `@RequiresIfMatch()` + `@ExpectedVersion()` (428 missing / 412 drift). The legacy `admin/ai-providers/*` routes remain for one release as thin redirects/aliases to `admin/providers/llm/*` (owned by TASK-572; console cutover in the same lane).

- **C4 — Wire shape (UNCHANGED — Python services untouched).** Gateway → Python injection stays `{ [provider]: { api_key, base_url?, region?, api_version?, deployment_name?, model? } }` under `provider_overrides`. STT and TTS already use this; LLM already uses this. Unification does **not** change what `apps/smr`, `apps/stt`, `apps/tts` receive.

- **C5 — Provider governance map.** `CLOUD_BYO_PROVIDERS` becomes a per-service map (TASK-569 defines the full map so no lane edits `constants.ts`):
  ```ts
  export const CLOUD_BYO_PROVIDERS: Record<ProviderService, readonly string[]> = {
    llm: ['azure', 'bedrock', 'openai', 'anthropic', 'vertex'],
    stt: ['azure-speech', 'sarvam', 'openai'],
    tts: ['azure', 'sarvam'],
  };
  ```
  A tenant row is permitted only for a provider listed under its service; anything else is a 403 privilege boundary on the caller's own tenant (NOT the 404-over-403 cross-tenant posture). The three new LLM entries (`openai`, `anthropic`, `vertex`) are listed here at freeze time but only become functional when TASK-572 lands their SMR adapters + seed rows.

---

## 5. Cross-cutting invariants (every lane enforces, every review checks)

1. **Vault-Transit ciphertext only** — `encryptedApiKey` is `secret-field.util` ciphertext; **no plaintext-at-rest fallback**. No `SecretsService` → credential write rejects (`BadRequestException`); Transit outage → 503.
2. **Masked reads** — `hasKey: boolean` + `keyVersion` only; the key is never returned by any read; **no reveal route**.
3. **Keys never in Redis, never in logs** — decrypted keys transit only the internal gateway→service hop (`X-Service-Token`, TLS in prod). Batch STT pulls creds via an internal route, never via the Redis job payload.
4. **OCC** — versioned writes use `If-Match`/`updateWithVersion`; drift → 412, missing → 428.
5. **Governance 403** — non-cloud / non-listed provider tenant write → 403; SYSTEM-row write requires `isSuperAdmin`.
6. **404-over-403** — a cross-tenant id read returns 404.
7. **No `pnpm gen:mapper`** — it is destructive (strips the OCC guard). The mapper is hand-edited (rule 03).

---

## 6. File-ownership matrix (proves zero concurrent edits)

Each path is owned by **exactly one** ticket. Two devs never edit the same file.

| Path (glob) | Owner |
|---|---|
| `packages/database/src/prisma/db_main/ai-provider-connection.prisma` + its `add-service` migration | **TASK-569** |
| `packages/domains/src/*/generated/core/AiProviderConnection*` | **TASK-569** |
| `packages/applications/src/services/ai-provider-connection/**` (service, `constants.ts`, DTOs, interface) | **TASK-569** |
| `packages/applications/src/services/tenant-tts-config/**` | **TASK-570** |
| `apps/api/src/modules/tenant-tts-config/**` · `apps/api/src/modules/speech/**` | **TASK-570** |
| `apps/admin-console/src/features/tenant-tts-config/**` | **TASK-570** |
| `packages/applications/src/services/tenant-stt-config/**` | **TASK-571** |
| `apps/api/src/modules/tenant-stt-config/**` · `apps/api/src/modules/streaming/stt-ws.gateway.ts` + STT streaming inject | **TASK-571** |
| `apps/admin-console/src/features/tenant-stt-config/**` | **TASK-571** |
| `apps/smr/src/smr/providers/{openai,anthropic,vertex}.py` (new) · `apps/smr/src/smr/models/requests.py` · SMR provider registry | **TASK-572** |
| `apps/api/src/modules/ai-provider-connection/**` (rename→`providers`, legacy alias) · `apps/api/src/modules/streaming/smr-proxy.controller.ts` | **TASK-572** |
| `apps/admin-console/src/features/ai-task-defaults/providers-*.ts` + `byo-credential-card.tsx` | **TASK-572** |
| `docs/implementation/TASK-567/**` · `apps/api/tests/e2e/stt-fallback-*.spec.ts` · Figma/waiver | **TASK-573** |
| `docs/implementation/TASK-524/**` · run of `apps/api/tests/e2e/byo-llm-credentials.spec.ts` | **TASK-574** |
| `apps/admin-console/src/features/ai-providers/**` (new) · `apps/admin-console/src/shared/navigation/nav-config.ts` | **TASK-575** |
| drop-table migration · dead `Tenant{Stt,Tts}ProviderCredential` domain-trio removal | **TASK-576** |

**Shared-file discipline** — the two categories that *could* collide are single-owner by construction:
- **Migrations dir**: only TASK-569 (add `service` + data-migrate rows) and TASK-576 (drop legacy tables) write migrations, and they are in different waves. No concurrent migration authoring.
- **Gateway injection controllers**: split one-per-lane — `speech-proxy.controller.ts`/`tts-ws.gateway.ts` → TASK-570, `stt-ws.gateway.ts` → TASK-571, `smr-proxy.controller.ts` → TASK-572. TASK-569 does **not** touch any gateway controller.
- **`constants.ts` (`CLOUD_BYO_PROVIDERS`)**: only TASK-569 (defines the full C5 map up front). TASK-572 adds SMR adapters + seed rows but does not edit `constants.ts`.
- **`turbo.json#globalEnv`** (generated): any new env keys (`ANTHROPIC_API_KEY`, `VERTEX_*`) are owned by TASK-572 and registered via env descriptors + regenerate (never hand-edited).

---

## 7. Waves, dependencies, and what starts on day 1

```
WAVE 0 (all start day 1, run concurrently)
  TASK-569  Foundation .......... tech-lead lane; must MERGE before Wave-1 lanes rebase
  TASK-572a SMR adapters ........ pure-Python, builds vs C4 wire shape (no dep on 569)
  TASK-573  STT owner-tails ..... docs/e2e/Figma only — no code dep
  TASK-574  LLM owner-verify .... e2e run only — no code dep

WAVE 1 (develop day 1 vs mocks of C2/C3; MERGE after 569 lands)
  TASK-570  TTS adoption ........ disjoint tree
  TASK-571  STT adoption ........ disjoint tree
  TASK-572b LLM adoption/wiring . disjoint tree (continues 572a)

WAVE 2 (after 570/571/572 merge)
  TASK-575  Console consolidation (optional)
  TASK-576  Legacy table cleanup (last; destructive drop migration)
```

Dependency edges: 570,571,572b → 569 (C1/C2). 572b → 572a. 575 → 570,571,572. 576 → 570,571,572 (rows migrated before tables dropped). 573,574 independent.

**Parallelism technique** (proven by TASK-524→526): the C1–C5 contracts are frozen in this doc, so 570/571/572b write their code and unit tests against a **mocked** `IProviderConnectionService` / stubbed `admin/providers` endpoint from day 1, and only *rebase onto* 569 for the integration commit. No lane waits idle.

---

## 8. Model-tier assignment (agent team)

Tiers per the owner's roster. Every ticket runs **Discovery → Implementation → Review** phases; the discovery phase always uses the low tier, the closing review always uses xhigh, and the implementation tier scales with complexity.

| Ticket | Complexity | Discovery | Implementation | Review/close |
|---|---|---|---|---|
| TASK-569 Foundation (unify schema+migration+data-migrate+domain+service; touches shipped code) | **Very high** | sonnet-5-low | **opus-4-8-high** | sonnet-5-xhigh |
| TASK-570 TTS adoption (repoint shipped TTS to unified service) | Mid | sonnet-5-low | sonnet-5-xhigh | sonnet-5-xhigh |
| TASK-571 STT adoption (repoint shipped STT to unified service) | Mid | sonnet-5-low | sonnet-5-xhigh | sonnet-5-xhigh |
| TASK-572 LLM expansion (3 net-new cloud SMR adapters + auth/streaming + wiring) | **High** | sonnet-5-low | **opus-4-8-high** | sonnet-5-xhigh |
| TASK-573 STT owner-tails (design-gate waiver, apply migration, run e2e) | Low-mid | sonnet-5-low | sonnet-5-high | sonnet-5-xhigh |
| TASK-574 LLM owner-verify (boot + Vault round-trip + run e2e) | Low | sonnet-5-low | sonnet-5-high | sonnet-5-xhigh |
| TASK-575 Console consolidation (frontend + a11y) | Mid | sonnet-5-low | sonnet-5-xhigh | sonnet-5-xhigh |
| TASK-576 Cleanup (destructive drop migration + dead-code removal) | Mid | sonnet-5-low | sonnet-5-xhigh | sonnet-5-xhigh |

Rationale for the two opus lanes: **569** is the only lane that alters a table three shipped features read and performs a data migration of live credential rows — a regression here silently breaks BYOK across all services; it needs the highest reasoning + adversarial self-review. **572** integrates three external cloud APIs (OpenAI transcription-adjacent auth, Anthropic Messages, Google Vertex SA/ADC auth) each with distinct client construction and streaming semantics; getting request-scoped isolation and override precedence right is high-stakes.

---

## 9. Risk register

| # | Risk | Mitigation | Owner ticket |
|---|---|---|---|
| R1 | Data migration corrupts/loses live BYO credential rows | Additive migration; copy rows (never move) into `AiProviderConnection` with `service='tts'|'stt'`; keep legacy tables until TASK-576; verify row counts + a decrypt round-trip before cutover | 569 |
| R2 | Unification regresses shipped LLM/TTS/STT BYOK | Re-run **all** existing BYOK unit + e2e (`ai-provider-connections*.spec.ts`, TTS/STT credential suites) as a hard gate on 569 and each adoption lane | 569,570,571,572 |
| R3 | Two lanes edit the same gateway controller | §6 assigns one controller per lane; enforced by review | all |
| R4 | New SMR provider leaks a key into logs / shares a client across tenants | Request-scoped clients (mirror `azure_openai.py`); `SecretStr`; adversarial review of logging | 572 |
| R5 | `service` default backfill mislabels a future non-LLM row | Backfill is a one-time `UPDATE ... WHERE service IS NULL SET 'llm'` against rows that are all-LLM today; new writes always set `service` explicitly (DTO required) | 569 |
| R6 | Console cutover breaks a working screen | Legacy `admin/ai-providers` alias kept one release; screens repoint within their own feature lane; axe + both-theme gate | 572,575 |
| R7 | `pnpm gen:mapper` run by mistake strips the OCC guard | Documented DO-NOT-RUN in 569; mapper hand-edited | 569 |

---

## 10. Verification strategy (evidence required to close each ticket)

Per the repo `verification-before-completion` discipline — every ticket's Implementation Summary MUST paste **actual** command output, not claims.

- **Static gates** (each ticket, scoped to its packages): `pnpm --filter <pkg> build test lint typecheck`; Python lanes: `pnpm py:smr:test|lint|typecheck` (and `stt`), `uv lock` if deps changed.
- **Program regression gate** (569 + adoption lanes): the full LLM + TTS + STT BYOK unit/e2e suites green.
- **Migration gates** (569, 576): SQL reviewed statement-by-statement; drift checks `generate-*-check` green; seed tests updated; row-count + decrypt round-trip evidence.
- **Runtime gates** (573, 574): actual boot + live e2e output captured.
- **UI gates** (572 cards, 575): axe 0 violations, both themes, vitest.

---

## 11. Ticket index

| Ticket | Title | Wave | Doc |
|---|---|---|---|
| TASK-569 | Unified Provider-Connection Plane (foundation) | 0 | `TASK-569-Unified-Provider-Connection-Plane/README.md` |
| TASK-570 | TTS — Adopt the Unified Plane | 1 | `TASK-570-TTS-Adopt-Unified-Plane/README.md` |
| TASK-571 | STT — Adopt the Unified Plane | 1 | `TASK-571-STT-Adopt-Unified-Plane/README.md` |
| TASK-572 | LLM Provider Expansion + Adopt the Unified Plane | 0/1 | `TASK-572-LLM-Provider-Expansion/README.md` |
| TASK-573 | STT BYOK — Owner Tails (design gate, migration, e2e) | 0 | `TASK-573-STT-BYOK-Owner-Tails/README.md` |
| TASK-574 | LLM BYOK — Runtime Verification | 0 | `TASK-574-LLM-BYOK-Runtime-Verification/README.md` |
| TASK-575 | Unified "AI Providers" Console Surface (optional) | 2 | `TASK-575-Unified-AI-Providers-Console/README.md` |
| TASK-576 | Legacy Credential-Table Cleanup | 2 | `TASK-576-Legacy-Credential-Table-Cleanup/README.md` |

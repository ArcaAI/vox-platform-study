# TASK-567 — Tenant-Configurable STT Fallback Provider (BYOK) + Seamless Switch

- **Status**: Review (Phases A–H implemented and gate-verified per §9; the two drift/lint fixes surfaced by Phase H are now RESOLVED — see the final Change History row; one owner tail remains: the rule-12 design gate on Phase G, plus applying the migration + executing the authored e2e against a live stack)
- **Type**: feature
- **Ticket number**: TASK-567 — highest allocated in `docs/implementation/` is TASK-566; confirmed free in the working tree 2026-07-28.
- **Size**: XL (5 lanes: database → applications → api → apps/stt → SDK/console). §4 proposes an optional sub-ticket split (568/569/570) if the owner prefers smaller review units.
- **Dependencies**: TASK-505 (pipeline schema v2 + processor registry — landed), TASK-496 (tenant TTS BYOK — landed, the pattern exemplar), TASK-524/526 (`AiProviderConnection` + Vault secret-field plane — landed, `Review`), TASK-529 (model lifecycle — landed).
- **Preconditions**: the tenant admin screen (§4 Phase G) is gated by rule 12 — approved Figma frame OR a recorded owner waiver (TASK-526 precedent: waiver acceptable when the screen composes only already-approved patterns; this screen composes `ScreenTemplate` + the TTS `CredentialCard` tab verbatim, so a waiver is a reasonable ask).

---

## 1. Requirement Analysis

Owner requirements (verbatim intent, restated as verifiable outcomes):

| # | Requirement | Verifiable outcome |
|---|---|---|
| R1 | Tenant admins configure a new default STT provider by BYOK: **Azure Speech (Azure Foundry)**, **Sarvam API**, **OpenAI speech-to-text API** | A tenant admin can set/rotate/disable/remove an API key (+ region/endpoint) per provider; key is Vault-Transit-encrypted at rest, never returned by any read; a pipeline backed by that provider transcribes using the tenant's key instead of the platform env key |
| R2 | Tenant admins set a **default fallback** used on exception / outage / pipeline-unavailable | A tenant-level "fallback pipeline" pointer exists; when the primary pipeline's ASR engine fails (classified outage), transcription continues on the fallback without operator action |
| R3 | A **switch mechanism** ensures seamless switch from the pipeline's provider to the default | Streaming: the live session swaps its ASR engine in place — the browser WebSocket, Redis streams, and session identity survive; at most the in-flight utterance is re-run or lost, never the session. Batch: the job re-dispatches on the fallback pipeline before exhausting retries |
| R4 | **End-users** can switch to the default fallback **on-the-flight** if they don't want the pipeline's provider | A clinician mid-consultation can trigger "switch to fallback" from the SDK/UI; the same seamless mechanism as R3 executes, user sees confirmation; transcript continuity is preserved |

Classification: `feature`. Out of scope (explicit): multi-hop fallback chains (ordered list of N fallbacks — single default fallback only, chain-ready data shape), mid-session switch **back** to primary (stop/start achieves it), TTS/SMR/NLP surfaces, per-user (non-admin) fallback preferences.

## 2. Current State Evaluation (code-verified 2026-07-28, branch `thuynh/2607`)

Three exploration passes (apps/stt internals, gateway+DB plane, browser SDK) — every claim below is grep/read-verified.

### 2.1 The STT pipeline plane (apps/stt, TASK-505 shape)

- **Source of truth is Postgres**: `AsrPipeline` (`packages/database/src/prisma/db_main/stt.prisma`) — `(tenantId, slug)` unique, `configYaml @db.Text`, `isDefault`, template lineage (`sourceTemplateSlug`, `templateLocked`); immutable history in `AsrPipelineVersion`. `AiModel` is a slug-referenced (no-FK) model catalog with `provider String?` and `format` discriminator.
- **One pipeline = one ASR engine.** `PipelineSpec.models.asr` (`apps/stt/src/stt/pipeline/dto.py`) is a single `ModelRef` — no list, no fallback field anywhere in DTO, YAML schema, or DB. Repo-wide grep for `fallback_pipeline|backup_pipeline|failover|provider_fallback` in `apps/stt/src/stt`: **zero hits**.
- **Engine abstraction (the seam we extend)**: `AiModelFormat` enum → loader (`apps/stt/src/stt/models/*_loader.py`, `BaseModelLoader`) → processor-registry adapter (`apps/stt/src/stt/processors/asr_engines.py::resolve_asr_engine`, `ASR_FORMAT_TO_NAME`) → real inference bodies on `BatchTranscriptionService._run_<engine>_inference` and `SessionManager._make_<engine>_callable`. Cloud engines already present: `AZURE_SPEECH` (`azure_speech_loader.py`, key/region validated at load, `CloudASRAuthError` on missing creds) and `AZURE_FOUNDRY` (batch-only, `azure_foundry_enabled`-gated). **No Sarvam, no OpenAI engine exists.**
- **Azure credentials are GLOBAL ENV ONLY** (`apps/stt/src/stt/core/config/settings.py`: `azure_speech_key: SecretStr|None`, `azure_speech_region`, `azure_foundry_*`). No per-tenant STT credential reaches the service; `apps/stt` has **zero references** to `AiProviderConnection` or any BYOK table.
- **Streaming runtime**: gateway → `POST /internal/streaming/sessions` (`streaming/api/routes.py`) → `SessionManager.create_session` (`streaming/session_manager.py:781`) → `_load_pipeline_config` → `_assemble_session_runtime` → `_load_asr_pipeline` (`:1233`) builds **one ASR callable for the session's lifetime**. Audio transits Redis Streams (`stt:audio:{sid}` in, `stt:result:{sid}` out, `stt:control:{sid}` control with `SessionControl{action: FINALIZE|PAUSE|RESUME|CANCEL}`). On per-utterance inference failure the loop logs `"Background inference failed"` and **drops the utterance** — no retry, no re-route; the session stays alive. This is exactly the seam an engine swap needs.
- **Batch runtime**: Dramatiq actor `transcribe_file` (`transcription/workers/transcribe_file.py`, `max_retries=3`) retries the SAME job with the SAME `pipeline_id`. Retry gate = `core/messaging/broker.py::should_retry` over the exception taxonomy in `core/exceptions.py`: `NON_RETRYABLE = (ConfigurationError, AudioProcessingError, ValidationError, JobCancelledError, JobTerminalError, CloudASRAuthError)`; retryable includes `CloudASRQuotaError`, `CloudASRTranscriptionError`, `ModelError`, `TransientError`. **The taxonomy exists but drives only same-pipeline retry — no alternate-pipeline dispatch.**
- The only outbox/retry machinery in streaming is transcript **persistence** to the gateway (`stt:transcript_outbox`) — unrelated to provider failure.

### 2.2 The gateway plane (apps/api + packages/applications)

- Session creation: `TranscriptionJobController.createStreamSession` (`apps/api/src/modules/streaming/transcription-job.controller.ts:316`) — entitlements check → `assertPipelineOwnership(pipelineId)` → resolves tenant audio bucket/storage → `StreamingSessionService.createSession(...)` (`packages/applications/src/services/stt/streaming/streamingSession.service.ts`) which POSTs `{session_id, tenant_id, pipeline_id, ...}` to apps/stt. **`pipeline_id` is the only ASR-selection parameter on the wire.**
- WS: `SttWsGateway` (`apps/api/src/modules/streaming/stt-ws.gateway.ts`, path `/ws/stt/stream`) — one-shot stream tickets, 15s resume grace, backpressure/drain, `resume`/`stop`/`close` control frames. No provider logic.
- Pipeline admin: `AudioPipelineController` (`apps/api/src/modules/pipeline/audio-pipeline.controller.ts`, `admin/audio/pipelines`, `@Authorize(['manage','AsrPipeline'])`) — CRUD/clone/validate/assign-tenant/set-default/toggle/versions, backed by `PipelineService`. **Tenant admins already self-serve pipeline selection here** — STT is the one AI surface where tenant-level model choice is already tenant-editable (unlike the GLOBAL-ADMIN-ONLY `AiTaskDefault` prefixes).
- `checkAvailability()` exists on `IStreamingSessionService` but **no controller calls it** — the closest thing to outage detection is dead code today.
- **No fallback/circuit-breaker mechanism anywhere in the gateway STT path** (grep-verified across `modules/streaming`, `modules/pipeline`, `services/stt`).

### 2.3 The BYOK precedents (what we mirror, not reinvent)

- **TASK-496 TTS (closest, and the blueprint)**: `TenantTtsConfig` (one row/tenant; SYSTEM row = platform default; **`routingEn`/`routingMl String[]` are ordered provider fallback chains** — the only fallback-chain concept in the codebase) + `TenantTtsProviderCredential` (`(tenantId, provider)` unique, `provider ∈ azure|sarvam`, `encryptedApiKey Bytes`, `keyVersion`, `enabled`). Service `TenantTtsConfigService`: `setCredential` (Vault-gate: no `SecretsService` → reject, never plaintext-at-rest), `maskCredential` (`hasKey` only, never the key), `resolveProviderOverrides(tenantId)` → `{[provider]: {api_key, region?, base_url?}}` decrypted gateway-side, **fail-open per credential** on decrypt error. Gateway injection: `SpeechProxyController.applyTenantConfig` (`apps/api/src/modules/speech/speech-proxy.controller.ts:64`) folds `provider_overrides` + routing into the forwarded body; the stateless Python service never touches Postgres/Vault.
- **TASK-524/526 LLM**: `AiProviderConnection` (`(tenantId, provider)` unique; tenant-BYO gated to `CLOUD_BYO_PROVIDERS=['azure','bedrock']`; self-host 403) with `resolveTenantCloudOverrides` injected by `smr-proxy.controller.ts`. Same crypto core. **Note a naming collision that shapes §3.1**: in this table `azure` = Azure OpenAI and `sarvam` = Sarvam LLM — the same provider *names* with different credential *semantics* than STT needs.
- **Single audited crypto path**: `encryptSecretField`/`decryptSecretField` (`packages/applications/src/services/baseServices/_meta/secrets/secret-field.util.ts`, ciphertext `vault:vN:<b64>`), shared by both precedents. Any new STT credential model MUST go through it.
- **Settings-registry postures** (`packages/applications/src/services/settings-registry/descriptors/`): secrets are `tier: 'db-secret'`, `failMode: 'closed'` (registry refuses non-closed secrets); provider/model **selection** is `closed` (`models.<taskKey>` precedent); tuning knobs `open-to-default`. Existing `stt.*` descriptors are capacity knobs only.

### 2.4 The browser SDK plane (packages/agentic-sdk-v2, packages/stt)

- `pipelineId` is consumed **once at construction**: `useArcaAudio.start` → `PluginManager.setRuntimeOptions` → `buildStreamingTransport(sttConfig, pipelineId)` → `StreamingSessionManager` + `SttWebSocketClient` → `StreamingBackendSTTProvider.init(pipelineId)`. No reconfigure primitive at any level; `useSTT`'s `configFingerprint` effect destroys & recreates the whole processor on config change.
- WS protocol (`SttWebSocketClient.ts`, `types/stt.ts`): client sends binary PCM / `audio` / `stop` / `close` / `resume`; server sends `transcript` / `status` / `error` / `resumed` / `resume_failed`. **The `status` message type is the ready-made channel for switch notifications** — no new frame type strictly needed client-side.
- Reconnect exists (5 attempts, exp backoff, ticket refresh, `resume` handshake) but: audio captured while disconnected is **silently discarded** (`StreamingBackendSTTProvider.processAudio` early-returns), and `onReconnect/onReconnected/onReconnectFailed/onDisconnect` callbacks are **implemented but wired to nothing** — no connection state reaches the store/UI.
- `usePipelines()` lists pipelines (incl. `isDefault`); `PersonalizationManager` resolves `remoteConfig.pipelineId` (`assignedBy: 'admin'|'tenant-default'`). No "current provider" indicator, no `sttConnectionState` in `agenticStore.ts`. Compat `useArcaSpeechToText.startTranscription` currently **drops `pipelineId` entirely**.

### 2.5 Gap summary

1. No multi-provider concept per pipeline or per tenant; no fallback pointer anywhere.
2. No tenant-scoped STT credentials; Azure STT creds are env-global; Sarvam/OpenAI engines don't exist.
3. No error-triggered switching — streaming drops utterances silently; batch retries the same engine.
4. No mid-session switch primitive server- or client-side; no connection/provider state in the UI.

## 3. Architecture & Best Practices (decisions with rationale)

### 3.1 D-1 Credential plane: new `TenantSttProviderCredential` (mirror TASK-496), NOT `AiProviderConnection` reuse

**Decision**: `TenantSttConfig` + `TenantSttProviderCredential` tables mirroring the TTS pair, provider enum `azure-speech | sarvam | openai`.

Rationale — reuse of `AiProviderConnection` was evaluated and rejected:
- Name collision: `azure` there means Azure OpenAI (endpoint+deployment+apiVersion) and `sarvam` means Sarvam LLM. Overloading rows with per-capability semantics (or inventing `azure-speech` rows in an LLM-shaped table) breaks the `(tenantId, provider)` unique contract's meaning and the TASK-526 `CLOUD_BYO_PROVIDERS` gate.
- The TTS precedent already made this exact call for the same reason (its own `azure`/`sarvam` credential rows, separate table), and STT's credential shapes differ again (Azure Speech: key+region — a Cognitive Services *Speech* resource, not an OpenAI one; Sarvam: `api-subscription-key`; OpenAI: bearer key + optional org/base_url).
- Future generalization of the three speech credential tables into one is a deliberate, separate refactor — flagged in §7, not preempted (Karpathy rule 2).

Credential fields per provider (all keys write-only, masked reads `hasKey`+`keyVersion`, Vault-gate, `encryptSecretField`):

| Provider | Secret | Non-secret config |
|---|---|---|
| `azure-speech` | subscription key | `region` (classic) or `endpoint` (Foundry resource); optional `foundryModel` (e.g. `mai-transcribe-1.5`) in `extraJson` |
| `sarvam` | api-subscription-key | optional `model` (default `saaras:v4` / `saarika` family), `languageCode` default in `extraJson` |
| `openai` | API key | optional `baseUrl` (Azure-OpenAI-compatible endpoints), `model` (default `gpt-4o-transcribe`; `gpt-4o-mini-transcribe` for latency) |

### 3.2 D-2 Fallback selection: tenant-level pointer to a pipeline, on `TenantSttConfig`

**Decision**: `TenantSttConfig.fallbackPipelineId String?` — a tenant-level default fallback **pipeline** (not a bare provider). Validation on write: the target row must exist, be tenant-visible (own row or SYSTEM template clone), `resourceStatus: ENABLED`, and be **cloud-engine-backed** (a local GPU pipeline is not a meaningful outage escape). A `fallbackChain String[]` shape was considered (TTS `routingEn` precedent) and deferred: R2 asks for *a* default; the single pointer upgrades to a chain without migration pain (add column later), and multi-hop failover multiplies the runtime states to test.

Why pipeline, not provider: the pipeline is HOPE's existing unit of ASR selection, tenant ownership, and admin UX (`AudioPipelineController`); a fallback *provider* alone wouldn't say which VAD/diarization/postprocessing to run. New SYSTEM catalog pipelines for `sarvam` and `openai` engines are seeded (§4 Phase A) so every tenant has cloud pipelines to point at, exactly like the existing `azure_speech_transcription` catalog entry.

Tenant-editability: unlike `AiTaskDefault` (GLOBAL-ADMIN-ONLY prefixes), STT pipeline selection is **already tenant-admin self-service** — the fallback pointer and BYOK rows follow that existing posture (`manage AsrPipeline`-family permission), not the LLM lock. This is a deliberate, documented divergence, consistent with the owner requirement "tenant admins MUST be able to configure".

### 3.3 D-3 Credentials reach apps/stt two ways (streaming: inject; batch: pull) — never through Redis

- **Streaming**: gateway injection at session create (house default, TTS precedent). `StreamingSessionService.createSession` body gains `provider_overrides` (same snake_case wire shape as TTS/SMR: `{[provider]: {api_key, region?, base_url?, model?}}`) + `fallback_pipeline_id`. Held in the session runtime **in memory only**; never persisted, never logged.
- **Batch**: the Dramatiq worker is a separate process and job messages transit Redis — **injecting a decrypted key into the queue message is prohibited** (PHI posture; secrets never at rest outside Vault ciphertext). Instead the worker pulls at execution time: new gateway internal route `GET /api/v1/internal/stt/provider-overrides?tenantId=` (service-token-guarded, mirrors the existing `stt-internal.controller.ts` surface), called via the existing `EffectiveConfigClient` pattern (TTL ~60s, negative cache, single-flight). This is a documented exception to injection-by-default with the same justification class as guardrail's sanctioned resolver: there is no per-attempt HTTP request from the gateway to piggyback on.
- **Fail postures** (frozen, matching house convention): credential *injection* fails **open per credential** with a non-secret `warn` (`{tenantId, provider, keyVersion}`) — a broken BYO key degrades to platform env creds, never blocks transcription (TTS/TASK-526 posture, incl. the logged-warn improvement over TTS's silent catch). Provider/pipeline *selection* stays **fail-closed** — an unresolvable primary AND unresolvable fallback surfaces as an error, never a silent engine substitution the tenant didn't configure.

### 3.4 D-4 The switch mechanism: in-session engine swap inside `SessionManager` (streaming), alternate-pipeline dispatch (batch)

**Streaming — the "seamless" core.** The session's transport (browser WS ↔ gateway ↔ Redis streams) is provider-agnostic; only the ASR callable built by `_load_asr_pipeline` is provider-bound. Therefore:

- The session runtime keeps `primary_spec` + lazily-resolved `fallback_spec` (from `fallback_pipeline_id`). A new `EngineSwitchController` (per-session, in `session_manager.py`) owns a single transition `active_engine: primary → fallback` (one-way per session; no flapping).
- **Automatic trigger** (R2/R3): classified failures only — `CloudASRAuthError`/`CloudASRQuotaError` immediately; `CloudASRTranscriptionError`/`ModelError`/load failure after `N=2` consecutive utterance failures (counter resets on success). Reuses the existing exception taxonomy; no new circuit-breaker infrastructure in v1 (per-session state is enough; a Redis per-(tenant,provider) breaker is a §7 future).
- **Create-time trigger**: if `_load_asr_pipeline` for the primary fails at `create_session` and a fallback is configured, open the session directly on the fallback instead of 500-ing (today's behavior is rollback + raise).
- **Manual trigger** (R4): extend `SessionControl` with `action: SWITCH_TO_FALLBACK` on the existing `stt:control:{sid}` stream; `ControlListener` routes it to the same `EngineSwitchController`.
- **On switch**: build the fallback callable (warm it), swap the reference the inference loop uses, feed the current un-finalized utterance buffer to the new engine (best case: re-transcribed; acceptable floor: that single utterance is lost — the requirement is session survival), then publish a `status` result on `stt:result:{sid}`: `{type:'status', status:'provider_switched', from_pipeline, to_pipeline, reason: 'auto|user', utterance_index}`. Gateway `SttWsGateway` forwards it as the existing `status` WS frame — **zero WS protocol changes**.
- Rejected alternative — gateway-orchestrated session teardown + recreate on the fallback pipeline: tears the WS, loses the resume buffer, multiplies races with the 15s resume grace machinery, and turns "seamless" into "reconnect-shaped". Kept only as the SDK's degraded path when the service predates the control action (§3.6).

**Batch**: in `transcribe_file`, wrap the inference call; on a retryable-classified `CloudASRError`/`ModelError` with a configured fallback, re-run `batch_service.transcribe` once with the fallback pipeline config **within the same Dramatiq attempt** (attempt-local, so Dramatiq's own retries still apply to the fallback path); stamp `TranscriptionJob` result metadata with `usedFallbackPipelineId` for auditability. `CloudASRAuthError` on primary → skip straight to fallback (retrying the same bad key is pointless).

**User-facing switch entry (R4), gateway side**: `POST /audio/transcription-jobs/stream/session/:sessionId/switch-to-fallback` on `TranscriptionJobController` — guarded like `closeStreamSession` (`@TenantOwnedResource`), validates a fallback is configured, publishes the control action via a new `StreamingSessionService.switchToFallback(sessionId)` → apps/stt internal `POST /internal/streaming/sessions/{id}/switch` (which XADDs the control message). 409 if already on fallback / no fallback configured.

### 3.5 D-5 New engines in apps/stt: Sarvam + OpenAI (Azure already exists)

Follow the established add-an-engine recipe (each ≈ loader + adapter + 2 inference bodies + registry entry):

| | `SARVAM` | `OPENAI` |
|---|---|---|
| `AiModelFormat` member + `_PROVIDER_ALIASES` | `sarvam :: saaras-v3` shorthand | `openai :: gpt-4o-transcribe` shorthand |
| Loader | `sarvam_loader.py` — validates key (tenant override or `SARVAM_API_KEY` env), `device="cloud"`, mem 0 | `openai_loader.py` — key (override or `OPENAI_API_KEY`), optional base_url |
| Streaming | `wss://api.sarvam.ai/speech-to-text/ws` (PCM16/WAV; VAD modes; `api-subscription-key` header) — `SessionManager._make_sarvam_callable` bridges per-utterance PCM → WS → text (utterance-scoped connection or pooled) | OpenAI Realtime transcription WS (`gpt-4o-transcribe` / `gpt-4o-mini-transcribe`) — `_make_openai_callable`; alternatively v1 ships REST `/audio/transcriptions` per utterance (simpler, ~utterance-latency acceptable since HOPE already segments by VAD) — **decision point flagged for implementation: per-utterance REST first, realtime WS as fast-follow** |
| Batch | Sarvam batch REST | `POST /v1/audio/transcriptions` |
| Errors | Map 401/403 → `CloudASRAuthError`, 429 → `CloudASRQuotaError`, else `CloudASRTranscriptionError` (exact Azure pattern) | same |
| Capabilities | `Capability(device='cloud', streaming=True, batch=True)` | same |

Azure Foundry: already integrated (`AZURE_FOUNDRY`, batch-only, disabled by default) — this ticket only adds the per-tenant key/endpoint override path to its existing loader; it stays batch-only.

Per-tenant credential consumption inside apps/stt: loaders accept an optional `provider_overrides` dict from the session runtime / effective-config pull (D-3) and prefer it over `get_settings()` env values. Keys live only in the in-memory `LoadedModel`/session runtime; `SecretStr`-wrapped; excluded from all logging (loaders already never log key material — keep it that way, test-locked).

### 3.6 D-6 SDK surface (R4 + visibility)

- **Store**: add `sttConnectionState: 'connected'|'reconnecting'|'switched_fallback'|'error'` + `activePipeline: {id, name, isFallback}` to `agenticStore.ts`; wire the four dangling `SttWebSocketClient` callbacks (`onReconnect`/`onReconnected`/`onReconnectFailed`/`onDisconnect`) — this closes a pre-existing observability gap the feature depends on.
- **Status handling**: `StreamingBackendSTTProvider` forwards `status: 'provider_switched'` frames; `useArcaAudio` exposes `activePipeline` + `switchToFallback(): Promise<void>` calling the new REST endpoint via `AgenticClient`. Degraded path (older service without the control action → 404): destroy/recreate the session on the fallback `pipelineId` using the existing `configFingerprint` rebuild primitive, surfaced honestly as `reconnecting`.
- **UI**: consumer apps show a toast/banner on auto-switch ("Transcription switched to fallback provider") and a manual switch affordance — playground/example wiring only in this ticket; admin-console live surfaces unaffected.

### 3.7 Settings-registry & config tiers (rule 09 compliance)

| Key | Tier | failMode |
|---|---|---|
| `stt.credential.azure-speech` / `.sarvam` / `.openai` | `db-secret` (Vault-Transit ciphertext column) | `closed` (secrets are mandatory-closed) |
| `stt.fallback.pipelineSlug` (descriptor over the `TenantSttConfig` column) | `db-config` | `closed` (it is provider *selection*) |
| `stt.fallback.autoSwitchEnabled` (tenant kill-switch for auto-trigger; default ON), `stt.fallback.consecutiveFailureThreshold` | `db-config` | `open-to-default` (tuning) |

Descriptors registered in `packages/applications/src/services/settings-registry/descriptors/` (new `stt-fallback.descriptors.ts`, mirroring `tts.descriptors.ts`). No new env vars except optional platform-level `SARVAM_API_KEY`, `OPENAI_API_KEY` service fallbacks in apps/stt settings (added to `turbo.json#globalEnv` + `.env.example` per rule 00 — placeholders only).

### 3.8 Provider API research notes (2026-07, external)

- **Azure**: real-time via Speech SDK/WebSocket + fast-transcription REST for batch; Foundry hosts both classic Speech and MAI-Transcribe models; 140+ languages. Already integrated in HOPE — BYOK override is the only delta.
- **Sarvam**: `wss://api.sarvam.ai/speech-to-text/ws`, `saaras:v4` default (modes: transcribe/translate/verbatim/translit/codemix), **WAV/PCM16 only, sample rate must match actual audio**, built-in VAD with sensitivity control, `api-subscription-key` auth, 10+ Indic languages + English — strong fit for HOPE's en+ml posture.
- **OpenAI**: `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` (better WER than whisper-1), REST `/v1/audio/transcriptions` + Realtime WS transcription sessions; `gpt-realtime-whisper` offers latency/quality-tradeoff delay settings.
- **Industry failover practice** (matches the design): classify errors before switching (auth/quota = immediate, transient = threshold), fail open on credential degradation but closed on selection, one-way switch per session to avoid flapping, always emit an observable event on switch, and never silently change the model family mid-transcript without telling the user (clinical-quality concern — hence the status frame + UI banner are REQUIRED, not optional).

## 4. Implementation Plan (ordered; layer chain DB → domains → applications → api → apps/stt → SDK → console)

Optional sub-ticket split if preferred: **567** = Phases A–D (config plane + BYOK + injection), then one sub-ticket each for Phase E (apps/stt engines + switch runtime), Phase F (SDK), and Phase G (console screen) — numbers allocated at split time (**TASK-568 is already taken** by the v1-compat provider-switch companion, see below). Phases are independently shippable in that order (each leaves the system consistent; the wire fields are inert until consumed — the TASK-496/526 phasing pattern).

**Companion ticket**: `docs/implementation/TASK-568-v1-Compat-STT-Provider-Switch/README.md` — exposes the R4 user control flow on the `@arcaai/vox/compat` surface (TASK-560–566 audience) as a thin additive hook over this ticket's Phase F output. Depends on Phase F; not part of this ticket's scope.

### Phase A — Database (`packages/database`)
1. `tenant-stt-config.prisma`: `TenantSttConfig` (house field template; `tenantId @unique`; `fallbackPipelineId String?`; `autoSwitchEnabled Boolean @default(true)`; `configJson Json?`) + `TenantSttProviderCredential` (`(tenantId, provider)` unique; `provider String` ∈ `azure-speech|sarvam|openai`; `endpoint/region String?`; `encryptedApiKey Bytes?`; `keyVersion Int?`; `enabled Boolean`; `extraJson Json?`). Migration `task_567_tenant_stt_fallback_config`.
2. Allow-lists: both models → `TENANT_SCOPED_MODELS`; credentials NEVER `SYSTEM_SHARED_READ_MODELS`; `TenantSttConfig` SYSTEM row = platform default (TTS parity).
3. Seeds: SYSTEM `AiModel` rows (`sarvam-saaras-v3`, `openai-gpt4o-transcribe`) + SYSTEM `AsrPipeline` catalog entries (`sarvam_transcription`, `openai_transcription`) in `seed/06-stt.ts`; SYSTEM `TenantSttConfig` row (no fallback by default — fallback is an explicit tenant choice).
4. `ResourceType` additions in BOTH `audit.prisma` (+`ADD VALUE` migration) and `packages/domains/src/enums/generated/ResourceType.ts` (enum-parity test guards).
   - **Verify**: migration SQL reviewed; `pnpm db:generate`; `pnpm --filter @arcaai/database test`.

### Phase B — Domains (`packages/domains`)
5. `pnpm gen:model` for both models; **hand-author** entity/factory/mapper/repository ×2 (never `gen:mapper`/`gen:repository`; mappers carry `FIELDS_NOT_WRITABLE=['version']` — both are OCC-written); register in `CoreDatabaseModule`; barrels; `gen:entity`+`gen:factory` reconcile.
   - **Verify**: `pnpm --filter @arcaai/domains build test`; drift `:check`s green.

### Phase C — Applications (`packages/applications`)
6. `services/tenant-stt-config/` (mirror `tenant-tts-config/` file-for-file): `ITenantSttConfigService` token, service (`getEffective` tenant→SYSTEM merge; `setFallbackPipeline` with the §3.2 validation via `PipelineService`; credential CRUD with Vault-gate + masked reads; `resolveProviderOverrides` fail-open-per-credential **with** the non-secret warn), DTO mapper, request/response DTOs (OCC `expectedVersion` on the config PUT; credentials PUT non-versioned? **No — deliberate TASK-526 divergence: OCC on credentials too**, `If-Match: "0"` create convention), module, barrel, sys-events on every mutation.
7. `settings-registry/descriptors/stt-fallback.descriptors.ts` (§3.7) + registration.
8. `StreamingSessionService.createSession` gains `providerOverrides` + `fallbackPipelineId` params (wire: `provider_overrides`, `fallback_pipeline_id`); new `switchToFallback(sessionId)` → apps/stt internal switch route.
   - **Verify**: `pnpm --filter @arcaai/applications build test` (TDD list §5 items 1–8 RED first).

### Phase D — API gateway (`apps/api`)
9. `modules/tenant-stt-config/tenant-stt-config-admin.controller.ts` (`admin/stt-config`): `GET ''` (effective), `GET/PUT 'row'` (If-Match OCC), `GET 'fallback-candidates'` (enabled cloud pipelines the tenant may target), `GET/PUT/DELETE 'credentials/:provider'` (masked; 428/412 OCC; unknown provider 400; cross-tenant 404). Tenant admins pinned to own tenant; elevated via working tenant.
10. `TranscriptionJobController`: `createStreamSession` resolves `getEffective` + `resolveProviderOverrides` (fail-open, warn) and forwards both; new `POST stream/session/:sessionId/switch-to-fallback` (§3.4; `@TenantOwnedResource`; 409 semantics).
11. `stt-internal.controller.ts`: `GET internal/stt/provider-overrides` (service-token; batch pull, D-3).
12. `SttWsGateway`: forward the `provider_switched` status result to the client `status` frame (likely zero-change if status frames already pass through — verify, and test-lock).
    - **Verify**: `pnpm api:build && pnpm test:unit`; e2e spec authored (§5 item 15).

### Phase E — STT service (`apps/stt`)
13. Settings: optional `sarvam_api_key`, `openai_api_key`/`openai_base_url` (SecretStr, env fallbacks).
14. Engines: `AiModelFormat.SARVAM`/`OPENAI` + aliases; `sarvam_loader.py` / `openai_loader.py`; adapters in `asr_engines.py` + registry `Capability` rows; `_run_sarvam_inference`/`_run_openai_inference` (batch) and `_make_sarvam_callable`/`_make_openai_callable` (streaming — per-utterance REST for OpenAI v1, §3.5); error mapping to the `CloudASR*` taxonomy; loaders honor `provider_overrides` (in-memory only, never logged).
15. Azure loaders: accept per-tenant key/region/endpoint overrides (same override dict), env fallback preserved.
16. Streaming switch runtime: `CreateStreamingSessionRequest` gains `provider_overrides` + `fallback_pipeline_id`; `EngineSwitchController` in `session_manager.py` (§3.4 triggers: create-time, auto with threshold + taxonomy classification, manual); `SessionControl.SWITCH_TO_FALLBACK` + internal `POST /internal/streaming/sessions/{id}/switch`; `provider_switched` status publication; utterance-buffer handoff.
17. Batch fallback dispatch in `transcribe_file` (§3.4) + `usedFallbackPipelineId` result metadata; effective-config client extension for the credential pull (TTL/negative-cache/single-flight reuse).
18. Prometheus: `stt_provider_switch_total{tenant,from,to,reason}`, `stt_cloud_asr_errors_total{provider,class}`.
    - **Verify**: `pnpm stt:test` (unit tiers mirror `test_azure_speech_flow.py`'s 3-tier pattern: YAML-only / mocked-SDK / `@slow` real-creds); `pnpm py:stt:lint` + `typecheck`; `uv lock` after adding `sarvam`/`openai` deps (prefer plain `httpx`/`websockets` over vendor SDKs — both APIs are thin HTTP/WS; avoids two new dependency trees).

### Phase F — SDK (`packages/agentic-sdk-v2`, `packages/stt`)
19. Store: `sttConnectionState` + `activePipeline`; wire the four dangling reconnect callbacks.
20. `StreamingBackendSTTProvider`/`STTProcessor`: surface `provider_switched` status; `useArcaAudio`: `activePipeline`, `switchToFallback()` (+ degraded destroy/recreate path); compat `useArcaSpeechToText`: forward `pipelineId` (fixes the drop found in §2.4 — coordinate with TASK-564/565 compat work in flight on this branch).
21. Playground/example: switch button + switched banner (minimal).
    - **Verify**: `pnpm sdk:build` + `pnpm --filter @arcaai/vox test lint typecheck`.

### Phase G — Admin console (`apps/admin-console`) — after rule-12 gate
22. `/(tenant)` STT configuration surface (recommend a tab on the existing pipelines screen or a sibling `/stt-config` mirroring `/tts-config`): fallback pipeline picker (from `fallback-candidates`), auto-switch toggle, three `CredentialCard`s (TTS pattern verbatim), `WorkingTenantGate` + acting-on banner, skeletons, axe 0 violations, both themes.
    - **Verify**: `pnpm --filter @arcaai/admin-console build lint test` + `next-dev-loop` runtime pass.

### Phase H — Evidence & docs
23. E2E executed (gateway e2e spec + apps/stt e2e tier-2), traceability-matrix rows, this README's Implementation Summary + Change History, `apps/stt/README.md` + `docs/architecture/overview.md` deltas.

## 5. TDD Plan (RED first; failing output pasted here before implementation)

Applications (`tenant-stt-config/__tests__/`):
1. Credential CRUD: unknown provider → 400; no `SecretsService` → write rejected (no plaintext-at-rest); key never echoed (deep snapshot over set/rotate/get/list); OCC drift → `OptimisticConcurrencyException`; sys-event on every mutation; factory-created entities.
2. `setFallbackPipeline`: non-existent / cross-tenant (→404) / disabled / non-cloud pipeline rejected; valid SYSTEM-catalog clone accepted.
3. `resolveProviderOverrides`: disabled row skipped; decrypt failure → credential skipped + warn with exactly `{tenantId, provider, keyVersion}` and no `vault:`/plaintext substrings; tenant isolation (A's key never in B's overrides — reuse `tests/cross-tenant/fixtures.ts`).
4. `getEffective`: tenant→SYSTEM merge; no-fallback default.

API:
5. Admin controller: 428/412 OCC matrix; cross-tenant → 404 (never 403); masked list.
6. `createStreamSession` forwards `provider_overrides` + `fallback_pipeline_id`; resolver throwing → session still created without overrides (fail-open) + warn.
7. `switch-to-fallback`: happy path publishes; no fallback configured → 409; foreign session → 404.
8. Internal provider-overrides route: rejects without service token.

apps/stt (pytest):
9. Loaders: sarvam/openai load with override key, fall back to env, `CloudASRAuthError` when neither; key material absent from repr/logs (caplog assertion).
10. Engine adapters resolve via `resolve_asr_engine`; capability rows admit `(cloud, streaming|batch)`.
11. Error mapping: 401→Auth, 429→Quota, 5xx→Transcription for both new engines (mocked HTTP).
12. `EngineSwitchController`: auth error → immediate switch; 2 consecutive transcription failures → switch; success resets counter; one-way (no second switch); `provider_switched` status published with correct reason; `SWITCH_TO_FALLBACK` control action triggers manual switch; create-time primary-load failure with fallback configured → session opens on fallback; **without** fallback → today's rollback+raise preserved.
13. Batch: retryable cloud error + fallback → same-attempt re-dispatch on fallback + `usedFallbackPipelineId` stamped; `CloudASRAuthError` skips straight to fallback; no fallback → existing Dramatiq behavior unchanged (regression lock).
14. YAML/DTO: `sarvam ::`/`openai ::` shorthands parse; v1.x configs still parse (forward-tolerance lock).

E2E (authored now, run when live stack available):
15. `apps/api/tests/e2e/stt-fallback-cross-tenant.spec.ts`: deep-key secret scan on every response, no-reveal probe, OCC matrix, cross-tenant 404, switch-endpoint auth.
16. SDK: `useArcaAudio` exposes switch + state transitions on mocked status frames; compat hook forwards `pipelineId`.

## 6. Acceptance & DoD

- [ ] Tenant admin sets/rotates/removes BYOK for all three providers; keys Vault-encrypted; **no response or log ever contains key material** (snapshot + caplog + e2e-locked)
- [ ] Fallback pipeline configurable (validated targets only); auto-switch on classified outage in streaming AND batch; manual mid-session switch via REST→control-stream; session/WS survives every switch
- [ ] Client informed on every switch (`provider_switched` status → store → UI banner); switch observable in Prometheus + sys-events/audit
- [ ] Fail postures honored: credential injection fail-open (warned), selection fail-closed, no-fallback behavior byte-identical to today (regression-locked)
- [ ] All §5 gates green with pasted output; `uv lock` updated; new env keys in `turbo.json#globalEnv` + `.env.example` (placeholders); rule-12 gate satisfied for Phase G; traceability matrix + service READMEs updated

## 7. Risks, Open Decisions & Future Work

| Risk / decision | Mitigation / owner call needed |
|---|---|
| **Clinical quality on silent engine change**: fallback may transcribe worse (different model family) | Switch is always surfaced to the clinician (banner + status event); auto-switch tenant-toggleable (`autoSwitchEnabled`); one-way per session prevents flapping |
| **Mid-utterance data loss on switch** | Buffer handoff re-feeds the un-finalized utterance; floor documented as "≤1 utterance"; test-locked |
| OpenAI streaming: per-utterance REST (v1) vs Realtime WS | Flagged decision — REST first (simpler, VAD already segments), WS fast-follow; owner may override |
| Sarvam PCM16/sample-rate strictness | Session pipeline already normalizes/resamples (TASK-505 stages); assert 16k mono before send |
| Key material transiting the batch queue | Prohibited by design (D-3 pull path); test asserts Dramatiq message contains no `api_key` |
| Vendor lock-in of a 4th speech-credential table shape later (TTS/LLM/STT tables diverging) | Deliberate; a unifying `TenantServiceCredential` refactor is future work, not preempted |
| Per-(tenant,provider) shared circuit breaker (Redis) across sessions | Future; v1 per-session thresholds are sufficient and simpler |
| Fallback chain (ordered N-provider list) | Future; single pointer is forward-compatible |
| Rollback | Additive throughout: drop the two tables' consumers, the wire fields are ignored by older services, control action unknown → no-op; migration is additive-only |

## 8. References

- Exemplars: `packages/applications/src/services/tenant-tts-config/tenant-tts-config.service.ts` (BYOK+routing), `apps/api/src/modules/speech/speech-proxy.controller.ts:64` (inject), `packages/applications/src/services/ai-provider-connection/` (TASK-526 lane), `secret-field.util.ts` (crypto core), `apps/stt/src/stt/models/azure_speech_loader.py` + `tests/e2e/test_azure_speech_flow.py` (engine + 3-tier test template)
- Rules: 02 (model template/allow-lists), 03 (hand-authored trios; never `gen:mapper`), 04 (BaseService/sys-events/404-over-403), 05 (OCC 428/412, internal routes), 06 (env prefixes, gateway-resolved injection + sanctioned pull exception), 09 (config tiers, db-secret), 12/13 (design gate, console)
- Tickets: TASK-496 (TTS BYOK), TASK-505 (pipeline v2/registry), TASK-506 (AiTaskDefault), TASK-524/526 (AiProviderConnection BYO), TASK-529 (model lifecycle)
- Provider docs (researched 2026-07-28): [Azure Speech STT overview](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-to-text) · [Azure real-time recognition](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-recognize-speech) · [Sarvam streaming STT WS](https://docs.sarvam.ai/api-reference-docs/speech-to-text/apis/streaming) · [Sarvam STT overview](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/overview) · [OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text) · [OpenAI realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)

## 9. Implementation Summary

### Phase A — Database (`packages/database`)

`packages/database/src/prisma/db_main/tenant-stt-config.prisma` (new) — `TenantSttConfig` (`tenantId @unique`; `fallbackPipelineId String?`; `autoSwitchEnabled Boolean @default(true)`; `configJson Json?`) + `TenantSttProviderCredential` (`(tenantId, provider)` unique; `provider String` — `azure-speech|sarvam|openai`; `endpoint`/`region`/`encryptedApiKey`/`keyVersion`/`enabled @default(true)`/`extraJson`), both carrying the standard meta/audit/resource-status field template and `_version` OCC. Migration `20260728000000_task_567_tenant_stt_fallback_config` (additive-only: 2 `CREATE TABLE` + indexes; **not applied** — no `db:migrate`/`db:push` was run, per this task's constraints; the folder is on disk for review, application is an owner step). Allow-lists updated in `packages/database/src/extensions/tenant-scope.ts`: both models added to `TENANT_SCOPED_MODELS`; only `TenantSttConfig` added to `SYSTEM_SHARED_READ_MODELS` (credentials are never SYSTEM-shared, matching the TTS precedent exactly). `ResourceType.TenantSttConfig`/`TenantSttProviderCredential` added to both `audit.prisma` and `packages/domains/src/enums/generated/ResourceType.ts` (enum-parity test-guarded). **Seed rows for the new SYSTEM catalog (`AiModel`/`AsrPipeline`/`AiProviderConnection`/RBAC grant) were deferred out of this phase and landed later in the Phase E continuation pass** (see below) — noted honestly rather than implied as done here.

Gate: `pnpm --filter @arcaai/database test` → **870 passed** (current, this pass — includes the coupled seed-test updates from the later continuation pass, see Phase E below).

### Phase B — Domains (`packages/domains`)

Hand-authored trio ×2 (never `gen:mapper`/`gen:repository`, per rule 03): `entities/generated/core/{TenantSttConfigEntity,TenantSttProviderCredentialEntity}.ts`, `factories/generated/core/{TenantSttConfigFactory,TenantSttProviderCredentialFactory}.ts`, `mappers/generated/core/{TenantSttConfigEntityMapper,TenantSttProviderCredentialEntityMapper}.ts` (both carry `FIELDS_NOT_WRITABLE = ['version']` — both models are OCC-written), `repositories/generated/core/{TenantSttConfigRepository,TenantSttProviderCredentialRepository}.ts` extending the base `Repository<Entity, Model>`. `models/generated/core/{TenantSttConfigModel,TenantSttProviderCredentialModel}.ts` produced by `pnpm gen:model` (the one true generator). Registered in `CoreDatabaseModule` (`packages/domains/src/common/databaseServices/core/core.database.module.ts`) — both providers and exports. Barrels (`entities`/`factories`/`mappers`/`models`/`repositories` `index.ts`) updated (reconciled by `gen:entity`/`gen:factory` for the entity/factory pair; mapper/repository barrel lines added by hand, per rule 03).

Gate: `pnpm --filter @arcaai/domains test` → **1408 passed, 2 skipped** (this pass).

### Phase C — Applications (`packages/applications`)

`services/tenant-stt-config/` (mirrors `services/tenant-tts-config/` file-for-file): `ITenantSttConfigService.ts` (symbol token), `tenant-stt-config.service.ts` (`TenantSttConfigService extends BaseService` — `getEffective` tenant→SYSTEM merge via `resolveEffectiveSttConfig`, `setFallbackPipeline`/`setAutoSwitch` with §3.2 validation delegated to `PipelineService` + `CLOUD_STT_PROVIDERS`/`CLOUD_STT_FORMATS` cloud-engine gate, credential CRUD (`setCredential`/`getCredentials`/`deleteCredential`) Vault-gated through `encryptSecretField`/`decryptSecretField` with masked reads (`hasKey`+`keyVersion` only), `resolveProviderOverrides` fail-open-per-credential with the non-secret `{tenantId, provider, keyVersion}` warn), `platform-limits.ts` (pure resolver — `BYO_STT_PROVIDERS`, `CLOUD_STT_PROVIDERS`/`CLOUD_STT_FORMATS`, `STT_FALLBACK_DEFAULTS`, `SttProviderOverrides` wire type, `resolveEffectiveSttConfig`), `tenant-stt-config.dto.mapper.ts`, `dto/` (`set-stt-fallback.request.ts`, `set-stt-credential.request.ts`, `tenant-stt-config.response.ts`, `effective-stt-config.response.ts`, `stt-credential.response.ts` — OCC `expectedVersion` on both the config PUT and credential PUT, the deliberate TASK-526 divergence recorded in §4 item 6), `tenant-stt-config.service.module.ts` (imports `CommonServiceModule` + `CoreDatabaseModule`; exports the token), `__tests__/tenant-stt-config.service.test.ts` (TDD §5 items 1–4). `settings-registry/descriptors/stt-fallback.descriptors.ts` (new) registered in `registry.ts` (§3.7: 3 `db-secret` credential descriptors `failMode: 'closed'`, `stt.fallback.pipelineSlug` `db-config`/`closed`, `stt.fallback.autoSwitchEnabled`/`consecutiveFailureThreshold` `db-config`/`open-to-default`). `streaming-session.dto.ts` + `streamingSession.service.ts` gained `providerOverrides`/`fallbackPipelineId` params (wire `provider_overrides`/`fallback_pipeline_id`) and a new `switchToFallback(sessionId)` method; `IStreamingSessionService.ts` interface updated to match.

Gate: `pnpm --filter @arcaai/applications test` → **7128 passed, 4 skipped** (this pass).

### Phase D — API gateway (`apps/api`)

`modules/tenant-stt-config/` (new): `tenant-stt-config-admin.controller.ts` (`@Controller('admin/stt-config')`, class-level `@Authorize()`) — `GET ''` (effective, `read`), `GET/PUT 'row'` (`manage`, `@RequiresIfMatch()` + `@ExpectedVersion()` — 428/412 OCC), `GET 'fallback-candidates'` (`read`), `GET 'credentials'` (`read`, masked), `PUT 'credentials/:provider'` (`manage`, OCC, unknown provider → 400), `DELETE 'credentials/:provider'` (`manage`); `tenant-stt-config.module.ts` registered in `app.module.ts`'s `featureModules`. `transcription-job.controller.ts`: `createStreamSession` resolves `getEffective` + `resolveProviderOverrides` and forwards both (fail-open on resolver throw, per §3.3); new `POST stream/session/:sessionId/switch-to-fallback` (`@TenantOwnedResource({ modelName: 'StreamSession', paramName: 'sessionId', lookup: 'session' })`, `@HttpCode(200)`; fail-closed selection guard — no fallback configured → 409 `ConflictException`; downstream 409/404 from the STT internal route mapped 1:1). `stt-internal.controller.ts`: `GET internal/stt/provider-overrides` (`ensureInternalApiKey` service-token guard; 400 on missing `tenantId`; pins `tenantId` into CLS before calling `resolveProviderOverrides` — batch-worker pull path, D-3). `SttWsGateway`: **zero code change required** — `status` results already pass through verbatim (test-locked in `stt-ws.gateway.test.ts`, new case: "forwards a provider_switched status result to the client verbatim (no seq tag)").

Gate (this pass): `pnpm api:build` — hit the documented concurrent-`nest --watch` race once (`ENOTEMPTY` on `rimraf dist` colliding with the live watcher rewriting `dist/modules/user`), succeeded cleanly on immediate retry (owner's `nest start --debug ... --watch` process is live throughout this session, matches the task's stated caveat). `pnpm test:unit` → **17477 passed, 4 skipped, 9 todo, 2 files failed** — both failures traced (not this ticket's code): `scripts/__tests__/env-sync.test.ts` ("declares at most ~130 distinct keys": 134) is **pre-existing, confirmed unrelated to TASK-567 via `git stash` bisection** (fails identically on the pre-TASK-567 tree — no file this ticket touches feeds that budget); `tests/contracts/ai-model-providers.contract.test.ts` **IS caused by this ticket** (Phase E's seed change added `openai` to the seed's provider list without the matching DTO allow-list edit — see Phase H below, follow-up spawned, not fixed in this docs-only pass). `pnpm lint --filter=@arcaai/api` also surfaced one real, ticket-caused issue: an unused `APIRequestContext` import in the new e2e spec (hard error in this app per rule 05) — also follow-up-spawned, not fixed here.

### Phase E — STT service (apps/stt): engine layer landed; switch runtime deferred

**Landed & gate-verified (2026-07-28)** — the Sarvam + OpenAI cloud BYOK ASR engines, plus the Azure BYOK override path. All uncommitted on `thuynh/2607` (matches prior phases' convention). No DB-applying command was run; no new Python dependency (uses the existing `httpx>=0.28.1`), so no `uv lock` change.

Engine layer (plan items 1–5, 9, 13):
- `pipeline/dto.py` — `AiModelFormat.SARVAM` + `OPENAI` (deliberate superset of the Prisma enum, like `KSERVE`; reachable via `provider :: model` shorthand, no Prisma migration implied), `_PROVIDER_ALIASES` (`sarvam`, `openai`) + `from_value` engine-mapping entries.
- `core/config/settings.py` — `sarvam_api_key`/`sarvam_base_url`, `openai_api_key`/`openai_base_url` (SecretStr env fallbacks).
- `models/cloud_asr.py` (new) — `CloudRestConfig` (frozen; key wrapped in `SecretStr`, `__repr__` never leaks it), `resolve_override_key`, `wav_bytes_from_samples`, and `raise_for_cloud_status`/`raise_for_cloud_transport` (401/403→`CloudASRAuthError`, 429→`CloudASRQuotaError`, else→`CloudASRTranscriptionError`, emitting `stt_cloud_asr_errors_total`).
- `models/sarvam_loader.py` + `models/openai_loader.py` (new) — validate key from injected `provider_overrides` FIRST, else env; `device="cloud"`, mem 0; `CloudASRAuthError` when neither; key never logged (test-locked via caplog + repr assertions). Registered in `cache.py` `_loaders` and `models/__init__.py`.
- `models/azure_speech_loader.py` + `models/azure_foundry_loader.py` — accept the same `provider_overrides` (`azure-speech` entry: key/region/endpoint), env + inline fallback preserved.
- `streaming/sarvam_asr.py` + `streaming/openai_asr.py` (new) — async `httpx` per-utterance/whole-audio recognize helpers (OpenAI per-utterance REST `POST {base_url}/audio/transcriptions` per §3.5; Sarvam REST `POST {base_url}/speech-to-text`).
- `transcription/batch_service.py` — `_run_sarvam_inference` / `_run_openai_inference`; `streaming/session_manager.py` — `_make_sarvam_callable` / `_make_openai_callable`.
- `processors/asr_engines.py` — `SarvamEngine`/`OpenAIEngine` adapters + `ASR_FORMAT_TO_NAME` entries; `processors/asr_capabilities.py` — `Capability(device='cloud', streaming=True, batch=True)` registry rows.
- `core/metrics.py` — `stt_cloud_asr_errors_total{provider,class}` (emitted now, from the error-mapping boundary) + `stt_provider_switch_total{tenant,from,to,reason}` (defined; emission site lives in the deferred switch runtime).

Tests (RED-first intent; the format-map set-equality test `test_every_model_format_is_mapped` was the natural RED between the enum and adapter edits): `tests/unit/models/test_sarvam_loader.py`, `test_openai_loader.py`, `tests/unit/streaming/test_cloud_rest_asr.py`, `tests/unit/test_provider_shorthand_task567.py`, plus extensions to `tests/unit/processors/test_asr_engines.py` (dispatch + health-payload set).

Gate evidence:
- `pytest` (new engine-layer subset + regression over touched files): `154 passed` then `374 passed` (dto/cache/loaders/config_reader/session-manager wiring/gloss/metrics). Full `pnpm stt:test` also drives the infra-gated integration/e2e tiers (real creds / live infra) which are out of scope here.
- `ruff check apps/stt/src/ apps/stt/tests/`: `All checks passed!`
- `mypy` over all new + edited modules: `Success: no issues found`.

### Phase E — STT service (apps/stt): switch runtime + batch fallback landed (2026-07-28, continuation pass)

The previously-deferred switch runtime, batch fallback, effective-config pull, DB seeds, and RBAC grant are now implemented and gate-verified. Uncommitted on `thuynh/2607`; no DB-applying command run; no new Python dependency (`uv.lock` unchanged).

Streaming switch runtime (plan item 6):
- `streaming/engine_switch.py` (new) — `EngineSwitchController`: one-way `primary → fallback` per session. Classifies failures (`CloudASRAuthError`/`CloudASRQuotaError` → immediate; `CloudASRTranscriptionError`/`ModelError` → after N=2 consecutive, counter resets on success), fail-closed selection, injected build/apply/publish primitives (unit-testable in isolation).
- `streaming/session_manager.py` — `create_session` gains `provider_overrides` + `fallback_pipeline_id` (in-memory only, never persisted/logged); create-time fallback (primary ASR load failure with a fallback configured opens on the fallback instead of raising); `_make_switch_controller` / `_build_fallback_asr_callable`; inference loop records success/failure through the controller and re-runs the un-finalized utterance on the swapped engine (buffer handoff); `SWITCH_TO_FALLBACK` handled in `_make_control_handler`; `request_switch_to_fallback` XADDs the control message; per-session state torn down in `remove_session`.
- Cloud-BYOK cache bypass: `_load_asr_pipeline` / batch `_load_models` load cloud ASR engines directly through the loader (uncached) when a per-tenant override is present, so a decrypted key is never cached under a slug and served cross-tenant. Env-only path byte-identical.
- `streaming/schemas.py` — `ControlAction.SWITCH_TO_FALLBACK`; `streaming/redis_streams.py` — `ResultPublisher.publish_provider_switched` (`{type:'status', status:'provider_switched', from_pipeline, to_pipeline, reason, utterance_index}`, zero WS protocol change); `streaming/api/schemas.py` + `routes.py` — request fields + `POST /internal/streaming/sessions/{id}/switch` (404 unknown / 409 no-fallback|already-switched), matching the already-landed gateway `StreamingSessionService.switchToFallback`.

Batch fallback (plan items 7, 8):
- `transcription/workers/transcribe_file.py` — actor gains `fallback_pipeline_id`; pulls tenant `provider_overrides` via `get_effective_config_client().get_provider_overrides` (fail-open) and passes them to `batch_service.transcribe`; on a retryable `CloudASRError`/`ModelError` (or `CloudASRAuthError` → straight) with a fallback configured, re-runs `transcribe` once on the fallback within the same Dramatiq attempt and stamps `result.metadata["usedFallbackPipelineId"]`. No-fallback path byte-identical (regression-locked).
- `transcription/batch_service.py` — `transcribe`/`_load_models` accept `provider_overrides` with the cloud cache-bypass.
- `core/effective_config.py` — `EffectiveConfigClient.get_provider_overrides(tenant_id)`: per-tenant TTL cache + single-flight + fail-open, hitting `GET /internal/stt/provider-overrides?tenantId=`.

DB seeds + RBAC (plan item 10, Phase-A/D gaps — `packages/database`):
- `seed/ai-models/shared.ts` — `openai` added to `AI_MODEL_PROVIDERS`; `seed/17-ai-provider-connection.ts` — SYSTEM `openai` connection row (config-plane coverage parity); `seed/ai-models/audio.ts` — SYSTEM `AiModel` rows `sarvam-saaras-v3` + `openai-gpt4o-transcribe` (`format: CLOUD_API`, catalog metadata); `seed/06-stt.ts` — SYSTEM `AsrPipeline` catalog rows `sarvam-transcription` + `openai-transcription` (inline `engine: sarvam`/`openai` refs, cloud BYOK fallback candidates).
- `seed/01-policy.ts` — tenant-full-access policy gains `manage TenantSttConfig` (mirrors `TenantTtsConfig`; without it tenant admins 403 on `/admin/stt-config`).
- Coupled test updates kept green: `ai-model-consolidation-seed.test.ts` (37→39, `TASK_567_NEW_SLUGS`, `ALLOWED_PROVIDERS`+openai), `seed.test.ts` (9→11 base pipelines), `pipeline-template-lineage-migration.test.ts` (the frozen TASK-531 9-slug backfill is now asserted as a subset of the growing catalog — the committed migration is immutable and post-531 templates are not part of it).

Tests (plan §5 items 9–14): `tests/unit/streaming/test_engine_switch.py` (11 — immediate/threshold/one-way/success-reset/manual/no-fallback/auto-disabled/ignore-class/create-time/fail-closed) and `tests/unit/test_transcribe_file_fallback_task567.py` (4 — retryable re-dispatch, auth-straight-to-fallback, no-fallback regression lock, happy-path-never-touches-fallback); loaders/error-map/shorthand already landed in the engine-layer pass. Also fixed the red `test_registry.py::test_asr_engines_registered` (added `sarvam`/`openai` to `EXPECTED_ASR`) and the create_session mock setups in three streaming tests (new in-memory dicts) + one loader-spy signature.

Gate evidence (this pass): `pnpm --filter @arcaai/database test` → **870 passed**; apps/stt unit tier (`pytest tests/unit/`) → **2517 passed** (incl. 15 new); `ruff check src/ tests/` → clean; `mypy src/` → **Success (129 files)** after removing a pre-existing redundant `cast` in `transcription/preprocessing.py:288` (env stub drift, unrelated to this ticket — the only change mypy demanded to green the full-src gate; file was otherwise untouched). Full `pytest tests/` collects **2804** tests with no import errors; the integration/e2e tiers remain infra-gated (out of scope, no live stack).

### Phase F — SDK (`packages/agentic-sdk-v2`, `packages/stt`)

Store + wiring (plan items 19–20): `agenticStore.ts` gains `sttConnectionState` (`'connected'|'reconnecting'|'switched_fallback'|'error'`) + `activePipeline: {id, name, isFallback}`; the four previously-dangling `SttWebSocketClient` callbacks (`onReconnect`/`onReconnected`/`onReconnectFailed`/`onDisconnect`) are now wired end-to-end (`SttWebSocketClient.ts` → `StreamingSessionManager.ts` → `PluginManager.ts` → `useArcaAudio.ts` → the store), closing the pre-existing observability gap the feature depends on (§2.4). `TranscriptionPipeline.ts`/`STTProcessor.ts` (`packages/stt`) and `StreamingBackendSTTProvider.ts` forward a `status: 'provider_switched'` frame (`from_pipeline`/`to_pipeline`/`reason`/`utterance_index`) up through the same status-callback path — no new WS message type needed (§3.6, matches the zero-protocol-change gateway relay in Phase D). `useArcaAudio.ts` exposes `activePipeline` + `switchToFallback(): Promise<void>` (calls the new REST endpoint via `AgenticClient`; degraded 404 path destroys/recreates the session on the fallback `pipelineId` via the existing `configFingerprint` rebuild primitive, surfaced as `reconnecting`). `types/audio.ts`/`types/stt.ts`/`constants.ts` carry the new status/state literal types. Compat `useArcaSpeechToText.ts` now forwards `pipelineId` (fixes the drop noted in §2.4/plan item 20 — coordinated with the concurrent TASK-564/565/566 compat work already landed on this branch).

Tests (plan item 21 verification + §5 item 16): `useArcaAudio.providerSwitch.task567.test.ts`, `PluginManager.providerSwitchWiring.task567.test.ts` (new), plus updated assertions across `StreamingSessionManager.test.ts`, `SttWebSocketClient.test.ts`, `constants.test.ts`/`constants.task210.test.ts`, `agenticStore.test.ts`, `useArcaSpeechToText.test.ts`, and the `useArca*`/`useArcaAudio*` suites touched by the store/type additions. Playground/example switch-button + switched-banner wiring (plan item 21, minimal): `consultation-demo-screen.tsx` + `scribe/live-session-column.tsx`.

Gate (this pass, re-run): `pnpm --filter @arcaai/vox test` → **3677 passed** (215 files) — the memory-noted pre-existing `window is not defined` flake (`useVoiceEnrollmentStatus`, unrelated to this ticket) did **not** reproduce in this run. `pnpm --filter @arcaai/vox build` → green (CJS+ESM for all 4 entry points + `.d.ts` emit via `tsc --emitDeclarationOnly`).

**Phase G (admin-console screen) — built, but DESIGN-GATE OPEN (⚠️ MUST NOT MERGE):** The `/stt-config` tenant surface is implemented in `apps/admin-console/src/features/tenant-stt-config/` (api client/hooks/keys/types via the BFF proxy + TanStack Query; `tenant-stt-config-screen.tsx` = ScreenTemplate + WorkingTenantGate + two tabs; `stt-fallback-form.tsx` = fallback-pipeline picker + auto-switch toggle + failure-threshold under If-Match OCC; `stt-credentials-tab.tsx` = three write-only/masked `CredentialCard`s (azure-speech/sarvam/openai) with per-credential OCC + `OccConflictAlert`) plus the route `app/(console)/(tenant)/stt-config/{page,loading}.tsx`. Composed ENTIRELY from already-approved patterns (the TASK-526 waiver-precedent SHAPE) — **but no approved Figma frame and no recorded owner waiver exist**, so the rule-12 gate is NOT satisfied. The screen is deliberately LEFT OUT of the sidebar nav (`shared/navigation/nav-config.ts` untouched; reachable only by direct URL, the `implemented: false` posture), and both the screen component and route page carry a `⚠️ DESIGN GATE OPEN — DO NOT MERGE` header. It must not ship until the owner grants a frame or records a waiver here. Gate: `pnpm --filter @arcaai/admin-console build && lint && test` (see Change History).

### Phase H — Evidence & docs (2026-07-28, this pass — docs only, no feature code)

Re-ran the actual gate commands (not a unit-only subset) across every touched package/app and reconciled §9 against the real tree (`git diff --stat` + full `git status --porcelain`, 124 changed paths) rather than trusting the prior phase summaries verbatim. Findings:

**Gates re-verified green (real output, this pass):**

| Gate | Result |
|---|---|
| `pytest apps/stt/tests/unit/` | **2517 passed** |
| `pnpm --filter @arcaai/database test` | **870 passed** |
| `pnpm --filter @arcaai/domains test` | **1408 passed, 2 skipped** |
| `pnpm --filter @arcaai/applications test` | **7128 passed, 4 skipped** |
| `pnpm --filter @arcaai/vox test` | **3677 passed** (215 files; the memory-noted flake did not reproduce) |
| `pnpm --filter @arcaai/vox build` | green (all 4 entries + `.d.ts`) |
| `pnpm --filter @arcaai/admin-console test` | **1227 passed** |
| `pnpm --filter @arcaai/admin-console lint` | clean |
| `pnpm --filter @arcaai/admin-console build` | green (`/stt-config` route compiles; absent from nav, as designed) |
| `pnpm api:build` | green on retry (see race note below) |
| `npx playwright test --list apps/api/tests/e2e/stt-fallback-cross-tenant.spec.ts` | **12 tests** listed/parsed cleanly (no live stack invoked) |

**`pnpm test:unit` (the actual root gate, not a subset): 17477 passed, 4 skipped, 9 todo, 2 test FILES failed.** Both traced to root cause, not assumed:

1. `scripts/__tests__/env-sync.test.ts` ("declares at most ~130 distinct keys": got 134) — **pre-existing, confirmed unrelated to TASK-567.** Verified by `git stash push -u` (removing every TASK-567 change, tracked + untracked) and re-running the file in isolation: it fails identically (134) on the pre-TASK-567 tree. No file this ticket touches feeds `env-sync.mts`'s `declaredSurface` (the new `stt-fallback.descriptors.ts` entries are `db-secret`/`db-config` tier, and `ENV_SUPPLIED_TIERS` only counts `env`/`vault-kv`). Not this ticket's regression; not fixed here.
2. `tests/contracts/ai-model-providers.contract.test.ts` ("DTO allow-list matches the canonical seed list exactly") — **IS caused by TASK-567**, confirmed by the same stash bisection (passes on the pre-TASK-567 tree). Root cause: the Phase E continuation pass added `'openai'` to the seed's `AI_MODEL_PROVIDERS` (`packages/database/src/prisma/db_main/seed/ai-models/shared.ts`) but did not add it to the sibling DTO allow-list `AI_MODEL_PROVIDERS` in `packages/applications/src/services/stt/model/dto/create-model.request.ts`. Real impact: the admin `AiModel` create/update routes' `@IsIn(AI_MODEL_PROVIDERS)` validator would reject `provider: 'openai'` even though the seed writes such a row directly. **Not fixed in this docs-only pass** — flagged as a background-task suggestion (chip) for a one-line follow-up rather than silently patched, per the Phase H scope constraint.

**`pnpm lint --filter=@arcaai/api` (hard-error gate for this app, rule 05): 2 errors, 65 warnings.** One is this ticket's: `apps/api/tests/e2e/stt-fallback-cross-tenant.spec.ts:24:24` — unused `APIRequestContext` import (`@typescript-eslint/no-unused-vars`). The other (`apps/api/tests/e2e/task-562-smr-compat.spec.ts:29`, a prettier formatting error) belongs to a different, concurrent ticket (TASK-562) and is untouched by this ticket's diff — left alone. The 65 warnings are the app's existing `eslint-comments/require-description` baseline, unrelated. **Not fixed here** — flagged as a background-task suggestion (chip), same rationale as above.

**Concurrent-owner race (as warned in this task's brief):** an owner `nest start --debug ... --watch` process (`sh -c "rimraf dist ... && nest start --watch"`) was live throughout this session. The first `pnpm api:build` invocation hit `ENOTEMPTY: directory not empty, rmdir '.../apps/api/dist/modules/user'` — the watcher's own `rimraf dist` racing this pass's build. An immediate retry succeeded cleanly with no further changes. Noted, not a code defect.

**Cross-tenant 403-vs-404 note:** the STT admin controller (`admin/stt-config`) is not itself `@TenantOwnedResource`-decorated (unlike per-id resources) — cross-tenant addressing there goes through an explicit `?tenantId=` query param a non-elevated tenant admin cannot exploit to read another tenant's row; the e2e spec accordingly asserts `[403, 404]` rather than forcing 404-only, matching the existing precedent elsewhere in the codebase (e.g. `ai-provider-connections-cross-tenant.spec.ts`) where query-addressed cross-tenant probes are 403-or-404, while the manual-switch route (which *is* `@TenantOwnedResource`-guarded, path-param addressed) is asserted as `[404, 409]` — no existence leak, per the house 404-over-403 posture for path-addressed resources.

**e2e status, told straight:** `apps/api/tests/e2e/stt-fallback-cross-tenant.spec.ts` (12 tests) is **authored, not executed** — it needs a seeded DB + running gateway (`pnpm test:up:api` then `pnpm test:e2e`), which this pass deliberately did not start (docs-only, no live stack per the task brief). It was verified to load/parse cleanly (`playwright test --list` succeeded, all 12 test titles resolved, zero collection errors) as the cheap compile-equivalent check available without a live stack — raw `tsc` was tried first but only surfaces pre-existing, unrelated module-resolution noise from `tests/helpers/*` under an ad-hoc bare invocation, so `--list` is the more meaningful signal here. By contrast, **`apps/stt`'s e2e/unit tiers ARE green** (`pytest apps/stt/tests/unit/` 2517 passed, this pass; the plan's own e2e/integration tiers for apps/stt remain infra-gated exactly as documented in Phase E, not a new gap).

**Migration status:** `20260728000000_task_567_tenant_stt_fallback_config` exists on disk, reviewed (§ above), and is **NOT applied** to any database — no `db:migrate`/`db:push`/`db:migrate:deploy` was run at any point in this ticket's work, consistent with the "no DB-applying command" constraint carried through every phase. Applying it (dev via `pnpm db:migrate`, later envs via the k3s PreSync job) is an explicit owner step.

**Docs updated this pass:** this README (status → Review, §9 backfilled for Phases A–D and F, this §9 Phase H block, Change History row below); `docs/traceability/transcription.md` (new **R6** capability row + an honest-notes bullet for the `openai` DTO drift) — chosen over editing the **superseded** `docs/traceability-matrix.md`, whose own header explicitly directs new capability rows to the owning per-domain file (`transcription.md`, already the migration target for the legacy STT rows 10/11/13/26); `apps/stt/README.md` (new engine-table rows for `sarvam`/`openai` + a "Per-tenant BYOK + fallback" subsection); `docs/architecture/overview.md` (§3.1 data-flow bullet for the switch mechanism + a `Model & Configuration Plane` table row for `TenantSttConfig`/`TenantSttProviderCredential`).

**Follow-ups spawned (not fixed here, by design):** two background-task chips for the owner — (1) add `'openai'` to the DTO `AI_MODEL_PROVIDERS` allow-list; (2) remove the unused `APIRequestContext` import from the new e2e spec. Both are one-line fixes with a clear verification path (re-run the named failing test/lint command), deliberately left to a follow-up session rather than folded into this docs-only pass.

**Owner tail, unchanged from earlier phases:** the rule-12 design gate on Phase G's `/stt-config` screen remains OPEN (no approved Figma frame, no recorded waiver) — must not ship/merge until resolved; applying the Phase A migration; executing the authored e2e spec against a live stack; the two follow-ups above.

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-28 | Ticket authored: three code-verified exploration passes (apps/stt internals, gateway+DB plane, SDK), external provider-API research, architecture decisions D-1…D-6 (new `TenantSttConfig`/`TenantSttProviderCredential` mirroring TASK-496; tenant-level fallback-pipeline pointer; inject-for-streaming / pull-for-batch credential delivery; in-session engine swap in `SessionManager`; Sarvam+OpenAI engines; SDK switch surface), phased implementation plan A–H with TDD list. Status Pending. |
| 2026-07-28 | §4 amended: companion ticket TASK-568 created for the v1-compat provider-switch surface (`useArcaSttProvider` + `onStatus` wiring, depends on Phase F); the optional sub-ticket split no longer pre-claims 568–570. |
| 2026-07-28 | Phase E (partial) implemented: Sarvam + OpenAI cloud BYOK ASR engine layer landed in `apps/stt` (enum members, aliases, settings, loaders with `provider_overrides`-first/env-fallback/never-log, Azure BYOK override, REST recognize helpers, batch + per-utterance streaming inference bodies, adapters + registry rows, `stt_cloud_asr_errors_total`) with unit tests. Gates green: pytest (154 + 374 passed), `ruff` all-passed, `mypy` no-issues. Deferred with rationale (see §9): the streaming/batch switch runtime (items 6–7), effective-config credential pull (item 8), and the Phase-A-deferred DB seeds + coupled seed-test updates (item 10). No DB command run; no new dep (`uv lock` unchanged). Uncommitted on `thuynh/2607`. |
| 2026-07-28 | Phase E completed (continuation): switch runtime (`EngineSwitchController` in new `streaming/engine_switch.py` + `session_manager.py` create-time/auto/manual triggers, buffer handoff, `provider_switched` publication), `CreateStreamingSessionRequest` fields + internal `POST …/sessions/{id}/switch`, `SessionControl.SWITCH_TO_FALLBACK`, cloud-BYOK cache bypass (streaming + batch), batch fallback dispatch + `usedFallbackPipelineId` in `transcribe_file`, `effective_config.get_provider_overrides` pull, and the Phase-A/D DB seeds + RBAC grant (`openai` provider/model/pipeline/connection rows, `manage TenantSttConfig` policy) with coupled seed-test updates. Fixed the red `test_registry` `EXPECTED_ASR`. New tests: `test_engine_switch.py` (11), `test_transcribe_file_fallback_task567.py` (4). Gates: `@arcaai/database test` 870 passed; apps/stt unit 2517 passed; ruff clean; mypy `src/` Success (removed a pre-existing redundant cast in `preprocessing.py:288`, env-drift, unrelated). Integration/e2e infra-gated (out of scope). Phases F (SDK) + G (console) remain. Uncommitted on `thuynh/2607`. |
| 2026-07-28 | Phase G (admin-console `/stt-config`) built under an OPEN rule-12 design gate: full feature in `apps/admin-console/src/features/tenant-stt-config/` (api client/hooks/keys/types via BFF proxy + TanStack Query; screen = ScreenTemplate + WorkingTenantGate + Fallback/Credentials tabs; fallback-pipeline picker + auto-switch toggle + failure-threshold with If-Match OCC; three write-only/masked CredentialCards azure-speech/sarvam/openai with per-credential OCC + OccConflictAlert) + route `app/(console)/(tenant)/stt-config/{page,loading}.tsx`. NO approved Figma frame and NO recorded owner waiver → gate NOT satisfied: screen intentionally OMITTED from `nav-config.ts` (direct-URL-only) and both screen + page carry a `⚠️ DESIGN GATE OPEN — DO NOT MERGE` header; must not ship until owner grants a frame or records a waiver. Tests: `tenant-stt-config-screen.test.tsx` (12 — render, WorkingTenantGate skeleton, no-fallback empty spec, sparse-threshold + pipeline-picker If-Match saves, 412 reload-merge, masked rotate under If-Match "3", create under If-Match "0", block-error retry, axe 0-violations per tab + dark theme). Gate: `pnpm --filter @arcaai/admin-console build && lint && test` (see structured result). Uncommitted on `thuynh/2607`. |
| 2026-07-28 | **Phase H (evidence & docs, this pass) — status → Review.** Re-ran the ACTUAL gates (not a unit-only subset) against the real tree and backfilled §9 for Phases A–D and F (previously undocumented, verified against `git status`/`git diff --stat`, 124 changed paths). All previously-reported counts reproduced: `pnpm --filter @arcaai/database test` 870 passed; `@arcaai/domains test` 1408 passed/2 skipped; `@arcaai/applications test` 7128 passed/4 skipped; `pytest apps/stt/tests/unit/` 2517 passed; `@arcaai/vox test` 3677 passed (the memory-noted flake did not reproduce) + `build` green; `@arcaai/admin-console` build/lint/test green (1227 passed). Root `pnpm test:unit`: **17477 passed, 2 files failed** — bisected with `git stash`: `scripts/__tests__/env-sync.test.ts` (134 vs ≤130 declared-keys budget) is pre-existing and unrelated to TASK-567 (fails identically on the pre-ticket tree); `tests/contracts/ai-model-providers.contract.test.ts` IS caused by this ticket (Phase E added `openai` to the seed's `AI_MODEL_PROVIDERS` without the matching DTO allow-list edit in `create-model.request.ts`) — NOT fixed in this docs-only pass, flagged as a spawned follow-up task instead. `pnpm lint --filter=@arcaai/api` (hard-error gate): one ticket-caused error (unused `APIRequestContext` import in the new e2e spec) — also flagged as a follow-up, not fixed here; one unrelated pre-existing error in a different ticket's file (TASK-562) left untouched. Hit and cleanly recovered from the documented concurrent-`nest --watch` build race on the first `pnpm api:build` attempt. The e2e spec (`stt-fallback-cross-tenant.spec.ts`, 12 tests) was verified to load/parse cleanly via `playwright test --list` (no live stack) but genuinely NOT executed (needs a seeded DB + running gateway, out of scope for this docs-only pass); the migration remains unapplied (owner step). Docs updated: this README, `docs/traceability/transcription.md` (new R6 row + an honest-notes bullet — chosen over the superseded `docs/traceability-matrix.md` per that file's own routing header), `apps/stt/README.md` (engine table + BYOK/fallback subsection), `docs/architecture/overview.md` (§3.1 flow note + Model & Configuration Plane table row). Two follow-up background tasks spawned (DTO allow-list fix; unused-import lint fix). Owner tail unchanged: rule-12 design gate on Phase G, migration application, live e2e execution, the two spawned follow-ups. |
| 2026-07-28 | **Post-Phase-H cleanup (owner-session, inline).** The two ticket-caused gate breakages that Phase H (docs-only) had flagged as follow-ups were fixed directly and re-verified green: (1) added `openai` to the DTO `AI_MODEL_PROVIDERS` allow-list (`packages/applications/src/services/stt/model/dto/create-model.request.ts`) so it matches the seed list — `tests/contracts/ai-model-providers.contract.test.ts` now 2/2 pass; (2) removed the unused `APIRequestContext` import from `apps/api/tests/e2e/stt-fallback-cross-tenant.spec.ts` — the apps/api hard-error lint on that file is now clean. Also verified the SDK provider_switched frame actually reaches the client: Phase F fixed `streamingAudioBridge.service` which had been swallowing non-terminal status frames (the Phase-E gateway test only passed via a mock). **Deferred (documented, out of scope):** registering the new `SARVAM_API_KEY`/`SARVAM_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_BASE_URL` in `turbo.json#globalEnv` is a generator-driven change (turbo.json globalEnv is a generated artifact keyed off the env descriptor registry, and the declared-key budget is already over its ≤130 target pre-ticket) — a TASK-558-adjacent follow-up, not hand-editable; the apps/stt platform-fallback keys read fine from host env / `.env.dev` meanwhile (Azure STT keys `AZURE_SPEECH_KEY`/`AZURE_FOUNDRY_API_KEY` were already registered). The pre-existing `env-sync` ≤130 budget failure is unrelated (bisected). |
| 2026-07-31 | **Superseded by TASK-586 (compat runtime provider switch).** Two TASK-567 owner tails are now closed under TASK-586: (1) the Phase-G rule-12 design gate on `/stt-config` was WAIVED by explicit owner authorization — the `⚠️ DESIGN GATE OPEN — DO NOT MERGE` headers were removed, the screen was wired into `nav-config.ts`, and the credentials UI was completed (Sarvam base-URL field, a new ephemeral `POST /admin/stt-config/credentials/:provider/test` connection-test with an SSRF guard); (2) the one-way engine switch (`engine_switch.py`) was generalized to a BIDIRECTIONAL user-initiated toggle (auto failure-switch stays one-way + a manual cooldown), exposed as `switchProvider(target)` end-to-end and a compat `POST /api/stt/switch` route consumed by the SDK `useArcaSttProvider().switchToPipeline()/switchToDefault()`. See `docs/implementation/TASK-586-Compat-Runtime-Provider-Switch/README.md`. The migration application + live e2e execution remain shared owner tails, tracked there. |
| 2026-08-12 | Note — remaining owner tails on STT provider switching were absorbed by TASK-586 (v1-Compat Runtime STT Provider Switch). |

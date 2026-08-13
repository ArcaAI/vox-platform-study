# TASK-586 — v1-Compat Runtime Pipeline↔Default STT Switching + Compat Playground

**Status:** Review (staged, not committed) · **Branch:** `dev-2.1` · **Type:** feature
**Supersedes owner tails of:** [TASK-567](../TASK-567-Tenant-STT-Fallback-Provider-BYOK/README.md), TASK-568 · **Builds on:** TASK-560/562/564 (v1-compat layer)

## 1. Requirement Analysis

Deliver, for developers integrating via the v1-compat surface (given `{ apiKey, tenantId, pipelineId }`):

1. **SDK compat** — an end-user ON/OFF toggle that switches the STT engine at runtime, mid-session, with no reconnect. **ON = the SDK-configured pipeline** (primary); **OFF = the tenant-admin default provider** (Sarvam/Azure fallback). Bidirectional.
2. **APIs compat** — the v1 STT operations must meet the v2 architecture: multi-tenancy, STT pipelines, the tenant-admin-set default fallback provider, and 2-way runtime switching between the configured pipeline and the default provider.
3. **Admin screen** — a fully functional tenant-admin surface to set + control providers (endpoint URL + secret key), best-practice (write-only secrets, test-connection).
4. **Playground** — a standalone live-transcription example app exercising SDK compat + APIs compat.

**Locked decisions:** playground = standalone `apps/compat-playground`; user toggle 2-way but AUTO failure-switch stays one-way (never auto-returns to a failing engine) + a manual cooldown; admin screen fully built with the rule-12 Figma gate **waived by explicit owner authorization**; compat switch = a new `/api/stt` route (x-api-key, self-contained).

## 2. Current State Evaluation (audit findings that motivated the ticket)

- `useArcaSttProvider` exposed only a one-way `switchToFallback`; no switch-back.
- `apps/stt/.../engine_switch.py` hard-latched one-way (`return False # one-way per session`); no path back to primary.
- `apps/api/.../stt-compat/stt-compat.controller.ts` rode the v2 pipeline plane but passed **no** `pipelineId`/`providerOverrides`/`fallbackPipelineId` into `createSession`, and had **no** switch route — so raw-v1 compat sessions ignored the tenant fallback config.
- The TASK-567 `/stt-config` admin screen existed but was `DO-NOT-MERGE` (design-gated) and incomplete (no test-connection, Sarvam URL missing from the UI).
- No compat playground existed.

## 3. Implementation Plan (frozen contracts)

Executed as parallel lanes with disjoint file ownership over a sequential Phase-0 foundation. Frozen contracts:
- **C1** `POST /internal/streaming/sessions/{id}/switch` body `{target:'primary'|'fallback'}` (absent⇒fallback) → `200 {switched, active}`, 409 unavailable/already-there, 404 unknown; emits `provider_switched` carrying `active`/`is_fallback` **both directions**.
- **C2** `IStreamingSessionService.switchProvider(sessionId, target)`; `switchToFallback` = alias.
- **C3** compat `POST /api/stt/switch` (x-api-key) body `{session_id, target:'pipeline'|'default'|'primary'|'fallback'}` (pipeline≡primary, default≡fallback) → `200 {switched:true, active:'pipeline'|'default'}`, 409 default-with-no-fallback, 404 unknown/cross-tenant.
- **C4** compat `start_session` accepts optional `pipelineId` (used directly) and always forwards resolved `providerOverrides`+`fallbackPipelineId`.
- **C5** `useArcaSttProvider()` adds `usePipeline`, `switchToPipeline()`, `switchToDefault()` (`switchToFallback` = alias); `ArcaCompatProvider` config gains `enableProviderSwitch` + `tenantId`.

## 4. Implementation Summary

### Phase 0 — bidirectional switch foundation (Lanes A+B)
- **`apps/stt/src/stt/streaming/`** — `engine_switch.py` retains a `build_primary` callable, generalizes the swap to `_switch_to(target)`; **`switch_manual(target)` is bidirectional** with a ~1.5s cooldown (soft no-op) and ignores the auto toggle; **`record_failure` stays one-way** primary→fallback; `switch_to('primary')` rejects (409) when primary never loaded at create; `switched` un-latches on switch-back. Threaded `target` through `SessionControl`, `session_manager.py` (`request_switch(id,target)`, kept `request_switch_to_fallback` alias), the internal route (`api/routes.py`+`schemas.py` per C1), and `redis_streams.publish_provider_switched` now emits `active`+`is_fallback`.
- **`packages/applications/.../stt/streaming/`** — `switchProvider(sessionId, target)` posting `{target}`; `switchToFallback` = alias.

### Lane C — compat backend (`apps/api/src/modules/stt-compat/`)
- `start-session.request.ts` gains optional `pipelineId`; controller uses it directly when present and always resolves + forwards `providerOverrides`+`fallbackPipelineId` (fail-open helper mirroring the native `resolveSttFallbackConfig`).
- New `POST /api/stt/switch` (`switch-session.{request,response}.ts`): normalizes both vocabularies, enforces tenant ownership via `StreamSessionTenantBindingService.lookup` (the **same** Redis binding both native `createStreamSession` and compat `start_session` write — so SDK-created native sessions are covered), 404-over-403, fail-closed 409 for `default` with no fallback, maps to `switchProvider`.
- Gateway forwards the `provider_switched` frame and maps `is_fallback`→`isFallback`.

### Lane D — SDK 2-way toggle (`packages/agentic-sdk-v2/`)
- `core/StreamingSessionManager.ts` — `switchProvider(target)` + `setCompatSwitchEnabled`; compat mode POSTs the literal `/api/stt/switch` shim (origin derived like `useSMR`, x-api-key via raw `fetch`); **native path unchanged** (`switchToFallback` alias).
- `hooks/useArcaAudio.ts` — generalized `switchProvider(target,opts)`; the `provider_switched` handler now un-latches `isFallback` on an explicit primary frame.
- `compat/useArcaSttProvider.ts` — `usePipeline`/`switchToPipeline()`/`switchToDefault()`, fires `onProviderSwitched` in **both** directions; `compat/types.ts` adds `enableProviderSwitch` + `tenantId`; `ArcaCompatProvider.tsx` carries the flag via an internal context.

### Lane E — admin provider screen (`apps/admin-console/.../tenant-stt-config/`)
- Design gate WAIVED: `DO-NOT-MERGE` headers removed, `/stt-config` wired into `nav-config.ts` (tenant tier). Fallback tab (pipeline picker + auto-switch + threshold, If-Match OCC). Credentials tab: per-provider endpoint URL + write-only masked secret + enabled toggle. New ephemeral `POST /admin/stt-config/credentials/:provider/test` (SSRF-guarded; real auth probe for OpenAI, reachability-only for Sarvam/Azure-Foundry — neither exposes an auth-only endpoint). Secrets stay in Vault via `AiProviderConnection` (never plaintext DB).

### Lane F — playground (`apps/compat-playground/`, new, port 5177)
- Vite+React app consuming `@arcaai/vox/compat`: config panel (`apiEndpoint`/`apiKey`/`tenantId`/`pipelineId`, localStorage), live transcription (`useAudioCapture`+`useArcaSpeechToText`), and the ON/OFF `ProviderToggle` (`useArcaSttProvider`). Root `compat:dev`/`compat:build` scripts.

### Integration pass (this session, owner)
- **Fixed a cross-lane seam bug:** `core/PluginManager.ts` (owned by no lane) dropped `active`/`is_fallback` when bridging `onStatus`→`onProviderSwitched`, so a switch-back-to-primary could never un-latch. Forwarded the fields; added them to `types/stt.ts` `WsStatusMessage` + `types/audio.ts` `ProviderSwitchInfo`; +2 tests in `PluginManager.providerSwitchWiring.task567.test.ts`.
- Added `tenantId` to `V1SdkConfig` (accepted for parity; API key stays authoritative); removed the playground's two forward-compat shims to bind against the real C5 types.

### Follow-up lanes (post-review corrections, this session)

- **Lane H — native v2 made 2-way** (`apps/api/.../transcription-job.controller.ts`, `agentic-sdk-v2/core/`): the native (non-compat) path was one-way. Added `POST stream/session/:id/switch-to-primary` (mirrors `switch-to-fallback` guards → `sessionService.switchProvider(id,'primary')`), a `StreamingSessionManager.nativeSwitchToPrimary()` (+`STT_ENDPOINTS.SWITCH_TO_PRIMARY`) replacing the native `'primary'` throw, and a **native end-user hook `hooks/useSttProviderToggle.ts`** (`switchToPipeline`/`switchToDefault`, no `ArcaCompatProvider`) exported from the core/plugins barrels. The app-service `switchProvider` + STT engine were already bidirectional (Phase 0), so no backend-logic change was needed — only exposure.
- **Lane I — playground corrections** (`apps/compat-playground/`): language-mode selector via the TASK-587 `useArcaSttLanguageModes()` catalog + `SttLanguageModePicker` (static fallback list), forwarded through the compat `options.languageMode`; per-line transcript **timestamps**; a **metadata-simulation** panel (`sendAudioData(empty, metadata)` → Sent/Received round-trip, TASK-564 passthrough) + full per-line metadata display; and an **example-source panel** rendering the actual playground source via Vite `import.meta.glob(?raw)` + `CodeExample`.
- **Lane J — unified `/ai-providers` wired in** (`apps/admin-console/.../ai-providers/`, `nav-config.ts`): removed the DO-NOT-MERGE design-gate banner (owner waiver) and added the consolidated LLM+STT+TTS provider-credentials screen to nav (tier 30-49, `GlobalSetting` ability). `/stt-config` + `/ai-configuration` left intact; credential-tab overlap flagged as a follow-up consolidation.

### Lane K — pre-start default-provider selection (this session)

**Problem:** the switch is a live-session, in-place ASR-engine swap. Before capture starts there is no session/WebSocket, so `useArcaSttProvider.switchTo*()` and every downstream layer reject — a developer/end-user could only pick the default (fallback) provider *after* recording began. Requirement: let them select "use the tenant-admin default provider" **before** starting live-transcription, so the session opens on that engine from frame 1.

**Approach (owner-approved):** *start directly on default (backend)* — a pre-start selection is remembered and applied at `audio.start(...)`; the session is created ON the fallback engine while the primary stays switchable (so the existing mid-session `switchToPipeline()` still returns to it). This is NOT a client-only auto-switch-after-start.

**Frozen contracts (extend TASK-586):**
- **C6 (SDK)** `AudioStartOptions.startOn?: 'primary' | 'fallback'` (default `'primary'`). Threaded through exactly like TASK-587 `languageMode`: `useArcaAudio.startAudio` → `PluginManager` runtime options + `buildStreamingTransport` → `TranscriptionPipeline` streaming config (`types/pipeline.ts`) → `@arcaai/stt` `StreamingBackendSTTProvider.createSession` → client `CreateStreamingSessionRequest.startOn` (`types/stt.ts`) → native POST body. On start, `useArcaAudio` sets `activePipeline.isFallback = (startOn === 'fallback')`.
- **C7 (gateway native)** `CreateStreamSessionRequest.startOn?: 'primary' | 'fallback'` (`apps/api/.../streaming/dto/transcription-job.dto.ts`). `createStreamSession` forwards it into `sessionPayload`. **Fail-closed:** `startOn === 'fallback'` with no resolved `fallbackPipelineId` → **409** (mirrors the C3 switch guard; never a silent primary start).
- **C7b (gateway compat, raw v1)** `StartSessionRequest.startOn?: 'pipeline' | 'default'` on `POST /api/stt/start_session`; `pipeline≡primary`, `default≡fallback`; same fail-closed 409.
- **C8 (applications)** `CreateStreamingSessionRequest.startOn?: 'primary' | 'fallback'` (`streaming-session.dto.ts`) → `streamingSession.service.ts` POSTs `start_on` to `/internal/streaming/sessions`.
- **C9 (apps/stt)** internal `SessionCreateRequest.start_on: str | None` (`'primary'|'fallback'`, default `primary`); `session_manager.create_session(start_on=...)`: when `'fallback'` AND a `fallback_pipeline_id` is configured, assemble the runtime on the **fallback** pipeline_config from the start, keep `primary_pipeline_id` wired so switch-back builds it lazily, and mark the controller via a **new** `EngineSwitchController.note_started_on_fallback()` — identical to `note_switched_at_create()` **except `_primary_available` stays `True`** (this was a deliberate user choice, not a primary load failure) and it emits no `provider_switched` event (there is no transition to announce; the SDK already reflects `isFallback` from `startOn`). If `start_on='fallback'` but no fallback is configured, the create proceeds on primary (gateway already fail-closed the 409; STT stays permissive/fail-open).

**Compat hooks (the user-facing surface):**
- `useArcaSttProvider`: when there is **no active session**, `switchToDefault()`/`switchToFallback()`/`switchToPipeline()` no longer reject — they record a **pending pre-start selection** in the store (`pendingSttProvider: 'primary'|'fallback'`, new store field + setter) and resolve. `usePipeline`/`isFallbackActive`/`activeProvider` reflect the pending selection before capture. Once a session is live, the same calls behave exactly as before (in-place switch).
- `useAudioCapture.startRecording()` and `useArcaSpeechToText.startTranscription()` read `store.pendingSttProvider` and pass `startOn` into `audio.start({ startOn })` (order-independent, mirroring the `languageMode` store-fallback pattern). The pending selection is cleared on start.

**Executed as 3 disjoint-file lanes:** K1 apps/stt (Python), K2 TS backend (applications + gateway native + compat), K3 SDK (agentic-sdk-v2 core + compat hooks + store, `@arcaai/stt` provider).

## 5. Verification / Evidence

- **Phase 0:** engine-switch unit suite **17/17**; full apps/stt unit **2540 passed**; ruff clean; app-service `switchProvider` **8/8**; `@arcaai/applications` **7147 passed** + build green.
- **Lane C:** `vitest run src/modules/stt-compat` **29 passed**; `api:build` 8/8; apps/api lint 0 errors (new files warning-free). E2E `stt-compat-switch-cross-tenant.spec.ts` authored, not run (no live stack).
- **Lane D:** full `@arcaai/vox` **3708 passed** + `build` emits the new members.
- **Lane E:** `@arcaai/applications` typecheck/build clean + 35/35; `@arcaai/api` 14/14; `@arcaai/admin-console` build/lint/test green (16/16 screen + 25/25 nav).
- **Integration pass:** affected vox tests **78 passed** (incl. 2 new PluginManager bidirectional cases); `@arcaai/vox` `tsc --noEmit` clean; `@arcaai/vox build` green; `@arcaai/compat-playground` `tsc --noEmit` clean after vox rebuild.

## 6. Owner Tails (remaining)

1. **Migration not applied** — `packages/database/.../migrations/20260728000000_task_567_tenant_stt_fallback_config` is git-tracked but unapplied (dev/test DB is `db push`-managed; apply additively, never reset). Required for the tenant fallback config to persist at runtime.
2. **Live e2e not executed** — `stt-fallback-cross-tenant.spec.ts` + new `stt-compat-switch-cross-tenant.spec.ts` need `pnpm test:up:api` → `pnpm test:e2e` against a seeded DB.
3. **Live-stack walkthrough** — run `apps/compat-playground` against `pnpm stack:dev`: verify OFF→`provider_switched active=fallback` and ON→`active=primary` mid-session with no reconnect; cooldown rejects rapid double-toggle; auto-switch (kill primary creds) stays one-way.
4. **Deferred (documented):** `SARVAM_*`/`OPENAI_*` in `turbo.json#globalEnv` — generator-driven, TASK-558-adjacent; host env / `.env.dev` works meanwhile. Sarvam/Azure-Foundry test-connection is reachability-only (no auth-only endpoint).
5. **Commit** — all work staged on `dev-2.1`, not committed (a concurrent session is editing `useSMR.ts` in the same tree).

## 7. Change History

| Date | Change |
|---|---|
| 2026-07-31 | **Lane K — pre-start default-provider selection.** Let developer + end-user pick the tenant default (fallback) STT provider BEFORE starting live-transcription (previously switchable only mid-session). Approach: *start directly on default (backend)* — `startOn:'primary'|'fallback'` (default primary) threaded through the SDK like TASK-587 `languageMode`; gateway fail-closed 409 when fallback requested with none configured; apps/stt `create_session(start_on=…)` assembles on the fallback engine while keeping primary switchable via new `EngineSwitchController.note_started_on_fallback()` (leaves `_primary_available=True`, emits no event). Compat `useArcaSttProvider.switchToDefault()/switchToPipeline()` now record a pending selection pre-session (new store `pendingSttProvider`) instead of rejecting; `useAudioCapture`/`useArcaSpeechToText` apply it at `audio.start({startOn})` and clear it. Contracts C6–C9 in §3-Lane-K/§4-Lane-K. 3 disjoint lanes (K1 apps/stt, K2 applications+gateway+compat, K3 SDK+compat hooks+store). Gates: apps/stt 403 py + ruff (RED→GREEN); `@arcaai/applications` 14 svc + build, apps/api 275 module (gw/compat) + build + lint 0 err; `@arcaai/vox` 3739 + typecheck + build emits .d.ts, `@arcaai/stt` build green. Staged, not committed. |
| 2026-07-31 | **Runtime bugfix — detected-language propagation (Sarvam ml-en).** Two defects surfaced live in the compat playground after configuring Sarvam as the fallback STT provider. (1) **500 on session open with ml-en**: the SQLAlchemy read-mirror `AiModelFormatType` (`apps/stt/.../core/database/models.py`) was a third `AiModelFormat` copy TASK-586 missed — hydrating the Sarvam fallback model row (`format='SARVAM'`) threw `LookupError`. Fixed by appending `SARVAM`/`OPENAI` to match the DB/Prisma/dto enums; added `test_ai_model_format_enum_parity.py` (Prisma ⇔ SQLAlchemy mirror ⊇ dto ⊇ day-1 seed formats). (2) **Metadata reported `language: "en"` for a Malayalam transcript**: the streaming path never carried an engine-detected language — `SegmentResult` had no `language` field, and `sarvam_asr`/`openai_asr` discarded the provider's `language_code`, so compat metadata echoed the session-configured language. Wired detected-language end-to-end: `sarvam_asr`/`openai_asr` return `language` → `inference.py` `SegmentResult(language=…)` → `schemas.py` field + `to_redis_dict`/`from_redis_dict` → applications bridge emits camelCase `detectedLanguage` on `StreamingTranscriptMessage` → `SttWebSocketClient.normalizeTranscript` captures `WsTranscriptResult.language` → `StreamingBackendSTTProvider.normalizeTranscript` prefers `payload.language` over the config default → `TranscriptSegment.language` → compat `composeDeliveredMetadata`. The v1-compat gateway already preferred `message.detectedLanguage`, so both paths now report the real detection. Gates: apps/stt streaming 208 + 4 new; `@arcaai/applications` 7170 (+2) + typecheck; `@arcaai/vox` 3729 + typecheck; `@arcaai/stt` 422 (+2) + typecheck; `@arcaai/api` 2285 + typecheck. **STT dev server must be restarted** (running uvicorn had no `--reload`, held the stale enum). Staged, not committed. |
| 2026-07-31 | **Follow-up review + corrections (Lanes H/I/J).** Review confirmed compat 2-way ✅, compat minimal-change integration ✅, admin STT+LLM config ✅, standalone playground ✅ — and surfaced 3 gaps, all now closed: native v2 was one-way (Lane H → 2-way + native `useSttProviderToggle`), playground lacked code-view/metadata-sim/timestamps/language-select (Lane I), and the unified `/ai-providers` screen was gated off (Lane J → wired into nav). Gates: vox 3722/3722 + build (Lane H); admin-console nav 26 + ai-providers 14 (Lane J); playground `tsc --noEmit` + `build` clean (Lane I, after vox rebuild). Native-2way changed a Lane-D contract (native `switchProvider('primary')` no longer throws) → the obsolete assertion in `streamingSessionManager.compatSwitch.test.ts` was updated. Cross-lane seam fix (`PluginManager` `active`/`is_fallback` forwarding) re-verified intact after concurrent TASK-587 edits. Staged, not committed. |
| 2026-07-31 | Ticket authored + implemented across 6 lanes (A–F) + an integration pass. Bidirectional user switch (auto stays one-way + cooldown); compat backend fallback wiring + `/api/stt/switch`; SDK `switchToPipeline`/`switchToDefault`; admin `/stt-config` completed with design-gate waived + test-connection; standalone `apps/compat-playground`. Fixed a cross-lane `PluginManager` seam bug (dropped `active`/`is_fallback` → switch-back couldn't un-latch). Gates green per §5. Staged on `dev-2.1`, not committed. Owner tails per §6. |

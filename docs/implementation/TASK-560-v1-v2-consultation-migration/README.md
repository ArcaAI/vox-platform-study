# TASK-560 — HOPE-v1 → HOPE-v2 Consultation Workflow Migration (Compatibility Layer)

| | |
|---|---|
| **Status** | Review (all sub-tickets implemented + verified; pending live-stack e2e + commit) |
| **Type** | feature / infrastructure (migration-compatibility) |
| **Classification** | Epic — indexes sub-tickets TASK-561 · TASK-562 · TASK-563 |
| **Owner** | (multi-agent) |
| **Created** | 2026-07-27 |
| **Branch** | `thuynh/2607` (planning); execution branches per sub-ticket |

> **One-line goal:** Let application engineers move their live-consultation code from HOPE-v1's `@arcaai/agentic-sdk` + v1 gateway onto HOPE-v2's `@arcaai/vox` + v2 gateway **with the smallest possible change on their side**, by adding a v2-side compatibility layer. **No HOPE-v2 core business logic changes** — only additive compat surfaces (new SDK subpath, new gateway shim endpoints, docs/tests).

---

## 1. Requirement Analysis

### 1.1 The workflow to preserve

The single end-to-end workflow this ticket protects (as stated by the requester):

1. **Start a new consultation session.**
2. **Start recording** with a **mixed stream + metadata** → receive **live transcripts**.
3. **Stop recording** → call an endpoint to **generate a summary of the case note**.

### 1.2 Constraints (hard)

- **DO NOT change core business logic.** `ConsultationService`, `SummaryService`, `SttWsGateway`, `StreamingSessionService`, the domain layer, and the Python services stay untouched. Everything we add is a thin, additive adapter that *delegates* to those.
- Respect the v2 architecture rules: `05-nestjs-api.md` (guards, `@Authorize`, `IConfigService` for downstream URLs, `X-Service-Token`), `06-python-services.md`, `08-vox-sdk.md` (per-provider store, public accessors only, subpath entry points), `04-application-services.md` (DTOs, 404-over-403).
- Two v1 defects and two v1 anti-patterns are **NOT** to be reproduced (see §6).

### 1.3 Scope decisions (locked with the requester 2026-07-27)

| # | Decision | Choice |
|---|---|---|
| D1 | Backend endpoint compat scope | **SDK compat hooks + reproduce the SMR summary endpoints** (`POST /api/smr/api/v1/summary/sync`, `POST /api/smr/api/v1/presummary`). Session-start and live-STT are handled behind the SDK compat layer, which drives v2's native ticketed flow. Raw `/api/sessions` + `/api/stt/*` endpoints are **out of scope**. |
| D2 | Auth posture on the compat surface | **Preserve `x-api-key` parity.** v2's `UnifiedAuthGuard` already accepts `apikey`/`api-key`/`x-api-key`; the working tenant is resolved from the API key. Zero app-side auth change. JWT/stream-ticket remains the internal mechanism the SDK layer uses for the STT WS. |
| D3 | SDK compat surface location | **Opt-in subpath `@arcaai/vox/compat`.** v1 hook names ship from a dedicated entry point; the v2 core barrel stays clean. |

### 1.4 Deliverables (sub-tickets)

| Ticket | Deliverable | Primary package | Suggested tier |
|---|---|---|---|
| **TASK-561** | v1-named SDK hooks (`useArcaSessionManager`, `useAudioCapture`, `useArcaSpeechToText`, `useSMR`) + config adapter + Provider bridge, in `@arcaai/vox/compat`, delegating to v2 hooks | `packages/agentic-sdk-v2` | opus-4-8-medium |
| **TASK-562** | Gateway shim endpoints `POST /api/smr/api/v1/summary/sync` + `/presummary`, x-api-key/tenant-from-key, returning the exact v1 `SummaryResponse` shape, over SMR `/api/v1/generate` | `apps/api` (+ `packages/applications` DTOs) | opus-4-8-medium |
| **TASK-563** | Migration guide (v1→v2 mapping), a working example, and cross-version contract + e2e tests | `docs/`, `apps/example`, tests | sonnet-5-high (guide/example) + opus (contract tests) |

**Dependency graph:** TASK-561 and TASK-562 are independent and can run in parallel against the **canonical contracts in §5 of this doc** (the single source of truth both copy). TASK-563 depends on both landing. The SDK `useSMR` (561) calls the shim endpoint (562) by path, so it depends only on 562's *contract* (§5.4), not its implementation.

---

## 2. Current State Evaluation — v1 vs v2 (verified)

Verified 2026-07-27 by four discovery agents reading **both** codebases (v1 source lives under `…/HOPE/docs/apps` and `…/HOPE/docs/packages`; v2 under `…/hope-v2`). File references below are real.

### 2.1 End-to-end workflow mapping

| Step | v1 surface | v2 surface | Delta |
|---|---|---|---|
| **Session start** | `useArcaSessionManager({doctorId,doctorName,patientId,patientName})` → `createSession(metadata)` + `startSession()`; optional `POST /api/sessions` | `useArcaSession().open({patientId, appointmentDate?, department?, metadata?})` → `POST /api/v1/consultations/open` (get-or-create) | v1 two-step + 4 identity props; v2 single `open`, **`doctorId` derived from auth**, names → `metadata`. Status enums differ. |
| **Record (mixed + metadata)** | `useAudioCapture({onAudioData})` (single mic) → app pushes PCM to `stt.sendAudioData(data,{deviceid,role})`. "Mix" = per-chunk metadata tagging | `useArcaAudio().start({deviceId, secondaryDeviceId, pipelineId, dualCaptureEnabled})` — **real** `AudioMixer`; transport internal | v1 exposes raw PCM to the app; v2 owns the pipeline. v1 "mixed stream" is metadata tagging, not real mixing (v2 is a superset). |
| **Live transcripts** | `useArcaSpeechToText({onTranscript(text,isFinal,metadata)})`; WS `/stt?sessionId=&key=`; inbound `{type:"transcription", text, speaker_id, is_final, timestamp, metadata}` | `audio.transcriptSegments[]` + `audio.currentTranscript`; **no public callback**; two-step ticketed WS `/ws/stt/stream`; `{type:"transcript", seq, isFinal}`; persisted as `ContextItem(TRANSCRIPT)`; plus `useArcaLiveSummary()` SSE | v1 push-callback vs v2 pull-state; v1 flat api-key WS vs v2 ticket-gated two-step; different message schemas. |
| **Stop → summary** | `useSMR().summarizeSync({text, departmentId, visitType,…})` → `POST /api/smr/api/v1/summary/sync`; `preSummarize()` → `/presummary`; returns nested `Enhanced`/`SimplifiedMedicalSummary` | `useArcaSummary().generateSummary(opts)` → `POST /api/v1/consultations/:id/summary`; `generatePreSummary()` | **`apps/smr` no longer has `/summary/sync` or `/presummary`** — only generic `POST /api/v1/generate`. Session-aware summary moved into the gateway (`SummaryService`). v1 response shape must be *assembled*. |

### 2.2 Architecture differences (the "why it's not a drop-in")

1. **Provider model.** v1 has **no** provider — each hook takes a plain `SDK_CONFIG_OPTIONS` object. v2 requires `<AgenticProvider config={AgenticConfig}>` wrapping the tree (per-provider Zustand store, `08-vox-sdk.md`). → The single unavoidable app change; the compat layer reduces it to *one* wrapper + a config adapter.
2. **Session identity & shape.** v1 carries `doctorId/doctorName/patientName` and is two-phase (`create`→`start`); v2 `open({patientId})` derives doctor from the JWT/API-key identity, patient by id, names to `metadata`. Status: v1 `IDLE|ACTIVE|PAUSED|EXPIRED|TERMINATED|SUSPENDED` vs v2 `OPEN|RECORDING|DRAFT_PENDING_SENSORS|PENDING_REVIEW|SIGNED|CLOSED|REOPENED`.
3. **Audio transport inverted.** v1: app gets raw PCM (`onAudioData`) and forwards to STT. v2: SDK owns capture→mix→noise→VAD→STT internally; the consumer passes `pipelineId` and reads `transcriptSegments`. The compat `useAudioCapture`/`useArcaSpeechToText` must drive `audio.start(pipelineId)` under the hood and turn `sendAudioData(data, metadata)` into a **metadata sink** (not a real per-chunk send).
4. **Transcript delivery.** v1 push (`onTranscript` callback) vs v2 pull (`transcriptSegments` array + `currentTranscript`). Compat must synthesize the callback by observing store selectors (no public `onTranscription` prop exists in v2).
5. **Summary relocated out of SMR.** In v2, `apps/smr` is a stateless generic generator (`POST /api/v1/generate`). Session summarization = gateway `ConsultationController` → `SummaryService` → SMR `/generate` + `SummaryMeta`. The v1 `/summary/sync` + `/presummary` contracts must be reproduced as **stateless gateway shims** that assemble a prompt from `SessionData` and call SMR `/generate` with a structured `response_format`, then map the LLM JSON to the v1 `Enhanced`/`Simplified` shape.
6. **STT WS auth & schema.** v2's WS is ticket-gated two-step: `POST /api/v1/audio/transcription-jobs/stream/session` → `{sessionId, ticket}`, then WS `/ws/stt/stream?sessionId=&ticket=`, Redis-Streams-backed. A raw api-key WS at `/stt` does not exist. The SDK compat layer hides this by calling the v2 session-create + driving the ticketed socket internally.
7. **Auth — carries over.** v2's `UnifiedAuthGuard` accepts `apikey`/`api-key`/`x-api-key` (`apiKey.service.ts:941`) and resolves tenant from the key. v1's REST auth model works unchanged on the shim endpoints; only WS handshake, `X-Tenant-Id` working-tenant, and 404-over-403 posture differ (all handled internally).

### 2.3 Verified v2 endpoint & hook inventory (targets to delegate to)

**v2 backend (all under global prefix `/api/v1`):**
- Session: `POST /consultations/open` (`apps/api/src/modules/consultation/consultation.controller.ts:335`); recording `POST :id/recording/start|stop` (`:468`, `:495`); live-summary SSE `GET :id/live-summary/stream` (`:508`).
- Summary: `POST /consultations/:id/summary` (`:845`), `.../summary/pre-summary` (`:869`), async variants (`:1059`+); `SummaryService.generateSummary` POSTs to `${SMR_URL}/api/v1/generate` (`packages/applications/src/services/consultation/summary/summary.service.ts:1040`) and writes `SummaryMeta`.
- STT: session-create `POST /audio/transcription-jobs/stream/session` (`apps/api/src/modules/streaming/transcription-job.controller.ts:312`); WS gateway `@WebSocketGateway({ path: '/ws/stt/stream' })` (`apps/api/src/modules/streaming/stt-ws.gateway.ts:170`); transcript callback `POST /internal/stt/transcripts` (`apps/api/src/modules/internal/stt-internal.controller.ts:34`).
- SMR generic proxy: `SmrProxyController` `@Controller('text')` (`apps/api/src/modules/streaming/smr-proxy.controller.ts:145`) → SMR `POST /api/v1/generate`.
- SMR service routes: `apps/smr/src/smr/main.py:327`, endpoints `api/endpoints/{generate,tasks,stream,providers,health}.py`; models `models/requests.py`, `models/responses.py`. **No `summary/sync`/`presummary` exist.**
- Auth: `UnifiedAuthGuard` (`packages/applications/src/authorization/unified-auth.guard.ts:59`); stream tickets `POST /auth/stream-ticket` (`apps/api/src/modules/auth/auth.controller.ts:893`).

**v2 SDK (`@arcaai/vox`):** `AgenticProvider` (`src/providers/AgenticProvider.tsx:244`); `useArcaSession` (`src/hooks/useArcaSession.ts:34`); `useArcaAudio` (`src/hooks/useArcaAudio.ts:65`); `useArcaSummary` (`src/hooks/useArcaSummary.ts:60`); `useArcaLiveSummary` (`src/hooks/useArcaLiveSummary.ts:38`); clients `AgenticClient`, `SttWebSocketClient`, `StreamingSessionManager`, `SSEClient` (all exported from `/core`). Build/exports in `package.json` + `tsup.config.ts` (4 entries: `.`, `core`, `plugins`, `plugins/med-ner`).

---

## 3. Implementation Plan (epic-level)

### 3.1 Sequencing

```
Phase 0 (this doc)  Canonical contracts §5 frozen  ──────────────┐
                                                                  │
Phase 1  ┌── TASK-561 (@arcaai/vox/compat hooks)  ─── parallel ───┤
         └── TASK-562 (gateway SMR summary shim)   ─── parallel ──┤
                                                                  │
Phase 2  TASK-563 (migration guide + example + contract/e2e) ─────┘  (after 561 & 562)
```

TASK-561 and TASK-562 share **no code** (different packages/languages of the same mapping) — they share only the frozen contracts in §5. Each implements its own copy of the v1 types and its own mapper, verified against §5.

### 3.2 Per-layer gates (from `01-development-workflow.md`)

- SDK (561): `pnpm --filter @arcaai/vox build lint test typecheck` green; new subpath resolves; both React 18/19.
- API (562): `pnpm api:build`, `pnpm lint` (hard errors in `apps/api`), `pnpm test:unit`, then e2e `pnpm test:up:api` + `pnpm test:e2e`.
- Applications (562 DTOs): `pnpm --filter @arcaai/applications build test`.
- Docs/tests (563): contract tests green; example builds.

### 3.3 Verification criteria (definition of done for the epic)

- [ ] A v1 app can migrate by: (a) adding one `<AgenticProvider>` wrapper, (b) changing imports `@arcaai/agentic-sdk` → `@arcaai/vox/compat`, (c) mapping `SDK_CONFIG_OPTIONS` via the provided adapter — and the session→record→transcript→stop→summary workflow works end-to-end.
- [ ] `POST /api/smr/api/v1/summary/sync` and `/presummary` return payloads that validate against the v1 schemas in §5.4/§5.5, authenticated by `x-api-key`.
- [ ] No diffs to `ConsultationService`, `SummaryService`, `SttWsGateway`, `StreamingSessionService`, or any Python service.
- [ ] Migration guide + working example committed; contract tests lock the v1 shapes.

---

## 4. Best Practices & Gold Standards (apply across sub-tickets)

- **Additive-only.** New files/subpaths/endpoints. Touch existing files only to *register* the new surface (barrels, module providers, `main.ts` prefix-exclude list, `package.json` exports, `tsup` entries).
- **Delegate, don't reimplement.** Compat hooks call v2 hooks; the shim endpoint calls SMR `/generate` via `IConfigService.getConfigValue('SMR_URL')` + `X-Service-Token` from `SecretsService` — mirroring `SmrProxyController`. Never call SMR by a hardcoded URL; never read `process.env.SMR_URL` in `src/modules/**` (`arcaai-internal/no-direct-downstream-url-env`).
- **404-over-403** for cross-tenant on any new endpoint; **strict DTOs** (`class-validator` + `@ApiProperty` on every field — the global pipe runs `whitelist + forbidNonWhitelisted + forbidUnknownValues`).
- **TDD, red first** (`01-development-workflow.md`): failing test → minimal green → refactor.
- **`08-vox-sdk.md` compliance:** compat hooks read state only via `useArcaStore`/`useStoreApi` selectors or by delegating to public v2 hooks; never import the store object; never touch the deprecated `useAgenticStore` singleton. Every compat file carries `"use client"`.
- **Types ship correctly:** the SDK builds `.d.ts` via the chained `tsc` step (`build` = `tsup && pnpm build:dts`; `tsup` has `dts:false`). Any new entry must be added to BOTH `tsup.config.ts` and `package.json#exports`/`typesVersions`, and the `tsc` declaration step must emit it.

---

## 5. Canonical v1 Contracts (SINGLE SOURCE OF TRUTH — frozen)

Both TASK-561 and TASK-562 implement against these. Derived from the v1 SDK source (`…/HOPE/docs/packages/agentic-sdk/src`) and `SMR_Summary_Endpoints.md`.

### 5.1 v1 config → v2 `AgenticConfig` adapter (used by 561)

```ts
// v1 SDK_CONFIG_OPTIONS (subset that matters)
interface V1SdkConfig {
  apiEndpoint: string;              // REST base, e.g. https://api.arcaai.com
  websocketUrl: string;             // WS base, e.g. wss://api.arcaai.com
  credentials?: { apiKey?: string };
  audioSettings?: { sampleRate?; format?; channels?; noiseSuppression?; echoCancellation?; autoGainControl? };
  environment?: 'development'|'staging'|'production';
}
// → maps to v2 AgenticConfig:
{
  api: {
    baseUrl: v1.apiEndpoint,
    wsUrl: v1.websocketUrl,
    apiKey: v1.credentials?.apiKey,        // x-api-key parity (D2)
    tenantId: undefined,                    // resolved server-side from the api key
  },
  audio: { /* map sampleRate/noiseSuppression/echoCancellation → AudioPluginConfig */ },
}
```
> **Do NOT** carry v1's hardcoded default `apiKey: 'AFUTlhD/pGyyKOBTP3KTnA=='` or `encryptionKey: 'default-key-…'`. Omitted apiKey ⇒ error/throw, never a baked-in default.

### 5.2 v1 session hook contract (`useArcaSessionManager`, reproduced by 561)

```ts
useArcaSessionManager(props: {
  sessionId?: string; doctorId: string; doctorName: string;
  patientId: string; patientName: string;
  options?: Partial<V1SdkConfig>; onError?: (e: ErrorInfo) => void;
}): {
  session: MedicalSession | null; isLoading: boolean; error: ErrorInfo | null;
  createSession: (metadata?: Partial<SessionMetadata>) => Promise<MedicalSession>;
  startSession: () => Promise<void>; pauseSession: (reason?: string) => Promise<void>;
  resumeSession: () => Promise<void>; endSession: () => Promise<void>;
  loadSession: (id: string) => Promise<MedicalSession>;
  updateSession: (data?: Record<string, unknown>) => Promise<void>;
  clearError: () => void;
}
```
**Mapping to v2:** `createSession(meta)` + `startSession()` collapse onto `useArcaSession().open({ patientId, department: meta?.…, metadata: { doctorName, patientName, ...meta } })`. `doctorId` is dropped (server derives it) or stored in `metadata.legacyDoctorId`. `pause/resume` have no v2 equivalent → keep local status only (or map to no-op with a documented note). `endSession()` → `close()`. Expose a synthesized `MedicalSession` view (id, status, timestamps) derived from the v2 `Consultation` + store; map v2 status → v1 status enum (`OPEN`→`IDLE`, `RECORDING`→`ACTIVE`, `CLOSED`→`TERMINATED`).

### 5.3 v1 audio + STT hooks (reproduced by 561)

```ts
useAudioCapture(props: { options?; autoStart?; onAudioData?: (b: ArrayBuffer)=>void; onError? }): {
  isRecording: boolean; startRecording: () => Promise<void>; stopRecording: () => Promise<void>;
  getDeviceStatus: () => Promise<AudioDeviceStatus|null>; deviceStatus; error; isReady: boolean;
}
useArcaSpeechToText(props: {
  sessionId: string; language: string; options?; transcriptTemplate?;
  onTranscript: (text: string, isFinal: boolean, metadata?: Record<string,any>) => void;
  onError?; onStatus?;
}): {
  transcript: string; startTranscription: () => Promise<void>; stopTranscription: () => Promise<void>;
  sendAudioData: (b: ArrayBuffer, metadata?: Record<string,any>) => void;  // metadata sink in v2
  uploadAudioFile; getTranscriptionStatus; isUploading; uploadProgress; error;
}
```
**Mapping to v2:** the compat pair coordinates a single `useArcaAudio().start({ pipelineId, language, deviceId })` (pipelineId from config/props for backend streaming). `startTranscription()` + `startRecording()` both resolve to one `audio.start(...)` (idempotent-guard so calling both doesn't double-start). `onTranscript` is fired by subscribing to `transcriptSegments`/`currentTranscript` via `useArcaStore` selectors and diffing (final → `onTranscript(text,true,meta)`, interim → `onTranscript(text,false,meta)`), formatted through `transcriptTemplate`. `sendAudioData(data, metadata)` becomes a **metadata sink**: it records `{deviceid, role}` to attach to context/segments; it does NOT push PCM (v2 owns capture). `stopRecording()`/`stopTranscription()` → `audio.stop()`.

### 5.4 v1 `POST /api/smr/api/v1/summary/sync` (reproduced by 562)

Request `SyncSummaryRequest` and response `SummaryResponse` exactly as in `SMR_Summary_Endpoints.md` §3. Key request fields: `session_data{ session_id, patient_id?, provider_id?, created_at, conversation_segments[], patient_info?, session_metadata?, test_results[], previous_visits[], test_results_text?, previous_visits_text?, pre_summary_text? }`, plus top-level `use_enhanced_format`, `department`, `visit_type`, `specialty`, `encounter_type`, `temperature`, `max_tokens`, `include_pre_summary_in_context`. Response: `{ session_id, summary: Enhanced|Simplified, created_at, processing_time_ms?, token_usage?, confidence_score?, metadata? }`. Full `Enhanced`/`Simplified` JSON schema: `SMR_Summary_Endpoints.md` §3.3.

**Shim mapping to v2 (stateless, no core change):** assemble a prompt from `session_data.conversation_segments` (+ pre_summary_text/test_results_text/previous_visits_text/patient_info) using a department/visit-type template; POST to SMR `${SMR_URL}/api/v1/generate` with `system_prompt`, `prompt`, `temperature`, `max_tokens`, and `response_format: { type:'json_schema', json_schema: <Enhanced|Simplified> }` (chosen by `use_enhanced_format`), `X-Service-Token` attached. Parse `GenerateResponse.content` JSON → validate against the chosen schema → wrap in v1 `SummaryResponse` (fill `processing_time_ms` from `latency_ms`, `metadata.finish_reason` etc.). Persistence to Postgres/`job_id` is **optional/out-of-scope** (v1's response never depended on it).

### 5.5 v1 `POST /api/smr/api/v1/presummary` (reproduced by 562)

Request `PreSummaryRequest{ current_department?, visit_type?, age?, dob?, gender?, formatted_vitals?, formatted_test_results?, formatted_previous_visits?, language?='en', temperature?=0.2, max_tokens?=800 }`; response `PreSummaryResponse{ pre_summary: string, structured_data: { title, sections:[{title, items:[{text}]}] }, created_at }`. Same stateless SMR `/generate` mapping; `structured_data.sections` may be `[]` while `pre_summary` carries the full markdown — clients treat `pre_summary` as source of truth.

### 5.6 Exact-path reproduction note (for 562)

v1 paths are literally `/api/smr/api/v1/summary/sync` and `/api/smr/api/v1/presummary`. v2's global prefix is `api/v1` (excludes only `/metrics`). To reproduce the **exact** literal paths, add the compat controller routes to the `setGlobalPrefix('api/v1', { exclude: [...] })` exclusion list in `apps/api/src/main.ts` and declare `@Controller('api/smr/api/v1')` with `@Post('summary/sync')` / `@Post('presummary')`. This makes existing v1 client base-URLs and the compat SDK's default URL construction "just work" when pointed at the v2 gateway. (Alternative v2-native path `/api/v1/smr/...` is rejected — it would force app-side URL edits.)

---

## 6. Findings / Defects / Anti-patterns (do NOT port)

| # | Item | Source | Action |
|---|---|---|---|
| F1 | **Custom binary WS audio frame** prepends 1 byte type + 4 byte length + JSON metadata before PCM; the v1 STT service never strips it → likely corrupts/desyncs the PCM fed to Azure/Whisper | `remoteStt.service.ts:65` builds it; `apps/stt/.../websocket.py` treats all binary as raw audio | Not applicable to v2 (SDK drives v2's native raw-PCM WS). Do not reproduce the framing. Documented so no one "restores" it. |
| F2 | **`useSMR` collapses the whole transcript into one `conversation_segments` entry** (`speaker:'user'`) instead of per-turn | v1 `useSMR.ts` `summarize()` | The v2 compat `useSMR`/shim should send **real per-turn segments** (v2 backend already supports the array). |
| A1 | **Hardcoded default `apiKey` + `encryptionKey`** baked into `useArcaSessionManager` | v1 `useArcaSessionManager.ts:6` | Never port. Missing apiKey ⇒ throw. |
| A2 | **TTS hook returns a positional 10-tuple** | v1 `useTTS.ts` | Out of workflow scope; if TTS compat is ever added, return an object. |
| I1 | **Two unrelated "session" ids in v1** (`/api/sessions` DB vs `/api/stt/start_session` in-memory) linked only by a shared string | v1 gateway | v2 unifies on the `Consultation` id; the compat session hook exposes one id. |
| I2 | **No confidence in v1 live transcript**; diarization is a bare `speaker_id` string | v1 STT WS `transcription` event | v2 `TranscriptSegment` has optional `confidence`/`speakerLabel`; compat `onTranscript` metadata may include them (richer, backward-compatible). |

---

## 7. Implementation Summary

Implemented 2026-07-28 via a 4-agent opus-4-8-high workflow (implement 561+562 in parallel → combined adversarial verify → integrate 563). **Verify verdict: PASS, zero core-business violations.** All headline gates independently re-confirmed in the main session.

### 7.1 What shipped

- **TASK-561 — `@arcaai/vox/compat`** (Status: Review). New opt-in subpath exporting v1-named hooks that delegate to v2:
  - Files: `packages/agentic-sdk-v2/src/compat.ts` (barrel) + `src/compat/{config-adapter,ArcaCompatProvider,useArcaSessionManager,useAudioCapture,useArcaSpeechToText,useSMR,types}.tsx?` + 5 `__tests__/*`.
  - Registration (additive): `tsup.config.ts` (+`compat` entry), `package.json` (`exports["./compat"]` + `typesVersions`). `dist/compat.{js,mjs,d.ts}` all emitted; 7 runtime members resolve under CJS + ESM.
  - Behavior: `mapV1ConfigToAgenticConfig` throws on missing apiKey (no default key); `useSMR` sends **per-turn** `conversation_segments` (fixes v1 F2) to the §5.6 literal paths; `sendAudioData` is a metadata sink; `onTranscript` synthesized from store selectors; v2→v1 status mapping via `mapV2StatusToV1`.
- **TASK-562 — gateway SMR summary shim** (Status: Review). Stateless `@Controller('api/smr/api/v1')` with `POST summary/sync` + `POST presummary` over SMR `/api/v1/generate`.
  - Files: `apps/api/src/modules/smr-compat/{smr-compat.controller,smr-compat.module,summary-prompt.builder,summary-response.mapper,summary-schemas}.ts` + `dto/*` (strict request DTOs, response types) + 3 `__tests__/*` + e2e `apps/api/tests/e2e/task-562-smr-compat.spec.ts`.
  - Registration (additive): `main.ts` (`setGlobalPrefix` exclude for the 2 literal paths → real `/api/smr/api/v1/...`), `app.module.ts` (`SmrCompatModule`).
  - Behavior: `SMR_URL` only via `IConfigService`; `X-Service-Token` via `SecretsService`; `x-api-key` parity (tenant from key); `response_format:{type:'json_schema', strict:true}` chosen by `use_enhanced_format`; upstream errors PHI-redacted; presummary section-parse with `sections:[]` fallback.
- **TASK-563 — guide + example + contract lock** (Status: Review). `MIGRATION_GUIDE.md`; runnable `apps/example/compat.html` + `src/compat-consultation.tsx`/`compat-main.tsx` on `<ArcaCompatProvider>`; contract tests `packages/agentic-sdk-v2/src/compat/__tests__/contract.test.ts` (+13) and hermetic zod schema lock `tests/contracts/smr-compat.{schemas,contract}.test.ts` + `tests/fixtures/smr-compat.fixture.ts`.

### 7.2 Evidence (independently re-run in the main session, 2026-07-28)

- `packages/agentic-sdk-v2/src/compat` → **42 passed** (29 unit + 13 contract).
- `tests/contracts/smr-compat.contract.test.ts` → **18 passed** (Enhanced/Simplified/envelope/PreSummary + drift guards).
- `apps/api/src/modules/smr-compat` → **30 passed** (prompt builder, response mapper, controller; negative branches assert PHI-redacted 502 + invalid-JSON handling).
- `git status` confirms only sanctioned additive edits + new dirs — **no** change to `ConsultationService`, `SummaryService`, `SttWsGateway`, `StreamingSessionService`, existing v2 hooks/store/clients/providers, or `apps/smr`/`apps/stt`.
- Full-suite: implementers/verifier reported vox `3600 passed` and api `test:unit 17296 passed`; the sole full-suite failure `scripts/__tests__/env-sync.test.ts` (134 > 130 declared env keys) is **pre-existing and unrelated** — no `.env`/`turbo.json` changed by this ticket.

### 7.3 Accepted deviations (non-blocking)

- Two 561 compat hooks import the **context-backed** `useAgenticStore` from `../store` (sanctioned internal per-provider hook — not the `@deprecated` inert singleton) rather than `./hooks`. Functionally correct; cosmetic vs the ticket wording.
- 562 response DTOs are plain TS interfaces (0 `@ApiProperty`) — deliberate: they never traverse the request `ValidationPipe`. Trade-off: Swagger won't document the response body. Request DTOs remain strict. Acceptable for a v1-shape passthrough; revisit if Swagger response docs are required.

### 7.4 Outstanding (infra-gated, not code-blocking)

- **Live e2e happy path**: `pnpm test:up:api` then `pnpm test:e2e -- task-562-smr-compat` with SMR `:8862` booted (spec currently SMR-down-tolerant, so it asserts the gateway contract without a live LLM).
- Optional driven-browser Playwright walkthrough of `apps/example/compat.html` (session→transcript→summary render).
- **Commit** the change set (a concurrent `nest --watch` is live in this tree — work is staged to protect it).

### 7.5 v1-fidelity fixes to the SMR compat shim (2026-07-31)

Five v1-fidelity items applied to `apps/api/src/modules/smr-compat/**` ONLY (plus `turbo.json#globalEnv` + `.env.dev`/`.env.sample` for the item-5 config key). No V2 core touched — the shim still calls `/generate` as a stateless client; `apps/smr` unchanged. TDD throughout; verified with scoped vitest (`pnpm vitest run apps/api/src/modules/smr-compat`).

**Frozen wire contract (item 1, unchanged from the agent-B SDK side):** department = top-level `body.department` (non-empty) ELSE `session_metadata[department|department_name|current_department|dept|department_id]` ELSE undefined; visit_type = `body.visit_type` ELSE `session_metadata[visit_type|visit|encounter|encounter_type]` ELSE `session_data.session_type` ELSE undefined. Then normalized to the 7 v1 departments × {new_referral, followup}; General/Medicine → generic conversational path.

- **Item 1 — dept/visit resolution.** New exported pure helper `resolveDepartmentVisit(body, sessionData)` (`smr-compat.controller.ts`, ~L60-118), ported from v1 `prompt_selector.extract_department_and_visit_type`. Wired into `summarySync` (replaces the direct `body.department`/`body.visit_type` reads). Tests: `__tests__/smr-compat.controller.test.ts` (top-level wins; alias fallback + precedence; session_type last-resort; none → undefined).
- **Item 2 — v1 department template + schema engine.** New `dept-templates.ts` ports `select_prompt_template` + `get_department_schema` synonym maps (visit-type + department normalization) and the full 14-entry `DEPT_VISIT_SCHEMAS` (`prompts_json.py:31-223`, cited inline). `buildSummaryPrompt` now injects the selected dept×visit field set as **prompt guidance** ("Department-specific documentation focus …") for the 6 non-medicine departments, while the **wire response stays generic Simplified/Enhanced** (v1 normalizes dept keys back to the generic response; the shim keeps `response_format.json_schema` = Simplified/Enhanced, so no 200-line key-normalizer is needed). General/Medicine + unknown depts keep the generic path. Tests: `__tests__/dept-templates.test.ts` (12) + prompt-builder tests.
- **Item 3 — pre-summary 5-section guarantee.** `summary-response.mapper.ts` `parseSections`/`mapGenerateToV1PreSummary` rewritten to v1 `PreviousVisitService.generate_pre_summary` (`previous_visit_service.py:214-294`): only the 5 EXACT canonical titles are recognized as headers; the structured output always carries all five IN ORDER, missing/empty filled with `{text:"Not available"}`; v1 title prepended to `pre_summary` when absent. Tests: all-present, some-missing (filled), none-parsed (all 5 = Not available).
- **Item 4 — metadata labels.** Added `llm_provider`, `model_name`, `parsing_method`, `raw_llm_content` to the sync response `metadata` as cosmetic passthrough LABELS (populated from the call: provider/model actually used — including the fallback; `raw_llm_content` = the `/generate` `content` already parsed into `summary`; `parsing_method` = `"json_schema"`). This is v1-faithful: v1's `_sanitize_response_for_frontend` (`summary_service.py:1775-1782`) explicitly KEEPS `raw_llm_content` + `parsing_method`. **Decision (reverses a prior v2 over-hardening):** the old mapper comment/test asserted `raw_llm_content` is "NEVER echoed"; that test was replaced. `raw_llm_content` exposes nothing beyond the `summary` already returned. `summary_id`: kept as the additive field it already was (v1 had none) — it never displaces a v1 key; existing keys unchanged.
- **Item 5 — Azure Foundry fallback.** On a primary `/generate` provider-side failure (upstream RESPONSE error / unparseable content), `summarySync` retries ONCE against the Azure AI Foundry provider (`resolveFallbackTarget` + `isFallbackEligible` + `postGenerate` refactor). **Investigation result — NOT blocked, no V2-core change:** Azure AI Foundry is served by SMR's already-registered `azure-openai` provider (`apps/smr/src/smr/main.py` provider table, L180-181); provider/model for `/generate` come from `HarnessPolicyService.resolveSmrSelection`. The fallback names `provider=azure-openai` (override via `SMR_FALLBACK_PROVIDER`) + `model=SMR_FALLBACK_MODEL`; SMR resolves Foundry credentials from its own env/control-plane exactly as for any provider — so no `apps/smr` edit. Fallback is DISABLED when `SMR_FALLBACK_MODEL` is unset (no silent behavior change), skipped when SMR itself is unreachable (a second call can't help) or when the primary already IS the Foundry provider, and surfaces the ORIGINAL error if the fallback also fails.

**Owner decisions / follow-ups (item 5 env plumbing):** `SMR_FALLBACK_PROVIDER`/`SMR_FALLBACK_MODEL` were added to `turbo.json#globalEnv` + `.env.dev` + `.env.sample`. They are plain compat-scoped env vars read via `process.env` (not downstream URLs, so `no-direct-downstream-url-env` does not apply; not in `IAppConfig`/`IConfigService`, which is out of this task's edit scope). If the repo's `env:sync --check` drift gate is descriptor-generated, an owner should either register descriptors for these two keys or accept them as hand-added — otherwise that (already pre-existing-failing) gate's declared-key count will need updating.

**Test evidence (scoped, 2026-07-31):** `pnpm vitest run apps/api/src/modules/smr-compat` → **4 files, 63 passed** (dept-templates 12, prompt-builder 13, mapper 14, controller 24). Frozen contract lock `tests/contracts/smr-compat.contract.test.ts` → **18 passed** (unchanged — additive labels + 5-section shape are contract-compatible). Left in the working tree, not committed/staged.

## 8. Change History

| Date | Author | Change |
|---|---|---|
| 2026-07-27 | (planning) | Ticket created. Four-agent v1/v2 discovery complete; gap analysis, architecture diff, canonical contracts, and scope decisions D1–D3 recorded. Sub-tickets TASK-561/562/563 defined. Status → In Progress (planning complete). |
| 2026-07-28 | (multi-agent) | All three sub-tickets implemented via opus-4-8-high workflow + combined adversarial verify (PASS, 0 core-business violations). Independently re-confirmed 42 compat + 18 contract + 30 shim tests. §7 Implementation Summary populated. Status → Review (pending live-stack e2e + commit). |
| 2026-07-31 | (compat fixes) | Five v1-fidelity fixes to the SMR compat shim (items 1–5): dept/visit resolution helper, v1 dept×visit template/schema engine (`dept-templates.ts`), pre-summary 5-section guarantee, v1-parity metadata labels (incl. reinstating `raw_llm_content`), and a one-retry Azure Foundry fallback (served via the registered `azure-openai` provider — NOT blocked, no `apps/smr` change). smr-compat suite 63 passed; frozen contract 18 passed. See §7.5. Uncommitted. |

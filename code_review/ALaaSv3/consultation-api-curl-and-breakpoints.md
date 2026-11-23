# Consultation-related HOPE API: curl commands and debugger breakpoints (local)

**Date:** 2026-11-15 (Asia/Calcutta)  
**Workspace:** `/Users/apple/repos/VOX`  
**Scope:** Consultation-related HOPE API Gateway calls for local testing (`project-hope/apps/api`, base `http://localhost:8868`), with **streaming/realtime STT treated as a separate module** (`audio/transcription-jobs/*`) because it lives in the streaming module/controller but is used by consultation flows.

> **Status of previous guidance:** The breakpoint guidance shared earlier in chat (e.g. `createStreamSession` in `transcription-job.controller.ts` and `StreamingSessionService.createSession`) was **not previously written to a procedure document**. This document records that guidance plus consultation-flow curl commands and breakpoint locations.

## 0. Current local context (as of this session)

- HOPE API: `:8868` healthy (inspector `127.0.0.1:9229` listening; VS Code attach config: `project-hope/.vscode/launch.json` → **Attach: HOPE API (9229)**).
- HOPE STT: `:8861` healthy, started with `HF_HOME=/Users/apple/.cache/huggingface`.
- Whisper-small fix applied locally: `Systran/faster-whisper-small` cached; HOPE DB `AiModel` `faster-whisper-small` (`80000000-0000-0000-00aa-000000000001`) added; tenant `50000000-0000-0000-0000-000000000001` agent `realtime-transcription` (`217c9372-9c08-8b41-8ce7-c6e083eb79da`) pointed to it (local-dev DB workaround).
- ALaaS (`audio-stream-svc :4000`, `web_ui :5173`, `mmr_agent :5001`, stores `5433/6380`) restarted; `mmr_agent` lists mics but showed WS streaming errors (`'NoneType' object has no attribute 'encode'`) in prior attempt — streaming/audio path may still need fix before end-to-end success.
- Logs: `review/ALaaSv3/deploy_console_20261114.log`.
- **Do not commit secrets** (`.env`, tokens, client secrets).

## 1. Prerequisites and curl conventions

### Base URL / headers
- **Base:** `http://localhost:8868`
- **JSON:** `-H 'Content-Type: application/json'`
- **Auth (choose what your caller uses):**
  - User session/API bearer token: `-H 'Authorization: Bearer <ACCESS_TOKEN>'`
  - Service account / machine auth: use the locally configured HOPE service account credentials/token flow for ALaaS integration (see local `.env`/seed in `project-hope` and ALaaS `audio-stream-svc/.env`; **do not paste secrets into docs/commits**).
  - Some consultation endpoints require service scopes (e.g. `svc:consultation:session:write` via `@RequiredSvcScopes`) and/or abilities (`@Authorize([...])`). `If-Match` is required on OCC-protected lifecycle/content mutations (RFC 7232, often the consultation/context `_version`).
- **Tenant context:** supplied by authenticated principal/token; local working tenant in this debug flow is typically `50000000-0000-0000-0000-000000000001` (verify in your local env/DB).

### Placeholders used below
- `<TOKEN>` = bearer/access token
- `<CONSULTATION_ID>` = consultation id
- `<SESSION_ID>` = STT stream session id
- `<CONTEXT_ITEM_ID>`, `<ATTACHMENT_ID>`, `<JOB_ID>` = resource ids
- `<VERSION>` = row `_version` for `If-Match` (e.g. `"7"`)

### Example: health check (no auth)
```bash
curl -sS http://localhost:8868/api/v1/health
```

## 2. Consultation module APIs (HOPE API)

**Controller:** `project-hope/apps/api/src/modules/consultation/consultation.controller.ts` (`@Controller('consultations')`, base path `/api/v1/consultations` unless globally prefixed differently in your runtime).

| Area | Method & path (typical) | Purpose | Suggested breakpoint(s) in HOPE API (`project-hope`) |
|---|---|---|---|
| Open/get-or-create consultation | `POST /api/v1/consultations/open` | Open/create consultation for clinician/patient context (service-account flows may need `clinicianUserId` or schema-declared identity in `context`; validates workflow/schema/language/department rules). | `apps/api/src/modules/consultation/consultation.controller.ts` → `open(...)` (~line 744), and step into `consultationService.getOrCreate(...)` (`packages/applications/.../consultation/*`). Inspect request body, resolved acting clinician, tenant, refusal codes. |
| List selectable workflows | `GET /api/v1/consultations/workflows` | Workflows caller may select at open (same authorization predicate as open). | Controller `listSelectableWorkflows()` (~804) → service call. |
| Get consultation | `GET /api/v1/consultations/:id` | Read consultation. | Controller `getById(...)` (~817) and access checks (`verifyConsultationAccess`/ownership helpers). |
| List consultations | `GET /api/v1/consultations?...` | Paginated list (filters like `patientId` as supported). | `list(...)` (~860). |
| Update consultation | `PATCH/PUT /api/v1/consultations/:id` (see OpenAPI/decorators in controller) | Update mutable fields (e.g. `languageMode`); requires `If-Match`. | `update(...)` (~959) and `consultationService.updateConsultation(...)`. Break on OCC/version validation and language-mode validation. |
| Start capture | `POST /api/v1/consultations/:id/start` | OPEN/PAUSED/STOPPED → RECORDING; may bind STT `sessionId`. | `start(...)` (~999), lifecycle service / live-doc start / session binding. |
| Pause capture | `POST /api/v1/consultations/:id/pause` | Pause recording/capture. | `pause(...)` (~1017). |
| Stop capture | `POST /api/v1/consultations/:id/stop` | Stop and finalize transcript/capture flow. | `stop(...)` (~1037); inspect stop request (`waitForFinal`, snapshot/proposals as applicable). |
| Approve | `POST /api/v1/consultations/:id/approve` | Approve consultation (lifecycle rules, `If-Match`, safety/processing constraints). | `approve(...)` (~1090). |
| Close | `POST /api/v1/consultations/:id/close` | Close consultation (attribution rules differ for human vs machine/API key; `If-Match`). | `close(...)` (~1266), `verifyConsultationOwnership`, `callerOf`, `consultationService.closeConsultation(...)`. |
| Reopen | `POST /api/v1/consultations/:id/reopen` | Reopen closed consultation (`If-Match`, reason/attribution rules). | `reopen(...)` (~1322). |
| Recording state/manifest | `GET /api/v1/consultations/:id/recording` | Recording manifest/parts (presigned URLs as applicable). | `getRecording(...)` (~1136), `presignRecordingPart(...)` (~1165). |
| Encounters | `GET /api/v1/consultations/:id/encounters` | Encounter list/order. | `listEncounters(...)` (~1118). |
| Context items | `GET /api/v1/consultations/:id/context-items` | List context items. | `getContextItems(...)` (~1695). |
| Add context item | `POST /api/v1/consultations/:id/context-items` | Add context (schema/version aware; may require `contextSchemaVersionId`). | `addContext(...)` (~1678) → `contextService.addContext(...)`. |
| Update/delete context | `PATCH/DELETE /api/v1/consultations/:id/context-items/:contextId` | Mutate/remove context (OCC/permissions as applicable). | `updateContext(...)` (~1789), `deleteContext(...)` (~1821). |
| Summaries / pre-summary / generate | `GET /api/v1/consultations/:id/summaries`, `GET .../summaries/latest`, `POST .../summaries/generate` (async variants as implemented) | Read/generate summaries (harness/text pipeline dependencies). | `getSummaries` (~2099), `generateSummaryAsync` (~2355), `startHarnessSummaryJob` (~2378), `generatePreSummaryAsync` (~2449), `generateComprehensiveSummary` (~2492), summary service/harness internals. |
| Attachments (separate controller) | `POST/GET /api/v1/consultations/:id/attachments...` | Upload intent/complete/content/list/get attachments. | `apps/api/src/modules/consultation/consultation-attachment.controller.ts` handlers (e.g. ~55+). |
| Feedback (separate controller) | `GET /api/v1/consultations/feedback/reason-codes`, `POST/GET /api/v1/consultations/:id/feedback` | Submit/list feedback/corrections. | `apps/api/src/modules/consultation/consultation-feedback.controller.ts` handlers. |
| Consultation jobs (separate controller) | `GET /api/v1/consultations/jobs/:jobId`, `PATCH .../cancel`, SSE stream as exposed | Track/cancel consultation jobs. | `apps/api/src/modules/consultation/consultation-job.controller.ts`. |

### Example curl templates (consultation module)

```bash
# Open consultation (get-or-create) — shape depends on your auth mode and schema
curl -sS -X POST 'http://localhost:8868/api/v1/consultations/open' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "patientId": "<PATIENT_OR_EXTERNAL_PATIENT_ID>",
    "departmentId": "<DEPARTMENT_ID_OPTIONAL>",
    "clinicianUserId": "<CLINICIAN_USER_ID_IF_REQUIRED>",
    "context": {}
  }'

# Get consultation
curl -sS 'http://localhost:8868/api/v1/consultations/<CONSULTATION_ID>' \
  -H 'Authorization: Bearer <TOKEN>'

# Update consultation (OCC) — set spoken language mode example
curl -sS -X PATCH 'http://localhost:8868/api/v1/consultations/<CONSULTATION_ID>' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -H 'If-Match: "<VERSION>"' \
  -d '{ "languageMode": "en" }'

# Start / pause / stop lifecycle
curl -sS -X POST 'http://localhost:8868/api/v1/consultations/<CONSULTATION_ID>/start' \
  -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' -d '{}'

curl -sS -X POST 'http://localhost:8868/api/v1/consultations/<CONSULTATION_ID>/pause' \
  -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' -d '{}'

curl -sS -X POST 'http://localhost:8868/api/v1/consultations/<CONSULTATION_ID>/stop' \
  -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' -d '{ "waitForFinal": true }'

# Approve / close / reopen (OCC; body/attribution rules vary by caller type)
curl -sS -X POST 'http://localhost:8868/api/v1/consultations/<CONSULTATION_ID>/approve' \
  -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' -H 'If-Match: "<VERSION>"' -d '{}'

curl -sS -X POST 'http://localhost:8868/api/v1/consultations/<CONSULTATION_ID>/close' \
  -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' -H 'If-Match: "<VERSION>"' -d '{}'

curl -sS -X POST 'http://localhost:8868/api/v1/consultations/<CONSULTATION_ID>/reopen' \
  -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' -H 'If-Match: "<VERSION>"' -d '{ "reason": "<REASON>" }'

# Context and summaries (examples)
curl -sS 'http://localhost:8868/api/v1/consultations/<CONSULTATION_ID>/context-items' \
  -H 'Authorization: Bearer <TOKEN>'

curl -sS 'http://localhost:8868/api/v1/consultations/<CONSULTATION_ID>/summaries' \
  -H 'Authorization: Bearer <TOKEN>'
```

> **Note:** Exact request/response DTOs, required fields, and path variants can differ by HOPE version/config; confirm with generated OpenAPI (`pnpm api:openapi` in `project-hope`) or controller DTOs when a call returns 400/422.

## 3. Streaming module APIs (separate module, used in consultation recording/transcription)

**Controller:** `project-hope/apps/api/src/modules/streaming/transcription-job.controller.ts` (`@Controller('audio/transcription-jobs')`, base `/api/v1/audio/transcription-jobs`). This is the key path for realtime mic/consultation transcription issues.

| Area | Method & path | Purpose | Suggested breakpoint(s) in HOPE API (`project-hope`) |
|---|---|---|---|
| Create realtime stream session | `POST /api/v1/audio/transcription-jobs/stream/session` | Resolve ASR agent/spec and create STT stream session; returns session/ws/ticket metadata. **Primary debug point for prior “Transcription returned an invalid response” / HOPE_UNAVAILABLE flow.** | `apps/api/src/modules/streaming/transcription-job.controller.ts` → `createStreamSession(...)` (~963): inspect `body`, resolved tenant/consultation/agent/spec, `sessionPayload` (~1081), and `await this.sessionService.createSession(sessionPayload)` (~1083). Step into `packages/applications/src/services/stt/streaming/streamingSession.service.ts` → `createSession(...)` (~340): inspect outbound call to STT, request body (model/engine/language), response/status/parsing/errors. |
| Refresh stream ticket | `POST /api/v1/audio/transcription-jobs/stream/session/:sessionId/refresh-ticket` | Mint fresh one-shot WS ticket. | `refreshStreamTicket(...)` (~1328). |
| Switch to fallback/primary | `POST .../stream/session/:sessionId/switch-to-fallback`, `POST .../stream/session/:sessionId/switch-to-primary` | Change active ASR engine path for session. | `switchStreamSessionToFallback(...)` (~1364), `switchStreamSessionToPrimary(...)` (~1408). |
| Close stream session | `DELETE /api/v1/audio/transcription-jobs/stream/session/:sessionId` | Teardown stream session. | `closeStreamSession(...)` (~1303). |
| Batch transcription job | `POST /api/v1/audio/transcription-jobs/batch` | Create batch STT job. | `createBatch(...)` (~547), `dispatchBatchJob(...)`, ASR/limits resolution helpers. |
| Transcribe uploaded file | `POST /api/v1/audio/transcription-jobs/transcribe` (multipart/form-data, as implemented) | Direct/file transcription flow. | `transcribeFile(...)` (~647), `transcribeFileOnce(...)` (~677). |
| Get job / list / stats / by consultation | `GET /api/v1/audio/transcription-jobs/:id`, `GET ...`, `GET .../stats`, `GET .../consultation/:consultationId`, `GET .../limits`, `GET .../language-modes` | Inspect transcription jobs/capabilities. | `getById` (~1432), `list` (~1508), `getStats` (~583), `getByConsultation` (~867), `getBatchLimits` (~883), `getLanguageModes` (~908). |
| Job control/stream | `POST .../:id/cancel`, `POST .../:id/retry`, `GET .../:id/stream` (SSE) | Cancel/retry/observe job. | `cancel` (~1465), `retry` (~1491), stream handler (~1443+). |

### Example curl templates (streaming module)

```bash
# Capabilities / limits
curl -sS 'http://localhost:8868/api/v1/audio/transcription-jobs/language-modes' \
  -H 'Authorization: Bearer <TOKEN>'

curl -sS 'http://localhost:8868/api/v1/audio/transcription-jobs/limits' \
  -H 'Authorization: Bearer <TOKEN>'

# Create realtime stream session (consultation-linked; fields depend on resolved contract)
curl -sS -X POST 'http://localhost:8868/api/v1/audio/transcription-jobs/stream/session' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "consultationId": "<CONSULTATION_ID>",
    "languageMode": "en"
  }'

# Refresh ticket / close session
curl -sS -X POST 'http://localhost:8868/api/v1/audio/transcription-jobs/stream/session/<SESSION_ID>/refresh-ticket' \
  -H 'Authorization: Bearer <TOKEN>'

curl -sS -X DELETE 'http://localhost:8868/api/v1/audio/transcription-jobs/stream/session/<SESSION_ID>' \
  -H 'Authorization: Bearer <TOKEN>'

# Get transcription job(s)
curl -sS 'http://localhost:8868/api/v1/audio/transcription-jobs/<JOB_ID>' \
  -H 'Authorization: Bearer <TOKEN>'

curl -sS 'http://localhost:8868/api/v1/audio/transcription-jobs/consultation/<CONSULTATION_ID>' \
  -H 'Authorization: Bearer <TOKEN>'
```

> **Important:** Stream session creation also involves a WebSocket/audio streaming path (ticketed WS URL returned by create/refresh). curl is useful for control-plane calls (create/refresh/close/inspect), but not for full PCM streaming; for end-to-end audio use `mmr_agent` + `web_ui`/ALaaS flow or the appropriate WS client.

## 4. STT service (downstream, when HOPE→STT needs debugging)

If the HOPE API reaches STT but session/model load fails:
- **Service:** `project-hope/apps/stt` (`:8861`, `HF_HOME=/Users/apple/.cache/huggingface`)
- **Debug targets:** realtime stream/session creation handlers and `faster_whisper` / model resolution/load path in `apps/stt/src/stt/...` (use debugpy/VS Code "Text" is for text service; configure an STT debugpy launch or run with debugger attached as needed).
- **Check:** `curl -sS http://localhost:8861/api/v1/health` and STT logs in `review/ALaaSv3/deploy_console_20261114.log`.

## 5. Suggested trace order for the current local issue

1. **Consultation open/start** (`consultation.controller.ts` open/start/stop) — confirm consultation, ownership, lifecycle, and any bound stream/session ids.
2. **Stream session create** (`transcription-job.controller.ts:createStreamSession` → `streamingSession.service.ts:createSession`) — confirm resolved ASR agent/spec points to `faster-whisper-small` and inspect STT response/error.
3. **STT session/model handling** (`apps/stt`) — confirm model loads from local HF cache and session becomes active.
4. **ALaaS/mmr_agent audio WS** (outside HOPE API) — current mmr_agent log shows `audio_stream` `NoneType ... encode`; fix there if audio never reaches HOPE.

## 6. Notes / caveats

- Line numbers are approximate to the current checked-out source state and may drift after edits/rebases; search by method/route names (`createStreamSession`, `createSession`, `open`, `close`) if they differ.
- Some endpoints require `If-Match`, specific scopes/abilities, consent, or service-account constraints; 400/401/403/404/409/412/428 responses often include machine-readable codes/messages useful for tracing.
- End-to-end consultation/summary can still depend on services/providers beyond API+STT (e.g. `stt-worker` for batch, text/LLM, guardrail, NLP, harness/Temporal, reranker). Validate per scenario.
- Real secrets/tokens must not be stored in this repo or logs.

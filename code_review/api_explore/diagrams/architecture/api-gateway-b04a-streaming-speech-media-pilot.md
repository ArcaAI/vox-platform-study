# API Gateway B04a — Streaming, Speech & Media (Pilot)

Companion explainer for `api-gateway-b04a-streaming-speech-media-pilot.html`.

## Scope

Pilot batch (`B04a`) for the API Gateway architecture diagram program. It documents **representative** flows in the requested shape:

**Left = API endpoints** → **Middle = controllers/gateways** → **Services** → **Right = downstream microservices/APIs/storage**.

Covered modules/areas (representative, not exhaustive):
- `apps/api/src/modules/streaming` — transcription jobs, stream session, text generation proxy
- `apps/api/src/modules/speech` — speech synthesis proxy, TTS WS gateway
- `apps/api/src/modules/media` — media upload/reference
- Key downstream microservices: **Text** (`TEXT_URL`, local default pattern `:8862`), **STT** (`STT_URL`, `:8861`), **TTS** (`TTS_URL`, `:8865`)
- Tenant blob/object storage via `IBlobStorageService` / tenant bucket resolution

Repository evidence is pinned to `https://github.com/ArcaAI/project-hope.git` @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoints / handlers (representative)

| API endpoint | Controller/Gateway | Handler | Responsibility | Downstream |
|---|---|---|---|---|
| `POST /api/v1/audio/transcription-jobs/transcribe` | `TranscriptionJobController` (`apps/api/src/modules/streaming/transcription-job.controller.ts:124`) | `transcribeFile()` `:642` / `transcribeFileOnce()` `:677` | Multipart batch audio upload; validates file/MIME/size/duration; resolves owner/ASR agent; resolves tenant audio bucket; uploads audio; creates batch job; dispatches worker. | STT application services (`TranscriptionJobService` `packages/applications/src/services/stt/job/transcriptionJob.service.ts:49`, realtime/streaming services) + tenant blob storage + STT batch/worker path. |
| `POST /api/v1/audio/transcription-jobs/stream/session` | `TranscriptionJobController` | `createStreamSession()` `:932` | Creates live STT streaming session/ticket; resolves owner/ASR agent/language mode; binds session to consultation or standalone workflow run. | `StreamingSessionService` (`packages/applications/src/services/stt/streaming/streamingSession.service.ts:75`) and `SttWsGateway` (`apps/api/src/modules/streaming/stt-ws.gateway.ts:486`, `/ws/stt/stream`) to STT upstream. |
| `POST /api/v1/text-generations/generate` | `TextProxyController` (`apps/api/src/modules/streaming/text-proxy.controller.ts:331`) | `generate()` `:799` → `proxyGenerate()` `:812` → `postTextGenerate()` `:858` | Business text generation proxy. Refuses raw `provider`/`model` pinning (`MODEL_PINNING_NOT_ALLOWED`), applies agent/model selection/enrichment/policy/provider overrides, forwards to TEXT. | Text microservice (`TEXT_URL`, `getTextBaseUrl()` `:513`, `POST /api/v1/generate`). |
| `POST /api/v1/speech/synthesize` | `SpeechProxyController` (`apps/api/src/modules/speech/speech-proxy.controller.ts:89`) | `synthesize()` `:269` | Resolves TTS agent/spec (`TtsAgentResolverService` `packages/applications/src/services/agent/tts-agent-resolver.service.ts:95`), preflights monthly TTS character quota, proxies synthesis and streams audio/SSE. | TTS microservice (`TTS_URL`, `getTtsBaseUrl()` `:152`, `POST /api/v1/audio/speech`). WS duplex path: `TtsWsGateway` (`apps/api/src/modules/speech/tts-ws.gateway.ts:148`, `/ws/tts/stream`). |
| `POST /api/v1/media` / `GET /api/v1/media/:mediaId` | `MediaController` (`apps/api/src/modules/media/media.controller.ts:51`) | `upload()` `:82`, `getReference()` `:106` | Validates multipart file and MIME/category, stores tenant media, returns only metadata (`mediaId,mime,sizeBytes,sha256`); never bytes/URL/storage location. | `MediaUploadService` (`packages/applications/src/services/media-upload/media-upload.service.ts:71`) + tenant blob/object storage. |

## Example input/output (representative)

Examples are summarized from controller/DTO contracts and diagram cards; verify exact DTO schemas before client integration.

- **Transcribe upload**: input `multipart/form-data` file + `TranscribeFileRequest` fields (`consultationId?`, `agentSlug?`, `language/languageMode?`, `clinicianUserId?` for machine callers). Output `BatchTranscribeResponse` `{id,status,sseUrl,audioUri,agentSlug?,agentVersionId?,warnings?}`.
- **Stream session**: input `CreateStreamSessionRequest` (`consultationId` or `workflowSlug`, `agentSlug?`, `language/languageMode?`, `context?`). Output `StreamSessionResponse` (session/ticket metadata) plus optional `warnings`.
- **Text generate**: input `TextGenerateRequest` `{prompt, system_prompt? (deprecated), agentSlug?, temperature?, max_tokens?, top_p?, frequency_penalty?, presence_penalty?, stream?, response_format?, context?, reasoning?}`. Output: proxied TEXT response (sync JSON or streaming/task mapping depending on mode).
- **Speech synthesize**: input `SpeechSynthesizeRequest` `{input, voice?, response_format?, speed?, stream_format?, model?, agentSlug?}`; gateway injects resolved spec/overrides. Output: streamed audio/SSE; TTS metadata headers.
- **Media upload**: input `multipart/form-data` file (attachment/audio allow-list). Output `{mediaId,mime,sizeBytes,sha256}`.

## Dependencies / downstream APIs

- **apps/text** via `TEXT_URL` — text generation/proxy.
- **apps/stt** via `STT_URL` — batch transcription worker path and live WS streaming bridge.
- **apps/tts** via `TTS_URL` — synthesis (`/api/v1/audio/speech`, `/voices`) and duplex WS.
- **Tenant blob/object storage** — audio/media bytes and tenant bucket resolution.

## Validation / evidence

- Archify finalize: **pass** (`validate`, `deliver`, `check`, `browser-check`).
- Browser evidence: pass; visual review not requested.
- Advisory: route-readability recommendation reports 1 crossing/3 detours; one placement repair pass was attempted and restored per Archify guidance. Gates still pass.
- Limitations: pilot/representative node set (not all B04 endpoints), example I/O placed in cards/sublabels due to architecture node schema constraints, config-driven service URLs, some WS method-level details can be deepened in follow-up batches.

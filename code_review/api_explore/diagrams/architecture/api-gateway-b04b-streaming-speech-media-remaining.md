# API Gateway B04b — Streaming, Speech & Media (Remaining)

Companion explainer for `api-gateway-b04b-streaming-speech-media-remaining.html`.

## Scope

B04b completes the remaining B04 scope after B04a (representative pilot). It covers remaining modules/route groups:

- `storage` — 10 routes (`/storage` buckets/files/health)
- `storage-access-key` — 3 routes (`/admin/tenants/storage/keys`)
- `voice-profile` — 6 routes (`/voice-profiles`)
- Remaining `streaming` route groups: transcription job create/batch/streaming/list/stats/status/consultation/limits/language-modes/get/SSE/cancel/retry, stream-session delete/refresh/switch, admin transcription list/stats/status, text task status/cancel/stream, providers/guardrail-providers, generate/assembled (business/admin)
- Remaining `speech` route group: `GET /speech/voices` (synthesis covered in B04a)

Repository evidence is pinned to `https://github.com/ArcaAI/project-hope.git` @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups (left side)

The diagram uses **endpoint-group nodes** for readability. Route-level details and example I/O are in diagram cards.

| Group | Routes / examples | Controller(s) | Key service(s) | Downstream |
|---|---|---|---|---|
| Storage | `GET/POST /storage/buckets`, `GET/PATCH/DELETE /storage/buckets/:name`, list/upload/get/delete files, `GET /storage/health` | `StorageController` (`apps/api/src/modules/storage/storage.controller.ts:59`) | `TenantBucketService` (`packages/applications/.../tenant-bucket.service.ts:66`), `BlobStorageService` `:36`, `S3Service` `:43`, media/thumbnail services | Tenant object storage (S3/MinIO/Azure blob), presigned URLs |
| Storage access keys | `GET/POST/DELETE /admin/tenants/storage/keys*` | `StorageAccessKeyController` (`storage-access-key.controller.ts:17`) | `StorageAccessKeyService` (`storage-access-key.service.ts:29`) | Tenant admin storage-key management; API key forbidden |
| Voice profiles | `POST /voice-profiles/enroll`, `GET enrollment-target`, `GET /`, `PATCH :id/activate|deactivate`, `DELETE :id` | `VoiceProfileController` (`voice-profile.controller.ts:51`) | `VoiceProfileService` (`voiceProfile.service.ts:91`) | STT/ASR agent embedding/diarization target dependencies; JWT-only biometrics flow |
| Transcription/STT mgmt | job create/batch/streaming/list/stats/status/consultation/limits/language-modes/get, SSE stream, cancel/retry, session delete/refresh/switch; admin list/stats/status | `TranscriptionJobController` (`transcription-job.controller.ts:124`), `AdminTranscriptionJobController` (`admin-transcription-job.controller.ts:38`) | `TranscriptionJobService` `:49`, `StreamingSessionService` `:75` | STT jobs/sessions/streams (`STT_URL`) |
| Text/speech ops | `POST /text-generations/generate|generate/assembled`, `GET/POST /tasks/:taskId*`, `GET /tasks/:taskId/stream`, `GET /providers`, `GET /guardrail-providers`, admin text generate routes, `GET /speech/voices` | `TextProxyController` (`text-proxy.controller.ts:331`), `TextGenerationAdminController` (`text-generation-admin.controller.ts:37`), `SpeechProxyController.voices()` (`speech-proxy.controller.ts:470`) | Text enrichment/selection/policy services | TEXT (`TEXT_URL`), TTS (`TTS_URL`) |

## Example input/output (summary)

- **Storage upload**: input multipart file + bucket/key context; output file metadata and/or presigned download URL. Bucket ops input `{name}`/metadata; output bucket status/info.
- **Storage access key create**: input create request; output key metadata and secret shown once.
- **Voice enrollment**: input 1–3 audio files + optional `label`/`agentSlug`; output `VoiceProfileResponse`. Enrollment target/activation/deactivation/delete follow voice-profile DTOs.
- **Transcription mgmt**: inputs/outputs follow transcription job/session DTOs; SSE endpoints stream status/results; admin routes return tenant-wide views.
- **Text tasks/providers**: task status/cancel/stream proxy TEXT responses; providers/guardrail-providers return registry/routing listings. Voices returns TTS voice listing.

## Validation / evidence

- Archify finalize: **pass** (`validate`, `deliver`, `check`, `browser-check`).
- Browser evidence: pass; visual review not requested.
- Advisory: route-readability detours only (no crossings reported).
- Limitations: endpoint groups used for readability (not 1:1 endpoint boxes); example I/O summarized in cards; config-driven downstream URLs; reconcile exact route counts against inventory/catalog for strict per-endpoint coverage follow-ups.

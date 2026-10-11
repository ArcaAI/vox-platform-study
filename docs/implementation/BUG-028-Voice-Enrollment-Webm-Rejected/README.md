# BUG-028 — Voice enrollment rejects browser-recorded `audio/webm` samples

| Field | Value |
|---|---|
| Status | Review |
| Type | bugfix |
| Source | https://github.com/ArcaAI/project-hope/issues/28 |
| Reporter / date | JayaramNambiar, 2026-09-30 |
| Labels | bug, Playground |
| Severity | High for the feature (in-browser enrollment is 100% blocked) |
| Area | `apps/api` voice-profile (rule 05); console `/playground/voice-profiles` (rule 13) |
| Attachment | https://github.com/user-attachments/assets/ff613d12-ac64-468b-9d2d-e47e4b086fa6 |

## Requirement Analysis

Recording 3 samples in the browser (`recording-N.webm`, MediaRecorder default) and clicking **Enroll profile** returns 400
`Validation failed (current file type is audio/webm, expected type is /^audio\//)`. Expected: browser-recorded samples accepted, profile enrolled.

## Current State Evaluation

- `apps/api/src/modules/voice-profile/voice-profile.controller.ts:76-83` — `ParseFilePipe` with
  `new FileTypeValidator({ fileType: /^audio\// })`.
- `@nestjs/common` is **11.2.3** (`apps/api/node_modules/@nestjs/common/package.json`). Its `FileTypeValidator`
  (`pipes/file/file-type.validator.js:58-112`) validates the **magic-number-detected** type via the `file-type` package
  (`fileTypeFromBuffer`) unless `skipMagicNumbersValidation` is set, but its error message prints the client-declared `file.mimetype`.
- `file-type` identifies any WebM/Matroska (EBML) container as `video/webm` — it cannot tell audio-only WebM apart. So
  `video/webm` fails `/^audio\//` while the message shows `audio/webm`, exactly as reported. Safari's MediaRecorder `audio/mp4`
  may be detected as `video/mp4` the same way.
- Only voice-profile uses an audio-only regex; `storage.controller.ts:215` and `tenant-bucket.controller.ts:174` allow `video/` too.
- No related ticket found in `docs/implementation` / `docs/archive`; not fixed on dev-2.2 (HEAD `5cf8f736f`).

## Root Cause

Nest 11's magic-number `FileTypeValidator` reports browser-recorded WebM audio as `video/webm`, which the voice-profile route's
`/^audio\//` pattern rejects. Confidence: high.

## Implementation Plan

TDD (red first), `apps/api/src/modules/voice-profile/__tests__/`:
1. Enroll with a real minimal WebM/Opus buffer (EBML header) declared `audio/webm` → passes validation (currently 400).
2. Same for `audio/webm;codecs=opus`, `audio/ogg`, `audio/wav`, `audio/mp4` (Safari) fixtures.
3. A non-media buffer (e.g. PNG magic) declared `audio/webm` → still 400 (spoof protection kept).
4. A real video container is acceptable only per OD-1.

Change order:
1. `voice-profile.controller.ts` — replace the regex with an explicit allow-list matching detected types: `audio/*` plus the
   container types `video/webm` and `video/mp4` (or a small custom `FileValidator` that accepts detected `video/webm|video/mp4`
   only when the declared mimetype is `audio/*`). Prefer reusing `ALLOWED_AUDIO_MIMES` if it fits (`transcription-job.controller.ts:891`).
2. Keep the service-side decode (the embedding model rejects non-audio) as the second gate.
3. Console: no change needed unless the error copy should be friendlier.

Verification: `pnpm --filter @arcaai/api test -- voice-profile` (own files), `pnpm api:build`, `pnpm lint`;
live: record 3 samples in Chrome and Safari on `/playground/voice-profiles`, enroll succeeds.
If route metadata changes, regenerate per rule 05 (`api:route-manifest`, `api:openapi`, …) — a validator-only change should not.

## Risks / Open Questions (owner)

- **OD-1**: Accept `video/webm`/`video/mp4` containers for enrollment (needed for browser recordings) — acceptable given the
  downstream audio decode rejects real video without an audio track?
- Check other multipart audio routes (consultation attachments, batch transcription) for the same validator once Nest is bumped.

## Implementation Summary

Decision OD-1 (owner, 2026-10-11): a sniffed `video/webm` / `video/mp4` container is accepted only when the upload DECLARES `audio/*`; anything sniffed as `audio/*` passes whatever was declared.

- `apps/api/src/modules/voice-profile/audio-upload-type.validator.ts` (new) — `AudioUploadTypeValidator extends FileValidator`, composed of two magic-number `FileTypeValidator`s (audio-or-recorder-container, then audio) plus the declared-type check; error message "expected an audio recording; current file type is …".
- `apps/api/src/modules/voice-profile/voice-profile.controller.ts` — `enroll`'s `ParseFilePipe` uses it in place of `FileTypeValidator({ fileType: /^audio\// })`. Route metadata unchanged, so no manifest/OpenAPI/SDK regeneration.
- `.../voice-profile/__tests__/audio-upload-type.validator.test.ts` (new) — real magic bytes: reproduces the defect with the former validator; accepts Chrome WebM (`audio/webm`, `audio/webm;codecs=opus`), Safari MP4 (`audio/mp4`), WAV declared anything; refuses containers declared `video/*` and a JPEG declared `audio/webm`.

Evidence:
- RED: the new test file failed (validator absent); the defect-reproduction case shows the former validator returns false for a Chrome WebM.
- GREEN: `vitest run src/modules/voice-profile/` → 2 files, 29 tests passed.
- `pnpm api:build` exit 0; `eslint` on the validator and controller exit 0.
- Live, `POST /api/v1/voice-profiles/enroll` as tenant_admin @ Global against the running gateway: real WebM/Opus (ffmpeg from the cardiology fixture) declared `audio/webm;codecs=opus` → passes validation, reaches the service → 409 `ASR_AGENT_DIARIZATION_DISABLED`; same file declared `video/webm` → 400; JPEG declared `audio/webm` → 400.
- Not proven live: a full 201 enrollment. It needs a published STT agent with `audioFrontEnd.diarization.enabled` in the tenant (config change) and the embedding model loaded (owner approval) — the separate 409 gate above, unchanged by this fix.

## Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from GitHub issue #28 (read-only triage). |
- 2026-10-11 — Fixed (OD-1: recorder containers only when declared audio); tests, build, lint, live upload checks green. Status Review.

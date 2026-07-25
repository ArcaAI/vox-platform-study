# 02 — Voice Enrollment

| | |
|---|---|
| Reviewer | A2 |
| Parent | TASK-293 Vox SDK Deep Assessment V2 |
| Created | 2026-05-24 |
| Scope | `@arcaai/vox` `useVoiceEmbedding` ↔ API Gateway `voice-profile` ↔ STT `voice_profile`/`diarization` ↔ local `@arcaai/stt` diarizer |
| Status | Review |

---

## 1. Scope & method

This file evaluates the voice-enrollment surface end-to-end against the five business requirements supplied in the brief:

1. Doctor can enrol their voice.
2. The sample is stored to **browser local storage** AND **persisted to the backend DB** (durable across devices/sessions).
3. The voice sample must be consumed by **both** local diarization+VAD and backend diarization+VAD.
4. Enrollment is **prerequisite** for enabling on-device diarization.
5. Enrollment supports re-enrollment, deletion, and audit.

Method: full read of the SDK hook, transport, store, secure storage, and panel; full read of the backend controller, application service, repository, Prisma model, migration, and the STT Python receiver including the preseed path; cross-reference against TASK-262 GAP-02 (which TASK-265-D2 and TASK-275-B2 nominally closed). Every claim cites `file:line`.

The verdict is **non-conformant in production**. Although TASK-265-D2 fixed the 404 path mismatch and TASK-275-B2 wired the playground panel, three structural defects remain:

- new enrollments are created `isActive=false` and the SDK has **no** activation surface (so the backend preseed permanently sees "no active profile");
- the **local** diarizer has no API to consume `useVoiceEmbedding` output and uses a 40-dim MFCC clusterer that is dimensionally incompatible with the backend's 256-dim model;
- there is **no** local-storage layer, **no** enrollment gate on `diarization: true`, and the controller mutations lack ownership checks (IDOR).

---

## 2. Current architecture (end-to-end)

```
Browser (vox SDK)                         API Gateway (NestJS)                   STT (Python)            Postgres / pgvector
────────────────────                      ───────────────────────                ─────────────────          ──────────────────

useVoiceEmbedding                                                                                          core."UserVoiceProfile"
    .enroll(File|Blob[])                                                                                   ┌──────────────────┐
       │                                                                                                   │ id, userId,      │
       │   POST /voice-profile/enroll        VoiceProfileController.enroll                                 │ embedding(256d), │
       │   multipart/form-data ─────────────►   ParseFilePipe                                              │ isActive(=false),│
       │                                        │  10 MB / file, 3 files,                                  │ label, modelId,  │
       │                                        │  /^audio\//                                              │ resourceStatus,  │
       │                                        ▼                                                          │ audit fields     │
       │                                    VoiceProfileService.enroll                                     └──────────────────┘
       │                                        │
       │                                        │   POST /internal/voice-profile/extract
       │                                        │   multipart ─────────────────────────────────►  routes.extract_voice_embedding
       │                                        │                                                          │ embedding_service.extract_from_samples
       │                                        │                                                          │ ExtractionService → centroid 256d
       │                                        │   200 OK { embedding[256], model_id } ◄──────────  ExtractionResponse
       │                                        │
       │                                        ▼ Factory.CreateUserVoiceProfile({ isActive:false })
       │                                    repository.createWithEmbedding                              raw INSERT … vector(256)
       │                                        │ broadcastSysEvent(ResourceCreated)
       │   201 { id, userId, isActive:false, label, modelId, createdAt, … } ◄────────────────
       │
       │   GET /voice-profile                 VoiceProfileController.list
       │ ───────────────────────────────────►   service.listByUserId(cls.user.id)
       │   200 [{ id, isActive, … }]      ◄──── repository.findAllByUserId
       │
       │   DELETE /voice-profile/:id          VoiceProfileController.deleteById
       │ ───────────────────────────────────►   service.deleteById(id)          ← NO OWNERSHIP CHECK
       │
       ▲
   no SecureStorage write, no IndexedDB, no Zustand subscription, no SimpleCrossTabSync event


Local pipeline (uses NOTHING of the above)
─────────────────────────────────────────
useSTT → STTProcessor → LocalSTTProvider.init({ diarization, numSpeakers })
                          ↓
                       LocalSpeakerDiarizer (in-session, 40-dim MFCC centroids,
                                             builds profiles ad-hoc from first speech segments
                                             — no path to load useVoiceEmbedding result)


Backend pipeline (uses ONLY the DB row, NEVER the SDK)
──────────────────────────────────────────────────────
SDK POST /audio/transcription-jobs/stream/session
       │ JWT ⟶ CLS user.id
       │ NO voiceProfileId in CreateStreamSessionRequest
       ▼
TranscriptionJobController.createStreamSession (transcription-job.controller.ts:246)
       │ user_id ← cls.get('user').id
       ▼
StreamingSessionService.createSession({ userId, … })  (streamingSession.service.ts:78)
       │ user_id
       ▼ POST /internal/streaming/sessions
session_manager.create_session(user_id=…)            (session_manager.py:241)
       │
       ▼ preseed_speaker(tracker, consultation_id, user_id=…)   (preseed.py:17)
       │     get_voice_embedding(user_id)
       │       WHERE "userId" = :user_id
       │       AND   "isActive" = true               ← NEVER TRUE post-enroll
       │       AND   "resourceStatus" = 'ENABLED'
       │     → returns None  →  log "No active voice profile, skipping pre-seed"
       │
       ▼ SpeakerTracker starts with ZERO pre-registered speakers
         diarization output: "Speaker 1", "Speaker 2" — never the doctor's name
```

The diagram makes plain that the wire-up between SDK and backend is correct in **shape** (path, multipart, auth, user_id forwarding, preseed lookup), but **functionally broken** because no profile ever becomes active.

---

## 3. Public surface map

| SDK hook action | HTTP verb + path | Backend method | Storage | Status |
|---|---|---|---|---|
| `useVoiceEmbedding.enroll(files)` | `POST /voice-profile/enroll` (multipart, ≤3 files, 10 MB ea., `audio/*`) | `VoiceProfileController.enroll` → `VoiceProfileService.enroll` → STT `/internal/voice-profile/extract` → `repository.createWithEmbedding` | pgvector(256) row, **`isActive:false`** by default | Aligned |
| `useVoiceEmbedding.list()` | `GET /voice-profile` | `VoiceProfileController.list` → `service.listByUserId(cls.user.id)` | Reads `findAllByUserId` | Aligned |
| `useVoiceEmbedding.delete(profileId)` | `DELETE /voice-profile/:id` | `VoiceProfileController.deleteById` → `service.deleteById` (soft) | `resourceStatus='DELETED'` | Aligned but **no ownership check** |
| **— (missing)** | `PATCH /voice-profile/:id/activate` | `VoiceProfileController.activate` (`voice-profile.controller.ts:87`) | Sets `isActive=true`, deactivates all others for the user | Backend exists, **SDK does NOT expose** |
| **— (missing)** | `PATCH /voice-profile/:id/deactivate` | `VoiceProfileController.deactivate` (L96) | Sets `isActive=false` | Backend exists, **SDK does NOT expose** |
| `useVoiceEmbedding.profiles` (state) | n/a | n/a | In-memory React state; **no SecureStorage**, **no IndexedDB**, **no Zustand store**, **no SimpleCrossTabSync** | Reqt 2 not met (local) |
| Local diarizer profile load | n/a | n/a | **No code path** (`LocalSpeakerDiarizer` has no `loadProfile` method) | Reqt 3 not met |
| Backend diarizer profile load | n/a | `preseed_speaker(user_id=…)` → `get_voice_embedding` → `tracker.register` | DB row | Wire-up correct; **functionally inert** because of P0-1 |
| Enrollment prerequisite gate | n/a | n/a | None | Reqt 4 not met |
| Audit on enroll/delete | n/a | `broadcastSysEvent(ResourceCreated/Deleted)` | SysEvent bus | Reqt 5 partially met (no per-mutation IP/audit-PHI redaction enforced) |

`VOICE_EMBEDDING_ENDPOINTS` is declared at `packages/agentic-sdk-v2/src/core/constants.ts:595` with only `enroll | list | delete` keys.

---

## 4. Strengths

1. **Path/multipart alignment is correct** post TASK-265-D2. `useVoiceEmbedding.enroll` calls `apiClient.postFormData()` (`packages/agentic-sdk-v2/src/hooks/useVoiceEmbedding.ts:59`), which omits Content-Type and lets the browser set the multipart boundary (`AgenticClient.postFormData`, `packages/agentic-sdk-v2/src/core/AgenticClient.ts:393`). The controller uses `FilesInterceptor('files', 3)` with `ParseFilePipe` enforcing `MaxFileSizeValidator({ maxSize: 10 MB })` and `FileTypeValidator({ fileType: /^audio\// })` (`apps/api/src/modules/voice-profile/voice-profile.controller.ts:50-58`). The SDK's FormData key is `'files'` and the controller's interceptor field name matches.
2. **Raw audio is not persisted.** The application service streams the buffers to STT via `multipart/form-data` and only stores the 256-dim embedding plus metadata (`packages/applications/src/services/user/voiceProfile/voiceProfile.service.ts:105-124`). The Python receiver does not write the audio to disk (`apps/stt/src/stt/voice_profile/api/routes.py:33-91`). This is the right HIPAA posture for the raw biometric input.
3. **User identity is derived server-side from CLS, not client-supplied.** The controller uses `this.cls.get('user').id` (`voice-profile.controller.ts:38`), and the streaming session controller forwards `user_id` to STT from CLS, not from the SDK (`apps/api/src/modules/streaming/transcription-job.controller.ts:268`). The SDK cannot enrol on behalf of another user.
4. **Backend preseed wiring is implemented.** `preseed_speaker` (`apps/stt/src/stt/diarization/preseed.py:17`) is invoked by both the streaming session manager (`apps/stt/src/stt/streaming/session_manager.py:409-415`) and the batch transcription service (`apps/stt/src/stt/transcription/batch_service.py:280-285`). When a profile *is* active, both pipelines pre-register the speaker on the `SpeakerTracker` with the doctor's display name (`preseed.py:99-107`). The architecture for reqt 3 (backend side) is correct.
5. **Audit-event broadcast on every mutation.** `VoiceProfileService.enroll/activate/deactivate/deleteById` all emit `broadcastSysEvent(SysEventType.*)` (`voiceProfile.service.ts:58, 77, 88, 97`). Provides a tap point for downstream audit storage.
6. **Embedding-only entity boundary.** `UserVoiceProfileEntity` (`packages/domains/src/entities/generated/core/UserVoiceProfileEntity.ts:14`) holds only `userId`, `isActive`, `label`, `modelId`. The 256-d vector lives in pgvector and is never round-tripped to the HTTP layer or audit log, limiting biometric exposure on the wire.
7. **Per-user partial-unique constraint on active profile.** Migration `20260413000000_add_user_voice_profile/migration.sql:40-42` enforces "only 1 active per user", so the activate path cannot create a forked active state.
8. **Embedding numeric validation.** `repository.createWithEmbedding` rejects non-finite floats before constructing the vector string (`packages/domains/src/repositories/generated/core/UserVoiceProfileRepository.ts:65-67`), reducing the SQL-injection-via-`$3::vector` risk.

---

## 5. Defects

### 5.1 Critical (P0 — must block release)

#### C-1 — Enrolled profile is created `isActive=false` and there is no SDK path to activate it

- `VoiceProfileService.enroll` (`packages/applications/src/services/user/voiceProfile/voiceProfile.service.ts:45-51`) calls `UserVoiceProfileFactory.CreateUserVoiceProfile({ ..., isActive: false })`. The new row's `isActive` is `false`.
- `VOICE_EMBEDDING_ENDPOINTS` (`packages/agentic-sdk-v2/src/core/constants.ts:595-599`) contains only `{ enroll, list, delete }`. There is no `activate` constant and no `useVoiceEmbedding.activate(profileId)` method (`packages/agentic-sdk-v2/src/hooks/useVoiceEmbedding.ts:30-38`).
- Backend `get_voice_embedding(user_id)` selects `WHERE "isActive" = true AND "resourceStatus" = 'ENABLED'` (`apps/stt/src/stt/core/database/voice_profile_model.py:48-51`). It will return `None` for every newly enrolled profile.
- Result: `preseed_speaker` logs "No active voice profile for user … skipping pre-seed" (`apps/stt/src/stt/diarization/preseed.py:82-89`) and proceeds without pre-registering the doctor. The doctor sees generic `Speaker 1` / `Speaker 2` labels even though they enrolled.

**Impact**: requirement #3 (backend consumption) is wired but **functionally non-conformant**. The user-visible value of enrollment is zero.

**Patch (smallest viable):** auto-activate the freshly enrolled row when the user has no other active profile, OR expose `activate` in the SDK and call it from the playground/host app immediately after `enroll`. Preferred: do both (server-side auto-activate on first enrollment + SDK surface for re-selection).

```ts
// packages/applications/src/services/user/voiceProfile/voiceProfile.service.ts
async enroll(request: EnrollVoiceProfileRequest): Promise<UserVoiceProfileEntity> {
  const extraction = await this.extractEmbeddings(request.audioBuffers);
  const entity = UserVoiceProfileFactory.CreateUserVoiceProfile({
    userId: request.userId,
    isActive: false,
    label: request.label,
    modelId: extraction.model_id,
    createdBy: this.requestUser?.id,
  });
  const created = await this.voiceProfileRepository.createWithEmbedding(entity, extraction.embedding);
  if (!created) throw new InternalServerErrorException('Failed to create voice profile');
+ // Auto-activate iff user has no other active profile yet.
+ const existingActive = await this.voiceProfileRepository.findActiveByUserId(request.userId);
+ if (!existingActive) {
+   await this.voiceProfileRepository.activateById(created.id);
+ }
  this.broadcastSysEvent(SysEventType.ResourceCreated, { ... });
  return created;
}
```

#### C-2 — `LocalSpeakerDiarizer` cannot consume the enrolled voice profile (requirement #3, local side)

- The local diarizer is an in-session 40-dim MFCC/spectral clusterer that builds profiles ad-hoc as speech segments arrive (`packages/stt/src/providers/LocalSpeakerDiarizer.ts:38-149`). It has no `loadProfile`, `seedFromEmbedding`, or any constructor parameter to pre-seed a centroid.
- `LocalSTTProvider.init` instantiates it with only `{ enabled, maxSpeakers }` and never reads from `useVoiceEmbedding` (`packages/stt/src/providers/LocalSTTProvider.ts:116-119`).
- `LocalProviderConfig` (`packages/stt/src/types/index.ts:766-793`) has no `voiceProfile` / `speakerEmbedding` / `voiceProfileId` field.
- Even if it did, the backend embedding is **256-dim PyAnnote/SpeechBrain** while the local features are **40-dim MFCC + spectral + pitch**. The cosine similarity at `LocalSpeakerDiarizer.cosineSimilarity` (L531) operates on `Math.min(a.length, b.length)` which would silently produce garbage similarities across dimensions.

**Impact**: requirement #3 (local consumption) is **NOT MET at any layer** — model, API, or wiring.

**Patch (minimum viable):** ship one of the following, in order of effort:

- **Short term (S):** add an opaque server-issued "doctor pre-seed" string to `LocalProviderConfig` that the local diarizer treats as "speaker 1 is reserved for the doctor". The diarizer can pin the first speech segment's profile to that ID rather than auto-numbering. Solves the labelling half of the requirement without sharing the embedding.
- **Medium term (M):** ship a tiny browser-side MFCC re-extraction in `useVoiceEmbedding.enroll` so the SDK simultaneously POSTs the file to the backend AND computes a 40-dim local feature vector that gets cached and passed to `LocalSpeakerDiarizer` via a new `preseededProfiles: { id: string; features: number[] }[]` constructor option.
- **Long term (L):** unify on a single ONNX speaker-embedding model (e.g., 256-d WeSpeaker or X-vector) that runs both in the browser worker and in STT. This is the only way to satisfy reqt 3 with byte-for-byte fidelity.

#### C-3 — IDOR on `DELETE /voice-profile/:id`, `PATCH :id/activate`, `PATCH :id/deactivate`

- `VoiceProfileController.deleteById`/`activate`/`deactivate` (`apps/api/src/modules/voice-profile/voice-profile.controller.ts:91-112`) accept `:id` and pass it straight to `voiceProfileService.deleteById(id)` / `activate(id)` / `deactivate(id)`.
- The service implementations (`packages/applications/src/services/user/voiceProfile/voiceProfile.service.ts:71-102`) likewise do not verify `entity.userId === this.requestUser?.id`.
- `@Authorize()` is invoked with **no permission tuple**, so `UnifiedAuthGuard` only checks authentication, not authorization (`packages/applications/src/authorization/decorators.ts:53-65`).
- Voice profile IDs are UUIDv7 (`packages/database/src/prisma/db_main/user.prisma:224`) which makes brute force expensive, but any user who learns or guesses another user's profile id (e.g. via an admin debug surface, leaked audit log, or shared screen) can permanently delete or hijack-activate it. Biometric PHI mutation by unauthorized actor.

**Impact**: PHI integrity violation; HIPAA-relevant. Defence-in-depth for biometric data requires ownership enforcement at the service layer regardless of frontend behaviour.

**Patch:**

```ts
// voiceProfile.service.ts
private async assertOwnership(profileId: EntityId): Promise<UserVoiceProfileEntity> {
  const profile = await this.voiceProfileRepository.findById(profileId);
  if (profile.userId !== this.requestUser?.id) {
    throw new ForbiddenException('Voice profile does not belong to current user');
  }
  return profile;
}
async deleteById(profileId: EntityId) {
  await this.assertOwnership(profileId);
  const deleted = await this.voiceProfileRepository.softDelete(profileId);
  …
}
async activate(profileId: EntityId) {
  const profile = await this.assertOwnership(profileId);
  await this.voiceProfileRepository.deactivateAllForUser(profile.userId);
  await this.voiceProfileRepository.activateById(profileId);
  …
}
```

(Admin override should go through a separate `@Authorize(['manage', 'UserVoiceProfile'])` controller surface.)

#### C-4 — No enrollment-prerequisite gate (requirement #4)

- `LocalProviderConfig.diarization` is honoured unconditionally; `LocalSTTProvider.init` constructs `LocalSpeakerDiarizer({ enabled: config.diarization, … })` without any check for an enrolled profile (`packages/stt/src/providers/LocalSTTProvider.ts:116-119`).
- `useArca`/`useSTT`/`useArcaSession` do not call `useVoiceEmbedding.list()` before enabling diarization. There is no `requiresEnrollment` flag anywhere in the SDK.
- The backend `preseed_speaker` is silent on missing profile — it logs at WARN and proceeds (`preseed.py:82-89`). The SDK has no way of knowing diarization is running un-personalized.

**Impact**: requirement #4 (gating) is **NOT MET**. Users who toggle `diarization: true` without enrolling get the worst of both worlds: degraded transcription accuracy from un-seeded clustering and zero personalization benefit, with no UI feedback explaining why.

**Patch:** add a typed gating helper and wire it through `STTProcessor`:

```ts
// packages/agentic-sdk-v2/src/hooks/useVoiceEnrollmentStatus.ts (new)
export function useVoiceEnrollmentStatus() {
  const { profiles, list, isLoading } = useVoiceEmbedding();
  useEffect(() => { void list(); }, [list]);
  const hasActive = profiles.some((p) => p.isActive === true);
  return { hasActive, isLoading, profiles };
}
// In STTProcessor / useSTT, before starting with diarization=true:
if (features.diarization && !(await voiceEnrollmentChecker())) {
  throw new AgenticError('ENROLLMENT_REQUIRED', 'Enrol your voice before enabling diarization');
}
```

Also surface a server-side echo in the streaming-session response (`StreamSessionResponse` at `apps/api/src/modules/streaming/dto/transcription-job.dto.ts:61`): include `voiceProfileSeeded: boolean` so the client UI can show a banner when diarization is running without personalization.

### 5.2 High (P1)

#### H-1 — Zero local storage of voice-profile state (requirement #2, local side)

- `useVoiceEmbedding` holds `profiles` purely in component state (`packages/agentic-sdk-v2/src/hooks/useVoiceEmbedding.ts:42-43`).
- `SecureStorage` exists (`packages/agentic-sdk-v2/src/utils/secureStorage.ts`) but is wired only for preferences ([grep result above]); it never persists voice-profile metadata.
- `agenticStore` has no voice-related field.
- Multiple consumer components (e.g. the audio panel and the dedicated voice-profile page) each maintain their own `profiles` state and each fire their own `list()` on mount.

**Impact**: requirement #2 ("stored to browser local storage AND persisted to the backend") is **partially met** (backend only). N tabs / N components × N redundant `GET /voice-profile` calls. Offline-aware UX impossible.

**Patch:** lift `voiceProfiles: VoiceProfile[]` + `voiceProfilesLoadedAt: number | null` into `agenticStore` slice and persist via `SecureStorage` keyed by `vox.voiceProfiles.${userId}.${tenantId}`. On hook mount, hydrate from `SecureStorage` first, then revalidate via `list()` ("stale-while-revalidate").

#### H-2 — No cross-tab broadcast on enroll/activate/delete (requirement #5 + UX)

- `SimpleCrossTabSync` (used by the SDK post-TASK-280) is not subscribed to voice-profile events.
- After enrolling/deleting in tab A, tab B still shows its stale `profiles` until manual refresh.

**Patch:** publish a `voiceProfileChanged` message (with HMAC per TASK-280) and invalidate local cache + refetch in subscriber tabs.

#### H-3 — `useVoiceEmbedding.enroll` discards the `label` parameter

- The hook signature is `enroll(files: EnrollFiles): Promise<VoiceProfile>` (`useVoiceEmbedding.ts:35`). There is no way to pass a label.
- The controller, however, accepts `EnrollBodyDto.label?` (`apps/api/src/modules/voice-profile/dto/enroll-body.dto.ts:4-10`).
- Result: every profile is stored with `label: null`, and the panel falls back to `\`Profile ${profile.id}\`` (`apps/ui-playground/src/features/audio/components/voice-embedding-panel.tsx:142`). The "doctor's display name" pretty-rendering on the diarizer is unaffected (it pulls from `UserProfile`), but the SDK contract is misaligned with the API.

**Patch:** extend the SDK signature.

```ts
export type EnrollOptions = { label?: string };
enroll: (files: EnrollFiles, opts?: EnrollOptions) => Promise<VoiceProfile>;
// then formData.append('label', opts.label) when present
```

#### H-4 — `AgenticClient.postFormData` does not call `checkRateLimit()`

- Compare `uploadFormData` (`packages/agentic-sdk-v2/src/core/AgenticClient.ts:521`) which calls `this.checkRateLimit()` first, with `postFormData` (L393-501) which does not.
- An automated/looped enrollment can hammer `/voice-profile/enroll` without tripping the SDK's RL. Server-side throttling exists, but the SDK-side guard is missing exclusively for the multipart path.

**Patch:** add `this.checkRateLimit();` as the first line of `postFormData`.

#### H-5 — No upload progress / cancellation reporting from `enroll`

- `postFormData` uses `fetch()` with no `onProgress` reporting and no AbortController exposed to the caller (`AgenticClient.ts:393-501`). The SDK has `uploadFormData` (XHR) which supports both but `useVoiceEmbedding.enroll` does not use it.
- For 10 MB × 3 files on a clinic network, the UX is "spinner for ~60 s" with no feedback. Slow networks may also timeout silently at the client-wide timeout.

**Patch:** route `enroll` through `apiClient.uploadFormData` and add `onProgress?: (pct: number) => void` and `signal?: AbortSignal` to the hook signature. Set `timeout: 0` for the upload (XHR `progress` events keep the connection healthy).

#### H-6 — Raw audio buffers not zeroized after extraction

- `VoiceProfileService.enroll` keeps `request.audioBuffers` alive until the function returns (via `formData.append(...)` references; Node's `Buffer.from(uint8)` does not transfer ownership). Although the buffers are never persisted to disk in this service, biometric raw PHI lingers in V8 heap until GC.
- Best-effort wipe: `request.audioBuffers.forEach((b) => b.fill(0))` after `extractEmbeddings` returns successfully.

#### H-7 — `EnrollFiles` accepts `Blob` whose `type` may not satisfy server validator

- The SDK accepts `Blob` (`useVoiceEmbedding.ts:28`). A `Blob` constructed without `type` (or with `type: ''`) will be uploaded with `Content-Type: application/octet-stream` per the spec. The server's `FileTypeValidator({ fileType: /^audio\// })` will reject it as 400 "Validation failed (expected type is …)".
- The SDK has no client-side precheck or normalization (e.g., wrapping into `new Blob([b], { type: 'audio/wav' })` if the source type is empty).

**Patch:** client-side guard with friendly error before POST:

```ts
for (const f of fileList) {
  const t = (f as File).type ?? '';
  if (!t.startsWith('audio/')) {
    throw new AgenticError('VALIDATION_ERROR', 'Voice sample must be an audio file', …);
  }
}
```

#### H-8 — No inter-sample consistency check

- `ExtractionService` computes a centroid of the three embeddings (`apps/stt/src/stt/voice_profile/extraction_service.py:61-64`) but does not check that the three samples actually came from the same speaker. There is no minimum cosine-similarity threshold across the samples.
- A doctor could enrol their voice as one sample plus two samples of a colleague's voice; the centroid is a noisy average and downstream diarization labels both speakers as "the doctor".
- Could also be a vector for malicious impersonation if the device is shared.

**Patch:** in `ExtractionService.extract`, when `len(samples) > 1`, compute pairwise cosine similarities; reject the enrollment if `min(pairwise_sim) < 0.6` (tuneable per model). Return HTTP 400 with a structured error.

### 5.3 Medium (P2)

#### M-1 — `extractEmbeddings` HTTP call has 60 s timeout but no retry

- `voiceProfile.service.ts:118` sets `timeout: 60000` but no retry on transient 5xx. Buffers are already consumed from the multipart stream by then, so a 502/503 from STT → unrecoverable from the user's perspective.

**Patch:** wrap with `retry({ count: 2, delay: 1000 })` from rxjs OR explicit try/catch + 1 retry.

#### M-2 — `audit.data: created.toObject()` may leak biometric fields if entity grows

- `voiceProfile.service.ts:60-62` and `:99` broadcast `data: created.toObject()`. Currently the entity does not include the embedding (only metadata), but a future refactor that adds `embedding` to the entity would silently leak biometric PHI into every SysEvent consumer (loki/highlight/postgres SysEvent table).

**Patch:** project an allowlist before broadcasting:

```ts
this.broadcastSysEvent(SysEventType.ResourceCreated, {
  resourceId: created.id,
  createdAt: created.createdAt,
- data: created.toObject() as object,
+ data: { id: created.id, userId: created.userId, isActive: created.isActive, label: created.label, modelId: created.modelId },
});
```

#### M-3 — No retention policy / right-to-erasure path

- Soft-deleted rows (`resourceStatus='DELETED'`) remain indefinitely (`packages/database/src/prisma/db_main/migrations/20260413000000_add_user_voice_profile/migration.sql`). No scheduled hard-purge.
- HIPAA / GDPR right-to-erasure compliance requires an explicit hard-delete path for biometric data. The current `delete` is a soft-delete that preserves the embedding indefinitely.

**Patch:** schedule a daily worker that hard-deletes `UserVoiceProfile` rows with `resourceStatus='DELETED'` AND `resourceStatusUpdatedAt < NOW() - INTERVAL '30 days'`. Document the retention policy in the developer guide.

#### M-4 — `UserVoiceProfileRepository.activateById/deactivateAllForUser` bypass change-tracking

- `activateById` and `deactivateAllForUser` use `(this as any).db.update(…)` / `updateMany(…)` directly (`packages/domains/src/repositories/generated/core/UserVoiceProfileRepository.ts:40-62`). They do not go through the entity's change tracker or domain-event emission. The audit trail for activation transitions exists only via the service's `broadcastSysEvent` and not via the entity event pipeline.
- A subtle consequence: `updatedBy` is not stamped (only `updatedAt`).

**Patch:** route through `repository.update(id, { isActive: true })` after `entity.isActive = true` so the BaseEntity change-set captures the actor.

#### M-5 — Vector value built via string concat for `$3::vector`

- `createWithEmbedding` constructs `vectorStr = \`[${embedding.join(',')}]\`` and binds it as a string with `::vector` cast (`UserVoiceProfileRepository.ts:68-78`).
- Input is validated as finite numbers, so injection is not currently possible. But the architectural pattern bypasses pgvector's native parameter binding (which Prisma 7 does not yet support cleanly). Future contributors adding a code path that omits validation would create a SQL injection sink.

**Patch:** add a unit test that asserts non-finite or non-numeric values throw before reaching the SQL, and add a TODO referencing the upstream Prisma issue for native vector binding.

#### M-6 — No `tenantId` column on `UserVoiceProfile`

- The model omits the standard `tenantId` field (`packages/database/src/prisma/db_main/user.prisma:220-251`). Cross-tenant isolation depends on `userId → tenantId` join through `User`.
- The `preseed_speaker` Python helper accepts `tenant_id` (`preseed.py:21, 41`) but `get_voice_embedding` does NOT filter by tenant (`voice_profile_model.py:36-67`). If a user existed in multiple tenants (e.g. service account, future feature) the active profile of the wrong tenant could leak across.

**Patch:** add `tenantId String` to the model, backfill from `User.UserRoleAssignment[0].tenantId`, and add `AND "tenantId" = :tenant_id` to `get_voice_embedding`.

#### M-7 — `useVoiceEmbedding` per-hook state means N components → N `list()` calls

- Each `useVoiceEmbedding()` invocation gets its own `useState<VoiceProfile[]>([])`. If three components in a tab use it (audio panel + voice-profile page + a session badge), each one fires `list()` on mount.

**Patch:** lift state into the agentic store (see H-1). Hooks become thin selectors.

#### M-8 — Backend `preseed_speaker` swallows all exceptions silently

- `try: … except Exception: logger.warning(…)` (`apps/stt/src/stt/diarization/preseed.py:114-120`). DB connectivity issues / SQL errors degrade silently to "no preseed". The streaming session continues without informing the API gateway or the SDK.

**Patch:** at minimum emit a structured metric (`voice_profile.preseed.failed{reason}`) and a `status` field in the session response so the SDK can warn the user that diarization is running unpersonalized.

### 5.4 Low (P3)

#### L-1 — `activate`/`deactivate` endpoints have no SDK constants

- The backend exposes `PATCH /voice-profile/:id/activate` and `PATCH /voice-profile/:id/deactivate` (`voice-profile.controller.ts:87-103`) but `VOICE_EMBEDDING_ENDPOINTS` does not list them. Dead surface from the SDK's POV (until C-1 is resolved).

#### L-2 — `ON DELETE CASCADE` from `User` removes biometric history

- `UserVoiceProfile.userId` has `onDelete: Cascade` (`user.prisma:245`). A hard-delete of the user (rare but possible) nukes the audit-relevant biometric history without a tombstone.

**Patch:** consider `onDelete: SetNull` plus a scheduled purge to allow audit reconstruction.

#### L-3 — No model-version compatibility check on consumption

- `modelId` is persisted on enrollment (`UserVoiceProfile.modelId`, `migration.sql:14`) but `get_voice_embedding` does not return it (`voice_profile_model.py:36-67`); `preseed_speaker` does not check that the live `embedding_service` model id matches the stored one. If STT is upgraded to a new embedding model, old 256-d vectors are used silently with degraded accuracy.

**Patch:** return `modelId` from `get_voice_embedding` and skip preseed when it differs from the current `embedding_service._hf_model_id`; emit a `voice_profile.stale_model` metric and force re-enrollment.

#### L-4 — `EnrollBodyDto.label` `MaxLength(100)` while DB column is `VARCHAR(100)` — same bound, but no enforced normalization

- A label of exactly 100 chars passes validation but cannot be subsequently appended-to without violating the DB constraint. Minor UX trap.

#### L-5 — No `useEffect`-level guard against re-firing `list()` on render

- The playground panel calls `void list();` inside a `useEffect(..., [list])` and `list` is a `useCallback` keyed on `[execute]` (`useVoiceEmbedding.ts:69-78`). `execute` is allocated inside `useApiOperation` which may re-issue when `apiClient` re-renders. Cheap enough today, but a per-render `list()` call in a high-churn tree would not be noticed.

---

## 6. Security findings (biometric PHI specifically)

| ID | Finding | Severity | Source |
|---|---|---|---|
| SEC-V-1 | IDOR — `DELETE /voice-profile/:id`, `PATCH :id/activate`, `PATCH :id/deactivate` have no ownership check | Critical | `voice-profile.controller.ts:91-112`, service `:71-102` |
| SEC-V-2 | No tenant scoping on `get_voice_embedding` | High | `apps/stt/src/stt/core/database/voice_profile_model.py:36-67` |
| SEC-V-3 | Audit-event payload includes full entity via `toObject()` — risk grows as entity grows | Medium | `voiceProfile.service.ts:60-62, 97-99` |
| SEC-V-4 | No retention TTL; soft-deleted biometric data lives forever in the table | Medium | `migration.sql` |
| SEC-V-5 | Raw audio buffer not zeroized after extraction in the application service | Medium | `voiceProfile.service.ts:105-124` |
| SEC-V-6 | No client-side or server-side speaker-consistency check across samples (impersonation vector) | Medium | `apps/stt/src/stt/voice_profile/extraction_service.py:51-64` |
| SEC-V-7 | `@Authorize()` invoked without permission tuple — only authentication is enforced, not subject-level authorization | High (root cause of SEC-V-1) | `packages/applications/src/authorization/decorators.ts:53-65` |
| SEC-V-8 | Voice samples uploaded over the same transport as everything else — no separate stricter TLS / circuit policy for biometric uploads | Low | observation, no explicit fix needed if API TLS posture is correct |
| SEC-V-9 | No SDK-side "data-minimization" — file is sent in full to the backend even though only the embedding is retained. A future on-device extractor would let the backend never see raw biometric audio (data-minimization principle, HIPAA & GDPR favoured) | Low | architecture |

---

## 7. Performance findings

| ID | Finding | Source |
|---|---|---|
| PERF-V-1 | `enroll` uses `fetch` without progress reporting; UX freeze on slow networks for 10 MB × 3 files | `AgenticClient.postFormData` (`AgenticClient.ts:440`) |
| PERF-V-2 | Each consumer of `useVoiceEmbedding` fires its own `list()` on mount | M-7 above |
| PERF-V-3 | No client-side `SecureStorage` cache → every tab / page nav refetches | H-1 above |
| PERF-V-4 | STT `/internal/voice-profile/extract` re-runs the embedding model on every sample even when several samples are identical (no dedup hash) | `extraction_service.py:51-56` |
| PERF-V-5 | The application service builds FormData on every call rather than streaming the request body to STT; for 30 MB of audio this materializes another 30 MB copy in Node | `voiceProfile.service.ts:106-110` |
| PERF-V-6 | `postFormData` does not call `checkRateLimit()` (also a security finding, H-4) | `AgenticClient.ts:393` |

---

## 8. Test coverage gaps

| ID | Gap | Where it should live |
|---|---|---|
| TST-V-1 | No test that `enroll` → `list` → backend `preseed_speaker` flow yields an active profile end-to-end | `apps/api/tests/e2e` + Python contract test |
| TST-V-2 | No test for IDOR — cross-user delete/activate | `apps/api/src/modules/voice-profile/__tests__/voice-profile.controller.test.ts` (expand) |
| TST-V-3 | No test that `LocalSTTProvider` does **not** silently start an un-personalized diarizer when no profile exists (after the gate lands) | `packages/stt/src/providers/__tests__/LocalSTTProvider.test.ts` |
| TST-V-4 | No test that re-enrollment in tab A invalidates tab B's `profiles` cache | `packages/agentic-sdk-v2/src/sync/__tests__` |
| TST-V-5 | No test for `enroll(label)` propagation (currently the SDK can't even send it) | `useVoiceEmbedding.test.ts` |
| TST-V-6 | No test that the backend rejects non-audio Blobs / `application/octet-stream` | `voice-profile.controller.test.ts` |
| TST-V-7 | No test for "samples are not the same speaker" rejection (SEC-V-6) | `apps/stt/tests/unit/voice_profile/test_extraction_service.py` |
| TST-V-8 | No test for `get_voice_embedding` tenant scoping (after M-6 lands) | `apps/stt/tests/unit/voice_profile/` |
| TST-V-9 | No Playwright test for "enrol → start streaming consultation → transcript labels show doctor's name" | `apps/ui-playground/tests` or `tests/` |
| TST-V-10 | No test that the `EnrollBodyDto.label` MaxLength is enforced (boundary 100 / 101) | `voice-profile.controller.test.ts` |

The existing `useVoiceEmbedding.test.ts` (`packages/agentic-sdk-v2/src/hooks/__tests__/useVoiceEmbedding.test.ts`) is a thorough lock-in of the path/multipart contract but is purely a unit test against a mocked client — it cannot catch any of the structural gaps in §5.

---

## 9. Conformance to the business requirement

### 9.1 Local storage + backend persistence — **PARTIAL**

- Backend persistence: **MET**. The 256-d embedding plus metadata are stored in `core."UserVoiceProfile"` via `repository.createWithEmbedding` (`UserVoiceProfileRepository.ts:64-89`). Survives device/session/tab restart.
- Local storage: **NOT MET**. `useVoiceEmbedding` does not write to `localStorage`, `IndexedDB`, or `SecureStorage`. The hook holds `profiles` only in React state (`useVoiceEmbedding.ts:42`); every tab refetches independently. There is no offline-cache or pre-cache path for the local diarizer.

### 9.2 Consumed by local diarizer — **NOT MET**

- `LocalSpeakerDiarizer` has no `loadProfile` API (`packages/stt/src/providers/LocalSpeakerDiarizer.ts`), `LocalProviderConfig` has no `voiceProfile` field (`packages/stt/src/types/index.ts:766-793`), and there is no code path that reads `useVoiceEmbedding.profiles` and feeds it into the diarizer (`packages/stt/src/providers/LocalSTTProvider.ts:116-119`).
- Models are dimensionally incompatible anyway (40-d MFCC vs 256-d PyAnnote/SpeechBrain).
- See C-2.

### 9.3 Consumed by backend diarizer — **WIRED BUT FUNCTIONALLY INERT**

- Wire-up is correct: API GW forwards `user_id` from JWT/CLS → STT `create_session(user_id)` → `preseed_speaker(user_id)` → `get_voice_embedding(user_id)` → `tracker.register(embedding, speaker_id=display_name)` (`apps/api/src/modules/streaming/transcription-job.controller.ts:268`, `packages/applications/src/services/stt/streaming/streamingSession.service.ts:78`, `apps/stt/src/stt/streaming/session_manager.py:409-415`, `apps/stt/src/stt/diarization/preseed.py:81-107`).
- **BUT**: `get_voice_embedding` filters `WHERE "isActive" = true`, and enrolled rows are always `isActive=false`, and the SDK has no activate surface. So `preseed_speaker` always logs "No active voice profile … skipping pre-seed" and proceeds without the doctor pre-registered. See C-1.

### 9.4 Gated as prerequisite for on-device diarization — **NOT MET**

- `LocalProviderConfig.diarization: true` is honoured unconditionally (`LocalSTTProvider.ts:116-119`). No `useVoiceEmbedding.list()` precheck. No `AgenticError('ENROLLMENT_REQUIRED', …)` anywhere in the codebase. The user can silently enable on-device diarization without ever enrolling. See C-4.

---

## 10. Recommended fixes (P0/P1/P2)

### P0 (must ship before any "voice enrollment" claim in product copy)

| # | Action | File(s) | Effort |
|---|---|---|---|
| P0-1 | Auto-activate first enrolled profile if user has none active yet | `packages/applications/src/services/user/voiceProfile/voiceProfile.service.ts` | S |
| P0-2 | Add SDK `activate(profileId)` and `deactivate(profileId)` to `useVoiceEmbedding` + `VOICE_EMBEDDING_ENDPOINTS` | `packages/agentic-sdk-v2/src/hooks/useVoiceEmbedding.ts`, `core/constants.ts` | S |
| P0-3 | Add `assertOwnership()` in `VoiceProfileService` for `activate/deactivate/deleteById` (close IDOR) | `voiceProfile.service.ts` | S |
| P0-4 | Add `LocalProviderConfig.voiceProfile?: { id: string; reservedSpeakerId: string }` and have `LocalSpeakerDiarizer` accept a "doctor pre-seed" slot that pins speaker-1 to the enrolled user. (Workaround for embedding-model incompatibility; closes reqt 3 functionally if not perfectly.) | `packages/stt/src/types/index.ts`, `LocalSpeakerDiarizer.ts`, `LocalSTTProvider.ts` | M |
| P0-5 | Add enrollment-prerequisite gate in `STTProcessor`/`useSTT` when `diarization: true`. Throw `AgenticError('ENROLLMENT_REQUIRED', …)` if `useVoiceEmbedding.list()` shows no active profile. | `packages/stt/src/core/STTProcessor.ts`, `packages/agentic-sdk-v2/src/types/common.ts` | S |
| P0-6 | Expose `voiceProfileSeeded: boolean` in `StreamSessionResponse` so the SDK/UI can warn when backend preseed silently skipped | `apps/api/src/modules/streaming/dto/transcription-job.dto.ts`, `streamingSession.service.ts`, `session_manager.py` | S |

### P1

| # | Action | File(s) | Effort |
|---|---|---|---|
| P1-1 | Lift `voiceProfiles` into `agenticStore`; hydrate from `SecureStorage` keyed by `vox.voiceProfiles.${userId}.${tenantId}` | `packages/agentic-sdk-v2/src/store/agenticStore.ts`, `useVoiceEmbedding.ts`, `utils/secureStorage.ts` | M |
| P1-2 | Publish `voiceProfileChanged` via `SimpleCrossTabSync` (HMAC-signed per TASK-280) on enroll/activate/delete | `useVoiceEmbedding.ts`, `sync/SimpleCrossTabSync.ts` | S |
| P1-3 | Extend `enroll(files, opts?: { label?: string })`; forward `label` field on the FormData | `useVoiceEmbedding.ts` | S |
| P1-4 | Switch `enroll` to `apiClient.uploadFormData(...)` with `onProgress`, `signal`, `timeout: 0` | `useVoiceEmbedding.ts`, `AgenticClient.ts` | S |
| P1-5 | Call `this.checkRateLimit()` first thing in `postFormData` | `AgenticClient.ts:393` | XS |
| P1-6 | Zeroize `request.audioBuffers` after `extractEmbeddings` resolves | `voiceProfile.service.ts` | XS |
| P1-7 | Add server-side cross-sample cosine-similarity rejection in `ExtractionService.extract` | `apps/stt/src/stt/voice_profile/extraction_service.py` | S |
| P1-8 | Client-side MIME precheck (`type?.startsWith('audio/')`) before POST | `useVoiceEmbedding.ts` | XS |

### P2

| # | Action | File(s) | Effort |
|---|---|---|---|
| P2-1 | Retry-with-backoff for `extractEmbeddings` (1 retry on 5xx) | `voiceProfile.service.ts` | S |
| P2-2 | Project audit `data` to an allowlist (drop `toObject()`) | `voiceProfile.service.ts` | XS |
| P2-3 | Daily hard-purge job for `resourceStatus='DELETED'` rows older than 30 days | `packages/applications/src/services/user/voiceProfile/`, `packages/database` migration | M |
| P2-4 | Route activate/deactivate through `repository.update(id, entity.changes)` to stamp `updatedBy` and emit domain events | `UserVoiceProfileRepository.ts`, `voiceProfile.service.ts` | S |
| P2-5 | Add `tenantId` column to `UserVoiceProfile`; scope `get_voice_embedding` by tenant | `user.prisma`, new migration, `voice_profile_model.py` | M |
| P2-6 | Return `modelId` from `get_voice_embedding`; skip preseed when stale; emit `voice_profile.stale_model` metric | `voice_profile_model.py`, `preseed.py` | S |
| P2-7 | Long-term: unify on a single ONNX speaker-embedding model so the local diarizer can consume the backend embedding byte-for-byte | `packages/stt/src/providers/`, `apps/stt/src/stt/diarization/` | XL |

---

## 11. Scorecard

| Dimension | Grade | Rationale |
|---|:---:|---|
| Correctness | **D** | Wire-up shape is right post TASK-265-D2, but the *functional* end-to-end flow is broken: enrolled profiles are never active, so backend preseed always skips. The local diarizer has no consumption path at all. Two of four business requirements unmet (reqts 3 & 4), one partially met (reqt 2), one met (reqt 5). |
| Security | **D+** | IDOR on `activate/deactivate/delete` for biometric data is a P0 PHI issue. Helpful posture in places (raw audio not persisted, identity from CLS not client) is undermined by `@Authorize()` without permission tuple and audit-payload generosity. |
| Performance | **C** | No fatal hot path, but no upload progress, no SecureStorage cache, redundant `list()` calls, and `postFormData` skips client-side rate-limit. Backend extraction is single-pass / non-retrying. |
| Test coverage | **C−** | The post-TASK-265 lock-in tests for the SDK contract are good. None of the structural defects in §5 are caught by any test (no IDOR test, no `isActive=false` regression test, no local-diarizer-consumption test, no Playwright end-to-end "enrol → diarize" test). |

---

## 12. Top-3 must-fix (blockers for next release)

1. **C-1 + P0-1/P0-2** — Auto-activate first enrollment AND expose `activate/deactivate` in `useVoiceEmbedding`. Without this, backend diarization personalization never actually engages, no matter how many doctors enrol.
2. **C-3 + P0-3** — Close the IDOR on `DELETE /voice-profile/:id`, `PATCH :id/activate`, `PATCH :id/deactivate` by adding `assertOwnership()` in `VoiceProfileService`. PHI integrity defence-in-depth.
3. **C-2 + P0-4** — Give `LocalSpeakerDiarizer` a "doctor-reserved speaker slot" parameter and wire `useVoiceEmbedding.profiles` into `LocalSTTProvider.init` so the local pipeline at least labels the doctor's segments consistently. Without this, requirement #3 (local consumption) is permanently unmet.

A close fourth: **C-4 + P0-5** — gate `diarization: true` on the existence of an active profile, so silent un-personalized diarization stops shipping by default.

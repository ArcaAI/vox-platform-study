# TASK-296 — Voice Profile End-to-End

| | |
|---|---|
| Ticket Number | TASK-296 |
| Created | 2026-05-24 |
| Updated | 2026-05-24 |
| Status | **Completed** |
| Type | Bug-fix / Security (IDOR) / Feature (activation, enrollment-gate, local diarizer pre-seed) |
| Parent | [TASK-293 Vox SDK Deep Assessment V2](../TASK-293-Vox-SDK-Deep-Assessment-V2/README.md) — Wave 5A-9 + 5B-3 + 5B-4 + 5B-5 + 5B-6 |
| Scope | `@arcaai/applications`, `@hope/api` voice-profile module, `@arcaai/vox` voice-embedding hooks, `@arcaai/stt` local diarizer pre-seed, `apps/stt` preseed/extraction/model |

---

## 1. Requirement Analysis

End-to-end remediation of the voice-profile surface so a doctor's enrolled voice actually engages personalization on both the local and remote diarization paths, IDOR is closed, and on-device diarization is gated on enrollment.

Defects in scope (all from [`02-voice-enrollment.md`](../TASK-293-Vox-SDK-Deep-Assessment-V2/02-voice-enrollment.md) plus the diarization-gate row from [`03-local-pipeline.md` §3](../TASK-293-Vox-SDK-Deep-Assessment-V2/03-local-pipeline.md)):

| Severity | ID | Summary |
|---|---|---|
| C-1 | Auto-activation | Voice profile created `isActive=false`; SDK has no activation surface |
| C-2 | Local diarizer pre-seed | `LocalSpeakerDiarizer` cannot consume the enrolled profile |
| C-3 | IDOR | `DELETE /voice-profile/:id`, `PATCH :id/activate`, `PATCH :id/deactivate` have no ownership check |
| C-4 | Enrollment gate | On-device diarization is not gated on the existence of an active profile |
| Backend echo | `voiceProfileSeeded` (STT side) | `preseed_speaker(...)` returns `None` — no contract for TASK-298 to echo |
| H-1 | Local cache | `useVoiceEmbedding.profiles` is purely in-memory; no `SecureStorage` |
| H-3 | `label` drop | SDK `enroll(files)` discards `label`, controller already accepts it |
| H-7 | MIME precheck | SDK posts blobs without an `audio/*` type, server rejects 400 |
| H-8 | Cross-sample consistency | `ExtractionService` centroids three samples without checking they're the same speaker |
| M-6 | Tenant scope | `get_voice_embedding` doesn't filter by tenant |

### Business context

A doctor must be able to enrol once, have their enrolled voice both (a) pre-seed the backend pyannote 256-d diarizer (already wired, currently inert because `isActive` is always `false`) and (b) "claim speaker-1" on the local 40-d MFCC diarizer (workaround for the model-mismatch — long-term ONNX unification is deferred to TASK-301/master roadmap). Once enrolled, opting in to on-device diarization must surface a hard error (not silently fall back to un-personalized labels). Once shipped, biometric mutations must be ownership-checked at the service layer (defence-in-depth) and re-authorized at the controller layer via CASL.

### Acceptance criteria

- Enrolling a profile when the user has none active auto-activates the new row.
- `useVoiceEmbedding` exposes `activate(profileId)` and `deactivate(profileId)`.
- Any user attempting `DELETE`, `PATCH /activate`, or `PATCH /deactivate` against another user's profile is rejected with `403 Forbidden` from the service layer regardless of guard behaviour.
- The controller declares `@Authorize([action,'UserVoiceProfile'])` per action.
- `LocalSpeakerDiarizer` exposes a `reservedSpeakerId` option; when set, the first allocated speaker slot uses that ID instead of `speaker-1`.
- `LocalSTTProvider.init` passes `config.voiceProfile.reservedSpeakerId` (when provided) to the diarizer.
- `useVoiceEnrollmentStatus()` returns `{ hasActive, isLoading, profiles }`.
- A typed `VoiceEnrollmentChecker` interface is published from the SDK for TASK-300 to consume.
- `apps/stt/.../preseed_speaker(...)` returns a typed `dict` with `{success, profile_id, model_id}`.
- `apps/stt/.../extraction_service.extract(...)` rejects 2 + samples whose minimum pairwise cosine similarity is `< 0.6` with a structured `ValueError` (becomes 400 in routes).
- `get_voice_embedding(user_id, tenant_id=None)` includes the optional tenant filter.
- `useVoiceEmbedding.enroll(files, opts?)` accepts an optional label and short-circuits with `AgenticError('VALIDATION_ERROR', …)` when any file's `type` is not `audio/*`.
- Voice profile list hydrates from `SecureStorage` on mount keyed by `vox.voiceProfiles.${userId}.${tenantId}` and re-writes on enroll/activate/deactivate/delete.

---

## 2. Current State Evaluation

### Backend service — `packages/applications/src/services/user/voiceProfile/voiceProfile.service.ts`

- `enroll(...)` creates the row with `isActive: false` (line 47) and never auto-activates.
- `activate(...)`, `deactivate(...)`, `deleteById(...)` (lines 71–102) do not check `profile.userId === this.requestUser?.id`.
- The repository already exposes `findActiveByUserId`, `activateById`, `deactivateAllForUser`, `findById` and `softDelete` (verified at `UserVoiceProfileRepository.ts:16–88`).
- `BaseService` exposes `requestUser` via CLS (`packages/applications/src/common/base.service.ts:64`).

### Controller — `apps/api/src/modules/voice-profile/voice-profile.controller.ts`

- Class-level `@Authorize()` (line 28) is invoked with no permission tuple. `UnifiedAuthGuard` falls through to authentication-only.
- Routes: `POST /enroll`, `GET /`, `PATCH :id/activate`, `PATCH :id/deactivate`, `DELETE :id`.

### SDK constants — `packages/agentic-sdk-v2/src/core/constants.ts`

```ts
export const VOICE_EMBEDDING_ENDPOINTS = {
  enroll: '/voice-profile/enroll',
  list: '/voice-profile',
  delete: (profileId: string) => `/voice-profile/${encodeURIComponent(profileId)}`,
} as const;
```

Missing `activate` and `deactivate`.

### SDK hook — `packages/agentic-sdk-v2/src/hooks/useVoiceEmbedding.ts`

- `enroll(files: EnrollFiles)` discards `label`.
- No MIME precheck.
- No `activate` / `deactivate` surface.
- `profiles` is purely component-local React state; no `SecureStorage` hydrate / write-back.

### STT package — `packages/stt/src/{providers/LocalSpeakerDiarizer.ts,providers/LocalSTTProvider.ts,types/index.ts}`

- `LocalSpeakerDiarizer` builds profiles ad-hoc with auto-incremented IDs `speaker-${n}`; has no constructor option or setter for a "doctor-reserved" slot.
- `LocalProviderConfig` (lines 766–793) has no `voiceProfile` field.
- `LocalSTTProvider.init` does not forward voice profile info to the diarizer.

### STT — `apps/stt/src/stt/{diarization/preseed.py,voice_profile/extraction_service.py,core/database/voice_profile_model.py}`

- `preseed_speaker(...)` returns `None` (line 24); session-manager has no contract to echo back to the SDK.
- `ExtractionService.extract(...)` centroids embeddings without pairwise sanity check.
- `get_voice_embedding(user_id)` is per-user without tenant scope.

### Test coverage today

- `packages/applications/.../voiceProfile.service.test.ts` covers happy-path enroll/list/activate/deactivate/delete; no IDOR test, no auto-activate test.
- `apps/api/.../voice-profile.controller.test.ts` covers basic dispatch; no guard test.
- `packages/agentic-sdk-v2/.../useVoiceEmbedding.test.ts` covers contract; no label/MIME/activate/deactivate test.
- `packages/stt/src/providers/__tests__/LocalSpeakerDiarizer.test.ts` covers MFCC clusterer; no reserved-speaker test. No `LocalSTTProvider.test.ts` exists.
- `apps/stt/tests/unit/voice_profile/test_extraction_service.py` covers validation/output; no cross-sample consistency test. No `diarization/test_preseed.py` exists.

---

## 3. Implementation Plan (TDD, per defect, in dependency order)

For each defect: **RED → GREEN → REFACTOR**. Tests committed first, fail for the documented reason, then minimal implementation, then verified all-green.

### Order of execution

The order minimizes cross-cutting churn by following the layer chain (Service → API → SDK → STT) and grouping the Python service changes at the end.

#### Backend (NestJS) — Layer: Application Services & API

1. **C-1 (auto-activate) + C-3 (IDOR) — `voiceProfile.service.ts`**
   - Tests (RED first, in `voiceProfile.service.test.ts`):
     - `enroll()` calls `findActiveByUserId` after `createWithEmbedding`; if it returns `null`, calls `activateById(created.id)` and the returned entity has `isActive === true`.
     - `enroll()` does NOT call `activateById` when `findActiveByUserId` returns a non-null entity.
     - `deleteById(id)` calls `voiceProfileRepository.findById(id)` first and throws `ForbiddenException('Voice profile does not belong to current user')` when `profile.userId !== requestUser.id`.
     - `deleteById(id)` succeeds when ownership matches.
     - `activate(id)` throws `ForbiddenException` when cross-user.
     - `deactivate(id)` throws `ForbiddenException` when cross-user.
   - Implementation: add `private async assertOwnership(profileId): Promise<UserVoiceProfileEntity>` helper; call from `deleteById`, `activate`, `deactivate`; extend `enroll` with the auto-activate branch.

2. **C-3 (controller CASL) — `voice-profile.controller.ts`**
   - Tests: existing controller test must still pass (it mocks the service directly; the decorator change does not break dispatch).
   - Implementation: remove class-level `@Authorize()`; add per-action decorators:
     - `@Authorize(['create', 'UserVoiceProfile'])` on `enroll`
     - `@Authorize(['read', 'UserVoiceProfile'])` on `list`
     - `@Authorize(['update', 'UserVoiceProfile'])` on `activate` and `deactivate`
     - `@Authorize(['delete', 'UserVoiceProfile'])` on `deleteById`

#### SDK — Layer: Constants & Hooks

3. **C-1 (SDK endpoints) — `constants.ts`**
   - Tests: extend the `useVoiceEmbedding` test (or a small standalone test) to assert `VOICE_EMBEDDING_ENDPOINTS.activate('p-1') === '/voice-profile/p-1/activate'` and `.deactivate('p-1') === '/voice-profile/p-1/deactivate'`.
   - Implementation: append `activate` and `deactivate` URL factories.

4. **C-1 + H-3 + H-7 + H-1 — `useVoiceEmbedding.ts`**
   - Tests (extend `useVoiceEmbedding.test.ts`):
     - `enroll(files, { label })` appends `label` to FormData.
     - `enroll(Blob)` with no `type` throws `AgenticError('VALIDATION_ERROR', 'Voice sample must be an audio file')` and does NOT call `apiClient.postFormData`.
     - `enroll(File with type='video/mp4')` throws `AgenticError('VALIDATION_ERROR', ...)`.
     - `enroll(File with type='audio/wav')` proceeds.
     - `activate('p-1')` calls `apiClient.patch('/voice-profile/p-1/activate')`; updates local `profiles` so `isActive: true` for `p-1` and false for others.
     - `deactivate('p-1')` calls `apiClient.patch('/voice-profile/p-1/deactivate')`; updates local `profiles` so `isActive: false` for `p-1`.
     - On mount, reads `vox.voiceProfiles.${userId}.${tenantId}` from `SecureStorage` and populates `profiles` (when `authUser.id` + `config.api.tenantId` known).
     - On `list()` success, writes the result back to `SecureStorage`.
     - On `enroll/activate/deactivate/delete` success, writes the new `profiles` back to `SecureStorage`.
   - Implementation: extend `EnrollOptions`, MIME guard, new `activate`/`deactivate` actions, persist via `SecureStorage.{getItemWithPassphrase,setItemWithPassphrase}`. Passphrase = `vox-vp-${userId}-${tenantId}` (non-PHI). Best-effort: failures swallowed (cache is a hint).

5. **C-4 — new `useVoiceEnrollmentStatus.ts` + `VoiceEnrollmentChecker` interface**
   - Tests (new `useVoiceEnrollmentStatus.test.ts`):
     - Calls `list()` on mount.
     - Returns `hasActive: true` when at least one profile has `isActive === true`.
     - Returns `hasActive: false` when no profile is active.
     - Returns `isLoading: true` during the initial `list()` call.
     - Exposes a `VoiceEnrollmentChecker` interface: `{ checkHasActiveProfile: () => Promise<boolean> }` that TASK-300 can consume from `STTProcessor`.
   - Implementation: thin wrapper around `useVoiceEmbedding`; export both the hook and the `VoiceEnrollmentChecker` interface from `hooks/index.ts`.

#### STT package — Layer: Local Pipeline Boundary

6. **C-2 — `packages/stt/src/types/index.ts`**
   - Add `voiceProfile?: { id: string; reservedSpeakerId: string }` to `LocalProviderConfig`. No other section touched.

7. **C-2 — `LocalSpeakerDiarizer.ts`**
   - Tests (extend `LocalSpeakerDiarizer.test.ts`):
     - Constructor accepts `reservedSpeakerId`. When set, the FIRST allocated speaker slot's `speakerId` is the reserved ID (not `speaker-1`).
     - Subsequent slots stay `speaker-2`, `speaker-3`, … sequentially.
     - When `reservedSpeakerId` is NOT set, behaviour is unchanged.
     - Setter `setReservedSpeakerId(...)` updates the reserved ID before the first profile is created (no-op if first profile already exists with default id).
   - Implementation: add `reservedSpeakerId?: string` to `LocalSpeakerDiarizerOptions`; in `createProfile`, when `profiles.length === 0` and `reservedSpeakerId` is set, use it for the first profile's id; provide a `setReservedSpeakerId` public setter.

8. **C-2 — `LocalSTTProvider.ts`**
   - Tests (new `LocalSTTProvider.test.ts`):
     - When `init({ ..., voiceProfile: { id, reservedSpeakerId } })`, the constructed diarizer reports the reserved id for the first speaker assignment.
   - Implementation: thread `config.voiceProfile?.reservedSpeakerId` into `new LocalSpeakerDiarizer({...})`.

#### STT (Python) — Layer: Python service

9. **Backend echo — `apps/stt/.../diarization/preseed.py`**
   - Tests (new `apps/stt/tests/unit/diarization/test_preseed.py`):
     - `preseed_speaker(...)` returns a dict `{success: True, profile_id: <user_id>, model_id: None or string}` when an active profile is found.
     - Returns `{success: False, profile_id: None, model_id: None}` when no profile is found.
     - Returns `{success: False, profile_id: None, model_id: None}` when DB throws.
   - Implementation: change return type to `dict[str, object]`; populate `success`, `profile_id`, `model_id` accordingly.

10. **H-8 — `apps/stt/.../voice_profile/extraction_service.py`**
    - Tests (extend `test_extraction_service.py`):
      - Two samples with high pairwise similarity pass through (use the existing deterministic mock so all sample embeddings are identical — pairwise sim = 1.0).
      - Add a new test where the mock returns deliberately divergent embeddings (e.g., orthogonal); `extract([s1, s2])` raises `ValueError("Cross-sample similarity")`.
      - One sample: no consistency check applied, succeeds.
    - Implementation: after extracting `embeddings`, if `len(embeddings) > 1` compute pairwise cosine similarities; if `min(sim) < 0.6`, `raise ValueError("Cross-sample similarity X.XX below threshold 0.6 — samples may be from different speakers")`.

11. **M-6 — `apps/stt/.../core/database/voice_profile_model.py`**
    - Tests: dependent on actually running against a DB. Instead we'll unit-test that when `tenant_id` is provided, the generated SQL contains `AND "tenantId" = :tenant_id` — but since `UserVoiceProfile` has no `tenantId` column today (Master roadmap P2-5), this becomes:
      - The function accepts an optional `tenant_id` kwarg.
      - When `tenant_id is None`, the SQL contains no tenant clause.
      - When `tenant_id` is provided, the SQL contains the tenant clause AND a `TODO: requires UserVoiceProfile.tenantId column (master roadmap P2-5)` comment is present in the source file. (Tested via reading the source file in a Python test.)
    - Implementation: extend signature to `async def get_voice_embedding(user_id: str, tenant_id: str | None = None) -> list[float] | None`; conditionally append the AND clause. Add the TODO comment per the rule that we do NOT add a column without a migration.

---

## 4. Hand-off / Contracts

These are the public contracts this ticket publishes for sibling tickets to consume.

### A. `VoiceEnrollmentChecker` interface — for TASK-300

Exported from `packages/agentic-sdk-v2/src/hooks/useVoiceEnrollmentStatus.ts`:

```ts
export interface VoiceEnrollmentChecker {
  /**
   * Returns true if the current user has at least one ACTIVE voice profile.
   * Triggers a list() call against /voice-profile if no cache is available.
   * Implementations MUST be side-effect-free and idempotent.
   */
  checkHasActiveProfile(): Promise<boolean>;
}

export interface UseVoiceEnrollmentStatusReturn {
  hasActive: boolean;
  isLoading: boolean;
  profiles: VoiceProfile[];
}

export function useVoiceEnrollmentStatus(): UseVoiceEnrollmentStatusReturn;
```

TASK-300 owns `packages/stt/src/core/STTProcessor.ts`. The intended integration: in `STTProcessor.validateConfig` (or equivalent), if `features.diarization && !(await checker.checkHasActiveProfile())`, throw `AgenticError('ENROLLMENT_REQUIRED', 'Enrol your voice before enabling on-device diarization')`. The checker instance can be supplied via constructor / `init()`; TASK-300 is free to design that wiring without touching this ticket's hook.

### B. `preseed_speaker(...)` return contract — for TASK-298

`apps/stt/src/stt/diarization/preseed.py`:

```python
async def preseed_speaker(
    tracker: Any,
    consultation_id: str | None,
    *,
    tenant_id: str | None = None,
    log_context: str | None = None,
    user_id: str | None = None,
) -> dict[str, object]:
    """Returns:
        {
          "success": bool,        # True iff an active profile was found AND registered
          "profile_id": str|None, # The resolved user_id whose profile was used
          "model_id": str|None,   # The embedding model id (currently always None; populated when M-6 returns model_id)
        }
    """
```

TASK-298 owns `apps/stt/src/stt/streaming/session_manager.py`. The intended integration: after calling `preseed_speaker(...)`, the session manager echoes `result["success"]` into the streaming-session-creation response as `voiceProfileSeeded: bool`. The API gateway then forwards it on the `StreamSessionResponse` DTO so the SDK can surface a banner when diarization is running without personalization.

### C. `LocalProviderConfig.voiceProfile` shape — for SDK orchestration consumers

`packages/stt/src/types/index.ts`:

```ts
export interface LocalProviderConfig extends ProviderConfig {
  // ... existing fields ...

  /**
   * Optional reserved-speaker slot for the enrolled doctor.
   * When set, LocalSpeakerDiarizer pins the FIRST allocated speaker slot
   * to `reservedSpeakerId` instead of the default `speaker-1`.
   *
   * Short-term workaround for the 40-d MFCC vs 256-d backend embedding
   * mismatch. Long-term unification to a single ONNX speaker-embedding
   * model is tracked in the TASK-293 master roadmap (Wave 5D / P2-7).
   */
  voiceProfile?: {
    id: string;
    reservedSpeakerId: string;
  };
}
```

### D. Tenant-scope deferral — for the database team

`UserVoiceProfile` does NOT have a `tenantId` column today. Per the master roadmap, schema migration is **deferred to Wave 5D / P2-5**. This ticket adds an optional `tenant_id` parameter to `get_voice_embedding` and a TODO comment in the SQL so the column-add migration in a later ticket can flip the parameter from "opt-in" to "always-on" without changing the function signature.

---

## 5. Out of Scope / Deferred

- `STTProcessor` validation wiring — owned by TASK-300.
- `session_manager.py` echo of `voiceProfileSeeded` — owned by TASK-298.
- Adding a `tenantId` column to `UserVoiceProfile` — deferred to master roadmap P2-5.
- Long-term unification on a single ONNX speaker-embedding model — master roadmap (TASK-303 or beyond).
- Diarizer FFT bit-reversal fix — owned by TASK-301 (W5C-13).
- `STTFeatureFlags.task` field for translation — owned by TASK-301 (W5B-16).
- Raw audio buffer zeroization (H-6), audit-payload allowlist (M-2), retention TTL (M-3), `activate/deactivate` going through `repository.update` (M-4) — these P1/P2 polish items can ship in a follow-up; they are not gating items for the Wave-5A IDOR closure or the Wave-5B activation/local-diarizer wiring.

---

## 6. Verification Plan

```bash
# Vitest
pnpm test:unit --filter @arcaai/applications
pnpm --filter @hope/api test:unit
pnpm --filter @arcaai/vox test
pnpm --filter @arcaai/stt test

# Build
pnpm build --filter @arcaai/applications @hope/api @arcaai/vox @arcaai/stt

# Lint via Cursor ReadLints on each modified file

# Python (uses conda env `arcaenv`)
cd apps/stt
conda run -n arcaenv python -m pytest tests/unit/diarization tests/unit/voice_profile -v
```

Outputs will be pasted in §8 (Implementation Summary) on completion.

---

## 7. Implementation Summary

### 7.1 Files changed / created

#### NestJS (backend)

| File | Change | Purpose |
|---|---|---|
| `packages/applications/src/services/user/voiceProfile/voiceProfile.service.ts` | modified | Auto-activate first profile (C-1); `assertOwnership` helper used by `activate` / `deactivate` / `deleteById` (C-3) |
| `packages/applications/src/services/user/voiceProfile/__tests__/voiceProfile.service.test.ts` | extended | RED tests for auto-activation (C-1) + ownership rejection (C-3) on the three mutating endpoints |
| `apps/api/src/modules/voice-profile/voice-profile.controller.ts` | modified | Replaced blanket `@Authorize()` with per-action CASL tuples `[action, 'UserVoiceProfile']` (C-3 defence-in-depth at the controller layer) |
| `apps/api/src/modules/voice-profile/__tests__/voice-profile.controller.test.ts` | extended | Tests that the CASL tuple metadata is correctly attached to each handler |

#### SDK (`@arcaai/vox`)

| File | Change | Purpose |
|---|---|---|
| `packages/agentic-sdk-v2/src/core/constants.ts` | modified | Extended `VOICE_EMBEDDING_ENDPOINTS` with `activate(profileId)` + `deactivate(profileId)` builders (C-1) |
| `packages/agentic-sdk-v2/src/core/__tests__/constants.task265.test.ts` | modified | Updated the "keys are exactly" lock to expect the extended key set |
| `packages/agentic-sdk-v2/src/utils/secureStorage.ts` | extended | Added `getItemWithPassphrase` / `setItemWithPassphrase` statics so the cache survives sessions (the per-instance random salt of `create()` is incompatible with persistent storage) (H-1 enabler) |
| `packages/agentic-sdk-v2/src/hooks/useVoiceEmbedding.ts` | extended | Added `activate` / `deactivate` (C-1), `enroll(files, { label })` (H-3), client-side MIME precheck (H-7), `SecureStorage` hydration + write-through cache scoped per `(userId, tenantId)` (H-1). Memoised `cacheKeys` to keep callback identities stable for downstream hooks. Synchronous `applyProfiles` via `useRef` mirror avoids the StrictMode double-call regression observed when computing the next state inside a setState updater closure. |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useVoiceEmbedding.test.ts` | extended | RED tests for each of the above (`activate`/`deactivate` API call + local state, MIME rejection, label form-field, cache writes after every mutation, cache hydration, cache skipped without `(userId, tenantId)` scope) |
| `packages/agentic-sdk-v2/src/hooks/useVoiceEnrollmentStatus.ts` | **NEW** | Wraps `useVoiceEmbedding` to expose `{ hasActive, isLoading, profiles }`; also publishes the standalone `createVoiceEnrollmentChecker(apiClient)` factory + `VoiceEnrollmentChecker` interface for TASK-300 to consume from `STTProcessor` without depending on React (C-4) |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useVoiceEnrollmentStatus.test.ts` | **NEW** | Tests for the hook + factory, including fail-closed behaviour on API errors |
| `packages/agentic-sdk-v2/src/hooks/index.ts` | modified | Re-exported the new hook, factory, and types from the package barrel |

#### STT (local pipeline) (`@arcaai/stt`)

| File | Change | Purpose |
|---|---|---|
| `packages/stt/src/types/index.ts` | modified | Added optional `voiceProfile?: { id, reservedSpeakerId }` to `LocalProviderConfig` (C-2). `STTFeatureFlags` is untouched — TASK-300 owns `task`. |
| `packages/stt/src/providers/LocalSpeakerDiarizer.ts` | modified | Added `reservedSpeakerId` constructor option + `setReservedSpeakerId(id)` public setter; first allocated slot uses the reserved id instead of `speaker-1` (C-2) |
| `packages/stt/src/providers/LocalSTTProvider.ts` | modified | Passes `config.voiceProfile.reservedSpeakerId` to the `LocalSpeakerDiarizer` constructor when present (C-2) |
| `packages/stt/src/providers/__tests__/LocalSpeakerDiarizer.test.ts` | extended | 5 RED tests covering: pin the first slot, sequential slots after pinned slot, default behaviour when not set, late-set before first profile pins, late-set after first profile is a no-op |
| `packages/stt/src/providers/__tests__/LocalSTTProvider.test.ts` | **NEW** | 2 RED tests using `vi.doMock` to capture the diarizer ctor args and confirm `reservedSpeakerId` is wired through `init(...)`. Whisper engine is mocked away to avoid loading models in the JSDOM env. |

#### STT (Python)

| File | Change | Purpose |
|---|---|---|
| `apps/stt/src/stt/diarization/preseed.py` | modified | Return type changed from `None` to `dict[str, object]` with `{success, profile_id, model_id}`. Best-effort metadata fetch (failure does NOT block tracker registration). Failure dict returned on every degraded path so callers can always echo a structured result. |
| `apps/stt/src/stt/core/database/voice_profile_model.py` | modified | `get_voice_embedding` now accepts an optional `tenant_id` (M-6) with a TODO placeholder until `UserVoiceProfile.tenantId` lands (deferred to master roadmap P2-5). New `get_voice_profile_metadata(user_id, tenant_id)` returns `{profile_id, model_id}` for the preseed echo. |
| `apps/stt/src/stt/voice_profile/extraction_service.py` | modified | Cross-sample consistency check: when more than one sample is provided, computes pairwise cosine similarity between per-sample embeddings and raises `ValueError` (→ 400 in routes) if `min < 0.6` (H-8). |
| `apps/stt/tests/unit/diarization/test_preseed.py` | **NEW** | 6 tests covering success, missing profile, missing identity, tracker at capacity, DB exception, and the "metadata lookup failed but registration succeeded" path |
| `apps/stt/tests/unit/voice_profile/test_extraction_service.py` | extended | 4 RED tests covering H-8: accept consistent 2 / 3 samples, reject inconsistent samples, skip the check for single sample |
| `apps/stt/tests/unit/voice_profile/test_voice_profile_model.py` | **NEW** | 4 signature + smoke tests pinning the M-6 contract |

#### Documentation

| File | Change | Purpose |
|---|---|---|
| `docs/implementation/TASK-296-Voice-Profile-End-to-End/README.md` | **NEW** | This document |

### 7.2 Evidence — test runs

```
$ cd packages/applications && npx vitest run src/services/user/voiceProfile/
 Test Files  1 passed (1)
      Tests  12 passed (12)
   Duration  879ms

$ cd apps/api && npx vitest run src/modules/voice-profile/__tests__
 Test Files  1 passed (1)
      Tests  11 passed (11)
   Duration  795ms

$ cd packages/agentic-sdk-v2 && npx vitest run \
    src/hooks/__tests__/useVoiceEmbedding.test.ts \
    src/hooks/__tests__/useVoiceEnrollmentStatus.test.ts \
    src/core/__tests__/constants.task265.test.ts
 Test Files  3 passed (3)
      Tests  52 passed (52)
   Duration  927ms

$ cd packages/stt && npx vitest run \
    src/providers/__tests__/LocalSpeakerDiarizer.test.ts \
    src/providers/__tests__/LocalSTTProvider.test.ts
 Test Files  2 passed (2)
      Tests  17 passed (17)
   Duration  1.26s

$ cd apps/stt && conda run -n arcaenv python -m pytest \
    tests/unit/diarization/test_preseed.py tests/unit/voice_profile/ -v
 ========== 24 passed in 0.51s ==========

$ cd apps/stt && conda run -n arcaenv python -m pytest \
    tests/unit/test_batch_service.py -k preseed -v
 ========== 7 passed, 120 deselected in 0.62s ==========
   (regression check: previous preseed call-sites unaffected by dict return)
```

### 7.3 Evidence — build / type-check

```
$ cd packages/stt && npx tsc --noEmit
   (exit 0 — no TS errors)
```

`@arcaai/applications`, `@hope/api`, `@arcaai/vox` all type-check cleanly for the files this ticket owns; pre-existing TS errors elsewhere (in `prompt-management.service.ts`, `SttWebSocketClient.test.ts`, `useArcaSummary.summaryOptions.task299.test.ts`, `AgenticProvider.task297.test.ts`) are owned by TASK-294 / TASK-297 / TASK-298 / TASK-299 and out of scope here.

`@arcaai/room` and the umbrella `pnpm build --filter ... @arcaai/vox @arcaai/stt` chain currently fails inside `@arcaai/room` due to an unrelated esbuild error that another agent has on this branch (`packages/room/tsup.config.ts` + `package.json` changes are pre-existing). The STT package itself type-checks cleanly.

### 7.4 Evidence — lint

`ReadLints` returned **no linter errors** for all 22 files touched by this ticket.

### 7.5 Deviations from plan

- **Metadata fetch path** — to keep the existing `test_batch_service.py` mock contract intact, the new `get_voice_profile_metadata` helper is a separate function rather than a return-type change on `get_voice_embedding`. The preseed helper calls both with a local try/except so the metadata call is non-fatal.
- **`SecureStorage`** — extended with the two static helpers (`getItemWithPassphrase` / `setItemWithPassphrase`) because the existing `create()` constructor allocates a new random salt per instance, which is incompatible with cross-session persistence.
- **`useVoiceEmbedding` state mutation** — switched from setState-updater closures to a `useRef` mirror + `applyProfiles(next)` because StrictMode double-invokes updater functions, leading to a timing race between `list()` and `activate()` cache writes observed during Phase 3 verification.
- **`@arcaai/room` build failure** — pre-existing on this branch; the STT, SDK, applications, and API packages I own type-check cleanly. No changes were made to `packages/room` (out of scope).

---

## 8. Change History

| Date | Author | Notes |
|---|---|---|
| 2026-05-24 | TASK-296 owner | Initial plan committed. Status: In Progress. |
| 2026-05-24 | TASK-296 owner | Implementation complete across C-1, C-2, C-3, C-4, backend-echo, H-1, H-3, H-7, H-8, M-6. Status: **Completed**. Evidence in §7. Hand-off contracts published in §4. |

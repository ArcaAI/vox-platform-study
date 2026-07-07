# TASK-434 — Playground: Voice Profiles (frame 52)

- **Status**: Review
- **Type**: feature — screen `/playground/voice-profiles` in `apps/admin-console`
- **Created**: 2026-07-06
- **Parent**: TASK-420 row 36 (matrix + approved frame `52 - Voice Profiles`); foundation TASK-431

## Requirement Analysis

Own-account voice biometric enrollment (works with or without a working tenant — NO tenant gate; annotate as own-account plane):

- **Enrollment wizard**: record-or-upload up to 3 samples (`POST /voice-profile/enroll`, multipart field `files`, ≤10 MB each, mime `audio/*`, optional `label` ≤100 chars), per-file size meter, REC SAMPLE indicator (MediaRecorder capture).
- **Profile list**: `GET /voice-profile` → `{ id, userId, isActive, label, modelId, createdAt, updatedAt }[]`; active badge; activate/deactivate toggles (`PATCH /voice-profile/:id/{activate,deactivate}` → `{ success: true }`); delete with confirm dialog (`DELETE /voice-profile/:id`).
- Biometric "user-owned only" chip; seeded profiles auto-attach to streaming sessions (row 35 bridge note).
- All REST via BFF (`@/shared/api`). State variants: loading/empty/error; light + dark.

## Implementation Plan

1. Failing tests: api client paths, screen render (wizard, list, toggles, delete confirm).
2. Feature `src/features/playground-voice-profiles/` api layer + components over `ScreenTemplate`; routes under `(playground)/playground/voice-profiles/`.
3. Verify: `pnpm --filter @arcaai/admin-console test lint`; axe 0 violations; both themes.

## Implementation Summary

TDD (RED → GREEN): the api-layer test and the screen test were authored first against the planned module shape, then the implementation was written to make them pass.

### Files created

| File | Purpose |
|---|---|
| `apps/admin-console/src/features/playground-voice-profiles/api/types.ts` | Wire types mirroring `VoiceProfileResponse` / enroll input / toggle ack (console cannot import gateway packages) |
| `…/api/keys.ts` | TanStack Query keys rooted at `playground-voice-profiles` |
| `…/api/client.ts` | `enrollVoiceProfile` (FormData `files` repeated + optional `label` via shared `request()`), `listVoiceProfiles`, `activateVoiceProfile`, `deactivateVoiceProfile`, `deleteVoiceProfile`; exports gateway caps `MAX_SAMPLES=3`, `MAX_SAMPLE_BYTES=10 MiB`, `MAX_LABEL_LENGTH=100`. Paths are gateway-relative (`voice-profile/…` — no `admin/` prefix, no `/api/v1`) |
| `…/api/hooks.ts` | `useVoiceProfiles`, `useEnrollVoiceProfile`, `useSetVoiceProfileActive` (activate/deactivate behind one mutation), `useDeleteVoiceProfile` — every mutation invalidates the feature root key |
| `…/api/index.ts` | Barrel |
| `…/components/use-sample-recorder.ts` | MediaRecorder state machine `idle → requesting → recording` with `denied`/`unsupported` designed dead-ends; support checked inside `start()` (no render-time `window` branch → no hydration mismatch); emits one `File` per take (`recording-N.webm`); releases tracks + timer on stop AND unmount |
| `…/components/enrollment-card.tsx` | Frame 52 panel (a): Record/Stop + Upload buttons, drag-and-drop zone, REC SAMPLE mm:ss badge (pulse dot, reduced-motion aware), staged-sample rows with per-file size meter vs the 10 MB cap + remove buttons, client-side pre-validation mirroring the gateway `ParseFilePipe` (audio/* only, ≤10 MB, ≤3 samples), label input (≤100 chars, visible label), submit → multipart POST → toast + wizard reset |
| `…/components/profile-list-card.tsx` | Frame 52 panel (b): `GET /voice-profile` rows with Active/Inactive badge, `modelId` (or "Model pending"), relative enrolled/updated timestamps, per-row Activate/Deactivate buttons (aria-labelled), delete behind the shared destructive `ConfirmDialog`; loading skeletons / `EmptyState` with enroll CTA / `ErrorState` with retry |
| `…/components/voice-profiles-screen.tsx` | Composition over `ScreenTemplate` + `PageHeader` (one h1, count meta, "Biometric · user-owned only" chip, "+ Enroll voice profile" CTA that focuses the wizard) + `statusBanner` own-account note (the frame's repurposed NoTenant panel — deliberately NO `WorkingTenantGate`) + `StatusFooter` |
| `…/api/__tests__/voice-profiles-api.test.ts` | 8 tests: query-key stability, exact `METHOD /api/hope/<path>` assertions for all five routes, FormData contents (repeated `files`, optional `label`, no manual content-type so fetch sets the multipart boundary), path-param escaping, cap constants |
| `…/components/__tests__/voice-profiles-screen.test.tsx` | 16 tests: header/annotation/chip/list render, loading skeletons, empty state, error + retry, submit gating, non-audio + >10 MB + >3-samples client validation, staged-sample removal, multipart enroll → toast → reset → invalidation, enroll failure keeps samples, MediaRecorder record flow (REC indicator, staged take), mic-permission denial, activate/deactivate PATCHes, delete confirm (cancel = no DELETE) |
| `apps/admin-console/src/app/(console)/(playground)/playground/voice-profiles/page.tsx` | Thin server component: metadata + screen import |
| `…/voice-profiles/loading.tsx` | Segment skeleton mirroring the loaded layout (header, note, wizard card, 3 list rows, footer bar) |

No shared files were touched (nav entry + `(playground)` guard shipped with TASK-431).

### Verification evidence (2026-07-06)

`pnpm --filter @arcaai/admin-console exec vitest run src/features/playground-voice-profiles`:

```
 Test Files  2 passed (2)
      Tests  24 passed (24)
   Start at  23:03:27
   Duration  4.42s (transform 904ms, setup 27ms, import 3.75s, tests 434ms, environment 157ms)
```

Lint, scoped to this ticket's files (`npx eslint "src/features/playground-voice-profiles/**" "src/app/(console)/(playground)/playground/voice-profiles/**" --max-warnings 0`):

```
LINT-SCOPED: CLEAN (0 errors, 0 warnings)
```

Types: `tsc --noEmit` reports **zero errors in this ticket's files**. The full app-wide `check-types` / `lint` runs currently fail ONLY on `src/features/playground-consultation/**` and `src/features/playground-live-transcription/**` — in-flight work of the parallel sub-tickets TASK-432/433 (verified by scoping: `tsc --noEmit 2>&1 | rg voice-profiles` → no matches).

### Deviations / notes

- **Frame 52 panel (c) "Profile actions"** (a selection-driven detail panel) is folded into per-row actions on the profile list — matrix row 36 specifies "profile list with active badge, activate/deactivate toggles, delete confirm", and a third panel would add a selection model with no extra capability. The seeding bridge note ("active profiles auto-attach to live-transcription sessions") is kept as the list-card caption.
- **Recording level meter**: the frame's tiny in-row waveform would need an `AudioContext`/`AnalyserNode` pipeline; the REC SAMPLE indicator + mm:ss clock is implemented instead. `@arcaai/ui`'s `AudioMeter` was evaluated but requires a live `level` feed — rendering it frozen at 0 would be misleading.
- **Toggle control**: activate/deactivate uses labelled buttons (per the frame's `[ Deactivate ]` actions) rather than a Switch — avoids a color-only state and keeps one obvious verb per row.
- Playwright E2E + axe scan + design QA on the running app are deferred to the TASK-420 integration pass (per sub-ticket instructions); unit/lint/type gates above are complete.
- No blocked shared-change needs arose.

## Change History

| Date | Change |
|---|---|
| 2026-07-06 | Ticket created from TASK-420 (frames approved 2026-07-06). |
| 2026-07-06 | Implemented api layer + enrollment wizard + profile list + screen + routes with colocated tests (24 passing), scoped lint/type gates clean. Status → Review. E2E/axe/design QA deferred to the integration pass. |

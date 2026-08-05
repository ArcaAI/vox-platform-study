# @arcaai/vox — Changelog

All notable changes to the `@arcaai/vox` SDK are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

_Nothing yet._

---

## [2.0.4] — 2026-08-05

### Added / Changed — TASK-612 (external-microphone / injected-stream hardening)

Hardens the `sourceStreams` / `addSource({ stream })` external-audio
integration seam end to end: previously-silent failure paths around it now
fail loudly, and stream ownership between the SDK and the caller is now
explicit. Touches `useArcaAudio`, the `useAudioCapture`/`useArcaSpeechToText`
compat hooks, and `@arcaai/room`'s `AudioMixer`. Full contract:
[`docs/Compat-API-Reference.md` §8](docs/Compat-API-Reference.md#8-external-microphones--injected-streams).

- **New `AgenticErrorCode` members:** `SOURCE_STREAM_NOT_LIVE` (a
  `sourceStreams` entry, or the stream passed to `addSource({ stream })`, has
  no audio track — or none with `readyState === 'live'`) and
  `CAPTURE_OPTIONS_DROPPED` (`useArcaAudio.start()` now REJECTS, instead of
  only `logger.warn`ing, when the compat start-race drops a call's
  capture-shaped options: `deviceId`, `secondaryDeviceId`,
  `additionalDeviceIds`, `sourceStreams`, `sourceGains`, `audioProcessing`,
  `dynamicSources`).
- **BEHAVIOR CHANGE — caller-owned stream ownership.** `useArcaAudio` (and
  therefore `useAudioCapture`) no longer stops the tracks of an injected
  stream (`sourceStreams`, `addSource({ stream })`) on `stop()`, a failed
  `start()`, or mixer removal/dispose. The same `MediaStream` object can now
  be reused across sessions. Integrators that relied on the SDK releasing an
  injected stream's microphone must now call `track.stop()` themselves.
  SDK-opened (`deviceId`) streams are unaffected — released exactly as
  before. `@arcaai/room`'s `AudioMixer.addSource()` gained the per-source
  `stopTracksOnRemove` option (default `true`, the pre-TASK-612 behavior)
  backing this.
- **Silent-uplink watchdog.** A streaming session with 5 continuous seconds
  of zero input level (while unmuted) is now flagged: the store gains
  `audioSignalState: 'ok' | 'silent'`, and `useArcaSpeechToText`'s `onStatus`
  gains two events — `'no_audio_signal'` / `'audio_signal_restored'` — each
  firing once per transition, never on mount.
- **`useAudioCapture` diagnostics parity.** Additive return fields
  `uplinkBitrate`, `audioLost`, `droppedFrames`, mirroring the native
  `useArcaAudio()` store fields of the same purpose.
- **Empty-final suppression.** A whitespace-only final transcript no longer
  produces a transcript segment, a context POST, or a synthesized
  `onTranscript` call. `useArcaSpeechToText.stopTranscription()` also now
  resets its interim-dedup ref, so an identical first interim in the next
  session is no longer silently swallowed.
- No breaking changes — every item above is additive or error-surfacing;
  frozen v1-compat signatures are unchanged.

---

## [2.0.3] and earlier

Everything below shipped in the packages published up to 2.0.3; per-version
sectioning was not yet in place, so first-shipped versions are unrecorded.

### Added — TASK-302 Stream D (optimistic locking on config writes)

- `useGlobalSettings.get(id)` now captures the response `ETag` header
  into a module-level cache keyed by setting id (`AgenticClient.getWithEtag`).
- `useGlobalSettings.update(id, input)` replays the cached `ETag` as the
  `If-Match` request header (`AgenticClient.patchWithIfMatch`).
- `ConfigConflictError` (exported from `@arcaai/vox` and `@arcaai/vox/core`)
  is thrown when the server returns `412 Precondition Failed`. Carries
  `settingId` / `expectedVersion` / `currentVersion`. Callers can branch
  on `err instanceof ConfigConflictError` to surface a conflict modal.
- `AgenticClient.getWithEtag<T>(endpoint)` — public helper returning
  `{ body, etag }`.
- `AgenticClient.patchWithIfMatch<T>(endpoint, body, ifMatch)` — public
  helper that sets an `If-Match` request header.

### Server compatibility — **REQUIRED API version**

These features require the HOPE API to ship Phase D of TASK-302
(commits `cbf6da9`, `9b33725`, `2405d5a`):

- `ETag` header rendered by the global `ETagInterceptor` (D.1).
- `@RequiresIfMatch()` enforcement + `@ExpectedVersion()` parsing on
  mutating routes (D.2).
- The `PATCH /tenant/me/config` route applies `@RequiresIfMatch()` (D.3).

**Deploy ordering (R4):** API → SDK → UI. Shipping the SDK against an
older API will:

- Cause every `useGlobalSettings.get(id)` to silently fall back to
  bare GET (no `ETag` returned, no cache populated). The subsequent
  `update()` will throw `Error: No ETag cached for setting <id>…`.
- Cause every `PATCH` to a `@RequiresIfMatch()`-annotated route to
  return `428 Precondition Required` (the route requires `If-Match`
  but the client is sending it correctly — this is expected once the
  API rolls forward).

**Migration path for existing apps:**

1. After upgrading to this SDK, every `useGlobalSettings.update(id, input)`
   call MUST be preceded by a `useGlobalSettings.get(id)` so the SDK
   can capture the strong validator. The hook throws synchronously
   (with a clear error) if no validator is cached — no silent 428.
2. Wrap your save handler in `try / catch (err instanceof ConfigConflictError)`
   to surface a refresh-and-retry UX. The conflict modal stub at
   `apps/ui-playground/src/features/admin/configurations/conflict-modal.tsx`
   is a working reference.

---

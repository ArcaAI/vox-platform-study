# @arcaai/vox — Changelog

All notable changes to the `@arcaai/vox` SDK are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

_Nothing yet._

---

## [3.0.0] — 2026-08-18

### BREAKING — TASK-760 (business-plane URI normalization)

Every gateway path the SDK publishes as an endpoint constant has been
normalized. **This is a wire change, which is why it is a MAJOR** — the
constants in `src/core/constants.ts` are a public export, so an integrator that
imported them is affected even if it never wrote a path by hand.
`@arcaai/vox-node` takes the same version with no code change (its only paths
are the frozen `api/smr/api/v1` compat surface and `consultations/*`, neither
of which moved).

**The gateway answers `308 Permanent Redirect` on every retired path for ONE
release** — `ALL-2.0.0` deletes the shims. 308 preserves method and body, so an
un-upgraded client keeps working; a client still on the old paths after
`ALL-2.0.0` will get 404s.

| Retired path | New path | Why |
|---|---|---|
| `GET/PATCH /user/me/preferences` | `/users/me/preferences` | plural collection |
| `GET /user/me/settings` | `/users/me/settings` | plural collection |
| `PATCH /user/me/settings/:namespace/:key` | `/users/me/settings/:namespace/:key` | plural collection |
| `GET /user/me/departments` | `/users/me/departments` | plural collection |
| `GET /tenant/me` | `/tenants/me` | plural collection |
| `GET/PATCH /tenant/me/config` | `/tenants/me/config` | plural collection |
| `GET /tenant/me/context-schema` | `/tenants/me/context-schema` | plural collection |
| `GET /entitlements/me` | `/tenants/me/entitlements` | one tenant self alias |
| `GET /billing/me/invoices[/:id]` | `/tenants/me/invoices[/:id]` | one tenant self alias |
| `GET /billing/me/spend` | `/tenants/me/spend` | one tenant self alias |
| `GET /usage/me/summary` | `/tenants/me/usage-summary` | one tenant self alias |
| `GET /usage/me/burndown` | `/tenants/me/usage-burndown` | one tenant self alias |
| `POST /voice-profile/enroll` | `/voice-profiles/enroll` | plural collection |
| `GET /voice-profile` | `/voice-profiles` | plural collection |
| `PATCH /voice-profile/:id/{activate,deactivate}` | `/voice-profiles/:id/{activate,deactivate}` | plural collection |
| `DELETE /voice-profile/:id` | `/voice-profiles/:id` | plural collection |
| `POST /rbac/check` | `POST /users/:id/permission-checks` | verb-as-resource → resource |
| `POST /rbac/check/bulk` | `POST /users/:id/permission-checks/bulk` | verb-as-resource → resource |
| `POST /rbac/check/my-permissions` | `POST /users/me/permission-checks` | verb-as-resource → resource |
| `POST /ai/guardrail/analyze` | `POST /safety-checks` | `ai` named neither capability it hosted |
| `POST /ai/nlp/{entities,diagnosis,topic,intent}` | `POST /text-analyses/{…}` | ditto |
| `POST /text/generate[/assembled]` | `/text-generations/generate[/assembled]` | `text` was the name of a service |
| `GET /text/tasks/:id[/stream]` | `/text-generations/tasks/:id[/stream]` | ditto |
| `POST /text/tasks/:id/cancel` | `/text-generations/tasks/:id/cancel` | ditto |
| `GET /text/{providers,guardrail-providers}` | `/text-generations/{…}` | ditto |

**Two self aliases, not one.** `/users/me/**` is for USER-owned surfaces;
`/tenants/me/**` is for TENANT-owned ones. Billing, usage, entitlements and
tenant config are `read:Tenant` and resolve from the CLS tenant — folding them
under `users/me` would assert that a tenant's invoices belong to the calling
user. Under an API key the distinction is load-bearing: `users/me` resolves to
the key's BOUND USER, `tenants/me` to the key's TENANT.

**Deliberately unchanged:** `/speech/*` (its backing service is `apps/tts`, so
the prefix already names a capability, not a service), `/users/password-reset/*`,
`/audio/pipelines/*`, and the frozen v1 compat surface `api/smr/api/v1`.

### Migration

Import the endpoint constants instead of writing literals — they moved with the
gateway and nothing else in the SDK's public API changed:

```ts
import { MY_TENANT_ENDPOINTS, VOICE_EMBEDDING_ENDPOINTS, TEXT_ENDPOINTS } from '@arcaai/vox/core';
```

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

# @arcaai/vox — Changelog

## 3.4.0

### Minor Changes

- **Transcript anchors on live entities** (`transcriptSegmentId`, `transcriptStart`, `transcriptEnd` on the live-summary entity). NER runs over the transcript and the server then re-locates each entity inside the rendered note, overwriting `start`/`end`; these three survive that pass so a client can jump to where the mention was actually spoken. `transcriptSegmentId` is `utt-<utteranceIndex>` and the offsets index THAT segment's own text. All three present or all absent — never guessed. Mirrors hope-v2's live-summary DTO (2026-09-13).

## 3.3.0

### Minor Changes

- TASK-951 — the ArcaAI realtime contract on the SDKs.

  - `hope.stt.createStreamSession({ context })` (vox-node) / the stream-session request (vox): a client-declared session context (≤ 4 KB), validated against the ASR agent's frozen context schema and echoed VERBATIM on every transcript of that session together with `sessionEpochMs`.
  - `RealtimeSttSocket.setMetadata(value)` (vox-node) and `SttWebSocketClient.setMetadata(value)` (vox): declare the metadata in force from the current point of the audio onward — one microphone at a time, sticky until the next declaration, no timestamp. Every transcript then carries `metadata` (the flat object in force over its audio, e.g. `{ mic_id: '2' }`) and `metadataSpans` (`SttMetadataSpan[]` / `WsMetadataSpan[]`, the exact bounds clipped to the segment). Refusals arrive on the error channel — `METADATA_TOO_LARGE`, `METADATA_INVALID`, `METADATA_SCHEMA_VIOLATION` with `problems` — and never end the session.
  - `@arcaai/vox-codegen`: the context-schema marker roles (`userIdentity`, `department`, `visitType`, `externalRef`, `materializeAs`, `streamContext`) are emitted as documentation tags on the generated kind types.

### Patch Changes

- Updated dependencies
  - @arcaai/room@3.3.0
  - @arcaai/stt@3.3.0
  - @arcaai/vad@3.3.0
  - @arcaai/noise-filter@3.3.0
  - @arcaai/med-ner@3.3.0

## 3.2.0

### Minor Changes

- **Declare the language a consultation's NOTES are written in, independently of what the microphone hears (TASK-932).**

  `OpenSessionInput.language` (BCP-47 — `en`, `ml`, `en-IN`) is honoured by `session.open()` and by a re-visit, and reads back on `Consultation.language`. It is NOT the STT language mode, and the difference is the point of the field: a Malayalam-English consultation is routinely documented in English. `audio.start({ languageMode })` governs what the microphone is allowed to HEAR; this governs what the note is WRITTEN IN. Declaring either never sets the other. Omit it and the note's language is undeclared — which is not English: the tenant's own agent body decides, exactly as before. Re-opening an already-open consultation keeps the language it was opened with, the same way it keeps its governing workflow.

  **`useArcaLiveSummary` no longer wipes its own snapshot.** The gateway multiplexes typed sub-plane events onto the live-summary channel — per-section patches (`event: 'section.patch'`) and the warm-start pre-summary lifecycle (`event: 'presummary'`). They are not snapshots, and folding one over the last full-state payload cleared `entities` / `runningSummary` milliseconds after every flush. Only an undiscriminated payload is now treated as a snapshot, and both sub-plane events are registered as named no-ops so an upgraded gateway that tags them as named SSE frames cannot fold them either.

  `SttWebSocketClient.sendAudioFrame` accepts `ArrayBuffer | ArrayBufferView<ArrayBuffer>`. Under TypeScript 6 `ArrayBufferView` is generic over its backing buffer and defaults to `ArrayBufferLike`, which is not a `BufferSource`; the narrowing only makes the signature honest, since a `SharedArrayBuffer`-backed view was never sendable over a WebSocket at runtime.

### Patch Changes

- @arcaai/med-ner@3.2.0
  - @arcaai/noise-filter@3.2.0
  - @arcaai/room@3.2.0
  - @arcaai/stt@3.2.0
  - @arcaai/vad@3.2.0

## 3.1.0

### Minor Changes

- 2e09493: **The browser SDK follows the platform onto the agent/workflow plane (3.1.0).**

  **Named entity recognition is a first-class agent task.** `AgentTask` gains
  `'NAMED_ENTITY_RECOGNITION'`, `AGENT_ENDPOINTS.LIST` accepts it, and
  `useAgentInvocation().invoke(slug, { text })` calls a NER agent the same way it calls a
  text-generation one — the shape of the answer is the agent's own `outputSchema`
  (`{ entities: [{ text, label, start, end, score? }] }` by default), not a second method.
  `NamedEntityRecognitionInput` / `NamedEntityRecognitionOutput` / `RecognizedEntity` are
  exported for the default shape; an agent whose tenant authored a different schema is still
  yours to type. NER is a ONE-SHOT task: `?mode=stream` on a NER agent is a 400
  (`MODE_UNSUPPORTED`) at the gateway, so use `invoke`, never `stream`.

  **`useWorkflowRun({ transport: 'socket' })`.** The run stream can now be read over a
  WebSocket instead of SSE. The hook mints a run-scoped, single-use ticket
  (`POST /workflows/:slug/runs/:runId/stream-ticket`) and opens the `url` the response returns
  — never a JWT in a query string. Event shape, resume cursor, terminal detection and
  `stopWatching()` are identical to the SSE lane, so this is a one-word change at the call
  site. SSE stays the default: it resumes with `Last-Event-ID`, which a socket lane cannot.
  Pick `socket` when a proxy in front of you buffers `text/event-stream` (the failure mode is
  a run that looks stalled and then completes all at once) or when you already hold a socket
  budget per tab. `SocketUnavailableError` names the missing global rather than silently
  falling back — a silent fallback would hide the proxy problem you switched transports to
  solve.

  **First-party demo apps move `sttPipelineId` → `sttAgentSlug`.** The compat adapter already
  preferred the agent slug; the five remaining call sites in `apps/example`,
  `apps/compat-playground` and `apps/quick-compat-app` no longer pass the deprecated key.
  `sttPipelineId` itself is unchanged and still accepted (removed in R4).

### Patch Changes

- @arcaai/med-ner@3.1.0
  - @arcaai/noise-filter@3.1.0
  - @arcaai/room@3.1.0
  - @arcaai/stt@3.1.0
  - @arcaai/vad@3.1.0

All notable changes to the `@arcaai/vox` SDK are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added — TASK-931: `NAMED_ENTITY_RECOGNITION` is an agent task

`AgentTask` gains the value, so `AGENT_ENDPOINTS.LIST('NAMED_ENTITY_RECOGNITION')` and every
agent picker built on it type and filter. `useAgentInvocation().invoke()` is now generic over
the agent's OUTPUT (defaulting to the `TEXT_GENERATION` `{ text }` shape), so a NER agent is the
same call with a different answer:

```ts
const { output } = await invoke<NamedEntityRecognitionOutput>(slug, { text: note });
// output.entities → [{ text, label, start, end, score? }, …]
```

`NamedEntityRecognitionInput` / `NamedEntityRecognitionOutput` / `RecognizedEntity` describe the
task's DEFAULT schema; a tenant may author its own, which is why they are convenience types and
not a constraint on `invoke`. It is a ONE-SHOT task — `?mode=stream` on a NER agent is a gateway
400 (`MODE_UNSUPPORTED`), so reach for `invoke`, never `stream`.

`AGENT_ENDPOINTS.LIST` now takes the shared `AgentTask` union by a TYPE-only import rather than
its own inline copy of the three old values. The copy is exactly what went stale.

### Added — TASK-931: `useWorkflowRun({ transport: 'socket' })`

The run stream can be read over a WebSocket instead of SSE. The hook mints a run-scoped,
single-use ticket (`POST /workflows/:slug/runs/:runId/stream-ticket`) and opens the `url` that
response returns — never a JWT in a query string, the same rule as the SSE lane. `events`,
`status`, `lastEventId`, terminal detection and `stopWatching()` are identical, so this is a
one-word change at the call site.

**SSE stays the default, because it is the only lane that RESUMES.** A socket's ticket is
single-use, so a dropped socket ends the watch where SSE reconnects with `Last-Event-ID` and
loses no frames. Pick `socket` when a proxy in front of you buffers `text/event-stream` — the
failure mode is a run that looks stalled and then completes all at once — or when a socket is
the per-tab connection budget you already hold. `SocketUnavailableError` names a missing
`WebSocket` global rather than falling back silently, because a silent fallback would reproduce
the problem you switched transports to solve.

New exports on `/core`: `WorkflowRunSocketClient`, `SocketUnavailableError`,
`resolveWorkflowSocketUrl`, `workflowRunStreamTicketPath`, `WorkflowRunStreamTicket`.

### Fixed — TASK-931: `useAudioCapture` reads `sttAgentSlug`

`V1SdkConfig` gained `sttAgentSlug` when the ASR Agent replaced the pipeline, and
`mapV1ConfigToV2` has preferred it over `sttPipelineId` since — but the compat capture hook read
`options.sttPipelineId` and nothing else. A compat app that moved its provider config to the
agent slug AND drove capture from this hook (which the playground does, because whichever hook
calls `audio.start()` first wins the shared-audio race) therefore started a session with **no
selector at all** and silently ran the tenant default. It now forwards `sttAgentSlug` as
`agentSlug`, with the adapter's precedence: the agent slug wins, and never both, because the
session body carries at most one selector.

The five first-party demo call sites (`apps/example`, `apps/compat-playground`,
`apps/quick-compat-app`) move to `sttAgentSlug`, reading a NEW config field rather than
repurposing `pipelineId` — the same value still feeds `useArcaSpeechToText` and
`useArcaBatchTranscription`, which accept no agent slug yet. `sttPipelineId` itself is unchanged
and still honoured (removed in R4).

---

## [3.0.1] — 2026-09-07

### BREAKING — TASK-890 (OD-F/OD-K): `@arcaai/vox` is business-plane only, no management surface

Every admin-hook family has been removed, along with the `/admin/*` endpoint constants that backed
them — 25 hooks (`useUsers`, `useRoles`, `useDepartments`, `useUserDepartments`, `usePrompts`,
`useApiKeys`, `useAuditLog`, `useAdminConsultations`, `useAdminTranscriptionJobs`,
`useHarnessAdmin`, `useQueueAdmin`, `useRateLimits`, `usePrismaStudio`, `useTenants`,
`useTenantFrontendConfig`, `useTenantStorageConfig`, `useTenantBuckets`, `useEntitlements`,
`useGlobalSettings`, `useMonitoring`, `usePlatformMetrics`, `useHealthCheck`, `useStorageKeys`,
`useDnaStyle`, `useDnaDashboard`) and the constant groups (`USER_ENDPOINTS`, `ROLE_ENDPOINTS`,
`DEPARTMENT_ENDPOINTS`'s admin CRUD surface, `TENANT_ENDPOINTS`, `TENANT_BUCKET_ENDPOINTS`,
`GLOBAL_SETTINGS_ENDPOINTS`, `API_KEY_ENDPOINTS`, `AUDIT_LOG_ENDPOINTS`,
`ADMIN_USER_SETTINGS_ENDPOINTS`, `ADMIN_USER_ROLES_ENDPOINTS`, `ADMIN_USER_DEPARTMENTS_ENDPOINTS`,
`ADMIN_USER_PROFILE_ENDPOINTS`, `TENANT_STORAGE_CONFIG_ENDPOINTS`, `RATE_LIMIT_ADMIN_ENDPOINTS`,
`MONITORING_ENDPOINTS`, `PLATFORM_METRICS_ENDPOINTS`, `ADMIN_TRANSCRIPTION_JOB_ENDPOINTS`,
`ADMIN_CONSULTATION_ENDPOINTS`, `TENANT_FRONTEND_CONFIG_ENDPOINTS`, `PSTUDIO_ENDPOINTS`,
`SERVICE_HEALTH_ENDPOINTS`, `HARNESS_ADMIN_ENDPOINTS`, `QUEUE_ADMIN_ENDPOINTS`) it took to build a
URL for them. `useUserSettings` stays — it is self-only (`/users/me/settings`), never another
user's; its admin-plane `listForUser`/`updateForUser` methods are gone with it.

`isAdminPlanePath` is inverted: `AgenticClient` now REFUSES an admin-plane request outright — a
named `AdminPlaneRefusedError`, thrown before any network call — instead of routing it with a
stashed admin JWT during impersonation, as it once did. This applies regardless of credential
(JWT or API key) or impersonation state.

Zero first-party consumers imported any of the removed hooks or constants (verified: `apps/`,
`packages/ui` import none of them). Management moved to `@arcaai/vox-node`'s `hope.admin.*`
(service-account credential) or the admin console — see
[Business plane only](README.md#business-plane-only-no-management-surface).

### Docs — TASK-890 black-box J6: `api.baseUrl` carries the gateway's `/api/v1` prefix

`AgenticConfig.api.baseUrl` is the FULL base the SDK appends resource paths to, prefix included
(`http://host:8868/api/v1`) — the SDK adds no version segment of its own. A value without it
answers the gateway's root 404 on every call, with nothing in the SDK to say why. Documented on
the type and in the README; no behaviour change.

### Note — service-account credentials are not supported by this SDK

The gateway gained a third credential class in `ALL-3.0.0` (service accounts, bearer tokens with
`svc:*` scopes). **This SDK cannot send one**: `HopeClientOptions` exposes no such option and the
compat shims set `x-api-key` directly. Service-account access is raw HTTP for now.

API-key access is unchanged and unaffected — standalone summarization through `@arcaai/vox-node`
works exactly as before, against the same frozen v1 compat paths.

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

| Retired path                                     | New path                                    | Why                                     |
| ------------------------------------------------ | ------------------------------------------- | --------------------------------------- |
| `GET/PATCH /user/me/preferences`                 | `/users/me/preferences`                     | plural collection                       |
| `GET /user/me/settings`                          | `/users/me/settings`                        | plural collection                       |
| `PATCH /user/me/settings/:namespace/:key`        | `/users/me/settings/:namespace/:key`        | plural collection                       |
| `GET /user/me/departments`                       | `/users/me/departments`                     | plural collection                       |
| `GET /tenant/me`                                 | `/tenants/me`                               | plural collection                       |
| `GET/PATCH /tenant/me/config`                    | `/tenants/me/config`                        | plural collection                       |
| `GET /tenant/me/context-schema`                  | `/tenants/me/context-schema`                | plural collection                       |
| `GET /entitlements/me`                           | `/tenants/me/entitlements`                  | one tenant self alias                   |
| `GET /billing/me/invoices[/:id]`                 | `/tenants/me/invoices[/:id]`                | one tenant self alias                   |
| `GET /billing/me/spend`                          | `/tenants/me/spend`                         | one tenant self alias                   |
| `GET /usage/me/summary`                          | `/tenants/me/usage-summary`                 | one tenant self alias                   |
| `GET /usage/me/burndown`                         | `/tenants/me/usage-burndown`                | one tenant self alias                   |
| `POST /voice-profile/enroll`                     | `/voice-profiles/enroll`                    | plural collection                       |
| `GET /voice-profile`                             | `/voice-profiles`                           | plural collection                       |
| `PATCH /voice-profile/:id/{activate,deactivate}` | `/voice-profiles/:id/{activate,deactivate}` | plural collection                       |
| `DELETE /voice-profile/:id`                      | `/voice-profiles/:id`                       | plural collection                       |
| `POST /rbac/check`                               | `POST /users/:id/permission-checks`         | verb-as-resource → resource             |
| `POST /rbac/check/bulk`                          | `POST /users/:id/permission-checks/bulk`    | verb-as-resource → resource             |
| `POST /rbac/check/my-permissions`                | `POST /users/me/permission-checks`          | verb-as-resource → resource             |
| `POST /ai/guardrail/analyze`                     | `POST /safety-checks`                       | `ai` named neither capability it hosted |
| `POST /ai/nlp/{entities,diagnosis,topic,intent}` | `POST /text-analyses/{…}`                   | ditto                                   |
| `POST /text/generate[/assembled]`                | `/text-generations/generate[/assembled]`    | `text` was the name of a service        |
| `GET /text/tasks/:id[/stream]`                   | `/text-generations/tasks/:id[/stream]`      | ditto                                   |
| `POST /text/tasks/:id/cancel`                    | `/text-generations/tasks/:id/cancel`        | ditto                                   |
| `GET /text/{providers,guardrail-providers}`      | `/text-generations/{…}`                     | ditto                                   |

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

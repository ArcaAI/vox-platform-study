# @arcaai/vox — browser SDK for HOPE consultation workflows

`packages/agentic-sdk-v2`, npm package `@arcaai/vox` (version 4.0.0). A browser-only React SDK:
a configuration-driven `AgenticProvider`, a unified `useArca()` hook plus focused domain hooks,
real-time audio capture streamed to backend transcription, consultation/context/summary
management against the `apps/api` gateway (port 8868), and multi-tenant-safe browser state
(per-provider Zustand stores, namespaced persistence, cross-tab sync). Consumed by
`apps/admin-console` (`apps/compat-playground` went with the compat entry). Peer deps: `react` / `react-dom`
`^18.3.0 || ^19.0.4`.

## Layout

| Path                                      | What it holds                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` / `core.ts` / `plugins.ts` | The three entry points (see below)                                                                                                                                                                                                                                                                                  |
| `src/providers/`                          | `AgenticProvider` — owns one Zustand store instance per mount                                                                                                                                                                                                                                                       |
| `src/hooks/`                              | `useArca` + focused domain hooks (business plane only, no admin surface)                                                                                                                                                                                                                                            |
| `src/store/`                              | `createAgenticStore`, `useArcaStore`, `useStoreApi`                                                                                                                                                                                                                                                                 |
| `src/core/`                               | `AgenticClient`, `ConfigManager`/`ConfigSchema` (valibot), `PluginManager`, `TranscriptionPipeline`, `KnowledgePipeline`, `SttWebSocketClient`, `SSEClient`, `StreamingSessionManager`, `SharedConnectionManager`/`Worker`, `SimpleCrossTabSync`, `PersonalizationManager`, `ModelRegistry` (deprecated), `logger/` |
| `src/types/`                              | Config, consultation, context, summary, STT types                                                                                                                                                                                                                                                                   |
| `docs/API-Reference.md`                   | Maintained API reference (the compat and compat-batch references were deleted with the compat entry — TASK-1012)                                                                                                                                                                                                    |
| `e2e/`                                    | Playwright specs + fixtures                                                                                                                                                                                                                                                                                         |

## Commands

Run from this directory, or `pnpm --filter @arcaai/vox <script>` from the repo root.

| Command                                           | Effect                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm build`                                      | tsup build (`build:dts` runs after, `tsc --emitDeclarationOnly`) for all three entries             |
| `pnpm dev`                                        | tsup watch mode                                                                                    |
| `pnpm test` / `pnpm test:watch` / `pnpm test:cov` | Vitest unit tests                                                                                  |
| `pnpm test:e2e`                                   | Builds, then Playwright (`e2e/playwright.config.ts`); `:ui`, `:headed`, `:chromium` variants exist |
| `pnpm lint` / `pnpm lint:fix`                     | ESLint on `src`                                                                                    |
| `pnpm typecheck`                                  | `tsc --noEmit`                                                                                     |
| `pnpm clean`                                      | Remove build output; `pnpm nuke` also removes `node_modules`                                       |

## How it works

### Entry points (verified against `package.json#exports`, 3 entries)

| Import                | Contents                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `@arcaai/vox`         | Everything: core + audio plugin hooks and pipelines                                                                  |
| `@arcaai/vox/core`    | Provider, hooks, types, client — no audio/ML plugin code. Use for admin/dashboard surfaces that only need API access |
| `@arcaai/vox/plugins` | `useArcaAudio`, `useTtsPlayback`/`useTtsStream`, `PluginManager`, `TranscriptionPipeline`, `KnowledgePipeline`       |

The `./compat` entry point (v1-compatible hooks) was removed outright in TASK-1004 (zero
production traffic). The `./plugins/med-ner`, browser-only `useVAD`/`useSTT`/`useNoiseFilter`
re-exports from `./plugins`, and `useMedNER` were removed in TASK-1006 (R4) — the browser never
runs a model, so there is no client-side VAD/noise-filter/NER surface left to entry-split.

### The browser never runs a model (owner directive, TASK-865)

VAD, denoise, diarization, ASR and NER are server-side decisions made by the tenant's Agents.
The only supported capture graph:

```
Microphone -> @arcaai/room AudioTrack (native getUserMedia constraints stay on)
  -> STT stage (@arcaai/stt StreamingBackendSTTProvider over StreamingSessionManager + SttWebSocketClient)
  -> gateway -> STT service (server-side VAD, denoise, diarization, ASR)
  -> transcription events -> store -> context items
```

Selection is by `agentSlug`, never a pipeline/engine/model id: `useSelectableAsrAgents()` reads
`GET /agents?task=SPEECH_TO_TEXT` (`null` = unresolved, `[]` = none published), and
`audio.start({ agentSlug })` names the tenant's ASR Agent; omit it and the gateway resolves one —
the active session's governing workflow first, when it names a speech-to-text agent, otherwise the
tenant admin's assignment (department, then tenant default). There is no other way to select an
ASR engine from the browser SDK — `AudioStartOptions.pipelineId` and `audio.clientInference` were
removed in TASK-1006 (R4), and the gateway answers 400 for a `pipelineId`. Since 4.0.1 no SDK path
sends one: `@arcaai/stt`'s streaming provider still forwarded a caller-supplied `pipelineId` in
4.0.0; it now ignores it (one console warning) and the option is removed in 5.0.0. The browser model
registry (`ModelRegistry`, `useArcaConfig().models` / `selectModel` / `selectSttTask`, the Whisper /
Silero defaults) selects nothing and is `@deprecated` since 4.0.1.

Client-side VAD (Silero), noise filtering (RNNoise), local Whisper transcription, and browser NER
are gone, not merely gated off — the `@arcaai/vad`, `@arcaai/noise-filter`, and `@arcaai/med-ner`
packages were deleted, `@arcaai/stt`'s in-browser Whisper worker was removed, and
`useLocalVoiceEmbedding` (WavLM) was removed in favor of the server-side `useVoiceEmbedding`.
Removed alongside them: `usePipelines`, `useArcaPipelines`, `useSttProviderToggle`, the
`selectedPipelineId` user setting, `DEFAULT_LOCAL_CONFIG`, `LOCAL_TRANSCRIPTION_ENABLED`, and the
compat `sttPipelineId` (use `sttAgentSlug`). Full history:
`docs/operations/deprecation-register.md` SDK section.

### Provider and store

Each `AgenticProvider` mount creates its own Zustand store via `createAgenticStore()` and
publishes it through context. Read it only via `useArcaStore(selector)` (reactive) or
`useStoreApi()` (imperative `.getState()`) — both throw outside a provider. The exported
`useAgenticStore` is a deprecated module singleton kept for compatibility only: no provider
initializes it, so its `apiClient`/`configManager` stay `null`. On tenant switch the provider
calls `store.clearTenantSessionData()` before the new tenant config resolves.

### Consultation session lifecycle

1. `session.open({ patientId, appointmentDate?, workflowDefinitionSlug? })` — get-or-create the
   consultation. Passing `workflowDefinitionSlug` overrides the `department -> tenant ->
platform-default` assignment cascade for that one consultation; discover valid slugs with
   `useSelectableConsultationWorkflows()`, never guess them.
2. `audio.start({ agentSlug?, language?, deviceId?, secondaryDeviceId? })` — capture + pipeline;
   transcripts land in `context.transcriptions`, entities in `context.entities`. Devices are
   mixed via `@arcaai/room`'s `AudioMixer`.
3. `context.addCaseNote(...)`, `context.extractEntities()` — enrich the record.
4. `summary.generateSummary(...)` — starts the async note job, waits for it and resolves the
   persisted note (since 4.0.1; the synchronous route it called in 4.0.0 was removed by TASK-1006).
   Use `generateSummaryAsync` + `useConsultationJob` to track the job yourself.
5. `audio.stop()`, then `useArcaSession().close()` (or `reopen()`).

`session.open(input)` accepts `parentConsultationId`, `context` and `metadata`, and the returned
`consultation` carries `status` (the 12-value `ConsultationStatus`), `visitType`, `externalRef`,
`parentConsultationId`, `isNew`, `version`, `language` and **`recordable`**. Check `recordable`
before `audio.start()`: a signed or closed consultation comes back with `recordable: false` (a
recording on it is a 409 `CONSULTATION_NOT_RECORDABLE`). A return visit is a NEW consultation —
open again with a new encounter id in `context` (the schema's `externalRef` field), and it is
chained to the earlier visit. `isRevisit(consultation)` reads `visitType`, then the top-level
`parentConsultationId`. `close()` ends at `CLOSED_COMPLETE` / `CLOSED_INCOMPLETE`; `reopen()`
moves to `REOPENED`.

`useArcaSession().consultation.governingRun` and `useConsultationWorkflow().governingRun` read
the consultation's governing workflow run — `GoverningRunSummary | null` (`@arcaai/types`),
derived server-side from the persisted marker, never a live harness call. `useWorkflowRun().status`
carries `degraded: boolean` plus four node counts alongside the persisted `status` — DEGRADED is a
per-run FLAG, never a value `status` itself takes. `useConsultationSchema().validatePayload` is a
fast-fail UX aid only: it checks the SESSION-pinned schema bundle, which can differ from the
governing workflow's BOUND version when that trigger is pinned rather than follow-latest, so catch
400 `WORKFLOW_CONTEXT_INCOMPATIBLE` (on `AgenticError.context.problems`) regardless of what local
validation said. `ContextItem.kindKey` has been declared for a while and is now actually FILLED by
the wire — it names which declared kind an item is, so a consumer reads back what it sent instead
of remembering it.

### Business plane only — no management surface (TASK-890)

`@arcaai/vox` carries no administration capability. `AgenticClient` enforces this at the
transport layer: any request whose path matches `isAdminPlanePath` (`/admin/*`, plus
`/monitoring/*` and `/health/services*`) throws `AdminPlaneRefusedError` before any network call,
regardless of credential or impersonation state. `useUserSettings` is the one exception, and it
is self-only (`/users/me/settings`). Administration lives in
[`@arcaai/vox-node`](../vox-node/README.md)'s `hope.admin.*` or the admin console.

### Live streams

All SSE hooks connect against `apiClient.getStreamBaseUrl()` with a single-use ticket
(`POST /auth/stream-ticket`, JWT-only — an API key cannot mint one).

| Hook                    | Stream                                       | Notes                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useArcaLiveSummary`    | `GET /consultations/:id/live-summary/stream` | Full-state snapshots; keep only the latest                                                                                                                                                                     |
| `useArcaLiveAssist`     | `GET /consultations/:id/live-assist/stream`  | Full-state snapshots (`suggestions` + `corrections`); no terminal event, you close it                                                                                                                          |
| `useConsultationEvents` | `GET /consultations/:id/loop/stream`         | Append-only, capped at the last 500, no resume                                                                                                                                                                 |
| `useWorkflowRun`        | `GET /workflows/:slug/runs/:runId/stream`    | Resumes via `Last-Event-ID`; also lists/starts/cancels runs. `transport: 'socket'` reads over a run-scoped single-use-ticket WebSocket instead; SSE stays the default because it is the only lane that resumes |

### Which credential to use

`AgenticClient` accepts `accessToken` (JWT) and `apiKey` at the same time. For a user-facing
frontend, use the JWT: an API key is a long-lived shared secret bound to the tenant, not the
user, and nothing about a page load can revoke it. Prefer `@arcaai/vox-node` for server-side
callers that need an API key or service-account credential. Neither credential ever reaches the
admin plane from this SDK.

### Logging

`SDKLogger` with pluggable transports (`ConsoleTransport`, `HighlightTransport`,
`ClarityTransport`, `LokiTransport`, `OTelTransport`), PII redaction, and W3C trace-context
helpers. `ClarityTransport` and `HighlightTransport` refuse to activate on a production
deployment (session-replay tools with PHI exposure risk, no signed BAA) — the activation gate
reads a declared `environment`, not `NODE_ENV`, because bundlers bake `NODE_ENV=production` into
every optimized build including staging.

## Gotchas

- The `/api/v1` prefix is part of `baseUrl` — every SDK route is relative to it. Omit it and each
  call answers the gateway's root 404 with nothing thrown.
- `useSelectableConsultationWorkflows`, `useSelectableAsrAgents`, and `useConsultationWorkflow`
  all fail open: `null` means "we could not ask", `[]` means "there are none". Never collapse the
  two.
- `useWorkflowRun`'s reserved input keys (`consultationId`, `externalPatientId`, `userId`,
  `jobId`, `sessionId`) throw `ReservedRunIdentityError` synchronously if passed in `input` — the
  hook validates client-side rather than letting the gateway 400.
- There is no "list my runs" call on the business plane — a run is reachable only by the
  `runId` you were handed; keep it.
- Clarity's `event()` API accepts a name only (detail travels as tags), and Clarity has no
  stop/teardown API, so `shutdown()` revokes consent rather than truly stopping recording.

## Related

- [`@arcaai/vox-node`](../vox-node/README.md) — the non-browser server sibling; owns the admin
  plane and API-key/service-account credentials.
- [`@arcaai/room`](../room/README.md), [`@arcaai/stt`](../stt/README.md) — dependency packages
  (audio capture + the backend streaming transport). `@arcaai/vad`, `@arcaai/noise-filter`, and
  `@arcaai/med-ner` were deleted in TASK-1006 — the browser never runs a model.
- [`docs/guides/client-integration-guide.md`](../../docs/guides/client-integration-guide.md) — the
  end-to-end integration guide; chapter 10 maps every server-side step to its browser equivalent.
- `docs/API-Reference.md` — full generated signatures.
- `.claude/rules/08-vox-sdk.md` — SDK architecture rules; `.claude/rules/07-react-ui.md` — React
  component conventions.

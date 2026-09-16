# @arcaai/vox — browser SDK for HOPE consultation workflows

`packages/agentic-sdk-v2`, npm package `@arcaai/vox` (version 3.5.0). A browser-only React SDK:
a configuration-driven `AgenticProvider`, a unified `useArca()` hook plus focused domain hooks,
real-time audio capture streamed to backend transcription, consultation/context/summary
management against the `apps/api` gateway (port 8868), and multi-tenant-safe browser state
(per-provider Zustand stores, namespaced persistence, cross-tab sync). Consumed by
`apps/admin-console` and `apps/compat-playground`. Peer deps: `react` / `react-dom`
`^18.3.0 || ^19.0.4`.

## Layout

| Path                                                                                             | What it holds                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` / `core.ts` / `plugins.ts` / `plugins-med-ner.ts` / `compat.ts`                   | The five entry points (see below)                                                                                                                                                                                                                                                                                            |
| `src/providers/`                                                                                 | `AgenticProvider` — owns one Zustand store instance per mount                                                                                                                                                                                                                                                                |
| `src/hooks/`                                                                                     | `useArca` + focused domain hooks (business plane only, no admin surface)                                                                                                                                                                                                                                                     |
| `src/store/`                                                                                     | `createAgenticStore`, `useArcaStore`, `useStoreApi`                                                                                                                                                                                                                                                                          |
| `src/core/`                                                                                      | `AgenticClient`, `ConfigManager`/`ConfigSchema` (valibot), `PluginManager`, `TranscriptionPipeline`, `KnowledgePipeline`, `SttWebSocketClient`, `SSEClient`, `StreamingSessionManager`, `SharedConnectionManager`/`Worker`, `SimpleCrossTabSync`, `PersonalizationManager`, `ModelRegistry`, `LocalVoiceEmbedder`, `logger/` |
| `src/types/`                                                                                     | Config, consultation, context, summary, STT types                                                                                                                                                                                                                                                                            |
| `src/compat/`                                                                                    | v1-compat provider + hooks (entry: `src/compat.ts`)                                                                                                                                                                                                                                                                          |
| `docs/API-Reference.md`, `docs/Compat-API-Reference.md`, `docs/Batch-Transcription-Reference.md` | Generated/maintained API references                                                                                                                                                                                                                                                                                          |
| `e2e/`                                                                                           | Playwright specs + fixtures                                                                                                                                                                                                                                                                                                  |

## Commands

Run from this directory, or `pnpm --filter @arcaai/vox <script>` from the repo root.

| Command                                           | Effect                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm build`                                      | tsup build (`build:dts` runs after, `tsc --emitDeclarationOnly`) for all five entries              |
| `pnpm dev`                                        | tsup watch mode                                                                                    |
| `pnpm test` / `pnpm test:watch` / `pnpm test:cov` | Vitest unit tests                                                                                  |
| `pnpm test:e2e`                                   | Builds, then Playwright (`e2e/playwright.config.ts`); `:ui`, `:headed`, `:chromium` variants exist |
| `pnpm lint` / `pnpm lint:fix`                     | ESLint on `src`                                                                                    |
| `pnpm typecheck`                                  | `tsc --noEmit`                                                                                     |
| `pnpm clean`                                      | Remove build output; `pnpm nuke` also removes `node_modules`                                       |

## How it works

### Entry points (verified against `package.json#exports`, 5 entries)

| Import                        | Contents                                                                                                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@arcaai/vox`                 | Everything: core + audio plugin hooks and pipelines                                                                                                                                                                                                   |
| `@arcaai/vox/core`            | Provider, hooks, types, client — no audio/ML plugin code. Use for admin/dashboard surfaces that only need API access                                                                                                                                  |
| `@arcaai/vox/plugins`         | `useArcaAudio`, `useTtsPlayback`/`useTtsStream`, `PluginManager`, `TranscriptionPipeline`, `KnowledgePipeline`. Also re-exports the DEPRECATED `useVAD`, `useSTT`, `useNoiseFilter` (removed in R4)                                                   |
| `@arcaai/vox/plugins/med-ner` | DEPRECATED (removed in R4) — `useMedNER` only; isolates the optional `@arcaai/med-ner` dependency so importing `/plugins` alone never pulls it in                                                                                                     |
| `@arcaai/vox/compat`          | v1 (`@arcaai/agentic-sdk`) source-compatible hooks for migrating apps: `useArcaSessionManager`, `useAudioCapture`, `useArcaSpeechToText`, `useText`, `useArcaSttProvider`, `useArcaSttLanguageModes`, plus `ArcaCompatProvider` and `mapV1ConfigToV2` |

**Entry bundles don't share a React context.** Each entry is a separate tsup bundle
(`splitting: false`), so a tree rendered under `<ArcaCompatProvider>` (from `/compat`) must
import every hook it uses — including v2-native ones like `useArcaSttLanguageModes` — from
`/compat` too. Importing the "same" hook from `/core` in a `/compat`-provided tree throws
(`useStoreApi()` finds no provider), even though it is re-exported under an identical name.

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
`audio.start({ agentSlug })` names the tenant's ASR Agent; omit it and the tenant -> department
`AgentAssignment` cascade decides. `AudioStartOptions.pipelineId` is DEPRECATED (removed in R4):
still forwarded with a warning, and when both are passed `agentSlug` wins and `pipelineId` is
dropped with a warning, never silently.

`DEFAULT_AUDIO_CONFIG` and `DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG` declare the `noiseFilter`
(RNNoise) and `vad` (Silero) client stages OFF, and the runtime ignores `enabled: true` for them
unless the host also sets `audio.clientInference: { allow: true }` — itself deprecated on
arrival and retiring with the packages in R4. Local Whisper is gated by
`LOCAL_TRANSCRIPTION_ENABLED = false`; browser NER lives behind the deprecated
`/plugins/med-ner` entry; `useLocalVoiceEmbedding` (WavLM) is deprecated in favor of the
server-side `useVoiceEmbedding`.

Deprecated, removed in R4 (register: `docs/operations/deprecation-register.md` SDK section):
`@arcaai/vad`, `@arcaai/noise-filter`, `@arcaai/stt`'s in-browser Whisper, `@arcaai/med-ner` +
`/plugins/med-ner`, `useVAD`/`useSTT`/`useNoiseFilter`, `useLocalVoiceEmbedding`,
`AudioStartOptions.pipelineId`, `usePipelines`, `useArcaPipelines`, `useSttProviderToggle`, the
`selectedPipelineId` user setting, `LOCAL_TRANSCRIPTION_ENABLED`, and the compat `sttPipelineId`
(use `sttAgentSlug`).

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
4. `summary.generateSummary(...)` (or `generateSummaryAsync` for job-based generation with SSE
   progress).
5. `audio.stop()`, then `useArcaSession().close()` (or `reopen()`).

`useArcaSession().consultation.governingRun` and `useConsultationWorkflow().governingRun` read
the consultation's governing workflow run — `GoverningRunSummary | null` (`@arcaai/types`),
derived server-side from the persisted marker, never a live harness call. `useWorkflowRun().status`
carries `degraded: boolean` plus four node counts alongside the persisted `status` — DEGRADED is a
per-run FLAG, never a value `status` itself takes. `useConsultationSchema().validatePayload` is a
fast-fail UX aid only: it checks the SESSION-pinned schema bundle, which can differ from the
governing workflow's BOUND version when that trigger is pinned rather than follow-latest, so catch
400 `WORKFLOW_CONTEXT_INCOMPATIBLE` (on `AgenticError.context.problems`) regardless of what local
validation said.

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
- [`@arcaai/room`](../room/README.md), [`@arcaai/stt`](../stt/README.md),
  [`@arcaai/vad`](../vad/README.md), [`@arcaai/noise-filter`](../noise-filter/README.md),
  [`@arcaai/med-ner`](../med-ner/README.md) — dependency and deprecated-plugin packages.
- `docs/API-Reference.md`, `docs/Compat-API-Reference.md` — full generated signatures.
- `.claude/rules/08-vox-sdk.md` — SDK architecture rules; `.claude/rules/07-react-ui.md` — React
  component conventions.

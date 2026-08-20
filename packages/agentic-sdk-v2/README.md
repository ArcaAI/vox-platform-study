# @arcaai/vox

React SDK for ARCAAI medical consultation workflows. Provides a configuration-driven provider (`AgenticProvider`), a unified `useArca()` hook plus 40+ focused hooks, a real-time audio pipeline (noise filtering, voice activity detection, speech-to-text), consultation/context/summary management against the HOPE API gateway, and multi-tenant-safe browser state (per-provider Zustand stores, namespaced persistence, cross-tab sync).

Last updated: 2026-07-04

## Where it fits

| Direction     | Package / app                                        | Relationship                                                                |
| ------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Depends on    | `@arcaai/room`                                       | Audio capture, `AudioTrack`, processor contract, `AudioMixer`               |
| Depends on    | `@arcaai/noise-filter`, `@arcaai/vad`, `@arcaai/stt` | Stages of the transcription pipeline                                        |
| Optional peer | `@arcaai/med-ner`                                    | Browser NER stage; hook at `@arcaai/vox/plugins/med-ner`                    |
| Optional peer | `highlight.run`                                      | Optional logging transport                                                  |
| Optional peer | `@microsoft/clarity`                                 | Optional behavioural monitoring transport (non-production only)             |
| Talks to      | `apps/api` (NestJS gateway, port 8868)               | REST + WebSocket/SSE (streaming ASR via the STT service behind the gateway) |
| Consumed by   | `apps/admin-console`, `apps/compat-playground`       | In-repo consumers                                                           |

Peer dependencies: `react` / `react-dom` `^18.3.0 || ^19.0.4`.

## Entry points

| Import                        | Contents                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `@arcaai/vox`                 | Everything: core + audio plugin hooks and pipelines                                                                                  |
| `@arcaai/vox/core`            | Provider, hooks, types, client — no audio/ML plugin code. Includes `useBatchTranscription` (pre-recorded file upload + monitoring)   |
| `@arcaai/vox/plugins`         | `useVAD`, `useSTT`, `useNoiseFilter`, `useArcaAudio`, `useSttProviderToggle`, `useTtsPlayback`/`useTtsStream`, `PluginManager`, pipelines |
| `@arcaai/vox/plugins/med-ner` | `useMedNER` only — isolates the optional `@arcaai/med-ner` dependency so the main plugins entry never fails when it is not installed |
| `@arcaai/vox/compat`          | v1 (`@arcaai/agentic-sdk`) source-compatible hooks for migrating apps — see [Migrating from v1](#migrating-from-v1-arcaaivoxcompat)  |

Use `/core` for admin/dashboard surfaces that only need API access; audio and ML dependencies stay out of that graph.

**Entry bundles don't share a React context.** Each entry (`.`, `/core`, `/plugins`, `/plugins/med-ner`, `/compat`) is built as a separate bundle (`tsup.config.ts`, `splitting: false`), so a component tree rendered under `<ArcaCompatProvider>` (from `/compat`) must import every hook it uses — including v2-native ones like `useArcaSttLanguageModes` — from `/compat` too. Importing the "same" hook from `/core` in a `/compat`-provided tree throws (`useStoreApi()` finds no provider), even though the hook is re-exported under an identical name.

## Directory structure

```
packages/agentic-sdk-v2/
├── src/
│   ├── index.ts / core.ts / plugins.ts / plugins-med-ner.ts   # Entry points
│   ├── providers/     # AgenticProvider (owns one store instance per mount)
│   ├── hooks/         # useArca + focused domain/admin hooks (~45)
│   ├── store/         # Zustand store: createAgenticStore, useArcaStore, useStoreApi
│   ├── core/          # AgenticClient, ConfigManager/ConfigSchema (valibot),
│   │                  # PluginManager, TranscriptionPipeline, KnowledgePipeline,
│   │                  # SttWebSocketClient, SSEClient, StreamingSessionManager,
│   │                  # SharedConnectionManager/Worker, SimpleCrossTabSync,
│   │                  # PersonalizationManager, ModelRegistry, LocalVoiceEmbedder,
│   │                  # DualStreamRecorder, ProcessedAudioTap, FileTranscriptionService,
│   │                  # logger/ (SDKLogger + transports)
│   ├── types/         # Config, consultation, context, summary, STT, admin types
│   ├── utils/         # Diff, dates, errors, idempotency, citations, voice embedding
│   └── compat/        # v1-compat provider + hooks (entry: src/compat.ts) — see below
├── docs/API-Reference.md   # Full generated API reference
├── e2e/               # Playwright tests (fixtures + specs)
├── CHANGELOG.md
└── tsup.config.ts     # ESM + CJS for all four entries
```

## Quick start

```tsx
import { AgenticProvider, useArca } from '@arcaai/vox';

const config = {
  api: {
    baseUrl: 'https://api.arcaai.example.com',
    accessToken: 'jwt-from-your-auth-flow', // or apiKey for system keys (business plane only — admin hooks need the JWT)
    tenantId: 'tenant-id',
  },
  audio: {
    noiseFilter: { enabled: true, level: 'high' },
    vad: { enabled: true },
    stt: { enabled: true, language: 'en-US' },
  },
  debug: false,
};

function App() {
  return (
    <AgenticProvider config={config}>
      <ConsultationPage />
    </AgenticProvider>
  );
}

function ConsultationPage() {
  const { session, audio, context, summary, isReady, error } = useArca();

  const handleStart = async () => {
    // Get-or-create today's consultation for the patient
    await session.open({ patientId: 'patient-123' });
    await audio.start(); // pass { pipelineId } to stream via the backend ASR pipeline
  };

  if (!isReady) return <div>Loading…</div>;

  return (
    <div>
      {!session.consultation ? (
        <button onClick={handleStart}>Start Consultation</button>
      ) : (
        <>
          <p>
            Level: {audio.level}% — Speaking: {audio.isSpeaking ? 'Yes' : 'No'}
          </p>
          {audio.currentTranscript && <p>{audio.currentTranscript}…</p>}
          {context.transcriptions.map((t) => (
            <p key={t.id}>{t.content}</p>
          ))}
        </>
      )}
    </div>
  );
}
```

`useArca()` returns `{ session, audio, context, summary, pipelines, lifecycle, isAudioSource, isReady, error, withRetry }`. The same domains are available as focused hooks (`useArcaSession`, `useArcaAudio`, `useArcaContext`, `useArcaSummary`, `useArcaConfig`) when you do not want the aggregate.

## Architecture

### Provider and store

Each `AgenticProvider` mount creates its own Zustand store via `createAgenticStore()` and publishes it through context. Read it with the public accessors:

- `useArcaStore(selector)` — reactive, context-backed (same hook the SDK uses internally).
- `useStoreApi()` — the nearest provider's `StoreApi` for imperative `.getState()` reads.

Both throw outside an `AgenticProvider`. The exported `useAgenticStore` is a deprecated module singleton kept only for backwards compatibility — no provider initializes it, so its `apiClient`/`configManager` stay `null`; do not use it in new code. On tenant switch the provider calls `store.clearTenantSessionData()` before the new tenant config resolves, wiping tenant-scoped PHI/session state.

### Audio pipeline (TranscriptionPipeline)

`PluginManager` builds a `TranscriptionPipeline` that composes the audio packages as lazily-created stages on a `@arcaai/room` track:

```
Microphone → @arcaai/room AudioTrack
  → NoiseFilter stage (@arcaai/noise-filter, RNNoise WASM)
  → VAD stage (@arcaai/vad, Silero v5)
  → STT stage (@arcaai/stt: local Whisper worker, or backend streaming)
  → transcription events → store → context items
```

Per-capture runtime options flow through `useArcaAudio.start(options)` (`AudioStartOptions`): `pipelineId` (selects the backend ASR pipeline and switches the STT stage to a streaming transport built on `StreamingSessionManager` + `SttWebSocketClient`), `language`, `deviceId`, and `secondaryDeviceId` (second microphone mixed in via `AudioMixer` before the pipeline). `DualStreamRecorder` can record raw and processed tracks in parallel, and `createProcessedAudioTap` exposes the genuine post-RNNoise audio as a recordable stream without running the full pipeline.

> **Local (in-browser) transcription is disabled platform-wide (TASK-545).** `LOCAL_TRANSCRIPTION_ENABLED` in `src/core/constants.ts` gates the STT stage's local/offline path — it currently reads `false`, so `TranscriptionPipeline.resolveSTTRuntimeProvider()` never resolves to `'local'`: a configured backend transport (`stt.sttSocket`/`stt.streamingTransport`) resolves to `'remote'`; with no transport it throws `AgenticError('LOCAL_TRANSCRIPTION_DISABLED', ...)` instead of silently transcribing on-device (the local Whisper processor is never constructed while the flag is off — no model-download side effects). NoiseFilter and VAD are unaffected — they keep running in the browser as preprocessing stages for the backend stream. **To re-enable**, flip `LOCAL_TRANSCRIPTION_ENABLED` back to `true`; it is the single, findable switch.

### Knowledge pipeline

`KnowledgePipeline` post-processes transcription text with per-stage `location` (`browser`/`backend`/`auto`/`disabled`) and `triggerMode` (`auto`/`manual`): NER (browser via optional `@arcaai/med-ner`, or backend NLP), spell-check, and summarization (backend TEXT via `AgenticClient`).

### Transports and cross-tab behaviour

| Component                                              | Purpose                                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `AgenticClient`                                        | REST client: auth/refresh (single-slot 401 handler, `autoWireTokenRefresh`), idempotency keys, optimistic locking (ETag/If-Match) |
| `SttWebSocketClient`                                   | Streaming ASR WebSocket (audio frames out, transcripts in, reconnect)                                                             |
| `SSEClient`                                            | Server-sent events (job progress)                                                                                                 |
| `FileTranscriptionService` / `TranscriptionJobService` | File-based transcription jobs                                                                                                     |
| `SharedConnectionManager` + `SharedConnectionWorker`   | One shared WS/SSE connection across tabs (SharedWorker), dedup keyed per user                                                     |
| `SimpleCrossTabSync`                                   | BroadcastChannel `agentic.<tenantId>`, HMAC-authenticated messages (`CrossTabHmacKeyManager`, per-tenant HKDF subkeys)            |

### Consultation session lifecycle

1. `session.open({ patientId, appointmentDate? })` — get-or-create the consultation; related visits are exposed via `session.relatedConsultations` and `useConsultationChain`.
2. `audio.start(...)` — capture + pipeline; transcripts land in `context.transcriptions`; entities in `context.entities`.
3. `context.addCaseNote(...)`, `context.extractEntities()` — enrich the record.
4. `summary.generateSummary(...)` (or `generateSummaryAsync` for job-based generation with SSE progress) — versioning, diffs, and approval flows are exposed on `useArcaSummary`.
5. `audio.stop()`, then `useArcaSession().close()` (or a status `update`) closes out the visit; `reopen()` reverses it.

### Personalization and models

`PersonalizationManager` (IndexedDB) and `ModelRegistry` (custom STT/VAD/NER model definitions with load progress) persist per `${tenantId}::${userId}` namespace and re-key on auth/tenant switch. `LocalVoiceEmbedder` provides in-browser speaker embeddings (WavLM) for voice enrollment alongside the backend `useVoiceEmbedding`.

### Logging

`SDKLogger` with pluggable transports (`ConsoleTransport`, `HighlightTransport`, `ClarityTransport`, `LokiTransport`, `OTelTransport`), PII redaction, and W3C trace-context helpers. Configure via `config.logging`; access with `useSDKLogger()`.

#### Microsoft Clarity (behavioural monitoring)

> [!WARNING]
> **Clarity is non-production only, by design.** Clarity is a session-replay product: it reconstructs the page DOM, which on a HOPE surface contains consultation transcripts and patient context — PHI. Microsoft does **not** offer a HIPAA Business Associate Agreement for Clarity. `ClarityTransport` refuses to activate on a production deployment, exactly like `HighlightTransport`. Do not lift that gate without a signed BAA and a privacy review.

> [!IMPORTANT]
> **You must declare `environment` — on staging especially.** The activation gate tests the *deployment stage*, not the build mode. Every browser bundler bakes `process.env.NODE_ENV='production'` into any optimised build, **including the one you deploy to staging**. If `environment` is left undeclared, a staging deploy therefore looks like production and the transport silently disables itself. Set `environment: 'staging'` and it activates; `'production' | 'prod' | 'live'` always blocks. Same rule now applies to `HighlightTransport`.

Install the optional peer dependency:

```bash
pnpm add @microsoft/clarity
```

**The project ID is the on/off switch.** Supply one and Clarity is enabled; omit it and the transport is never constructed. Bind it to an env var and each deployment enables or disables Clarity purely by whether that variable is set — no code change, no flag to keep in sync:

```ts
<AgenticProvider
  config={{
    api: { baseUrl },
    logging: {
      clarity: {
        // Set CLARITY_PROJECT_ID=xynejqavet to enable; unset it to disable.
        projectId: process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID,
        environment: 'staging', // REQUIRED on staging — see the note above
        // level defaults to 'error' — Clarity is not a log sink
        upgradeOnError: true, // prioritise recording sessions that errored
      },
    },
  }}
/>
```

Empty and whitespace-only IDs count as "not configured", so an env var that resolves to `''` disables Clarity rather than crashing. To confirm what actually activated, check the SDK's startup log — `AgenticProvider` logs `transports: [...]`, which lists `clarity` only when it is live.

| To… | Do this |
| --- | --- |
| Enable Clarity | Set `projectId` |
| Disable Clarity | Omit `projectId` (or leave the env var unset) |
| Disable temporarily, keeping the ID | Add `enabled: false` |

Before enabling it anywhere, set the Clarity project's masking mode to **Mask All** in the Clarity dashboard and mark PHI-bearing elements `data-clarity-mask="true"`. Masking is a project-level setting — the npm SDK exposes no masking option, so the transport cannot enforce it from code.

| Config | Default | Notes |
| --- | --- | --- |
| `projectId` | — | **The on/off switch.** Set = enabled, unset/empty = disabled. |
| `enabled` | derived from `projectId` | Optional override. `false` forces Clarity off while keeping the ID configured; `true` is redundant and still requires a `projectId`. |
| `environment` | `NODE_ENV` | Deployment stage. **Must be `'staging'` on staging** — see the note above. |
| `level` | `'error'` | Only errors and completed operations become Clarity events. Use `'info'` to capture `vox.op.*` metrics. |
| `identifyUsers` | `false` | Sends the user id to Clarity's Identify API. Off by default — a user id is still a personal identifier handed to a third party. |
| `requireConsent` | `false` | Start with consent denied; grant later via `setConsent(true)`. |
| `upgradeOnError` | `false` | Ask Clarity to prioritise recording sessions containing an error. |

What the transport emits: `vox.error.<code>` and `vox.op.<name>` custom events, plus low-cardinality tags (`vox.service`, `vox.environment`, `vox.context`, `vox.component`, `vox.correlationId`, `vox.tenantId`, `vox.errorName`, `vox.errorCode`, `vox.httpStatus`, `vox.sdkVersion`). `vox.correlationId` is what links a Clarity session replay back to the gateway/Loki logs for the same request.

Two Clarity API constraints worth knowing: `event()` accepts a **name only** (no metadata — that is why detail travels as tags), and Clarity exposes **no stop/teardown API**, so `shutdown()` revokes consent rather than truly stopping recording.

#### Browser-wide capture (`console.*`, uncaught errors)

`SDKLogger` only sees what SDK code routes through it — application `console.*` calls, uncaught errors and unhandled promise rejections never reach a transport. That is why a staging bug report can arrive with an empty log trail while the browser console was full. `logging.capture` bridges them into the normal pipeline, so they flow to **every** transport (Clarity, Highlight, Loki, OTel) with `redactPHI()` applied.

```ts
logging: {
  capture: {
    console: true,                                          // default: false
    consoleMethods: ['log', 'info', 'debug', 'warn', 'error'], // default: ['warn','error']
    globalErrors: true,                                     // default: true
    maxEventsPerMinute: 500,                                // default: 200
  },
}
```

| Option | Default | Notes |
| --- | --- | --- |
| `console` | `false` | Off by default: console capture forwards arbitrary free-text, which `redactPHI()` cannot scrub (it scrubs known keys and `data:`/`blob:`/`file:` URLs). Enable only where data is synthetic. |
| `consoleMethods` | `['warn','error']` | `log`/`info`/`debug` are high-volume; opt in for a full staging trail. |
| `globalErrors` | `true` | `window.onerror` + `unhandledrejection`. Pure signal. |
| `maxArgLength` | `2000` | Per-argument truncation. |
| `maxEventsPerMinute` | `200` | Rolling cap so a render-loop cannot flood transports or the Clarity event quota. A suppressed-count warning is emitted when the window rolls. |

Original console output is always preserved — capture wraps, never replaces. A re-entrancy guard stops the obvious infinite loop (patched console → logger → `ConsoleTransport` → patched console), and the provider restores the original methods on unmount.

#### Recommended staging configuration

Everything captured, on the environment where the data is synthetic:

```ts
logging: {
  level: 'debug',
  clarity: {
    projectId: process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID, // unset ⇒ Clarity off
    environment: 'staging',
    level: 'info',        // lets vox.op.* operation metrics through; 'error' would drop them
    upgradeOnError: true,
  },
  capture: {
    console: true,
    consoleMethods: ['log', 'info', 'debug', 'warn', 'error'],
    globalErrors: true,
    maxEventsPerMinute: 500,
  },
  // Full log/metric retention — Clarity is a behavioural tool, not a log backend.
  loki: { enabled: true, url: process.env.LOKI_URL! },
}
```

Note the `clarity.level: 'info'` — at the default `'error'` floor, `vox.op.*` operation-timing events are filtered out before they become Clarity events. For searchable log/metric **retention**, pair Clarity with Loki or OTel: those transports have a real log sink and no environment gate, whereas Clarity can only record name-only events plus tags.

#### From `@arcaai/vox/compat`

`ArcaCompatProvider` renders `AgenticProvider`, so compat apps use the same transports — configured through a `logging` block on the v1 options object (compat-native; v1 had no logging config):

```ts
const SDK_CONFIG_OPTIONS = {
  apiEndpoint: 'https://staging-api.arcaai.com',
  websocketUrl: 'wss://staging-api.arcaai.com',
  credentials: { apiKey: KEY },                 // business plane only — see the admin-hooks note above
  environment: 'staging',                       // ← also feeds the transport stage gate
  logging: {
    clarity: { projectId: process.env.CLARITY_PROJECT_ID, level: 'info' },
    capture: { console: true, consoleMethods: ['log', 'info', 'warn', 'error'] },
  },
};

<ArcaCompatProvider options={SDK_CONFIG_OPTIONS}>{children}</ArcaCompatProvider>;
```

The v1 `environment` propagates into `clarity.environment` and `highlight.environment`, so declaring `environment: 'staging'` once satisfies the deployment-stage gate — no need to restate it per transport. An explicit transport-level `environment` still wins. Omit `logging` entirely and the mapped config is byte-identical to before, with no transports configured.

**Compat has no signed-in user, and Clarity does not need one.** Clarity mints its own anonymous session ID; session replay, heatmaps and custom events all work without any identity. Sessions are correlated by the `vox.correlationId` tag (auto-generated per provider mount — `autoCorrelationId` defaults to true) and `vox.tenantId`. The `identifyUsers` option is purely optional and simply never fires when there is no user; it is off by default in any case. Note this is not compat-specific: `logger.withUser()` has no call sites in the SDK today, so `entry.user.userId` is unpopulated on the native path too.

## Migrating from v1 (`@arcaai/vox/compat`)

`@arcaai/vox/compat` lets a HOPE v1 app (`@arcaai/agentic-sdk`) move to this SDK by changing an import specifier and adding one provider (`ArcaCompatProvider`) — no rewrite of call sites. It ships six hooks: `useArcaSessionManager`, `useAudioCapture`, `useArcaSpeechToText`, `useText`, `useArcaSttProvider`, and `useArcaSttLanguageModes`. Compat hooks are thin adapters that **only consume the public v2 API** (the hooks/store/clients documented above) — they never reach into v2 internals.

**Installing the SDK (GitHub Packages auth, install command, peer deps):** [`docs/Compat-API-Reference.md#installation`](docs/Compat-API-Reference.md#installation).
**Full compat API reference (setup, every hook's signature and gotchas, the metadata-precedence contract, reproduced v1 types):** [`docs/Compat-API-Reference.md`](docs/Compat-API-Reference.md).
**External microphones / injected streams (start order, ownership, liveness, the silent-uplink watchdog):** [`docs/Compat-API-Reference.md` §8](docs/Compat-API-Reference.md#8-external-microphones--injected-streams).
**Migration walkthrough:** [`docs/implementation/TASK-560-v1-v2-consultation-migration/MIGRATION_GUIDE.md`](../../docs/implementation/TASK-560-v1-v2-consultation-migration/MIGRATION_GUIDE.md) — 3-step checklist, side-by-side hook table, full before/after code sample, verification checklist.
**Working example:** `apps/compat-playground` (port 5177) — a full runnable reference exercising every compat hook end to end.

## Hooks overview

| Group            | Hooks                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Consultation     | `useArca`, `useArcaSession`, `useArcaAudio`, `useArcaContext`, `useArcaSummary`, `useArcaConfig`, `useConsultationChain`, `useConsultationJob`, `useAudioRecordings`                                                                                   |
| Auth and tenancy | `useAuth`, `useTenants`, `useTenantFrontendConfig`, `useTenantStorageConfig`, `useTenantBuckets`, `useEntitlements`                                                                                                                                    |
| Admin¹           | `useUsers`, `useRoles`, `useDepartments`, `useUserDepartments`, `usePolicies`, `usePrompts`, `useApiKeys`, `useAuditLog`, `useAdminConsultations`, `useAdminTranscriptionJobs`, `useHarnessAdmin`, `useQueueAdmin`, `useRateLimits`, `usePrismaStudio` |
| Platform         | `useHealthCheck`, `useMonitoring`, `usePlatformMetrics`, `usePipelines`, `useGlobalSettings`, `useUserSettings`, `useStorage`, `useStorageKeys`                                                                                                        |
| Voice and DNA    | `useVoiceEmbedding`, `useLocalVoiceEmbedding`, `useDnaStyle`, `useDnaDashboard`                                                                                                                                                                        |
| Audio plugins    | `useVAD`, `useSTT`, `useNoiseFilter` (from `/plugins`), `useMedNER` (from `/plugins/med-ner`)                                                                                                                                                          |
| Compat (v1 migration) | `ArcaCompatProvider`, `useArcaSessionManager`, `useAudioCapture`, `useArcaSpeechToText`, `useText`, `useArcaSttProvider`, `useArcaSttLanguageModes` (all from `/compat` — see [Migrating from v1](#migrating-from-v1-arcaaivoxcompat))                |

> **¹ Admin hooks require a JWT.** `/api/v1/admin/*` is a **JWT-only** plane (policy A2): API
> keys are prohibited there and every request carrying one is refused with `403 This route does not
> accept API-key authentication` — including a key holding the `'*'` wildcard. Configure
> `credentials: { accessToken }` for any admin hook; `credentials: { apiKey }` reaches the business
> plane (consultations, STT/TTS, storage, self-service `me` surfaces) only.
>
> The reason is credential class, not privilege: an API key is a long-lived static bearer secret
> with no MFA, no session expiry, no revocation-on-logout and no impersonation audit trail.
> Headless administration is unsupported until the platform's service-account credential ships.


Full signatures and types: [docs/API-Reference.md](docs/API-Reference.md). Release history: [CHANGELOG.md](CHANGELOG.md).

## Requirements

- React `^18.3.0` or `^19.0.4` (security-patched versions; the SDK is client-side only and every entry carries `"use client"`).
- Modern browser with Web Audio API; microphone permission is requested when audio starts.
- Local Whisper STT benefits from cross-origin isolation (COOP/COEP) for multi-threaded inference — see `../stt/README.md`.
- To use browser NER, install the optional peer `@arcaai/med-ner` and import from `@arcaai/vox/plugins/med-ner`.
- Do not embed long-lived API keys in production client code; prefer short-lived access tokens via your auth flow. This SDK processes medical data — deploy in line with HIPAA/GDPR obligations.

## Debug mode

Set `debug: true` in the config to enable verbose `[ARCAAI:DEBUG]` console logging: pipeline configuration dumps at startup and structured transcript JSON for every final transcription result. The flag propagates `debugMode` into the noise-filter, VAD, and STT processors automatically.

## Commands

From this directory:

| Command                         | Action                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm build` / `pnpm dev`       | tsup build of all four entries / watch mode                                                        |
| `pnpm test` / `pnpm test:watch` | Vitest unit tests                                                                                  |
| `pnpm test:e2e`                 | Builds, then Playwright (`e2e/playwright.config.ts`); `:ui`, `:headed`, `:chromium` variants exist |
| `pnpm lint`                     | ESLint on `src`                                                                                    |
| `pnpm typecheck`                | `tsc --noEmit`                                                                                     |
| `pnpm clean` / `pnpm clean:all` | Remove build output (nuke also removes `node_modules`)                                             |

From the repo root: `pnpm --filter @arcaai/vox build` (same pattern for `test`, `lint`, etc.).

## Related packages

| Package                | Role                                      |
| ---------------------- | ----------------------------------------- |
| `@arcaai/room`         | Audio capture, tracks, processor pipeline |
| `@arcaai/noise-filter` | RNNoise WASM noise cancellation           |
| `@arcaai/vad`          | Silero voice activity detection           |
| `@arcaai/stt`          | Whisper STT (worker) + backend streaming  |
| `@arcaai/med-ner`      | Optional browser medical NER              |

## License

MIT

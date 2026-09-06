# @arcaai/vox

React SDK for ARCAAI medical consultation workflows. Provides a configuration-driven provider (`AgenticProvider`), a unified `useArca()` hook plus 40+ focused hooks, real-time capture streamed to backend transcription (selected by the tenant's ASR Agent), consultation/context/summary management against the HOPE API gateway, and multi-tenant-safe browser state (per-provider Zustand stores, namespaced persistence, cross-tab sync).

> **The browser captures audio and renders results. It never runs a model.** (TASK-865, owner directive 2026-09-04.) VAD, denoise, ASR and NER are server-side decisions of the tenant's agents; the in-browser model packages are deprecated and removed in R4. See [The browser never runs a model](#the-browser-never-runs-a-model).

Last updated: 2026-09-04

## Where it fits

| Direction     | Package / app                                        | Relationship                                                                |
| ------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Depends on    | `@arcaai/room`                                       | Audio capture, `AudioTrack`, processor contract, `AudioMixer`               |
| Depends on    | `@arcaai/stt`                                        | The backend STREAMING transport (`StreamingBackendSTTProvider`) and PCM capture helpers; its in-browser Whisper is **deprecated** (removed in R4) |
| Depends on    | `@arcaai/noise-filter`, `@arcaai/vad`                | **Deprecated** client models (removed in R4) — never constructed unless `audio.clientInference: { allow: true }` |
| Optional peer | `@arcaai/med-ner`                                    | **Deprecated** browser NER (removed in R4); hook at `@arcaai/vox/plugins/med-ner` |
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
| `@arcaai/vox/plugins`         | `useArcaAudio`, `useTtsPlayback`/`useTtsStream`, `PluginManager`, pipelines. Also re-exports the **deprecated** `useVAD`, `useSTT`, `useNoiseFilter`, `useSttProviderToggle` (removed in R4) |
| `@arcaai/vox/plugins/med-ner` | **Deprecated** (removed in R4) — `useMedNER` only; isolates the optional `@arcaai/med-ner` dependency |
| `@arcaai/vox/compat`          | v1 (`@arcaai/agentic-sdk`) source-compatible hooks for migrating apps — see [Migrating from v1](#migrating-from-v1-arcaaivoxcompat)  |

Use `/core` for dashboard-style surfaces that only need API access; audio and ML dependencies stay out of that graph. (`@arcaai/vox` itself carries no ADMINISTRATION surface — see [Business plane only](#business-plane-only-no-management-surface).)

**Entry bundles don't share a React context.** Each entry (`.`, `/core`, `/plugins`, `/plugins/med-ner`, `/compat`) is built as a separate bundle (`tsup.config.ts`, `splitting: false`), so a component tree rendered under `<ArcaCompatProvider>` (from `/compat`) must import every hook it uses — including v2-native ones like `useArcaSttLanguageModes` — from `/compat` too. Importing the "same" hook from `/core` in a `/compat`-provided tree throws (`useStoreApi()` finds no provider), even though the hook is re-exported under an identical name.

## Directory structure

```
packages/agentic-sdk-v2/
├── src/
│   ├── index.ts / core.ts / plugins.ts / plugins-med-ner.ts   # Entry points
│   ├── providers/     # AgenticProvider (owns one store instance per mount)
│   ├── hooks/         # useArca + focused, business-plane domain hooks (no management surface — TASK-890)
│   ├── store/         # Zustand store: createAgenticStore, useArcaStore, useStoreApi
│   ├── core/          # AgenticClient, ConfigManager/ConfigSchema (valibot),
│   │                  # PluginManager, TranscriptionPipeline, KnowledgePipeline,
│   │                  # SttWebSocketClient, SSEClient, StreamingSessionManager,
│   │                  # SharedConnectionManager/Worker, SimpleCrossTabSync,
│   │                  # PersonalizationManager, ModelRegistry, LocalVoiceEmbedder,
│   │                  # DualStreamRecorder, ProcessedAudioTap, FileTranscriptionService,
│   │                  # logger/ (SDKLogger + transports)
│   ├── types/         # Config, consultation, context, summary, STT types
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
    accessToken: 'jwt-from-your-auth-flow', // or apiKey for system keys (business plane only — @arcaai/vox carries no admin hooks)
    tenantId: 'tenant-id',
  },
  // Backend streaming STT. No client model: VAD/denoise run server-side,
  // selected by the tenant's ASR Agent (TASK-865).
  audio: {
    stt: { enabled: true, provider: 'backend', language: 'en-US' },
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
    await audio.start(); // or { agentSlug } to name a published ASR Agent; omit it and the tenant assignment cascade decides
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

### The browser never runs a model

Owner directive (TASK-865, 2026-09-04): *by default, disable all local/client-side AI capabilities such as VAD, noise suppression — no need to load VAD or any AI model in the client.* The SDK's default — and only supported — capture graph is therefore:

```
Microphone → @arcaai/room AudioTrack (native getUserMedia constraints: echoCancellation / noiseSuppression / autoGainControl stay ON — they cost nothing and load nothing)
  → STT stage (@arcaai/stt StreamingBackendSTTProvider over StreamingSessionManager + SttWebSocketClient)
  → gateway → STT service (server-side VAD, denoise, diarization, ASR — selected by the tenant's ASR Agent)
  → transcription events → store → context items
```

What transcribes is a **server-side decision**. The client may name the tenant's published ASR Agent by slug (a lineage key, like `workflowDefinitionSlug` at `session.open()`), or name nothing and let the tenant → department `AgentAssignment` cascade decide. It never names a pipeline, an engine, a model or a VAD:

```tsx
const { agents, tenantDefault } = useSelectableAsrAgents(); // GET /agents?task=SPEECH_TO_TEXT — null (could not ask) ≠ [] (none published)
await audio.start({ agentSlug: agents?.[0]?.slug });        // or omit agentSlug → the assignment cascade decides
```

Per-capture runtime options still flow through `useArcaAudio.start(options)` (`AudioStartOptions`, exported from `/core` and the root): `agentSlug`, `language`, `languageMode`, `deviceId`, `secondaryDeviceId` (mixed via `AudioMixer`), `audioProcessing`, the stop-drain knobs. `pipelineId` is **deprecated** (removed in R4): still forwarded with a warning, and when both are passed `agentSlug` wins and `pipelineId` is dropped — with a warning, never silently.

**The hard-off gate.** `DEFAULT_AUDIO_CONFIG` and the pipeline-level `DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG` both declare the `noiseFilter` (RNNoise) and `vad` (Silero) client stages OFF, and the runtime **ignores `enabled: true`** for them — logging a deprecation warning once per pipeline — unless the host also sets `audio.clientInference: { allow: true }`. That switch exists only so a host that genuinely needs in-browser VAD/denoise during the deprecation window can keep it; it is deprecated on arrival and retires with the packages in R4. Nothing else in the SDK loads a model: local Whisper is gated by `LOCAL_TRANSCRIPTION_ENABLED = false` (a configured backend transport resolves to `'remote'`; with none it throws `AgenticError('LOCAL_TRANSCRIPTION_DISABLED')` rather than transcribing on-device), browser NER lives behind the deprecated `/plugins/med-ner` entry, and `useLocalVoiceEmbedding` (WavLM) is deprecated in favour of the server-side `useVoiceEmbedding`.

Deprecated with removal in R4 (register: `docs/operations/deprecation-register.md` §SDK): `@arcaai/vad`, `@arcaai/noise-filter`, `@arcaai/stt`'s in-browser Whisper, `@arcaai/med-ner` + `/plugins/med-ner`, `useVAD`/`useSTT`/`useNoiseFilter`, `useLocalVoiceEmbedding`, `AudioStartOptions.pipelineId`, `usePipelines`, `useArcaPipelines`, `useSttProviderToggle`, the `selectedPipelineId` user setting, `DEFAULT_LOCAL_CONFIG`'s model pins, `LOCAL_TRANSCRIPTION_ENABLED`, and the compat `sttPipelineId` (use `sttAgentSlug`). `DualStreamRecorder` and `createProcessedAudioTap` (post-RNNoise taps) follow the noise filter out.

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
2. `audio.start({ pipelineId })` — capture + pipeline; transcripts land in `context.transcriptions`; entities in `context.entities`.
   Omit `pipelineId` and the tenant's default engine runs; pass one to bind this session to a specific
   published STT pipeline. List them with `usePipelines().list()` (`GET /audio/pipelines`) — its
   `createPipeline`/`updatePipeline`/… siblings target the admin plane and are not reachable from a
   browser. `audio.start` also takes `language`, `languageMode`, `deviceId`, and `secondaryDeviceId`
   (mixed with the primary via `@arcaai/room`'s `AudioMixer`).
   Read live transcript off `useArcaAudio()`: `transcriptSegments` (finalized `TranscriptSegment[]`)
   and `currentTranscript` (the interim string).
   *Note: the `AudioStartOptions` type itself is not exported from any entry point today — pass an
   object literal rather than annotating it.*
3. `context.addCaseNote(...)`, `context.extractEntities()` — enrich the record.
4. `summary.generateSummary(...)` (or `generateSummaryAsync` for job-based generation with SSE progress) — versioning, diffs, and approval flows are exposed on `useArcaSummary`.
5. `audio.stop()`, then `useArcaSession().close()` (or a status `update`) closes out the visit; `reopen()` reverses it.

### Choosing the workflow that governs a consultation

A consultation is documented by one of two engines. By default the platform's own consultation
loop does it. If your tenant has published a `consultation`-palette workflow in Workflow Studio,
the `department → tenant → platform-default` assignment cascade can hand the consultation to that
instead — and `session.open()` lets you override the cascade for one consultation:

```ts
await session.open({ patientId, workflowDefinitionSlug: 'discharge_summary' });
```

**Which slugs may you pass?** Ask — do not guess:

```ts
const { workflows, tenantDefault } = useSelectableConsultationWorkflows();

workflows            // [{ slug, name, description, isTenantDefault }, ...] — every slug `open` accepts
workflows === null   // unknown — the read has not resolved, or it failed
workflows.length===0 // asked, and your tenant has published none: the default engine governs
tenantDefault        // what governs if you pass no slug at all — a sensible preselection
```

`GET /consultations/workflows` answers from the **same predicate** that authorizes `open`, so a
slug it lists is never refused and a slug it omits is never accepted. It is gated by the ability
`open` itself needs (`create:Consultation`), not by a workflow-definition ability — a
clinician-facing integration can enumerate its options without being able to read the workflow
plane. It is scoped to your session's tenant and takes no parameters.

Do **not** reach for `GET /workflows` here: that is the exposure plane (invokable products), it
needs `workflow:definition:read`, and it excludes the `consultation` palette entirely — it lists
none of these.

`useSelectableConsultationWorkflows` fails open exactly like `useConsultationWorkflow` below:
`null` is "we could not ask", `[]` is "there are none". Never collapse the two — an empty picker
on a network blip tells a clinician something false about their tenant.

The gateway authorizes the slug **before the consultation is written**, against your own tenant's
published, active `consultation`-palette definitions:

| Outcome | Status | Why |
| --- | --- | --- |
| Not visible to your tenant — another tenant's slug, an unknown one, or one that is not published/active | `404` | Answering `403` would confirm the slug exists. All three are deliberately indistinguishable. |
| Visible to your tenant, but not a `consultation`-palette definition | `403` | A definition you authored and can already see in the admin plane; hiding it would send you hunting for a row that is plainly there. `useSelectableConsultationWorkflows` never lists these. |
| Not a well-formed slug (`[a-z0-9_]{2,48}`) | `400` | Refused at the edge — it could never name a real row. |

Omit the field and the cascade decides, exactly as before. It is honoured by `session.open()` only:
a re-visit dispatches no consultation workflow, so there is nothing there to steer.

**Selecting is not the same as running.** Dispatch is best-effort by design — a clinician must be
able to open a consultation while the harness is down — so a dispatch failure silently degrades to
the platform default engine rather than failing the open. Read back what actually governs:

```ts
const { workflow, isGoverned } = useConsultationWorkflow(); // defaults to the session's consultation

isGoverned              // true  -> a tenant-authored workflow is writing this document
workflow?.governed      // false -> the platform default engine is
workflow === null       // unknown — the read has not resolved, or it failed
```

`useConsultationWorkflow` **fails open**: a failed read resolves to `null` and reports the reason on
`error`, never a rejection. Treat `null` as "we do not know", never as "the default engine governs" —
they are distinct states on purpose.

`workflow.inputSchema` is always `null` today. No per-definition input schema is declared anywhere
in the platform yet; the field exists so that declaring one later is additive rather than something
you have to discover. Note also that a consultation-governing graph takes no caller input at all —
the interpreter payload is built server-side.

### Running workflows

`useWorkflowRun` is the browser half of the workflow invocation plane; `@arcaai/vox-node`'s
`hope.workflows` / `hope.consultations.workflows` is the server half, over the same routes.

```tsx
const { workflows, start, events, status, isRunning, cancel } = useWorkflowRun();

await start(slug, { note });                    // unbound plane
await start(slug, input, { consultationId });   // writes into a clinical record
```

- **`workflows: null` is not `[]`.** `null` means the catalogue read has not resolved (or failed);
  `[]` means the tenant published none. Collapsing the two tells a user they have no workflows
  because a request blipped — the same rule `useSelectableConsultationWorkflows` follows.
- **The stream resumes.** `start()` streams by default and reconnects with `lastEventId`, so a
  disconnect costs latency, not frames. `watch(slug, runId, lastEventId?)` attaches to a run started
  earlier — e.g. one whose id you persisted across a page reload.
- **Never put a reserved key in `input`.** `consultationId`, `externalPatientId`, `userId`, `jobId`
  and `sessionId` are stamped server-side; the hook throws `ReservedRunIdentityError` synchronously
  rather than letting the gateway 400. The consultation is named by `options.consultationId`, not by
  the payload.
- **There is no "list my runs" call.** The business plane exposes a run only by `runId`
  (`GET /workflows/:slug/runs/:runId`); listing is admin-plane and API-key-forbidden. Keep the
  `runId` you were handed — you cannot re-discover it.

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
  credentials: { apiKey: KEY },                 // business plane only — see `Business plane only` above
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
| Consultation     | `useArca`, `useArcaSession`, `useArcaAudio`, `useArcaContext`, `useArcaSummary`, `useArcaConfig`, `useConsultationChain`, `useConsultationJob`, `useConsultationSchema`, `useConsultationWorkflow`, `useSelectableConsultationWorkflows`, `useAudioRecordings`                                |
| Live streams²    | `useArcaLiveSummary`, `useArcaLiveAssist`, `useConsultationEvents`, `useWorkflowRun`                                                                                                                                                                                          |
| Agents and workflows | `useSelectableAsrAgents`, `useAgentInvocation` (invoke a PUBLISHED agent), `useWorkflowReview` (release a `core.humanReview` node) — business plane only, see [Business plane only](#business-plane-only-no-management-surface) |
| Auth and self-service | `useAuth`, `useUserSettings` (self-only, `/users/me/settings`) |
| Platform         | `usePipelines` (deprecated, removed in R4), `usePolicies`, `useStorage`                                                                                                        |
| Voice            | `useVoiceEmbedding`, `useLocalVoiceEmbedding`                                                                                                                                                                        |
| Audio plugins    | `useVAD`, `useSTT`, `useNoiseFilter` (from `/plugins`), `useMedNER` (from `/plugins/med-ner`)                                                                                                                                                          |
| Compat (v1 migration) | `ArcaCompatProvider`, `useArcaSessionManager`, `useAudioCapture`, `useArcaSpeechToText`, `useText`, `useArcaSttProvider`, `useArcaSttLanguageModes` (all from `/compat` — see [Migrating from v1](#migrating-from-v1-arcaaivoxcompat))                |

### Business plane only — no management surface

**`@arcaai/vox` carries NO administration capability (TASK-890, OD-F/OD-K).** The admin-hook
families that used to live here — users, roles, departments, tenants, prompts, API keys, audit
logs, entitlements, global settings, monitoring, platform metrics, DNA style, rate limits, queues,
Prisma Studio, harness policy, tenant storage/buckets/frontend-config — are gone, along with the
`/admin/*` endpoint constants that backed them. `useUserSettings` is the one exception, and it is
self-only (`/users/me/settings`), never another user's.

`AgenticClient` enforces the same boundary at the transport layer: any request whose path matches
`isAdminPlanePath` (`/admin/*`, plus the two legacy non-`/admin/` admin-only surfaces
`/monitoring/*` and `/health/services*`) throws a named `AdminPlaneRefusedError` before any network
call is made — regardless of credential (JWT or API key) or impersonation state. Administration
lives in [`@arcaai/vox-node`](../vox-node/README.md)'s `hope.admin.*` (service-account credential)
or the admin console.

> **² Live streams are SSE, and each opens with a single-use ticket.** All four follow the same
> shape — `start(id)` / `stop()` plus `status` (`idle | connecting | open | error | closed`) — and
> connect against `apiClient.getStreamBaseUrl()`, so long-lived connections bypass a BFF and go to
> the gateway directly. `POST /auth/stream-ticket` is **JWT-only**: an API key cannot mint a ticket,
> so these hooks require `credentials: { accessToken }`.
>
> | Hook | Stream | Carries |
> | --- | --- | --- |
> | `useArcaLiveSummary` | `GET /consultations/:id/live-summary/stream` | **Full-state** snapshots: `runningSummary`, `sections`, `entities`, `vitals`. Keep only the latest — it is not a log. |
> | `useArcaLiveAssist` | `GET /consultations/:id/live-assist/stream` | **Full-state** snapshots carrying BOTH branches: `suggestions` and `corrections` (span-anchored proposals). Keep only the latest — an omitted branch means "there are none". **No terminal event** — you close it. **PHI**: a proposal quotes the original span verbatim. |
| `useConsultationEvents` | `GET /consultations/:id/loop/stream` | **Append-only** `LoopEvent`s (`kind` is an open string namespace, e.g. `action.started`). Capped at the last 500. **No resume** — frames published while disconnected are gone, and there is no server-side buffer. |
> | `useWorkflowRun` | `GET /workflows/:slug/runs/:runId/stream` | Workflow run frames, **with** resume (`Last-Event-ID`). Also does the listing, starting and cancelling — see [Running workflows](#running-workflows). |
>
> `useArcaLiveSummary`'s `snapshot.entities[]` gives you `{ text, type, confidence?, icd10?, start?, end? }`.
> **`start`/`end` are character offsets into `snapshot.runningSummary`, not into the transcript** —
> use them to highlight the summary, and match on `text` if you need to mark up the transcript.
>
> **Grammar corrections and suggestions ride the fourth stream, `useArcaLiveAssist`.** It takes an
> optional consultation id (`useArcaLiveAssist(id)` auto-connects and follows an id change; call it
> with no argument to drive `start`/`stop` yourself) and returns
> `{ suggestions, corrections, lastEvent, status, connected, error, start, stop }`. Do not go
> looking for these on `useConsultationEvents` — the loop stream carries ids and labels only.
>
> **Nothing on that feed has been applied to the note.** `corrections.applied` is `false` under
> proposal-first: the clinician decides. Each proposal's `start`/`end` are character offsets into
> the text named by `corrections.textSha256` — check that hash against the text you are about to
> patch, or the offsets may land on drifted content.

### Which credential to use — this SDK is JWT-first

`AgenticClient` accepts `accessToken` (a gateway JWT) and `apiKey` at the same time and sends each
independently, so both genuinely work on the business plane. An API key **can** open a consultation.
The recommendation is not a capability limit — it is about what each credential is:

| | JWT (`accessToken`) | API key (`apiKey`) |
| --- | --- | --- |
| Bound to | one **user**, for one session | the **tenant**, indefinitely |
| Lifetime | short, expiring, refreshable | long-lived and static until rotated |
| Revocation | logout, session end, refresh-token rotation | manual rotation only |
| Carries the identity abilities compose against | yes | no — a key's scopes bind the *credential*; abilities bind the bound *human*, and the two compose as **AND**, so a key can never exceed its human |
| Admin plane (`/api/v1/admin/*`) | **never** — the SDK itself refuses it (TASK-890, `AdminPlaneRefusedError`) | **never** — refused unconditionally (policy A2) |

For a **user-facing frontend, use the JWT.** A key shipped to a browser is a static, long-lived,
shared secret sitting in code every user can read, and nothing about a page load can revoke it.

API keys are the right credential for **server-side and integration** callers — where the secret
stays on your server, is rotatable, and is not handed to an end user. For those, prefer
[`@arcaai/vox-node`](../vox-node/README.md), which is built for that shape (no React, no audio, no
DOM) and also carries the service-account credential the admin plane requires.


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

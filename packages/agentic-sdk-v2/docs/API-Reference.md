# @arcaai/vox SDK — API Reference

**Package**: `@arcaai/vox` &middot; **Version**: 2.0.0  
**Peer Dependencies**: `react` 18/19, `react-dom` 18/19  
**Optional Peers**: `@arcaai/med-ner`, `highlight.run`

> Auto-generated from source on 2026-03-28. Verified against every hook, type, and barrel export.

---

## Table of Contents

- [Setup](#setup)
- [Import Paths](#import-paths)
- [1. useArca — Unified Hook](#1-usearc--unified-hook)
- [2. Focused Domain Hooks](#2-focused-domain-hooks)
  - [useSttProviderToggle() — live pipeline ↔ default](#usesttprovidertoggle--live-pipeline--default)
  - [useBatchTranscription() — pre-recorded files](#usebatchtranscription--pre-recorded-files)
- [3. useAuth — Authentication](#3-useauth--authentication)
- [4. useArcaConfig — Configuration](#4-usearcaconfig--configuration)
- [5. Admin & Management Hooks](#5-admin--management-hooks)
- [6. Infrastructure Hooks](#6-infrastructure-hooks)
- [7. Provider & Context Hooks](#7-provider--context-hooks)
- [8. Plugin Hooks](#8-plugin-hooks)
- [9. Advanced Core Classes](#9-advanced-core-classes)
- [10. Utility Functions](#10-utility-functions)
- [11. Key Types](#11-key-types)

---

## Setup

Wrap your application with `AgenticProvider`:

```tsx
import { AgenticProvider, useArca } from '@arcaai/vox';

const config: AgenticConfig = {
  api: {
    baseUrl: 'https://api.arcaai.com',
    apiKey: 'your-key',
    accessToken: 'jwt-token', // optional
    tenantId: 'tenant-uuid', // optional
  },
  audio: {
    noiseFilter: { enabled: true, level: 'high' },
    vad: { enabled: true, sensitivity: 0.5 },
    stt: { enabled: true, language: 'en', provider: 'auto' },
  },
  plugins: {
    ner: { enabled: true, autoExtract: true },
  },
  personalization: { storage: 'hybrid' },
  logging: {
    level: 'debug',
    console: { enabled: true, colorize: true },
    highlight: { enabled: true, projectId: 'YOUR_ID' },
    otel: { enabled: true, endpoint: 'https://otel.example.com' },
  },
  debug: false,
};

function App() {
  return (
    <AgenticProvider config={config}>
      <YourApp />
    </AgenticProvider>
  );
}
```

---

## Import Paths

| Path                          | Contents                                                                | Use Case                                           |
| ----------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| `@arcaai/vox`                 | Everything (core + plugins)                                             | Full SDK                                           |
| `@arcaai/vox/core`            | Core hooks, types, utils, classes (no audio plugin deps)                | Admin dashboards, SSR, lightweight bundle (~200KB) |
| `@arcaai/vox/plugins`         | Plugin hooks (useSTT, useVAD, useNoiseFilter), PluginManager, pipelines | Audio processing features                          |
| `@arcaai/vox/plugins/med-ner` | `useMedNER` hook                                                        | Medical NER (requires `@arcaai/med-ner` ~300MB)    |

---

## 1. useArca — Unified Hook

The primary hook providing access to all consultation functionality through namespaced sub-objects.

```tsx
import { useArca } from '@arcaai/vox';

function ConsultationPage() {
  const { session, audio, context, summary, pipelines, lifecycle, isAudioSource, isReady, error, withRetry } = useArca();
}
```

**Returns**: `UseArcaReturn`

| Property        | Type                                                              | Description                                     |
| --------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| `session`       | [`UseArcaSession`](#session)                                      | Session management                              |
| `audio`         | [`UseArcaAudio`](#audio)                                          | Audio capture & control                         |
| `context`       | [`UseArcaContext`](#context)                                      | Context items management                        |
| `summary`       | [`UseArcaSummary`](#summary)                                      | Summary generation & management                 |
| `pipelines`     | [`UseArcaPipelineControl`](#pipelines)                            | Pipeline control                                |
| `lifecycle`     | [`UseArcaLifecycle`](#lifecycle)                                  | Tab-close safety, graceful shutdown             |
| `isAudioSource` | `boolean`                                                         | Whether this tab owns audio capture (cross-tab) |
| `isReady`       | `boolean`                                                         | SDK initialized and ready                       |
| `error`         | `Error \| null`                                                   | Global SDK error                                |
| `withRetry`     | `<T>(fn: () => Promise<T>, options?: RetryOptions) => Promise<T>` | Retry wrapper for retriable API operations      |

---

### session

| Member                 | Signature                                                                       | Description                                |
| ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| `consultation`         | `Consultation \| null`                                                          | Current active consultation                |
| `relatedConsultations` | `Consultation[]`                                                                | Related consultations in the chain         |
| `isLoading`            | `boolean`                                                                       | Loading state                              |
| `error`                | `Error \| null`                                                                 | Session error                              |
| `open`                 | `(input: OpenSessionInput) => Promise<Consultation>`                            | Open a consultation (get-or-create)        |
| `load`                 | `(id: string) => Promise<Consultation>`                                         | Load a specific consultation by ID         |
| `findByPatientDate`    | `(patientId: string, date: string) => Promise<Consultation[]>`                  | Find consultations by patient + date       |
| `getPatientHistory`    | `(patientId: string, pagination?: PaginationParams) => Promise<Consultation[]>` | Get patient consultation history           |
| `getTimeline`          | `(scope?: 'single' \| 'chain') => Promise<TimelineEntry[]>`                     | Get consultation timeline                  |
| `listConsultations`    | `(params?: ListConsultationsParams) => Promise<PaginatedConsultations>`         | List consultations with filters/pagination |

---

### audio

| Member               | Signature                                        | Description                                    |
| -------------------- | ------------------------------------------------ | ---------------------------------------------- |
| `isCapturing`        | `boolean`                                        | Audio capture active                           |
| `isMuted`            | `boolean`                                        | Microphone muted                               |
| `level`              | `number`                                         | Current audio level (0–100)                    |
| `isSpeaking`         | `boolean`                                        | VAD speech detected                            |
| `currentTranscript`  | `string`                                         | In-progress (partial) transcript               |
| `transcriptSegments` | `TranscriptSegment[]`                            | Finalized transcript segments with timing data |
| `language`           | `string`                                         | Active language code (default `'en'`)          |
| `plugins`            | `AudioPluginStates`                              | Plugin states (STT, VAD, NoiseFilter)          |
| `error`              | `Error \| null`                                  | Audio error                                    |
| `start`              | `(options?: AudioStartOptions) => Promise<void>` | Start audio capture (requests mic permission)  |
| `stop`               | `() => Promise<void>`                            | Stop audio capture, release mic                |
| `mute`               | `() => void`                                     | Mute microphone                                |
| `unmute`             | `() => void`                                     | Unmute microphone                              |
| `toggleNoiseFilter`  | `(enabled?: boolean) => void`                    | Toggle noise filter on/off                     |
| `toggleSTT`          | `(enabled?: boolean) => Promise<void>`           | Toggle speech-to-text on/off                   |
| `toggleVAD`          | `(enabled?: boolean) => Promise<void>`           | Toggle voice activity detection on/off         |

---

### context

| Member                    | Signature                                                                       | Description                                      |
| ------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| `items`                   | `ContextItem[]`                                                                 | All context items                                |
| `transcriptions`          | `ContextItem[]`                                                                 | Filtered: transcription items only               |
| `caseNotes`               | `ContextItem[]`                                                                 | Filtered: case note items only                   |
| `entities`                | `MedicalEntity[]`                                                               | Extracted medical entities                       |
| `sharedContext`           | `ContextItem[]`                                                                 | Shared context from other doctors                |
| `isLoading`               | `boolean`                                                                       | Loading state                                    |
| `error`                   | `Error \| null`                                                                 | Context error                                    |
| `addCaseNote`             | `(content: string, metadata?: Record<string, unknown>) => Promise<ContextItem>` | Add a case note                                  |
| `addTranscription`        | `(text: string, metadata?: Record<string, unknown>) => Promise<ContextItem>`    | Add a transcription manually                     |
| `updateItem`              | `(id: string, content: string) => Promise<void>`                                | Update a context item's content                  |
| `loadSharedContext`       | `() => Promise<ContextItem[]>`                                                  | Load shared context from other doctors           |
| `extractEntities`         | `(contextItemId?: string) => Promise<MedicalEntity[]>`                          | Extract medical entities (all items or specific) |
| `getContextVersions`      | `(contextItemId: string) => Promise<ContextVersionEntry[]>`                     | Get version history for a context item           |
| `triggerEntityExtraction` | `(contextItemId: string) => Promise<void>`                                      | Trigger backend NER on a specific item           |
| `fetchTranscriptions`     | `() => Promise<ContextItem[]>`                                                  | Fetch transcriptions from backend                |
| `fetchCaseNotes`          | `() => Promise<ContextItem[]>`                                                  | Fetch case notes from backend                    |

> **Note**: The standalone `useArcaContext()` hook exposes additional methods — see [Focused Domain Hooks](#usearcacontext-1).

---

### summary

| Member                         | Signature                                                                                            | Description                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `preSummary`                   | `SummaryResponse \| null`                                                                            | Latest pre-summary                               |
| `summary`                      | `SummaryResponse \| null`                                                                            | Latest final summary                             |
| `all`                          | `SummaryResponse[]`                                                                                  | All summaries for the consultation               |
| `dnaStyle`                     | `DNAStyle \| null`                                                                                   | Doctor's DNA writing style                       |
| `isGenerating`                 | `boolean`                                                                                            | Summary generation in progress                   |
| `error`                        | `Error \| null`                                                                                      | Summary error                                    |
| `generatePreSummary`           | `(options?: SummaryGenerationOptions) => Promise<SummaryResponse>`                                   | Generate pre-summary (synchronous)               |
| `generateSummary`              | `(options?: SummaryGenerationOptions) => Promise<SummaryResponse>`                                   | Generate final summary (synchronous)             |
| `updateSummary`                | `(id: string, content: string, options?: UpdateSummaryOptions) => Promise<void>`                     | Update an existing summary                       |
| `loadSummaries`                | `(pagination?: PaginationParams) => Promise<SummaryResponse[]>`                                      | Load all summaries from backend                  |
| `generateSummaryAsync`         | `(options?: SummaryGenerationOptions) => Promise<AsyncJobResponse>`                                  | Generate summary asynchronously (returns job ID) |
| `generatePreSummaryAsync`      | `(options?: SummaryGenerationOptions) => Promise<AsyncJobResponse>`                                  | Generate pre-summary asynchronously              |
| `generateComprehensiveSummary` | `(options?: { dnaStyleId?: string; includeNER?: boolean }) => Promise<ComprehensiveSummaryResponse>` | Generate cross-chain comprehensive summary       |
| `getLatestPreSummary`          | `() => Promise<SummaryResponse>`                                                                     | Get latest pre-summary from backend              |
| `getSummaryHistory`            | `(summaryId: string) => Promise<SummaryVersionEntry[]>`                                              | Get version history for a summary                |
| `compareSummaryVersions`       | `(contextItemId: string, v1: number, v2: number) => Promise<DiffResult>`                             | Word-level diff between two versions             |
| `analyzeDNA`                   | `(texts: string[]) => Promise<DNAStyle>`                                                             | **DEPRECATED** — no backend endpoint exists      |

> **Note**: The standalone `useArcaSummary()` hook also exposes `approveSummary` — see [Focused Domain Hooks](#usearcasummary-1).

---

### pipelines

| Member                 | Signature                                     | Description                       |
| ---------------------- | --------------------------------------------- | --------------------------------- |
| `transcription`        | `PipelineStateInfo \| null`                   | Transcription pipeline state      |
| `knowledge`            | `PipelineStateInfo \| null`                   | Knowledge pipeline state          |
| `pauseTranscription`   | `() => void`                                  | Pause the transcription pipeline  |
| `resumeTranscription`  | `() => void`                                  | Resume the transcription pipeline |
| `triggerNER`           | `(text?: string) => Promise<MedicalEntity[]>` | Trigger NER extraction manually   |
| `triggerSummarization` | `() => Promise<string>`                       | Trigger summarization manually    |

---

### lifecycle

| Member                        | Signature                                          | Description                               |
| ----------------------------- | -------------------------------------------------- | ----------------------------------------- |
| `status`                      | `'RUNNING' \| 'PAUSED' \| 'ERROR' \| 'IDLE'`       | SDK lifecycle status                      |
| `canClose`                    | `boolean`                                          | Safe to close tab (no pending operations) |
| `pendingOperations`           | `string[]`                                         | List of pending operation names           |
| `state.audioCapture`          | `string`                                           | `'active'` or `'inactive'`                |
| `state.transcriptionPipeline` | `string`                                           | Pipeline status                           |
| `state.knowledgePipeline`     | `string`                                           | Pipeline status                           |
| `state.hasUnsavedData`        | `boolean`                                          | Whether unsaved data exists               |
| `requestGracefulShutdown`     | `(opts?: { timeoutMs?: number }) => Promise<void>` | Gracefully stop all operations            |
| `forceShutdown`               | `() => Promise<void>`                              | Force stop everything immediately         |

---

## 2. Focused Domain Hooks

Extracted from `useArca` for better performance when you only need a specific domain. These hooks subscribe to fewer store slices and re-render less.

### useArcaSession()

Session management with cross-tab sync via BroadcastChannel.

```tsx
import { useArcaSession } from '@arcaai/vox';
const session = useArcaSession();
```

**Returns**: `UseArcaSessionReturn`

| Member              | Signature                                            | Description                                                        |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| `consultation`      | `Consultation \| null`                               | Current consultation                                               |
| `context`           | `ContextItem[]`                                      | Context items for current consultation                             |
| `isLoading`         | `boolean`                                            | Loading state                                                      |
| `error`             | `Error \| null`                                      | Error state                                                        |
| `open`              | `(input: OpenSessionInput) => Promise<Consultation>` | Open/resume a consultation (get-or-create), sets up cross-tab sync |
| `close`             | `() => Promise<Consultation>`                        | Close consultation (transition status to CLOSED)                   |
| `reopen`            | `() => Promise<Consultation>`                        | Reopen a previously closed consultation                            |
| `addContext`        | `(input: AddContextInput) => Promise<ContextItem>`   | Add context item (broadcasts to other tabs)                        |
| `getSharedContext`  | `() => Promise<ContextItem[]>`                       | Get shared context from all doctors                                |
| `getPatientHistory` | `(patientId: string) => Promise<Consultation[]>`     | Get patient consultation history                                   |
| `loadConsultation`  | `(consultationId: string) => Promise<Consultation>`  | Load a specific consultation by ID                                 |
| `loadSummaries`     | `() => Promise<SummaryResponse[]>`                   | Load summaries from backend                                        |

> **Difference from `useArca().session`**: Exposes `close`, `reopen`, `addContext`, and `getSharedContext` which are not available on the unified hook's session sub-object.

---

### useArcaAudio()

Focused audio capture, muting, and plugin control.

```tsx
import { useArcaAudio } from '@arcaai/vox';
const audio = useArcaAudio();
```

Same interface as [`useArca().audio`](#audio).

---

### useArcaContext()

Context item management with worknote and attachment support.

```tsx
import { useArcaContext } from '@arcaai/vox';
const ctx = useArcaContext();
```

Includes all members from [`useArca().context`](#context) **plus**:

| Additional Member  | Signature                                                                        | Description                     |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------- |
| `worknotes`        | `ContextItem[]`                                                                  | Filtered: worknote items only   |
| `attachments`      | `ContextItem[]`                                                                  | Filtered: attachment items only |
| `addWorknote`      | `(content: string, metadata?: Record<string, unknown>) => Promise<ContextItem>`  | Add a work note                 |
| `addAttachment`    | `(content?: string, metadata?: Record<string, unknown>) => Promise<ContextItem>` | Add an attachment               |
| `fetchWorknotes`   | `() => Promise<ContextItem[]>`                                                   | Fetch worknotes from backend    |
| `fetchAttachments` | `() => Promise<ContextItem[]>`                                                   | Fetch attachments from backend  |

---

### useArcaSummary()

Summary generation and management with approval workflow.

```tsx
import { useArcaSummary } from '@arcaai/vox';
const summary = useArcaSummary();
```

Includes all members from [`useArca().summary`](#summary) **plus**:

| Additional Member | Signature                                                     | Description                                    |
| ----------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| `approveSummary`  | `(contextItemId: string) => Promise<SummaryApprovalResponse>` | Approve and lock a summary (APPROVED → LOCKED) |

---

### useArcaPipelines()

Pipeline control (pause/resume, NER, summarization).

```tsx
import { useArcaPipelines } from '@arcaai/vox';
const pipelines = useArcaPipelines();
```

Same interface as [`useArca().pipelines`](#pipelines).

---

### useSttProviderToggle() — live pipeline ↔ default

Switch a LIVE transcription session between the selected pipeline and the
tenant's default fallback STT provider, without dropping the session: the
backend swaps the ASR engine while the WebSocket, the Redis streams and the
session identity survive.

```tsx
import { useSttProviderToggle } from '@arcaai/vox';

function ProviderToggle() {
  const stt = useSttProviderToggle();

  return (
    <>
      <span>
        Transcribing on {stt.activeProvider?.name ?? 'the selected pipeline'}
        {stt.isFallbackActive && ' (fallback)'}
      </span>

      {stt.usePipeline ? (
        <button disabled={!stt.canSwitchToDefault} onClick={() => stt.switchToDefault()}>
          Switch to {stt.fallback?.pipelineName ?? 'the default provider'}
        </button>
      ) : (
        <button onClick={() => stt.switchToPipeline()}>Switch back to my pipeline</button>
      )}

      {stt.switchError && <p role="alert">{stt.switchError.message}</p>}
    </>
  );
}
```

| Member                | Type                                               | Description                                                                                      |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `activeProvider`      | `{ pipelineId, name?, isFallback } \| null`        | Pipeline currently transcribing. `null` before capture / for local STT                           |
| `usePipeline`         | `boolean`                                          | On the SDK-configured (primary) pipeline                                                         |
| `isFallbackActive`    | `boolean`                                          | On the tenant-admin default (fallback)                                                           |
| `switchToPipeline()`  | `() => Promise<void>`                              | Switch (back) to the primary. Idempotent                                                         |
| `switchToDefault()`   | `() => Promise<void>`                              | Switch to the tenant default. Idempotent                                                         |
| `switchStatus`        | `'idle' \| 'switching' \| 'switched' \| 'failed'`  | Lifecycle of the most recent switch                                                              |
| `switchError`         | `Error \| null`                                    | Last failure, so a UI need not wrap every call in `try/catch`                                    |
| `resetSwitchStatus()` | `() => void`                                       | Back to `idle`; clears `switchError`                                                             |
| `fallback`            | `{ configured, pipelineId, pipelineName } \| null` | The tenant's configured fallback. **`null` means UNKNOWN**, never "none configured"              |
| `canSwitchToDefault`  | `boolean`                                          | A live session exists, is not already on the fallback, and a fallback is configured (or unknown) |
| `refreshFallback()`   | `() => Promise<void>`                              | Re-read the fallback pointer                                                                     |

Notes:

- Both directions POST native routes (`switch-to-primary` / `switch-to-fallback`).
  Compat mode only reroutes them through the `/api/stt/switch` shim; it is not
  required for either direction.
- Success is confirmed ASYNCHRONOUSLY by the backend's `provider_switched`
  frame, which flips `activePipeline.isFallback` — that flip, not the HTTP
  response, moves `switchStatus` to `'switched'`.
- Both methods reject when there is no live streaming session (local STT
  included), so the control is a no-op rather than a silent failure.
- `canSwitchToDefault` is `true` while `fallback` is unknown: a failed labelling
  read must not take a working fallback away from the user.

---

### useBatchTranscription() — pre-recorded files

Upload pre-recorded audio (by default up to **5 recordings of at most 60
minutes** each), monitor each job live, and collect each result.

```tsx
import { useBatchTranscription } from '@arcaai/vox';

function BatchUpload({ pipelineId }: { pipelineId: string }) {
  const batch = useBatchTranscription({
    options: { pipelineId },
    onItemCompleted: (item) => console.log(item.fileName, item.text),
  });

  return (
    <>
      <input type="file" multiple accept="audio/*" disabled={batch.remainingSlots === 0} onChange={(e) => batch.enqueue(e.target.files ?? [])} />
      <p>
        {batch.remainingSlots} of {batch.limits.maxFilesPerBatch} slots free
      </p>

      <ul>
        {batch.items.map((item) => (
          <li key={item.id}>
            {item.fileName} — {item.status}
            {item.status === 'uploading' && ` ${item.uploadProgress}%`}
            {item.error && <span role="alert"> {item.error}</span>}
            {item.status === 'completed' && <blockquote>{item.text}</blockquote>}
            <button onClick={() => batch.cancel(item.id)}>Cancel</button>
            <button onClick={() => batch.retry(item.id)}>Retry</button>
          </li>
        ))}
      </ul>
    </>
  );
}
```

| Member                         | Type                            | Description                                                                 |
| ------------------------------ | ------------------------------- | --------------------------------------------------------------------------- |
| `items`                        | `BatchQueueItem[]`              | One row per selected file, in selection order                               |
| `enqueue(files, options?)`     | `(files, options?) => string[]` | Append files; returns the new row ids (refused files included)              |
| `cancel(id)` / `retry(id)`     | `(id: string) => void`          | Abort the upload or cancel the backend job / re-run from the top            |
| `remove(id)` / `clear()`       | `(id?) => void`                 | Drop one row / all rows, stopping each first                                |
| `limits`                       | `BatchTranscriptionLimits`      | Effective ceilings — the gateway's once loaded, the SDK defaults until then |
| `limitsError`                  | `Error \| null`                 | Set when the limits fetch failed; the defaults remain in force              |
| `remainingSlots`               | `number`                        | How many more recordings this batch accepts                                 |
| `isUploading` / `isProcessing` | `boolean`                       | Something is uploading / transcribing                                       |
| `activeCount`                  | `number`                        | Rows holding a concurrency slot                                             |

`BatchQueueItem` carries `status` (`validating \| pending \| uploading \|
processing \| completed \| failed \| cancelled`), `uploadProgress`, `jobId`,
`durationSeconds`, `rejectionReason`, `segments`, `text`, `error` and `job`.

Notes worth knowing before you build on it:

- **The ceilings come from the gateway.** The hook fetches
  `GET /audio/transcription-jobs/limits` (the admin-configurable `stt.batch.*`
  settings) and applies them over its own defaults, so lowering a knob moves the
  client too. If that fetch fails, the documented defaults stay in force —
  uploading is never blocked by a settings hiccup, and the gateway re-checks
  every request regardless.
- **A refused file is a visible row**, `status: 'failed'` with a
  `rejectionReason` of `too_many` / `too_long` / `too_large` /
  `unsupported_type` — never a silent drop.
- **Duration is checked locally first** so an over-long recording is refused
  before ~115 MB is uploaded. When the browser cannot read a container's
  duration the file is uploaded anyway and the gateway decides (it fails closed
  and returns 400).
- **`item.text` is authoritative once completed**: streamed chunks can be
  partial, so the finished job is re-read and its `resultText` replaces the
  streamed text.
- **Concurrency (default 2) covers the whole lifecycle**, upload and result
  stream, so a 5-file batch never opens 5 sockets at once.
- The engine is exported separately as `BatchTranscriptionQueue` for non-React
  callers.

---

## 3. useAuth — Authentication

JWT-based authentication with impersonation support.

```tsx
import { useAuth } from '@arcaai/vox';
const auth = useAuth();
```

**Returns**: `UseAuthReturn`

| Member             | Signature                                                                            | Description                                                |
| ------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `user`             | `AuthUser \| null`                                                                   | Current authenticated user                                 |
| `isAuthenticated`  | `boolean`                                                                            | Authentication status                                      |
| `isLoading`        | `boolean`                                                                            | Loading state                                              |
| `error`            | `Error \| null`                                                                      | Auth error                                                 |
| `impersonatedUser` | `AuthUser \| null`                                                                   | Currently impersonated user (null if not impersonating)    |
| `isImpersonating`  | `boolean`                                                                            | Whether impersonation is active                            |
| `canImpersonate`   | `boolean`                                                                            | Whether current user has SUPER_ADMIN or TENANT_ADMIN role |
| `login`            | `(username: string, password: string, tenantKey?: string) => Promise<LoginResponse>` | Login with credentials                                     |
| `logout`           | `() => Promise<void>`                                                                | Logout and clear tokens                                    |
| `getMe`            | `() => Promise<AuthUser>`                                                            | Get current user profile                                   |
| `refreshToken`     | `(refreshToken: string) => Promise<RefreshTokenResponse>`                            | Refresh JWT token                                          |
| `impersonate`      | `(targetUserId: string) => Promise<ImpersonateResponse>`                             | Start impersonation session                                |
| `endImpersonation` | `() => Promise<void>`                                                                | End impersonation, restore original admin identity         |

---

## 4. useArcaConfig — Configuration

Configuration and personalization access with three-tier config system (SYSTEM_DEFAULTS ← tenant ← user).

```tsx
import { useArcaConfig } from '@arcaai/vox';
const config = useArcaConfig();
```

**Returns**: `UseArcaConfigReturn`

| Member                 | Signature                                                         | Description                                                   |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `preferences`          | `UserPreferences`                                                 | Current user preferences                                      |
| `models.stt`           | `ModelDefinition[]`                                               | Available STT models                                          |
| `models.vad`           | `ModelDefinition[]`                                               | Available VAD models                                          |
| `models.ner`           | `ModelDefinition[]`                                               | Available NER models                                          |
| `models.selected`      | `{ stt?: string; vad?: string; ner?: string }`                    | Currently selected model IDs                                  |
| `tenantConfig`         | `TenantAudioConfig \| null`                                       | Tenant-scoped audio/AI config (null until loaded)             |
| `resolvedConfig`       | `AppConfig \| null`                                               | Merged config from all tiers (null until loaded)              |
| `configReady`          | `boolean`                                                         | True once all config tiers have been loaded                   |
| `update`               | `(updates: Partial<UserPreferences>) => Promise<void>`            | Update user preferences                                       |
| `selectModel`          | `(type: 'stt' \| 'vad' \| 'ner', modelId: string) => void`        | Select a model for a capability                               |
| `get`                  | `<K extends keyof UserPreferences>(key: K) => UserPreferences[K]` | Get a specific preference value                               |
| `reset`                | `() => Promise<void>`                                             | Reset preferences to defaults                                 |
| `isLocked`             | `(path: string) => boolean`                                       | Check if a config path is locked by tenant/admin              |
| `setUserPreference`    | `(path: string, value: unknown) => boolean`                       | Set a user preference by dot-path (returns `false` if locked) |
| `resetUserPreferences` | `() => void`                                                      | Clear all user preference overrides                           |

---

## 5. Admin & Management Hooks

All admin hooks follow a consistent pattern: they expose `isLoading`, `error`, local state, and CRUD methods. Every hook wraps the internal `useApiOperation` helper for standardized loading/error handling.

### useUsers()

```tsx
import { useUsers } from '@arcaai/vox';
```

**Returns**: `UseUsersReturn`

| Member              | Signature                                                             | Description                         |
| ------------------- | --------------------------------------------------------------------- | ----------------------------------- |
| `users`             | `User[]`                                                              | Loaded users list                   |
| `currentUser`       | `User \| null`                                                        | Last-fetched individual user        |
| `isLoading`         | `boolean`                                                             | Loading state                       |
| `error`             | `Error \| null`                                                       | Error state                         |
| `list`              | `(pagination?: PaginationParams) => Promise<User[]>`                  | List users                          |
| `listPaginated`     | `(pagination?: PaginationParams) => Promise<PaginatedResponse<User>>` | List users with pagination metadata |
| `search`            | `(query: string, options?: { limit?: number }) => Promise<User[]>`    | Search users by text query          |
| `get`               | `(id: string) => Promise<User>`                                       | Get user by ID                      |
| `getByExternalId`   | `(externalId: string) => Promise<User>`                               | Get user by external ID             |
| `create`            | `(input: CreateUserInput) => Promise<User>`                           | Create user                         |
| `update`            | `(id: string, input: UpdateUserInput) => Promise<User>`               | Update user                         |
| `remove`            | `(id: string) => Promise<void>`                                       | Delete user                         |
| `enable`            | `(id: string) => Promise<User>`                                       | Enable user                         |
| `disable`           | `(id: string) => Promise<User>`                                       | Disable user                        |
| `assignDepartments` | `(userId: string, input: AssignDepartmentsInput) => Promise<User>`    | Assign departments to user          |

---

### useRoles()

**Returns**: `UseRolesReturn`

| Member         | Signature                                                                            | Description             |
| -------------- | ------------------------------------------------------------------------------------ | ----------------------- |
| `roles`        | `Role[]`                                                                             | Loaded roles list       |
| `isLoading`    | `boolean`                                                                            | Loading state           |
| `error`        | `Error \| null`                                                                      | Error state             |
| `listRoles`    | `() => Promise<Role[]>`                                                              | List all roles          |
| `getRole`      | `(id: string) => Promise<Role>`                                                      | Get role by ID          |
| `createRole`   | `(input: CreateRoleInput) => Promise<Role>`                                          | Create role             |
| `updateRole`   | `(id: string, input: UpdateRoleInput) => Promise<Role>`                              | Update role             |
| `deleteRole`   | `(id: string) => Promise<void>`                                                      | Delete role             |
| `assignPolicy` | `(roleId: string, policyId: string, priority?: number) => Promise<unknown>`          | Assign policy to role   |
| `removePolicy` | `(roleId: string, policyId: string) => Promise<void>`                                | Remove policy from role |
| `getUserRoles` | `(userId: string) => Promise<UserRoleAssignment[]>`                                  | Get roles for a user    |
| `assignRole`   | `(userId: string, roleId: string, tenantId?: string) => Promise<UserRoleAssignment>` | Assign role to user     |
| `removeRole`   | `(userId: string, roleId: string) => Promise<void>`                                  | Remove role from user   |

---

### useApiKeys()

**Returns**: `UseApiKeysReturn`

| Member      | Signature                                                   | Description                           |
| ----------- | ----------------------------------------------------------- | ------------------------------------- |
| `apiKeys`   | `ApiKey[]`                                                  | Loaded API keys list                  |
| `isLoading` | `boolean`                                                   | Loading state                         |
| `error`     | `Error \| null`                                             | Error state                           |
| `list`      | `(pagination?: PaginationParams) => Promise<ApiKey[]>`      | List API keys                         |
| `get`       | `(id: string) => Promise<ApiKey>`                           | Get API key by ID                     |
| `create`    | `(input: CreateApiKeyInput) => Promise<ApiKeyWithRawKey>`   | Create API key (returns raw key once) |
| `update`    | `(id: string, input: UpdateApiKeyInput) => Promise<ApiKey>` | Update API key                        |
| `remove`    | `(id: string) => Promise<void>`                             | Delete API key                        |
| `revoke`    | `(id: string) => Promise<void>`                             | Revoke API key                        |
| `getUsage`  | `(id: string) => Promise<ApiKeyUsage>`                      | Get API key usage stats               |

---

### useTenants()

**Returns**: `UseTenantsReturn`

| Member          | Signature                                                   | Description                    |
| --------------- | ----------------------------------------------------------- | ------------------------------ |
| `tenants`       | `Tenant[]`                                                  | Loaded tenants list            |
| `currentTenant` | `Tenant \| null`                                            | Last-fetched individual tenant |
| `isLoading`     | `boolean`                                                   | Loading state                  |
| `error`         | `Error \| null`                                             | Error state                    |
| `list`          | `(pagination?: PaginationParams) => Promise<Tenant[]>`      | List tenants                   |
| `get`           | `(id: string) => Promise<Tenant>`                           | Get tenant by ID               |
| `getByCodeName` | `(codeName: string) => Promise<Tenant>`                     | Get tenant by code name        |
| `create`        | `(input: CreateTenantInput) => Promise<Tenant>`             | Create tenant                  |
| `update`        | `(id: string, input: UpdateTenantInput) => Promise<Tenant>` | Update tenant                  |
| `remove`        | `(id: string) => Promise<void>`                             | Delete tenant                  |
| `enable`        | `(id: string) => Promise<Tenant>`                           | Enable tenant                  |
| `disable`       | `(id: string) => Promise<Tenant>`                           | Disable tenant                 |
| `getConfigs`    | `(identifier: string) => Promise<unknown>`                  | Get tenant configs             |
| `updateConfigs` | `(identifier: string, data: unknown) => Promise<unknown>`   | Update tenant configs          |

---

### usePolicies()

**Returns**: `UsePoliciesReturn`

| Member          | Signature                                                       | Description                    |
| --------------- | --------------------------------------------------------------- | ------------------------------ |
| `policies`      | `Policy[]`                                                      | Loaded policies list           |
| `currentPolicy` | `Policy \| null`                                                | Last-fetched individual policy |
| `isLoading`     | `boolean`                                                       | Loading state                  |
| `error`         | `Error \| null`                                                 | Error state                    |
| `list`          | `(pagination?: PaginationParams) => Promise<Policy[]>`          | List policies                  |
| `get`           | `(id: string) => Promise<Policy>`                               | Get policy by ID               |
| `create`        | `(input: CreatePolicyInput) => Promise<Policy>`                 | Create policy                  |
| `update`        | `(id: string, input: UpdatePolicyInput) => Promise<Policy>`     | Update policy                  |
| `remove`        | `(id: string) => Promise<void>`                                 | Delete policy                  |
| `validate`      | `(input: CreatePolicyInput) => Promise<PolicyValidationResult>` | Validate policy rules          |

---

### useDepartments()

**Returns**: `UseDepartmentsReturn`

| Member               | Signature                                                            | Description                        |
| -------------------- | -------------------------------------------------------------------- | ---------------------------------- |
| `departments`        | `Department[]`                                                       | Loaded departments list            |
| `currentDepartment`  | `Department \| null`                                                 | Last-fetched individual department |
| `isLoading`          | `boolean`                                                            | Loading state                      |
| `error`              | `Error \| null`                                                      | Error state                        |
| `list`               | `() => Promise<Department[]>`                                        | List all departments               |
| `get`                | `(id: string) => Promise<Department>`                                | Get department by ID               |
| `create`             | `(data: Partial<Department>) => Promise<Department>`                 | Create department                  |
| `update`             | `(id: string, data: Partial<Department>) => Promise<Department>`     | Update department                  |
| `remove`             | `(id: string) => Promise<void>`                                      | Delete department                  |
| `getRoots`           | `() => Promise<Department[]>`                                        | Get root departments               |
| `getChildren`        | `(id: string) => Promise<Department[]>`                              | Get child departments              |
| `getByCode`          | `(code: string) => Promise<Department>`                              | Get department by code             |
| `updatePromptConfig` | `(id: string, data: Record<string, unknown>) => Promise<Department>` | Update department prompt config    |

---

### usePrompts()

**Returns**: `UsePromptsReturn`

| Member               | Signature                                                              | Description                               |
| -------------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| `prompts`            | `PromptTemplate[]`                                                     | Loaded prompt templates list              |
| `currentPrompt`      | `PromptTemplate \| null`                                               | Last-fetched individual prompt            |
| `isLoading`          | `boolean`                                                              | Loading state                             |
| `error`              | `Error \| null`                                                        | Error state                               |
| `create`             | `(input: CreatePromptInput) => Promise<PromptTemplate>`                | Create prompt template                    |
| `list`               | `(filters?: PromptListFilters) => Promise<PromptTemplate[]>`           | List prompts with optional filters        |
| `get`                | `(id: string) => Promise<PromptTemplate>`                              | Get prompt by ID                          |
| `update`             | `(id: string, input: UpdatePromptInput) => Promise<PromptTemplate>`    | Update prompt                             |
| `remove`             | `(id: string) => Promise<void>`                                        | Delete prompt                             |
| `getVersions`        | `(id: string) => Promise<PromptVersion[]>`                             | Get prompt version history                |
| `getUsageStats`      | `(id: string) => Promise<PromptUsageStats>`                            | Get prompt usage stats                    |
| `assignToDepartment` | `(input: AssignDepartmentPromptInput) => Promise<void>`                | Assign prompt to department               |
| `compareVersions`    | `(id: string, v1: number, v2: number) => Promise<DiffResult>`          | Diff two prompt versions                  |
| `activateVersion`    | `(promptId: string, versionNumber: number) => Promise<PromptTemplate>` | Activate (rollback to) a specific version |

---

### useDnaStyle()

**Returns**: `UseDnaStyleReturn`

| Member          | Signature                                                                                        | Description                                 |
| --------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `style`         | `DnaReport \| null`                                                                              | Current DNA style report                    |
| `versions`      | `DnaStyleVersion[]`                                                                              | Style version history                       |
| `isLoading`     | `boolean`                                                                                        | Loading state                               |
| `error`         | `Error \| null`                                                                                  | Error state                                 |
| `getMyStyle`    | `() => Promise<DnaReport>`                                                                       | Get current doctor's DNA style              |
| `generate`      | `(input?: DnaGenerateInput) => Promise<{ jobId: string }>`                                       | Start async DNA generation (returns job ID) |
| `update`        | `(reportId: string, input: DnaUpdateInput) => Promise<DnaReport>`                                | Update DNA style report                     |
| `getVersions`   | `(reportId: string) => Promise<DnaStyleVersion[]>`                                               | Get DNA style version history               |
| `getJobStatus`  | `(jobId: string) => Promise<{ status: string; result?: DnaReport }>`                             | Check DNA generation job status             |
| `pollJobStatus` | `(jobId: string, options?: { intervalMs?: number; maxAttempts?: number }) => Promise<DnaReport>` | Poll until job completes                    |
| `getByDoctor`   | `(doctorId: string) => Promise<DnaReport>`                                                       | Get DNA style for a specific doctor         |

---

### useGlobalSettings()

**Returns**: `UseGlobalSettingsReturn`

| Member            | Signature                                                                       | Description                     |
| ----------------- | ------------------------------------------------------------------------------- | ------------------------------- |
| `settings`        | `GlobalSetting[]`                                                               | Loaded global settings          |
| `tenantConfig`    | `GlobalSetting[]`                                                               | Tenant-specific config settings |
| `isLoading`       | `boolean`                                                                       | Loading state                   |
| `error`           | `Error \| null`                                                                 | Error state                     |
| `list`            | `(pagination?: PaginationParams) => Promise<GlobalSetting[]>`                   | List all global settings        |
| `getByTenant`     | `(tenantId: string, pagination?: PaginationParams) => Promise<GlobalSetting[]>` | Get settings by tenant ID       |
| `getTenantConfig` | `(tenantId: string) => Promise<GlobalSetting[]>`                                | Get tenant config settings      |
| `get`             | `(id: string) => Promise<GlobalSetting>`                                        | Get setting by ID               |
| `create`          | `(input: CreateGlobalSettingInput) => Promise<GlobalSetting>`                   | Create setting                  |
| `update`          | `(id: string, input: UpdateGlobalSettingInput) => Promise<GlobalSetting>`       | Update setting                  |
| `remove`          | `(id: string) => Promise<void>`                                                 | Delete setting                  |

---

### useUserSettings()

**Returns**: `UseUserSettingsReturn`

| Member          | Signature                                                             | Description                      |
| --------------- | --------------------------------------------------------------------- | -------------------------------- |
| `settings`      | `UserSetting[]`                                                       | All loaded user settings         |
| `mySettings`    | `UserSetting[]`                                                       | Current user's settings          |
| `isLoading`     | `boolean`                                                             | Loading state                    |
| `error`         | `Error \| null`                                                       | Error state                      |
| `list`          | `(pagination?: PaginationParams) => Promise<UserSetting[]>`           | List all user settings           |
| `getMySettings` | `(userId: string) => Promise<UserSetting[]>`                          | Get settings for a specific user |
| `get`           | `(id: string) => Promise<UserSetting>`                                | Get setting by ID                |
| `create`        | `(input: CreateUserSettingInput) => Promise<UserSetting>`             | Create user setting              |
| `update`        | `(id: string, input: UpdateUserSettingInput) => Promise<UserSetting>` | Update user setting              |

---

### useStorage()

**Returns**: `UseStorageReturn`

| Member         | Signature                                                                                    | Description                                       |
| -------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `buckets`      | `Bucket[]`                                                                                   | Loaded buckets list                               |
| `files`        | `StorageFile[]`                                                                              | Loaded files list (for last queried bucket)       |
| `isLoading`    | `boolean`                                                                                    | Loading state                                     |
| `error`        | `Error \| null`                                                                              | Error state                                       |
| `listBuckets`  | `() => Promise<Bucket[]>`                                                                    | List all storage buckets                          |
| `getBucket`    | `(name: string) => Promise<Bucket>`                                                          | Get bucket by name                                |
| `createBucket` | `(name: string, type?: string) => Promise<CreateBucketResult>`                               | Create a bucket (type: `'public'` or `'private'`) |
| `deleteBucket` | `(name: string) => Promise<void>`                                                            | Delete a bucket                                   |
| `listFiles`    | `(bucket: string, prefix?: string, pagination?: PaginationParams) => Promise<StorageFile[]>` | List files in a bucket                            |
| `uploadFile`   | `(bucket: string, file: File, key?: string) => Promise<StorageFile>`                         | Upload a file                                     |
| `getFileInfo`  | `(bucket: string, key: string) => Promise<StorageFileWithUrl>`                               | Get file info with URL                            |
| `deleteFile`   | `(bucket: string, key: string) => Promise<void>`                                             | Delete a file                                     |
| `checkHealth`  | `() => Promise<StorageHealth>`                                                               | Check storage service health                      |

---

### useMonitoring()

**Returns**: `UseMonitoringReturn`

| Member             | Signature                                         | Description                         |
| ------------------ | ------------------------------------------------- | ----------------------------------- |
| `uptime`           | `ServiceUptime[] \| null`                         | Service uptime data                 |
| `sessions`         | `SessionCounts \| null`                           | Active/total session counts         |
| `isLoading`        | `boolean`                                         | Loading state                       |
| `error`            | `Error \| null`                                   | Error state                         |
| `refresh`          | `() => Promise<void>`                             | Refresh uptime and session data     |
| `getServiceUptime` | `(service: string) => Promise<ServiceUptime>`     | Get uptime for a specific service   |
| `getHeartbeats`    | `(service: string) => Promise<HeartbeatRecord[]>` | Get heartbeat records for a service |

---

### useConsultationJob()

Job tracking with SSE streaming and polling for async operations.

**Returns**: `UseConsultationJobReturn`

| Member        | Signature                                                            | Description                                                                                  |
| ------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `job`         | `ConsultationJob \| null`                                            | Current job data                                                                             |
| `status`      | `JobStatus`                                                          | Job status (`'idle'`, `'pending'`, `'processing'`, `'completed'`, `'failed'`, `'cancelled'`) |
| `isStreaming` | `boolean`                                                            | Whether SSE stream is active                                                                 |
| `error`       | `Error \| null`                                                      | Error state                                                                                  |
| `getJob`      | `(jobId: string) => Promise<ConsultationJob>`                        | Fetch job by ID                                                                              |
| `cancelJob`   | `(jobId: string) => Promise<void>`                                   | Cancel a running job                                                                         |
| `streamJob`   | `(jobId: string, callbacks: JobStreamCallbacks) => () => void`       | Subscribe to job SSE events (returns cleanup function)                                       |
| `pollJob`     | `(jobId: string, options?: PollOptions) => Promise<ConsultationJob>` | Poll job until terminal status                                                               |

---

### usePipelines() (Admin — ASR Pipeline CRUD)

> Not to be confused with `useArcaPipelines()` which controls the runtime transcription/knowledge pipelines.

**Returns**: `UsePipelinesReturn`

| Member             | Signature                                                                | Description                   |
| ------------------ | ------------------------------------------------------------------------ | ----------------------------- |
| `pipelines`        | `Pipeline[]`                                                             | Loaded ASR pipelines list     |
| `selectedPipeline` | `Pipeline \| null`                                                       | Currently selected pipeline   |
| `isLoading`        | `boolean`                                                                | Loading state                 |
| `error`            | `Error \| null`                                                          | Error state                   |
| `list`             | `(pagination?: PaginationParams) => Promise<Pipeline[]>`                 | List ASR pipelines            |
| `get`              | `(id: string) => Promise<Pipeline>`                                      | Get pipeline by ID            |
| `getBySlug`        | `(slug: string) => Promise<Pipeline>`                                    | Get pipeline by slug          |
| `select`           | `(pipelineId: string) => void`                                           | Select a pipeline locally     |
| `createPipeline`   | `(input: CreatePipelineInput) => Promise<Pipeline>`                      | Create pipeline               |
| `updatePipeline`   | `(id: string, input: UpdatePipelineInput) => Promise<Pipeline>`          | Update pipeline               |
| `deletePipeline`   | `(id: string) => Promise<void>`                                          | Delete pipeline               |
| `validateConfig`   | `(configYaml: string) => Promise<PipelineValidationResult>`              | Validate pipeline YAML config |
| `assignToTenant`   | `(pipelineId: string, tenantId: string) => Promise<{ message: string }>` | Assign pipeline to tenant     |

---

### useHealthCheck()

**Returns**: `UseHealthCheckReturn`

| Member         | Signature                             | Description                                                                                 |
| -------------- | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `status`       | `HealthStatus`                        | Aggregated health status (`'idle'`, `'checking'`, `'healthy'`, `'degraded'`, `'unhealthy'`) |
| `services`     | `Record<string, ServiceHealthStatus>` | Per-service health map                                                                      |
| `lastChecked`  | `Date \| null`                        | Last check timestamp                                                                        |
| `isLoading`    | `boolean`                             | Loading state                                                                               |
| `error`        | `Error \| null`                       | Error state                                                                                 |
| `check`        | `() => Promise<void>`                 | Run health check (API gateway + all downstream services)                                    |
| `startPolling` | `(intervalMs?: number) => void`       | Start periodic health checks (default 30s)                                                  |
| `stopPolling`  | `() => void`                          | Stop periodic health checks                                                                 |

---

### useVoiceEmbedding()

**Returns**: `UseVoiceEmbeddingReturn`

| Member        | Signature                                                                      | Description                           |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| `status`      | `VoiceEmbeddingStatus \| null`                                                 | Current voice embedding status        |
| `isLoading`   | `boolean`                                                                      | Loading state                         |
| `isUploading` | `boolean`                                                                      | Upload in progress                    |
| `error`       | `Error \| null`                                                                | Error state                           |
| `upload`      | `(userId: string, audioFile: File \| Blob) => Promise<VoiceEmbeddingResponse>` | Upload audio for voice embedding      |
| `getStatus`   | `(userId: string) => Promise<VoiceEmbeddingStatus>`                            | Get voice embedding status for a user |
| `remove`      | `(userId: string) => Promise<void>`                                            | Remove voice embedding for a user     |

---

### useAuditLog()

**Returns**: `UseAuditLogReturn`

| Member       | Signature                                                                | Description                         |
| ------------ | ------------------------------------------------------------------------ | ----------------------------------- |
| `entries`    | `AuditLogEntry[]`                                                        | Loaded audit log entries            |
| `isLoading`  | `boolean`                                                                | Loading state                       |
| `error`      | `Error \| null`                                                          | Error state                         |
| `list`       | `(pagination?: PaginationParams) => Promise<AuditLogEntry[]>`            | List audit log entries              |
| `get`        | `(id: string) => Promise<AuditLogEntry>`                                 | Get audit log entry by ID           |
| `byResource` | `(resourceType: string, resourceId: string) => Promise<AuditLogEntry[]>` | Get entries for a specific resource |
| `byUser`     | `(userId: string) => Promise<AuditLogEntry[]>`                           | Get entries for a specific user     |

---

## 6. Infrastructure Hooks

### useSharedConnection(workerUrl?)

Multi-tab connection management via SharedWorker. Falls back to direct connections when SharedWorker is unavailable.

**Returns**: `UseSharedConnectionReturn`

| Member                 | Type                              | Description                        |
| ---------------------- | --------------------------------- | ---------------------------------- |
| `manager`              | `SharedConnectionManager \| null` | The connection manager instance    |
| `tabCount`             | `number`                          | Number of active tabs              |
| `isSharedWorkerActive` | `boolean`                         | Whether SharedWorker is being used |

### useSharedSSE(connectionId, options, manager)

Shared SSE subscription across tabs. Requires a `SharedConnectionManager` from `useSharedConnection`.

### useSharedWS(connectionId, options, manager)

Shared WebSocket subscription across tabs. Requires a `SharedConnectionManager` from `useSharedConnection`.

---

## 7. Provider & Context Hooks

### useAgenticContext()

Access raw provider context. Most users should use `useArca()` instead.

```tsx
const { initialized, config, logger } = useAgenticContext();
```

### useSDKLogger()

Access the `ISDKLogger` instance for custom logging in your components.

```tsx
import { useSDKLogger } from '@arcaai/vox';

function MyComponent() {
  const logger = useSDKLogger();
  logger.info('Something happened', { component: 'MyComponent' });
}
```

---

## 8. Plugin Hooks

Available from `@arcaai/vox/plugins` (or `@arcaai/vox`):

| Hook             | Package                | Description                                             |
| ---------------- | ---------------------- | ------------------------------------------------------- |
| `useVAD`         | `@arcaai/vad`          | Voice Activity Detection                                |
| `useSTT`         | `@arcaai/stt`          | Speech-to-Text (Whisper WebWorker)                      |
| `useNoiseFilter` | `@arcaai/noise-filter` | RNNoise WASM noise cancellation                         |
| `useMedNER`      | `@arcaai/med-ner`      | Medical NER (import from `@arcaai/vox/plugins/med-ner`) |

Also exported from `@arcaai/vox/plugins`:

| Export                        | Description                                     |
| ----------------------------- | ----------------------------------------------- |
| `PluginManager`               | Orchestrates audio processing plugins           |
| `TranscriptionPipeline`       | Audio → NoiseFilter → VAD → STT → Transcription |
| `KnowledgePipeline`           | Transcription → NER → SpellCheck → Summary      |
| `createTranscriptionPipeline` | Factory function                                |
| `createKnowledgePipeline`     | Factory function                                |

---

## 9. Advanced Core Classes

Exported from `@arcaai/vox/core` for advanced use cases:

| Class                      | Description                                                               |
| -------------------------- | ------------------------------------------------------------------------- |
| `AgenticClient`            | HTTP client with auth, rate limiting, tenant headers                      |
| `ConfigManager`            | Three-tier config merging (system → tenant → user)                        |
| `ModelRegistry`            | STT/VAD/NER model discovery and selection                                 |
| `PersonalizationManager`   | User preferences with local/backend/hybrid storage                        |
| `FileTranscriptionService` | Upload and transcribe audio files                                         |
| `BatchTranscriptionQueue`  | Framework-free batch queue (caps, scheduling, upload + result stream)     |
| `SSEClient`                | Authenticated, reconnectable Server-Sent Events client                    |
| `StreamingSessionManager`  | Manage STT streaming sessions                                             |
| `SttWebSocketClient`       | WebSocket client for STT streaming protocol                               |
| `useAgenticStore`          | Direct access to the Zustand store (advanced)                             |
| `createSDKLogger`          | Logger factory with Console, Highlight.io, Loki, OpenTelemetry transports |

---

## 10. Utility Functions

All exported from `@arcaai/vox/core` (or `@arcaai/vox`):

| Category           | Functions                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **Error Handling** | `isAgenticError`, `getErrorCode`, `getErrorMessage`, `wrapError`, `isNetworkError`, `isAuthError`, `isRetriableError` |
| **Date**           | `formatDate`, `formatDateTime`, `getToday`, `isSameDay`, `parseDate`, `formatRelativeTime`                            |
| **Diff**           | `computeDiff`, `computePromptDiff`, `computeSummaryDiff`, `createUnifiedPatch`                                        |
| **Prompts**        | `substitutePromptVariables`, `extractPromptVariables`, `validatePromptVariables`                                      |

---

## 11. Key Types

### AgenticConfig

```typescript
interface AgenticConfig {
  api: ApiConfig; // baseUrl, accessToken, apiKey, tenantId, timeout, wsUrl, rateLimit
  audio?: AudioPluginConfig; // noiseFilter, vad, stt
  plugins?: PluginConfig; // ner, tts
  models?: ModelRegistryConfig; // custom models, pre-selected models
  personalization?: PersonalizationConfig; // storage mode, sync interval, defaults
  logging?: LoggingConfig; // Console, Highlight.io, Loki, OpenTelemetry
  debug?: boolean;
}
```

### OpenSessionInput

```typescript
interface OpenSessionInput {
  patientId: string;
  doctorId: string;
  appointmentDate: string;
  department?: string;
  metadata?: Record<string, unknown>;
}
```

### ContextItemType (9 values)

`TRANSCRIPT` | `CASE_NOTE` | `WORKNOTE` | `ATTACHMENT` | `PRE_SUMMARY` | `SUMMARY` | `COMPREHENSIVE_SUMMARY` | `NER_RESULT` | `SYSTEM`

### AudioStartOptions

```typescript
interface AudioStartOptions {
  language?: string;
  pipelineId?: string;
}
```

### SummaryGenerationOptions

```typescript
interface SummaryGenerationOptions {
  dnaStyleId?: string;
  includeNER?: boolean;
}
```

### RetryOptions

```typescript
interface RetryOptions {
  maxRetries?: number; // default: 3
  delayMs?: number; // default: 1000
  backoff?: 'linear' | 'exponential';
  onRetry?: (attempt: number, error: unknown) => void;
}
```

### UserPreferences

```typescript
interface UserPreferences {
  workflowMode?: 'local' | 'remote';
  language?: string;
  dnaStyleId?: string;
  localConfig?: Partial<LocalWorkflowConfig>;
  remoteConfig?: RemoteConfigResponse; // read-only, admin-controlled
  custom?: Record<string, unknown>;
}
```

### PaginationParams

```typescript
interface PaginationParams {
  page?: number;
  limit?: number;
}
```

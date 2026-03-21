# TASK-032: SDK V2 Frontend Demo Implementation — Parallel Engineering Plan

| Field | Value |
|-------|-------|
| **Ticket Number** | TASK-032 |
| **Created Date** | 2026-02-20 |
| **Last Updated** | 2026-02-21 |
| **Status** | Completed |
| **Related Tickets** | SDK-206 (gap analysis, complete), SDK-207 (feature expansion, complete), TASK-031 (example app reimplementation, complete) |
| **Prerequisite Completions** | SDK-206 Layer 0–2 all streams, TASK-031 page skeleton |

---

## Requirement Analysis

With SDK-206 (all 41 gaps resolved), SDK-207 (5 workstreams complete), and TASK-031 (example apps reimplemented with 5-route skeleton), the next phase is to **fill the remaining SDK gaps** and **build production-quality demo pages** matching the FEAT-01 through FEAT-05 specifications.

### What's Already Done

- SDK core: All endpoint constants, types, hooks, services, WebSocket client, SSE client, file transcription, pipeline registry, personalization, model registry
- Example apps: Home, Setup, Transcription, Summarization, Admin pages exist as skeletons in both Vite and Next.js
- Shared UI: `@arcaai/ui` has ServiceStatusBar, AudioMeter, CodeExample, TranscriptViewer, DeptPromptSelector, DnaStyleSelector, WorkflowToggle, ModelSelector, AsyncJobTracker

### What's Missing (from gap analysis)

**SDK gaps — FEAT-01/02/03** (7 critical, 10 important):
- No `useAuth` hook (auth endpoints missing from SDK)
- No `useMonitoring` / `useHealthCheck` hooks
- No `useGlobalSettings` / `useUserSettings` hooks
- No `usePipelines` hook
- No `useConsultationJob` hook (consultation job SSE missing)
- Summary generation missing transcript input, prompt template ID, DNA style ID parameters
- No speaker voice embedding API
- Structured transcript with diarization not exposed

**SDK gaps — FEAT-04 Admin** (6 critical, 6 high):
- No `useUsers` hook or `USER_ENDPOINTS` constants
- No `useApiKeys` hook — API key CRUD controller also missing from backend (service exists)
- No `useAiModels` hook — `ModelRegistry` is read-only, no React hook wrapper
- `useDepartments` missing `create()` and `delete()` methods
- No `useStorage` hook — storage management controller also missing from backend (S3Service exists)
- No `useRoles` hook — user role assignment controller missing from backend (service exists)

**SDK gaps — FEAT-05 DNA Writing Style** (2 high, 4 medium):
- No "list all consultations" endpoint or SDK method (only patient-scoped)
- No `getJobStatus()` / `pollJobStatus()` in `useDnaStyle` hook
- `DnaGenerateInput` missing `promptTemplateId` parameter
- No `getByDoctor()` method in `useDnaStyle`

**Example app gaps**:
- Setup page needs full configuration UI (STT workflow toggle, model selection, pipeline selection)
- Transcription page needs live recording controls, sound meter, transcript display, file upload zone
- Summarization page needs streaming display, prompt/department selector, DNA style selector
- Admin page needs 5 tabs: Users, Prompts, Models, Departments, Storage
- DNA Writing Style page needs consultation selector, vertical stepper, job tracking
- All pages need code example sections

---

## Architecture Overview

This plan decomposes into **10 parallel workstreams** across 3 layers covering all 5 FEAT specifications. Each workstream can be assigned to a separate engineer. The dependency graph ensures no blocking between parallel streams.

**Workstream categories**:
- **Layer 1** (SDK foundation): WS-A (general hooks) + WS-G (admin hooks + backend controllers) — run in parallel
- **Layer 2** (SDK enhancements): WS-B (summary/STT) + WS-C (shared components) + WS-H (DNA style) — run in parallel
- **Layer 3** (demo pages): WS-D through WS-F (FEAT-01/02/03) + WS-I (FEAT-04) + WS-J (FEAT-05) — run in parallel

---

## WS-A: SDK Hooks & Constants (Layer 1)

**Goal**: Add all missing SDK hooks and endpoint constants required by the demo pages.

**Engineer**: 1 · **Duration**: 3 days · **Dependencies**: None

### Task A-1: Add `AUTH_ENDPOINTS` and `useAuth` hook

**Files**:
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts`
- Create: `packages/agentic-sdk-v2/src/hooks/useAuth.ts`
- Modify: `packages/agentic-sdk-v2/src/types/index.ts`

**What to implement**:

1. Add to `constants.ts`:
   ```
   AUTH_ENDPOINTS.LOGIN         → POST /auth/login
   AUTH_ENDPOINTS.LOGOUT        → POST /auth/logout
   AUTH_ENDPOINTS.ME            → GET  /auth/me
   ```

2. Create `useAuth` hook returning:
   ```typescript
   {
     user: AuthUser | null;
     isAuthenticated: boolean;
     isLoading: boolean;
     error: Error | null;
     login: (username: string, password: string) => Promise<LoginResponse>;
     logout: () => Promise<void>;
     getMe: () => Promise<AuthUser>;
   }
   ```

3. Types: `AuthUser`, `LoginRequest`, `LoginResponse`, `LogoutResponse`

**API endpoints consumed**:
- `POST /api/v1/auth/login` — body: `{ username, password }`, returns `{ user, token, refreshToken }`
- `POST /api/v1/auth/logout` — requires JWT
- `GET /api/v1/auth/me` — requires JWT, returns user info

**Notes**: The API uses JWT auth (`JwtAuthGuard`). The SDK currently uses API key auth only. This hook adds JWT-based auth as an alternative. The token should be stored and attached to subsequent requests via `AgenticClient`.

---

### Task A-2: Add `useMonitoring` hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/useMonitoring.ts`

**What to implement**:

1. Hook returning:
   ```typescript
   {
     uptime: ServiceUptime[] | null;
     sessions: SessionCounts | null;
     isLoading: boolean;
     error: Error | null;
     refresh: () => Promise<void>;
     getServiceUptime: (service: string) => Promise<ServiceUptime>;
     getHeartbeats: (service: string) => Promise<HeartbeatRecord[]>;
   }
   ```

2. Auto-polling with configurable interval (default 30s), cleanup on unmount.

**API endpoints consumed** (constants already exist in `MONITORING_ENDPOINTS`):
- `GET /api/v1/monitoring/uptime` — all services
- `GET /api/v1/monitoring/uptime/:service` — specific service
- `GET /api/v1/monitoring/heartbeats/:service` — heartbeat history
- `GET /api/v1/monitoring/sessions` — active session counts

**Types**: `ServiceUptime`, `SessionCounts`, `HeartbeatRecord`

---

### Task A-3: Add `useHealthCheck` hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/useHealthCheck.ts`

**What to implement**:

1. Hook returning:
   ```typescript
   {
     status: 'idle' | 'checking' | 'healthy' | 'degraded' | 'unhealthy';
     services: Record<string, ServiceHealthStatus>;
     lastChecked: Date | null;
     isLoading: boolean;
     error: Error | null;
     check: () => Promise<void>;
     startPolling: (intervalMs?: number) => void;
     stopPolling: () => void;
   }
   ```

2. Aggregates health from: API gateway (`/health`), STT (`/stt/health`), TTS (`/tts/health`), NLP (`/nlp/health`), SMR (`/smr/api/v2/health`).

**API endpoints consumed** (constants already exist in `HEALTH_ENDPOINTS`):
- `GET /health` — API gateway (version-neutral, no `/api/v1` prefix)
- `GET /health/live` — liveness probe
- `GET /health/ready` — readiness probe

Plus proxy health endpoints:
- `GET /api/v1/stt/health`
- `GET /api/v1/tts/health`
- `GET /api/v1/nlp/health`
- `GET /api/v1/smr/api/v2/health`

**Notes**: Add `SERVICE_HEALTH_ENDPOINTS` to constants for the proxy health checks. The hook should fire all checks in parallel and aggregate status.

---

### Task A-4: Add `useGlobalSettings` hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/useGlobalSettings.ts`
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts` (add `GLOBAL_SETTINGS_ENDPOINTS`)

**What to implement**:

1. Add to `constants.ts`:
   ```
   GLOBAL_SETTINGS_ENDPOINTS.LIST                    → GET  /global-setting
   GLOBAL_SETTINGS_ENDPOINTS.GET(id)                 → GET  /global-setting/:id
   GLOBAL_SETTINGS_ENDPOINTS.BY_TENANT(tenantId)     → GET  /global-setting/tenant/:tenantId
   GLOBAL_SETTINGS_ENDPOINTS.BY_USER(userId)         → GET  /global-setting/user/:userId
   GLOBAL_SETTINGS_ENDPOINTS.TENANT_CONFIG(tenantId) → GET  /global-setting/config/tenant/:tenantId
   GLOBAL_SETTINGS_ENDPOINTS.CREATE                  → POST /global-setting
   GLOBAL_SETTINGS_ENDPOINTS.UPDATE(id)              → PATCH /global-setting/:id
   ```

2. Hook returning:
   ```typescript
   {
     settings: GlobalSetting[];
     tenantConfig: GlobalSetting[];
     isLoading: boolean;
     error: Error | null;
     list: (pagination?: PaginationParams) => Promise<GlobalSetting[]>;
     getByTenant: (tenantId: string, pagination?: PaginationParams) => Promise<GlobalSetting[]>;
     getTenantConfig: (tenantId: string) => Promise<GlobalSetting[]>;
     get: (id: string) => Promise<GlobalSetting>;
     create: (input: CreateGlobalSettingInput) => Promise<GlobalSetting>;
     update: (id: string, input: UpdateGlobalSettingInput) => Promise<GlobalSetting>;
   }
   ```

**API endpoints consumed**: See constants above. All require JWT + RBAC (`CanRead('GlobalSetting')`, etc.)

---

### Task A-5: Add `useUserSettings` hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/useUserSettings.ts`
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts` (add `USER_SETTINGS_ENDPOINTS`)

**What to implement**:

1. Add to `constants.ts`:
   ```
   USER_SETTINGS_ENDPOINTS.LIST                    → GET  /user-settings
   USER_SETTINGS_ENDPOINTS.GET(id)                 → GET  /user-settings/:id
   USER_SETTINGS_ENDPOINTS.BY_TENANT(tenantId)     → GET  /user-settings/tenant/:tenantId
   USER_SETTINGS_ENDPOINTS.BY_USER(userId)         → GET  /user-settings/user/:userId
   USER_SETTINGS_ENDPOINTS.TENANT_CONFIG(tenantId) → GET  /user-settings/config/tenant/:tenantId
   USER_SETTINGS_ENDPOINTS.CREATE                  → POST /user-settings
   USER_SETTINGS_ENDPOINTS.UPDATE(id)              → PATCH /user-settings/:id
   ```

2. Hook returning:
   ```typescript
   {
     settings: UserSetting[];
     mySettings: UserSetting[];
     isLoading: boolean;
     error: Error | null;
     list: (pagination?: PaginationParams) => Promise<UserSetting[]>;
     getMySettings: (userId: string) => Promise<UserSetting[]>;
     get: (id: string) => Promise<UserSetting>;
     create: (input: CreateUserSettingInput) => Promise<UserSetting>;
     update: (id: string, input: UpdateUserSettingInput) => Promise<UserSetting>;
   }
   ```

**Notes**: This is separate from `PersonalizationManager` (which uses `/users/me/preferences`). User settings are RBAC-protected CRUD records, while preferences are lightweight key-value pairs. Both are needed — preferences for quick toggles, settings for structured configuration.

---

### Task A-6: Add `usePipelines` hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/usePipelines.ts`

**What to implement**:

1. Hook returning:
   ```typescript
   {
     pipelines: Pipeline[];
     selectedPipeline: Pipeline | null;
     isLoading: boolean;
     error: Error | null;
     list: (pagination?: PaginationParams) => Promise<Pipeline[]>;
     get: (id: string) => Promise<Pipeline>;
     getBySlug: (slug: string) => Promise<Pipeline>;
     select: (pipelineId: string) => void;
   }
   ```

2. Uses existing `PIPELINE_ENDPOINTS` from constants. Persists selected pipeline to `PersonalizationManager`.

**API endpoints consumed** (constants already exist):
- `GET /api/v1/pipelines` — list all
- `GET /api/v1/pipelines/:id` — by ID
- `GET /api/v1/pipelines/slug/:slug` — by slug

---

### Task A-7: Add `useConsultationJob` hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts`
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts` (add `CONSULTATION_JOB_ENDPOINTS`)

**What to implement**:

1. Add to `constants.ts`:
   ```
   CONSULTATION_JOB_ENDPOINTS.GET(jobId)    → GET    /consultations/jobs/:jobId
   CONSULTATION_JOB_ENDPOINTS.CANCEL(jobId) → DELETE /consultations/jobs/:jobId
   CONSULTATION_JOB_ENDPOINTS.SSE(jobId)    → GET    /consultations/jobs/:jobId/sse
   ```

2. Hook returning:
   ```typescript
   {
     job: ConsultationJob | null;
     status: JobStatus;
     isStreaming: boolean;
     error: Error | null;
     getJob: (jobId: string) => Promise<ConsultationJob>;
     cancelJob: (jobId: string) => Promise<void>;
     streamJob: (jobId: string, callbacks: JobStreamCallbacks) => () => void;
     pollJob: (jobId: string, options?: PollOptions) => Promise<ConsultationJob>;
   }
   ```

3. `streamJob` connects to SSE endpoint and dispatches events (`status`, `progress`, `result`, `error`). Returns cleanup function.

**API endpoints consumed**:
- `GET /api/v1/consultations/jobs/:jobId` — job status
- `DELETE /api/v1/consultations/jobs/:jobId` — cancel
- `GET /api/v1/consultations/jobs/:jobId/sse` — SSE stream (events: status, progress, currentStep; auto-closes on COMPLETED/FAILED/CANCELLED)

---

### Task A-8: Export all new hooks from SDK entry points

**Files**:
- Modify: `packages/agentic-sdk-v2/src/index.ts`
- Modify: `packages/agentic-sdk-v2/src/core.ts`
- Modify: `packages/agentic-sdk-v2/src/types/index.ts`

**What to implement**:
- Export `useAuth`, `useMonitoring`, `useHealthCheck`, `useGlobalSettings`, `useUserSettings`, `usePipelines`, `useConsultationJob` from both entry points
- Export all new types from `types/index.ts`

---

## WS-B: SDK Summary/STT Enhancements (Layer 2)

**Goal**: Extend existing SDK hooks to support missing parameters required by FEAT-02 and FEAT-03.

**Engineer**: 1 · **Duration**: 2 days · **Dependencies**: WS-A complete

### Task B-1: Extend summary generation to accept transcript, promptTemplateId, dnaStyleId

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useArca.ts`
- Modify: `packages/agentic-sdk-v2/src/types/summary.ts`

**What to implement**:

1. Extend `SummaryGenerationOptions`:
   ```typescript
   interface SummaryGenerationOptions {
     dnaStyleId?: string;
     includeNER?: boolean;
     transcript?: string;           // NEW: raw transcript text input
     promptTemplateId?: string;     // NEW: specific prompt template to use
     departmentId?: string;         // NEW: department for prompt resolution
   }
   ```

2. Update `generateSummary()`, `generatePreSummary()`, `generateSummaryAsync()`, `generatePreSummaryAsync()` to pass these new fields in the request body.

**API alignment**: The backend `GenerateSummaryRequest` and `GeneratePreSummaryRequest` DTOs accept these fields. The SDK hooks currently omit them.

---

### Task B-2: Expose structured transcript with diarization from WebSocket

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useArca.ts`
- Modify: `packages/agentic-sdk-v2/src/types/audio.ts`

**What to implement**:

1. Add to audio types:
   ```typescript
   interface TranscriptSegment {
     text: string;
     startTime: number;
     endTime: number;
     isFinal: boolean;
     speakerLabel?: string;
     confidence?: number;
     language?: string;
   }
   ```

2. Extend `UseArcaAudio`:
   ```typescript
   {
     // existing...
     currentTranscript: string;
     transcriptSegments: TranscriptSegment[];  // NEW: structured segments
     language: string;                          // NEW: current language
   }
   ```

3. Update `audio.start()` to accept `{ language?: string, pipelineId?: string }`.

---

### Task B-3: Add auto-refresh for context items after transcription job completion

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useArca.ts`

**What to implement**:

When a transcription job completes (detected via SSE or polling), automatically refresh context items by calling `GET /consultations/:id/context`. This ensures the new transcript context item created by the backend's internal STT service appears in the UI without manual refresh.

Wire into the existing `TranscriptionJobService.pollJobStatus()` completion callback and `SSEClient` terminal event handler.

---

## WS-C: Shared Example Components (Layer 2)

**Goal**: Build reusable React components used across all three demo pages.

**Engineer**: 1 · **Duration**: 2 days · **Dependencies**: WS-A (partial — can start component shells immediately)

**Note**: These components go into the example apps, not the SDK package. Build in Vite app first, then port to Next.js.

### Task C-1: `<DemoPageShell>` component

**Files**:
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/components/demo-page-shell.tsx`

**What to implement**:

A layout wrapper for all demo pages providing:
- Page title and description
- `<ServiceStatusBar>` from `@arcaai/ui` at the top
- Tab navigation container (using `Tabs` from `@arcaai/ui`)
- Collapsible code example section at the bottom

```typescript
interface DemoPageShellProps {
  title: string;
  description: string;
  tabs: { value: string; label: string; content: React.ReactNode }[];
  codeExample?: { title: string; code: string; language?: string };
  children?: React.ReactNode;
}
```

---

### Task C-2: `<RecordingControls>` component

**Files**:
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/components/recording-controls.tsx`

**What to implement**:

Audio recording control bar with:
- Start/Stop recording button (large, prominent)
- Mute/Unmute toggle
- Language selector dropdown (common languages: en, th, zh, ja, etc.)
- Recording status indicator (idle, recording, processing)
- `<AudioMeter>` from `@arcaai/ui` showing real-time sound level

```typescript
interface RecordingControlsProps {
  isCapturing: boolean;
  isMuted: boolean;
  level: number;
  isSpeaking: boolean;
  language: string;
  onStart: () => void;
  onStop: () => void;
  onMute: () => void;
  onUnmute: () => void;
  onLanguageChange: (lang: string) => void;
}
```

---

### Task C-3: `<TranscriptDisplay>` component

**Files**:
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/components/transcript-display.tsx`

**What to implement**:

Real-time transcript viewer with:
- Auto-scroll to bottom on new segments
- Speaker labels with color coding (Speaker 1 = blue, Speaker 2 = green, etc.)
- Timestamps per segment
- Final vs interim segment styling (interim = italic/dimmed)
- Empty state with placeholder text

```typescript
interface TranscriptDisplayProps {
  segments: TranscriptSegment[];
  isRecording: boolean;
  autoScroll?: boolean;
}
```

---

### Task C-4: `<FileUploadZone>` component

**Files**:
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/components/file-upload-zone.tsx`

**What to implement**:

Drag-and-drop file upload area with:
- Drag-over visual feedback
- File type validation (audio formats: wav, mp3, m4a, flac, ogg, webm)
- File size display
- Upload progress bar
- Selected file info card

```typescript
interface FileUploadZoneProps {
  onFileSelect: (file: File) => void;
  isUploading: boolean;
  progress?: number;
  acceptedFormats?: string[];
  maxSizeMb?: number;
}
```

---

### Task C-5: `<JobProgressTracker>` component

**Files**:
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/components/job-progress-tracker.tsx`

**What to implement**:

Job status display with:
- Job ID display
- Status badge (pending, processing, completed, failed, cancelled)
- Progress bar with percentage
- Elapsed time counter
- Step indicator (current processing step)
- Result display area (expandable)
- Cancel button (for in-progress jobs)

```typescript
interface JobProgressTrackerProps {
  jobId: string;
  status: string;
  progress?: number;
  currentStep?: string;
  startedAt?: Date;
  completedAt?: Date;
  result?: string;
  onCancel?: () => void;
}
```

---

### Task C-6: `<StreamingTextDisplay>` component

**Files**:
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/components/streaming-text-display.tsx`

**What to implement**:

Streaming text renderer for summary generation:
- Renders text as it arrives (character-by-character or chunk-by-chunk)
- Markdown rendering support (using `react-markdown` or similar)
- Typing cursor animation while streaming
- Copy-to-clipboard button
- "Generating..." indicator

```typescript
interface StreamingTextDisplayProps {
  text: string;
  isStreaming: boolean;
  format?: 'plain' | 'markdown';
}
```

---

### Task C-7: `<PromptDepartmentSelector>` component

**Files**:
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/components/prompt-department-selector.tsx`

**What to implement**:

Two-level selector for department → prompt template:
- Department dropdown (fetched via `useDepartments()`)
- Prompt template dropdown (filtered by selected department via `usePrompts()`)
- Shows prompt template description/preview
- Optional "None" selection

```typescript
interface PromptDepartmentSelectorProps {
  selectedDepartmentId?: string;
  selectedPromptId?: string;
  onDepartmentChange: (departmentId: string | undefined) => void;
  onPromptChange: (promptId: string | undefined) => void;
}
```

---

### Task C-8: Port all components to Next.js app

**Files**:
- Create: `packages/agentic-sdk-v2/examples/nextjs-app/src/components/demo-page-shell.tsx`
- Create: `packages/agentic-sdk-v2/examples/nextjs-app/src/components/recording-controls.tsx`
- Create: `packages/agentic-sdk-v2/examples/nextjs-app/src/components/transcript-display.tsx`
- Create: `packages/agentic-sdk-v2/examples/nextjs-app/src/components/file-upload-zone.tsx`
- Create: `packages/agentic-sdk-v2/examples/nextjs-app/src/components/job-progress-tracker.tsx`
- Create: `packages/agentic-sdk-v2/examples/nextjs-app/src/components/streaming-text-display.tsx`
- Create: `packages/agentic-sdk-v2/examples/nextjs-app/src/components/prompt-department-selector.tsx`

**What to implement**: Port all Vite components to Next.js. Changes are minimal — add `'use client'` directive, replace `react-router-dom` imports with `next/link` if needed.

---

## WS-D: FEAT-01 Setup Page (Layer 3)

**Goal**: Build the full Setup & Configuration page per FEAT-01 specification.

**Engineer**: 1 · **Duration**: 3 days · **Dependencies**: WS-A, WS-B, WS-C

### Task D-1: Backend Configuration Card

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/setup.tsx`

**What to implement**:

Card 1 of the setup page:
- Display current API URL, Socket URL, API Key (masked), Tenant ID, Doctor/User ID
- Edit mode with inline inputs (reuse from `api-settings.tsx`)
- Connection test button with status indicator
- Save & reload functionality
- Uses `useApiConfig()` store

---

### Task D-2: User Preferences Card — Theme & STT Workflow

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/setup.tsx`

**What to implement**:

Card 2a — Theme:
- Theme toggle (light/dark/system) using `ThemeToggle` from `@arcaai/ui`
- Persists via `useArcaConfig()` preferences

Card 2b — STT Workflow Preference:
- Toggle/switcher: "Local Processing" vs "Remote Processing"
- Uses `useArcaConfig()` to store preference

When **Local Processing** selected (2b1):
- AI Model selector for STT (fetched via `useArca().audio.plugins` + `ModelRegistry`)
- Word-level timestamp toggle (on/off)
- Noise Cancellation model selector (on/off + model selection)
- VAD model selector (on/off + model selection)
- Voice/Speaker Embedding toggle (on/off + model selection for diarization)
- All models fetched from tenant global settings via `useGlobalSettings()`

When **Remote Processing** selected (2b2):
- Pipeline selector (fetched via `usePipelines()`)
- Service health status display using `useHealthCheck()`
- Shows status badges for STT, NLP, SMR services

---

### Task D-3: User Settings Persistence

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/setup.tsx`

**What to implement**:

- All user preferences stored via `useUserSettings()` and `useArcaConfig()`
- On page load, fetch user settings and populate UI
- On change, debounce and save to backend
- Speaker voice embedding section:
  - "Record My Voice" button (records 10-second sample)
  - Status indicator (embedded / not embedded)
  - Note: Backend API for voice embedding storage is pending (see gap F1-8). For now, show a placeholder with "Coming Soon" badge and store locally.

---

### Task D-4: Code Example Section

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/setup.tsx`

**What to implement**:

Collapsible code example at the bottom showing:
```typescript
import { AgenticProvider, useArcaConfig } from '@arcaai/vox';

function Setup() {
  const { config, updateConfig } = useArcaConfig();

  // Theme preference
  updateConfig({ theme: 'dark' });

  // STT workflow
  updateConfig({
    audio: {
      stt: { provider: 'local', language: 'en' },
      vad: { enabled: true },
      noiseFilter: { enabled: true },
    }
  });
}
```

---

### Task D-5: Port Setup page to Next.js

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/nextjs-app/src/app/setup/_content.tsx`

---

## WS-E: FEAT-02 Transcription Page (Layer 3)

**Goal**: Build the full Transcription Demo page per FEAT-02 specification.

**Engineer**: 1 · **Duration**: 3 days · **Dependencies**: WS-A, WS-B, WS-C

### Task E-1: Service Status Section

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/transcription.tsx`

**What to implement**:

Top section of the page:
- `<ServiceStatusBar>` showing: active WebSocket connections, processing jobs count, service health
- Uses `useMonitoring()` for session counts and `useHealthCheck()` for service status
- Auto-refreshes every 10 seconds

---

### Task E-2: Tab 1 — Live Transcription

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/transcription.tsx`

**What to implement**:

1. **Consultation management**: On page load or "Start" click, call `session.open()` to get-or-create consultation. Display consultation ID.

2. **Recording controls**: `<RecordingControls>` component with:
   - Start → calls `audio.start()` (which creates streaming session + WebSocket if remote)
   - Stop → calls `audio.stop()`
   - Mute/Unmute → calls `audio.mute()` / `audio.unmute()`
   - Language selector → passed to `audio.start({ language })`

3. **Display components**:
   - Recording status badge (idle/recording/processing)
   - Voice activity indicator (`audio.isSpeaking`)
   - `<AudioMeter>` showing `audio.level`
   - `<TranscriptDisplay>` showing `audio.transcriptSegments` with auto-scroll

4. **Post-recording**: When recording stops, the consultation is updated with a new audio context item. Display the linked context item ID.

5. **Code example**: Collapsible section showing the full SDK integration code.

**SDK hooks used**: `useArca()` — `session.open()`, `audio.start()`, `audio.stop()`, `audio.mute()`, `audio.unmute()`, `audio.level`, `audio.isSpeaking`, `audio.transcriptSegments`, `context.items`

---

### Task E-3: Tab 2 — Upload Audio File Transcription

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/transcription.tsx`

**What to implement**:

1. **Consultation management**: Same as Tab 1 — get-or-create consultation.

2. **File upload**: `<FileUploadZone>` component for selecting audio file.

3. **Job submission**: On file select, call `FileTranscriptionService.uploadAndTranscribe(file, { pipelineId, consultationId, language })`.

4. **Job tracking**: `<JobProgressTracker>` component showing:
   - Job ID, status, progress percentage
   - Elapsed time (timer starts on submit)
   - SSE connection for real-time updates (via `SSEClient`)
   - Final result display when job completes

5. **Post-completion**: Display the transcription result text. Show that the consultation was updated with a new audio context item.

6. **Code example**: Collapsible section showing the full SDK integration code.

**SDK services used**: `FileTranscriptionService`, `SSEClient`, `TranscriptionJobService`, `useArca().session`

---

### Task E-4: Port Transcription page to Next.js

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/nextjs-app/src/app/transcription/_content.tsx`

---

## WS-F: FEAT-03 Summarization Page (Layer 3)

**Goal**: Build the full Summarization Demo page per FEAT-03 specification.

**Engineer**: 1 · **Duration**: 3 days · **Dependencies**: WS-A, WS-B, WS-C

### Task F-1: Service Status Section

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/summarization.tsx`

**What to implement**:

Same pattern as Transcription page:
- `<ServiceStatusBar>` showing active SSE connections, processing jobs, service health
- Uses `useMonitoring()` and `useHealthCheck()`

---

### Task F-2: Tab 1 — Streaming Summarization

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/summarization.tsx`

**What to implement**:

1. **Consultation management**: Get-or-create consultation via `session.open()`.

2. **Control components**:
   - **Transcript input**: Large textarea with a default example medical conversation transcript pre-filled. Editable by user.
   - **Department/Prompt selector**: `<PromptDepartmentSelector>` using `useDepartments()` + `usePrompts()`. Optional — user can skip.
   - **DNA Writing Style selector**: Dropdown using `useDnaStyle()`. Shows "My Style" if available. Optional.
   - **Submit button**: "Generate Summary (Streaming)"

3. **Generation flow**:
   - Call `summary.generateSummaryAsync({ transcript, promptTemplateId, dnaStyleId })`
   - Connect to SSE via `useConsultationJob().streamJob(jobId, callbacks)`
   - As chunks arrive, append to `<StreamingTextDisplay>`

4. **Display components**:
   - `<StreamingTextDisplay>` showing summary as it generates
   - Status indicator (generating / complete / error)
   - Once complete, show that the consultation was updated with a new summary context item

5. **Code example**: Collapsible section showing the full SDK integration code.

**SDK hooks used**: `useArca().session`, `useArca().summary.generateSummaryAsync()`, `useConsultationJob().streamJob()`, `useDepartments()`, `usePrompts()`, `useDnaStyle()`

---

### Task F-3: Tab 2 — Non-Streaming Summarization

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/summarization.tsx`

**What to implement**:

1. **Consultation management**: Same as Tab 1.

2. **Control components**: Same inputs as Tab 1 (transcript, department/prompt, DNA style). Submit button: "Generate Summary (Async)".

3. **Generation flow**:
   - Call `summary.generateSummaryAsync({ transcript, promptTemplateId, dnaStyleId })`
   - Use `useConsultationJob().pollJob(jobId, { intervalMs: 2000 })` to poll status
   - Display `<JobProgressTracker>` with status, progress, elapsed time

4. **Result display**:
   - When job completes, fetch and display the full summary
   - Show time-to-finish metric
   - Show that the consultation was updated with a new summary context item

5. **Code example**: Collapsible section showing the full SDK integration code.

**SDK hooks used**: `useArca().session`, `useArca().summary.generateSummaryAsync()`, `useConsultationJob().pollJob()`, `useDepartments()`, `usePrompts()`, `useDnaStyle()`

---

### Task F-4: Port Summarization page to Next.js

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/nextjs-app/src/app/summarization/_content.tsx`

---

## WS-G: FEAT-04 Admin Page — SDK Hooks (Layer 1, parallel with WS-A)

**Goal**: Add all missing SDK hooks and API endpoints required by the Admin Demo page.

**Engineer**: 1 · **Duration**: 4 days · **Dependencies**: None (can run in parallel with WS-A)

> **Note**: This workstream includes both SDK work AND backend API controller creation where services exist but REST endpoints are missing.

### Task G-1: Add `USER_ENDPOINTS` and `useUsers` hook

**Files**:
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts`
- Create: `packages/agentic-sdk-v2/src/hooks/useUsers.ts`

**What to implement**:

1. Add to `constants.ts`:
   ```
   USER_ENDPOINTS.CREATE          → POST   /users
   USER_ENDPOINTS.LIST            → GET    /users
   USER_ENDPOINTS.GET(id)         → GET    /users/:id
   USER_ENDPOINTS.GET_BY_EXTERNAL(externalId) → GET /users/external/:externalId
   USER_ENDPOINTS.UPDATE(id)      → PATCH  /users/:id
   USER_ENDPOINTS.DELETE(id)      → DELETE /users/:id
   ```

2. Hook returning:
   ```typescript
   {
     users: User[];
     currentUser: User | null;
     isLoading: boolean;
     error: Error | null;
     list: (pagination?: PaginationParams) => Promise<User[]>;
     get: (id: string) => Promise<User>;
     getByExternalId: (externalId: string) => Promise<User>;
     create: (input: CreateUserInput) => Promise<User>;
     update: (id: string, input: UpdateUserInput) => Promise<User>;
     remove: (id: string) => Promise<void>;
   }
   ```

**API endpoints consumed**: All require JWT + RBAC (`CanRead('User')`, `CanCreate('User')`, etc.)

---

### Task G-2: Create API Key management controller (Backend) + SDK hook

**Files**:
- Create: `apps/api/src/modules/api-key/api-key.controller.ts`
- Create: `apps/api/src/modules/api-key/api-key.module.ts`
- Modify: `apps/api/src/app.module.ts` (register module)
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts`
- Create: `packages/agentic-sdk-v2/src/hooks/useApiKeys.ts`

**Backend controller** (wraps existing `ApiKeyService`):
```
POST   /api-keys              → Create API key (returns raw key once)
GET    /api-keys              → List API keys (paginated, masked)
GET    /api-keys/:id          → Get API key by ID (masked)
PATCH  /api-keys/:id          → Update API key metadata
DELETE /api-keys/:id          → Soft delete API key
POST   /api-keys/:id/revoke   → Revoke API key
GET    /api-keys/:id/usage    → Get usage statistics
```

**SDK hook** returning:
```typescript
{
  apiKeys: ApiKey[];
  isLoading: boolean;
  error: Error | null;
  list: (pagination?: PaginationParams) => Promise<ApiKey[]>;
  get: (id: string) => Promise<ApiKey>;
  create: (input: CreateApiKeyInput) => Promise<ApiKeyWithRawKey>;
  update: (id: string, input: UpdateApiKeyInput) => Promise<ApiKey>;
  remove: (id: string) => Promise<void>;
  revoke: (id: string) => Promise<void>;
  getUsage: (id: string) => Promise<ApiKeyUsage>;
}
```

**Notes**: The `ApiKeyService` already exists with full CRUD. This task wraps it with a NestJS controller and SDK hook. The raw key is only returned on creation. All other responses mask the key (show prefix + checksum only).

---

### Task G-3: Create `useAiModels` hook + extend constants

**Files**:
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts`
- Create: `packages/agentic-sdk-v2/src/hooks/useAiModels.ts`

**What to implement**:

1. Add missing constants:
   ```
   AI_MODEL_ENDPOINTS.CREATE                → POST  /ai-models
   AI_MODEL_ENDPOINTS.UPDATE(id)            → PATCH /ai-models/:id
   AI_MODEL_ENDPOINTS.DELETE(id)            → DELETE /ai-models/:id
   AI_MODEL_ENDPOINTS.UPDATE_DOWNLOAD_STATUS(id) → PATCH /ai-models/:id/download-status
   ```

2. Hook returning:
   ```typescript
   {
     models: AiModel[];
     isLoading: boolean;
     error: Error | null;
     list: (pagination?: PaginationParams) => Promise<AiModel[]>;
     get: (id: string) => Promise<AiModel>;
     getBySlug: (slug: string) => Promise<AiModel>;
     getByTaskType: (taskType: string) => Promise<AiModel[]>;
     getDownloaded: () => Promise<AiModel[]>;
     create: (input: CreateAiModelInput) => Promise<AiModel>;
     update: (id: string, input: UpdateAiModelInput) => Promise<AiModel>;
     updateDownloadStatus: (id: string, status: DownloadStatusInput) => Promise<AiModel>;
     remove: (id: string) => Promise<void>;
   }
   ```

---

### Task G-4: Extend `useDepartments` with create/delete + missing constants

**Files**:
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts`
- Modify: `packages/agentic-sdk-v2/src/hooks/useDepartments.ts`

**What to implement**:

1. Add missing constants:
   ```
   DEPARTMENT_ENDPOINTS.CREATE              → POST   /departments
   DEPARTMENT_ENDPOINTS.DELETE(id)          → DELETE /departments/:id
   DEPARTMENT_ENDPOINTS.ROOTS              → GET    /departments/roots
   DEPARTMENT_ENDPOINTS.CHILDREN(id)       → GET    /departments/:id/children
   DEPARTMENT_ENDPOINTS.BY_CODE(code)      → GET    /departments/code/:code
   DEPARTMENT_ENDPOINTS.PROMPT_CONFIG(id)  → PATCH  /departments/:id/prompt-config
   ```

2. Add methods to `useDepartments`:
   ```typescript
   {
     // existing: list, get, update
     create: (input: CreateDepartmentInput) => Promise<Department>;
     remove: (id: string) => Promise<void>;
     getRoots: () => Promise<Department[]>;
     getChildren: (id: string) => Promise<Department[]>;
     getByCode: (code: string) => Promise<Department>;
     updatePromptConfig: (id: string, config: PromptConfigInput) => Promise<Department>;
   }
   ```

---

### Task G-5: Create Storage management controller (Backend) + SDK hook

**Files**:
- Create: `apps/api/src/modules/storage/storage.controller.ts`
- Create: `apps/api/src/modules/storage/storage.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts`
- Create: `packages/agentic-sdk-v2/src/hooks/useStorage.ts`

**Backend controller** (wraps existing `S3Service`):
```
GET    /storage/buckets                    → List buckets
GET    /storage/buckets/:name              → Get bucket info
GET    /storage/buckets/:name/files        → List files (paginated, with prefix filter)
POST   /storage/buckets/:name/files        → Upload file (multipart/form-data)
GET    /storage/buckets/:name/files/:key   → Get file info + presigned download URL
DELETE /storage/buckets/:name/files/:key   → Delete file
GET    /storage/health                     → Storage service health check
```

**SDK hook** returning:
```typescript
{
  buckets: Bucket[];
  files: StorageFile[];
  isLoading: boolean;
  error: Error | null;
  listBuckets: () => Promise<Bucket[]>;
  getBucket: (name: string) => Promise<Bucket>;
  listFiles: (bucket: string, prefix?: string, pagination?: PaginationParams) => Promise<StorageFile[]>;
  uploadFile: (bucket: string, file: File, key?: string) => Promise<StorageFile>;
  getFileInfo: (bucket: string, key: string) => Promise<StorageFileWithUrl>;
  deleteFile: (bucket: string, key: string) => Promise<void>;
  checkHealth: () => Promise<StorageHealth>;
}
```

**Notes**: The `S3Service` already implements all operations. This task creates a REST controller to expose them and an SDK hook to consume them. Auth: JWT + RBAC.

---

### Task G-6: Create User Role Assignment controller (Backend) + SDK hook

**Files**:
- Create: `apps/api/src/modules/user/user-role-assignment.controller.ts` (or add to existing users controller)
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts`
- Create: `packages/agentic-sdk-v2/src/hooks/useRoles.ts`

**Backend endpoints** (wraps existing `UserRoleAssignmentService`):
```
GET    /users/:userId/roles              → Get user's role assignments
POST   /users/:userId/roles              → Assign role to user
DELETE /users/:userId/roles/:roleId      → Remove role from user
GET    /roles                            → List all available roles
GET    /roles/:id                        → Get role by ID
```

**SDK hook** returning:
```typescript
{
  roles: Role[];
  isLoading: boolean;
  error: Error | null;
  listRoles: () => Promise<Role[]>;
  getRole: (id: string) => Promise<Role>;
  getUserRoles: (userId: string) => Promise<UserRoleAssignment[]>;
  assignRole: (userId: string, roleId: string) => Promise<UserRoleAssignment>;
  removeRole: (userId: string, roleId: string) => Promise<void>;
}
```

---

### Task G-7: Export all new hooks from SDK entry points

**Files**:
- Modify: `packages/agentic-sdk-v2/src/index.ts`
- Modify: `packages/agentic-sdk-v2/src/core.ts`
- Modify: `packages/agentic-sdk-v2/src/types/index.ts`

Export: `useUsers`, `useApiKeys`, `useAiModels`, `useStorage`, `useRoles` + all new types.

---

## WS-H: FEAT-05 DNA Writing Style — SDK Enhancements (Layer 2)

**Goal**: Fill SDK gaps specific to the DNA Writing Style demo flow.

**Engineer**: 1 · **Duration**: 2 days · **Dependencies**: WS-A (for `useConsultationJob`), WS-G (for `useUsers`)

### Task H-1: Add consultation listing endpoint (Backend) + SDK method

**Files**:
- Modify: `apps/api/src/modules/consultation/consultation.controller.ts`
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts`
- Modify: `packages/agentic-sdk-v2/src/hooks/useArca.ts`

**What to implement**:

1. Backend: Add admin endpoint to list all consultations with optional filters:
   ```
   GET /consultations?page=1&limit=20&hasSummary=true&doctorId=xxx
   ```
   This endpoint returns paginated consultations. The `hasSummary=true` filter returns only consultations that have at least one summary context item.

2. SDK constant:
   ```
   CONSULTATION_ENDPOINTS.LIST → GET /consultations
   ```

3. SDK method on `useArca().session`:
   ```typescript
   listConsultations: (filters?: ConsultationListFilters) => Promise<PaginatedResponse<Consultation>>;
   ```
   Where `ConsultationListFilters` includes `{ page?, limit?, doctorId?, hasSummary?, departmentId? }`.

---

### Task H-2: Add `getJobStatus` to `useDnaStyle` hook

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useDnaStyle.ts`

**What to implement**:

1. Add method to `useDnaStyle`:
   ```typescript
   {
     // existing: getMyStyle, generate, update, getVersions
     getJobStatus: (jobId: string) => Promise<DnaJobStatus>;
     pollJobStatus: (jobId: string, options?: PollOptions) => Promise<DnaReport>;
   }
   ```

2. `getJobStatus` calls `DNA_STYLE_ENDPOINTS.ADMIN_JOB_STATUS(jobId)`.

3. `pollJobStatus` polls until terminal state (completed/failed), then auto-fetches the updated DNA report via `getMyStyle()`.

**Types**:
```typescript
interface DnaJobStatus {
  jobId: string;
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused';
  progress?: number;
  result?: DnaReport;
}
```

---

### Task H-3: Extend `DnaGenerateInput` to accept `promptTemplateId`

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useDnaStyle.ts`
- Modify: `packages/agentic-sdk-v2/src/types/` (DNA types)
- Potentially modify: `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts`

**What to implement**:

1. Extend SDK input type:
   ```typescript
   interface DnaGenerateInput {
     textSamples?: string[];
     departmentId?: string;
     promptTemplateId?: string;  // NEW: optional override for DNA_ANALYSIS prompt
   }
   ```

2. If backend `GenerateDnaReportRequest` doesn't accept `promptTemplateId`, add it. The backend currently auto-selects a `DNA_ANALYSIS` category prompt. This change makes it optionally overridable.

---

### Task H-4: Add `getDnaReportByDoctor` method

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useDnaStyle.ts`
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts`

**What to implement**:

1. Add constant:
   ```
   DNA_STYLE_ENDPOINTS.BY_DOCTOR(doctorId) → GET /dna-writing-styles/doctor/:doctorId
   ```

2. Add method:
   ```typescript
   getByDoctor: (doctorId: string) => Promise<DnaReport | null>;
   ```

**Notes**: Check if the backend admin controller already exposes this. If not, add a new endpoint. The demo needs to view DNA reports for the doctor associated with the selected consultation.

---

## WS-I: FEAT-04 Admin Page (Layer 3)

**Goal**: Build the full Admin Demo page per FEAT-04 specification.

**Engineer**: 1 · **Duration**: 4 days · **Dependencies**: WS-G (admin SDK hooks), WS-C (shared components)

### Task I-1: Service Status Section

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx`

**What to implement**:
- `<ServiceStatusBar>` showing active sockets/SSE, processing jobs, resource consumption
- Uses `useMonitoring()` and `useHealthCheck()`

---

### Task I-2: Tab 1 — User Management

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx`

**What to implement**:

1. **User list table**: Paginated table with columns: Name, Email, Role, Tenant, Status, Actions
   - Uses `useUsers().list()`
   - Search/filter by name, email
   - Pagination controls

2. **Create user dialog**: Modal form with fields from `CreateUserInput`
   - Uses `useUsers().create()`

3. **Edit user dialog**: Pre-filled modal form
   - Uses `useUsers().update()`

4. **Delete user confirmation**: Confirmation dialog
   - Uses `useUsers().remove()`

5. **Role management**: Inline role badges with add/remove
   - Uses `useRoles().getUserRoles()`, `assignRole()`, `removeRole()`

6. **API Key management section** (expandable per user or separate sub-tab):
   - API key list table: Prefix, Type, Status, Last Used, Usage Count, Actions
   - Create key dialog (shows raw key once with copy button)
   - Revoke/delete key actions
   - Usage statistics display
   - Uses `useApiKeys()`

---

### Task I-3: Tab 2 — Prompt Management

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx`

**What to implement**:

1. **Prompt template list**: Table with Name, Category, Department, Version, Status
   - Uses `usePrompts().list()`
   - Filter by category (`SYSTEM`, `SUMMARY`, `DNA_ANALYSIS`, `CUSTOM`)
   - Filter by department

2. **Create/Edit prompt dialog**: Form with name, content (large textarea), category, variables
   - Uses `usePrompts().create()`, `update()`

3. **Version history panel**: Expandable section showing version timeline
   - Uses `usePrompts().getVersions()`, `compareVersions()`
   - `<DiffViewer>` component for version comparison

4. **Department assignment**: Assign prompt to department
   - Uses `usePrompts().assignToDepartment()`

5. **Delete confirmation**: With warning about department assignments
   - Uses `usePrompts().remove()`

---

### Task I-4: Tab 3 — Model Management

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx`

**What to implement**:

1. **Model list**: Table with Name, Slug, Category, Task Type, Source, Format, Download Status
   - Uses `useAiModels().list()`
   - Filter by category, task type, download status

2. **Create model dialog**: Form with all model fields
   - Uses `useAiModels().create()`

3. **Edit model dialog**: Pre-filled form
   - Uses `useAiModels().update()`

4. **Download status management**: Update download status, show progress
   - Uses `useAiModels().updateDownloadStatus()`

5. **Delete confirmation**
   - Uses `useAiModels().remove()`

---

### Task I-5: Tab 4 — Department Management

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx`

**What to implement**:

1. **Department tree/list**: Hierarchical display with parent-child relationships
   - Uses `useDepartments().getRoots()`, `getChildren()`

2. **Create department dialog**: Form with name, code, parent department
   - Uses `useDepartments().create()`

3. **Edit department dialog**: Pre-filled form
   - Uses `useDepartments().update()`

4. **Prompt config management**: Configure department-level prompt settings
   - Uses `useDepartments().updatePromptConfig()`

5. **Delete confirmation**: With warning about child departments
   - Uses `useDepartments().remove()`

---

### Task I-6: Tab 5 — Storage Management

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx`

**What to implement**:

1. **Bucket list**: Cards showing bucket name, file count, total size
   - Uses `useStorage().listBuckets()`

2. **File browser**: Table with file name, size, last modified, actions
   - Uses `useStorage().listFiles(bucket, prefix)`
   - Breadcrumb navigation for folder prefixes
   - Search/filter by prefix

3. **Upload file**: Drag-and-drop zone within selected bucket
   - Uses `useStorage().uploadFile()`

4. **File actions**: Download (presigned URL), delete
   - Uses `useStorage().getFileInfo()`, `deleteFile()`

5. **Storage health**: Connection status indicator
   - Uses `useStorage().checkHealth()`

---

### Task I-7: Code examples for each tab

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/admin.tsx`

Each tab includes a collapsible code example section showing SDK integration.

---

### Task I-8: Port Admin page to Next.js

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/nextjs-app/src/app/admin/_content.tsx`

---

## WS-J: FEAT-05 DNA Writing Style Page (Layer 3)

**Goal**: Build the full DNA Writing Style Demo page per FEAT-05 specification.

**Engineer**: 1 · **Duration**: 3 days · **Dependencies**: WS-H (DNA SDK enhancements), WS-C (shared components), WS-A (`useConsultationJob`)

### Task J-1: Add route and page skeleton

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/App.tsx` (add `/dna-style` route)
- Create: `packages/agentic-sdk-v2/examples/vite-app/src/pages/dna-style.tsx`
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/components/navigation.tsx` (add nav item)

---

### Task J-2: Service Status Section

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/dna-style.tsx`

**What to implement**:
- Status bar showing: running DNA jobs count, total DNA reports generated
- Uses `useMonitoring()` for job counts

---

### Task J-3: Consultation Selector

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/dna-style.tsx`

**What to implement**:

1. **Consultation list**: Searchable, paginated list of consultations
   - Uses `useArca().session.listConsultations({ hasSummary: true })`
   - Shows: Patient ID, Doctor ID, Date, Department, Summary count badge
   - Only shows consultations with at least one summary context item

2. **Selection**: Click to select a consultation. On selection:
   - Load the consultation via `session.load(id)`
   - Load summaries via `summary.loadSummaries()`
   - Display the raw summary content

---

### Task J-4: Vertical Stepper — DNA Generation Flow

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/dna-style.tsx`

**What to implement**:

A vertical stepper component with 5 steps:

**Step 1: Review & Edit Summary**
- Display the raw summary from the selected consultation (read-only preview)
- Editable textarea pre-filled with the raw summary content
- "Next" button to proceed

**Step 2: Existing DNA Style Report**
- Display the current DNA writing style report for the consultation's doctor
- Uses `useDnaStyle().getByDoctor(doctorId)` or `getMyStyle()`
- If no report exists, show "No existing DNA style report" message
- "Next" button to proceed

**Step 3: Select DNA Prompt Template**
- Dropdown listing available DNA_ANALYSIS prompt templates
- Uses `usePrompts().list({ category: 'DNA_ANALYSIS' })`
- Shows prompt template preview/description
- Optional — can proceed without selection (backend uses default)
- "Next" button to proceed

**Step 4: Generate DNA Report**
- Summary of all inputs: edited summary text, selected prompt template
- "Generate DNA Writing Style" submit button
- On submit:
  - Call `useDnaStyle().generate({ textSamples: [editedSummary], promptTemplateId })`
  - Returns `{ jobId }`
  - Start polling via `useDnaStyle().pollJobStatus(jobId)`
- Display `<JobProgressTracker>` with:
  - Job ID, status, progress
  - Elapsed time counter
  - Cancel button if in progress

**Step 5: Results**
- Display the newly generated DNA writing style report
- Show time-to-finish metric
- Version comparison with previous report (if exists) using `<DiffViewer>`
- Uses `useDnaStyle().getVersions(reportId)` for version history

---

### Task J-5: Code Example Section

**Files**:
- Modify: `packages/agentic-sdk-v2/examples/vite-app/src/pages/dna-style.tsx`

Collapsible code example showing the full SDK integration:
```typescript
import { useArca, useDnaStyle, usePrompts } from '@arcaai/vox';

function DnaStyleDemo() {
  const { session, summary } = useArca();
  const dna = useDnaStyle();
  const prompts = usePrompts();

  // 1. Load consultation with summaries
  await session.load(consultationId);
  await summary.loadSummaries();

  // 2. Get existing DNA report
  const existingReport = await dna.getMyStyle();

  // 3. List DNA prompt templates
  const dnaPrompts = await prompts.list({ category: 'DNA_ANALYSIS' });

  // 4. Generate new DNA report
  const { jobId } = await dna.generate({
    textSamples: [editedSummary],
    promptTemplateId: selectedPromptId,
  });

  // 5. Poll until complete
  const report = await dna.pollJobStatus(jobId);
}
```

---

### Task J-6: Port DNA Style page to Next.js

**Files**:
- Create: `packages/agentic-sdk-v2/examples/nextjs-app/src/app/dna-style/page.tsx`
- Create: `packages/agentic-sdk-v2/examples/nextjs-app/src/app/dna-style/_content.tsx`
- Modify: `packages/agentic-sdk-v2/examples/nextjs-app/src/components/navigation.tsx`

---

## API Gaps Requiring Backend Changes

These items require **backend API changes** in addition to SDK work. Some are included in workstreams above (G-2, G-5, G-6, H-1), others are separate tickets.

| ID | Gap | Included In | Priority |
|----|-----|-------------|----------|
| A4-3 | API Key CRUD controller | WS-G Task G-2 | Critical |
| A4-6 | User Role Assignment controller | WS-G Task G-6 | High |
| A4-14 | Storage management controller | WS-G Task G-5 | Critical |
| A5-1 | List all consultations endpoint | WS-H Task H-1 | High |
| A5-2 | Accept `promptTemplateId` in DNA generation | WS-H Task H-3 | Medium |
| F1-8 | Speaker voice embedding API | TASK-033 (separate) | High |
| X-4 | PersonalizationManager reconciliation | Future TASK (to be planned) | Medium |

### TASK-033: Speaker Voice Embedding API

**What's needed**:
- `POST /api/v1/users/:id/voice-embedding` — upload voice sample, extract embedding, store in Qdrant
- `GET /api/v1/users/:id/voice-embedding` — retrieve embedding status and metadata
- `DELETE /api/v1/users/:id/voice-embedding` — remove stored embedding

**Why**: FEAT-01 item 3 requires embedding the current user's voice for speaker recognition during local diarization. The Qdrant vector DB exists in infrastructure but no API endpoint exposes embedding storage.

### TASK-034: Reconcile PersonalizationManager with User Settings API

**What's needed**: Clarify the relationship between `PersonalizationManager` (uses `/users/me/preferences`) and the `UserSettingsController` (uses `/user-settings/*`). Either:
- Option A: Merge them — `PersonalizationManager` delegates to `/user-settings/*`
- Option B: Keep separate — preferences for lightweight toggles, settings for structured config

---

## Updated Dependency Graph

```
Layer 1 (parallel):
┌───────────────────────┐    ┌───────────────────────────────┐
│  WS-A: SDK Hooks      │    │  WS-G: Admin SDK Hooks        │
│  (Auth, Monitoring,   │    │  (Users, ApiKeys, AiModels,   │
│   Settings, Pipelines,│    │   Departments+, Storage,      │
│   ConsultationJob)    │    │   Roles)                      │
│  1 eng · 3 days       │    │  1 eng · 4 days               │
└───────────┬───────────┘    └───────────┬─────────────────┘
            │                            │
Layer 2 (parallel after Layer 1):
┌───────────┴───────────┐    ┌───────────┴─────────────────┐
│  WS-B: SDK Summary/   │    │  WS-H: DNA Style SDK        │
│  STT Enhancements     │    │  Enhancements               │
│  1 eng · 2 days       │    │  1 eng · 2 days             │
├───────────────────────┤    └───────────┬─────────────────┘
│  WS-C: Shared Example │                │
│  Components           │                │
│  1 eng · 2 days       │                │
└───────────┬───────────┘                │
            │                            │
Layer 3 (parallel after Layer 2):
┌───────────┴───┐ ┌─────────┐ ┌─────────┐ ┌───────┴───┐ ┌─────────┐
│  WS-D: FEAT-01│ │ WS-E:   │ │ WS-F:   │ │ WS-I:     │ │ WS-J:   │
│  Setup Page   │ │ FEAT-02 │ │ FEAT-03 │ │ FEAT-04   │ │ FEAT-05 │
│  1 eng · 3d   │ │ Transcr.│ │ Summary │ │ Admin     │ │ DNA     │
│               │ │ 1e · 3d │ │ 1e · 3d │ │ 1e · 4d  │ │ 1e · 3d │
└───────────────┘ └─────────┘ └─────────┘ └──────────┘ └─────────┘
```

---

## Updated Timeline

```
Day 1-4:  WS-A (SDK Hooks & Constants)        ← Engineer 1  }
          WS-G (Admin SDK Hooks + Backend)     ← Engineer 2  } parallel

Day 5-6:  WS-B (SDK Summary/STT Enhancements) ← Engineer 3  }
          WS-C (Shared Components)             ← Engineer 4  } parallel
          WS-H (DNA Style SDK Enhancements)    ← Engineer 5  }

Day 7-10: WS-D (FEAT-01 Setup)                ← Engineer 3  }
          WS-E (FEAT-02 Transcription)         ← Engineer 4  }
          WS-F (FEAT-03 Summarization)         ← Engineer 5  } parallel
          WS-I (FEAT-04 Admin)                 ← Engineer 2  }
          WS-J (FEAT-05 DNA Style)             ← Engineer 1  }
```

**Total**: 10 calendar days with 5 engineers
**Total engineer-days**: ~28 days
**Maximum parallelism**: 5 engineers during Layer 3
**Critical path**: WS-G (4d) → WS-H (2d) → WS-I (4d) = 10 days

---

## Updated Workstream Summary

| Workstream | Engineer | Duration | Dependencies | Focus |
|------------|----------|----------|--------------|-------|
| WS-A: SDK Hooks & Constants | Eng 1 | 3 days | None | Auth, Monitoring, Health, Settings, Pipelines, ConsultationJob |
| WS-B: SDK Summary/STT Enhancements | Eng 3 | 2 days | WS-A | Extend summary params, structured transcript, auto-refresh |
| WS-C: Shared Example Components | Eng 4 | 2 days | WS-A (partial) | DemoPageShell, RecordingControls, TranscriptDisplay, etc. |
| WS-D: FEAT-01 Setup Page | Eng 3 | 3 days | WS-A, WS-B, WS-C | Full configuration page |
| WS-E: FEAT-02 Transcription Page | Eng 4 | 3 days | WS-A, WS-B, WS-C | Live + file upload transcription |
| WS-F: FEAT-03 Summarization Page | Eng 5 | 3 days | WS-A, WS-B, WS-C | Streaming + non-streaming summary |
| **WS-G: Admin SDK Hooks + Backend** | **Eng 2** | **4 days** | **None** | **Users, ApiKeys, AiModels, Departments, Storage, Roles** |
| **WS-H: DNA Style SDK Enhancements** | **Eng 5** | **2 days** | **WS-A, WS-G** | **Consultation listing, DNA job polling, prompt selection** |
| **WS-I: FEAT-04 Admin Page** | **Eng 2** | **4 days** | **WS-G, WS-C** | **5-tab admin: Users, Prompts, Models, Depts, Storage** |
| **WS-J: FEAT-05 DNA Style Page** | **Eng 1** | **3 days** | **WS-H, WS-C** | **Consultation selector, vertical stepper, DNA generation** |

---

## Acceptance Criteria

### FEAT-01 through FEAT-03 (unchanged)
1. All new SDK hooks have unit tests (TDD)
2. Both Vite and Next.js example apps are feature-equivalent
3. All API interactions go through SDK hooks (no direct `fetch` except health checks in settings)
4. Each demo page shows a collapsible code example section
5. Service status bar displays on Transcription and Summarization pages
6. Live transcription shows real-time diarized transcript with timestamps
7. File upload shows job progress with SSE updates
8. Streaming summarization displays text as it generates via SSE
9. Non-streaming summarization shows job polling with progress tracker
10. Setup page persists all user preferences to backend

### FEAT-04 Admin Demo
11. Admin page has 5 functional tabs: Users, Prompts, Models, Departments, Storage
12. User management includes full CRUD + role assignment + API key management
13. Prompt management includes CRUD + version history + diff viewer + department assignment
14. Model management includes CRUD + download status tracking
15. Department management includes CRUD + hierarchical display + prompt config
16. Storage management includes bucket listing + file browser + upload/download/delete
17. All admin operations use SDK hooks (no direct API calls)

### FEAT-05 DNA Writing Style Demo
18. DNA page has consultation selector with summary-existence filter
19. Vertical stepper visualizes the 5-step DNA generation process
20. Edited summary input pre-fills from raw summary
21. DNA prompt template selector filters by `DNA_ANALYSIS` category
22. Job tracking shows real-time status with polling
23. Result displays new DNA report with version comparison
24. Code example section shows full SDK integration

---

## Change History

| # | Date | Description | Status |
|---|------|-------------|--------|
| 1 | 2026-02-20 | Initial implementation plan created from gap analysis review. 6 workstreams (WS-A through WS-F), 3 layers, 8-day timeline for FEAT-01/02/03. | Pending |
| 2 | 2026-02-20 | Added FEAT-04 (Admin Demo) and FEAT-05 (DNA Writing Style Demo). Added 4 new workstreams (WS-G, WS-H, WS-I, WS-J). Identified 16 additional gaps: 6 critical (missing SDK hooks for users, API keys, AI models, storage; missing API controllers for API keys, storage), 6 high (missing department create/delete, role assignment, DNA job polling, consultation listing), 4 medium (DNA prompt selection, DNA by doctor, consultation summary filter). Updated timeline to 10 days with 5 engineers. Total workstreams: 10. Backend changes included in WS-G (API key + storage controllers) and WS-H (consultation listing + DNA prompt override). | Pending |
| 3 | 2026-02-20 | **WS-A Complete**: Implemented all 8 tasks (A-1 through A-8) using strict TDD. Created 7 new hooks (`useAuth`, `useMonitoring`, `useHealthCheck`, `useGlobalSettings`, `useUserSettings`, `usePipelines`, `useConsultationJob`), 5 new type files, 5 new endpoint constant groups (`AUTH_ENDPOINTS`, `SERVICE_HEALTH_ENDPOINTS`, `GLOBAL_SETTINGS_ENDPOINTS`, `USER_SETTINGS_ENDPOINTS`, `CONSULTATION_JOB_ENDPOINTS`). All 70 new tests pass. All 537 total hook tests pass (0 regressions). Exported from `hooks/index.ts`, `core.ts`, and `types/index.ts`. | Completed |
| 4 | 2026-02-20 | **WS-G Complete**: Implemented all 7 tasks (G-1 through G-7) using strict TDD. **SDK hooks**: `useUsers` (27 tests), `useApiKeys` (15 tests), `useAiModels` (16 tests), `useStorage` (12 tests), `useRoles` (10 tests). **Extended** `useDepartments` with 6 new methods (11 tests). **Constants**: `USER_ENDPOINTS`, `API_KEY_ENDPOINTS`, `STORAGE_ENDPOINTS`, `ROLE_ENDPOINTS` + extended `DEPARTMENT_ENDPOINTS` (+6 keys) and `AI_MODEL_ENDPOINTS` (+4 keys). **Backend controllers**: `ApiKeyController`, `StorageController`, `UserRoleAssignmentController`. All 155 WS-G tests pass. All 537 total hook tests pass (0 regressions). | Completed |
| 5 | 2026-02-20 | **WS-H Complete**: Implemented all 4 tasks (H-1 through H-4) using strict TDD. **Task H-1**: Added `CONSULTATION_ENDPOINTS.LIST` constant + `listConsultations(filters?)` on `useArca().session` with `ConsultationListFilters` type. Backend: `GET /consultations` endpoint + `listConsultations` on `IConsultationService`. **Task H-2**: Extended `useDnaStyle` with `getJobStatus(jobId)` and `pollJobStatus(jobId, options?)`. Added `DnaJobStatus` type. **Task H-3**: Extended `DnaGenerateInput` with `promptTemplateId`. Backend: added `departmentId` + `promptTemplateId` to `GenerateDnaReportRequest`. **Task H-4**: Added `DNA_STYLE_ENDPOINTS.BY_DOCTOR(doctorId)` + `getByDoctor(doctorId)` on `useDnaStyle`. Backend: `GET /dna-writing-styles/doctor/:doctorId`. All 24 WS-H tests pass. 583/584 total hook tests pass (1 pre-existing failure). | Completed |
| 6 | 2026-02-20 | **WS-B Complete**: Implemented all 3 tasks (B-1 through B-3) using strict TDD. **Task B-1**: Extended `UseArcaSummary` interface — `generateSummary`, `generatePreSummary`, `generateSummaryAsync`, `generatePreSummaryAsync` now accept `SummaryGenerationOptions` with `transcript`, `promptTemplateId`, `departmentId` (13 tests). **Task B-2**: Added `TranscriptSegment` type and `AudioStartOptions` to `audio.ts`. Extended `UseArcaAudio` with `transcriptSegments: TranscriptSegment[]` and `language: string`. Updated `audio.start()` to accept `{ language?, pipelineId? }` (10 tests). **Task B-3**: Wired auto-refresh of context items into `useConsultationJob.pollJob()` and `streamJob()` SSE handler — calls `CONTEXT_ENDPOINTS.GET(consultationId)` on terminal job status. Added missing WS-A endpoint constants (`AUTH_ENDPOINTS`, `SERVICE_HEALTH_ENDPOINTS`, `GLOBAL_SETTINGS_ENDPOINTS`, `USER_SETTINGS_ENDPOINTS`, `CONSULTATION_JOB_ENDPOINTS`) to `constants.ts` (6 tests). All 29 WS-B tests pass. 296 non-pre-existing tests pass (0 regressions). | Completed |
| 7 | 2026-02-20 | **WS-C Complete**: Implemented all 8 tasks (C-1 through C-8) using strict TDD. **Shared components** (Vite first, ported to Next.js): `<DemoPageShell>` (9 tests), `<RecordingControls>` (13 tests), `<TranscriptDisplay>` (9 tests), `<FileUploadZone>` (10 tests), `<JobProgressTracker>` (10 tests), `<StreamingTextDisplay>` (9 tests), `<PromptDepartmentSelector>` (11 tests). All ported to Next.js with `'use client'`. Added vitest + testing-library to Vite app, created `@/lib/utils.ts` for both apps. 71 new component tests, 283 total Vite app tests pass (0 regressions). | Completed |
| 8 | 2026-02-20 | **WS-F Complete**: Implemented all 4 tasks (F-1 through F-4) using strict TDD. **Task F-1**: Replaced custom `useServiceHealth()` with `useMonitoring()` + `useHealthCheck()` SDK hooks. Service status now uses `monitoring.sessions` for active sessions/jobs and `healthCheck.services` for per-service health. Auto-polls health every 10s via `healthCheck.startPolling()`. **Task F-2**: Refactored `StreamingTab` — replaced raw `EventSource` with `useConsultationJob().streamJob(jobId, callbacks)`. Now uses `<StreamingTextDisplay>` component. Passes `transcript`, `departmentId`, `promptTemplateId`, `dnaStyleId` in `generateSummaryAsync()` options. SSE cleanup via returned cleanup function. **Task F-3**: Refactored `PollingTab` — replaced raw `fetch` polling with `useConsultationJob().pollJob(jobId, { intervalMs: 2000 })`. Now uses `<JobProgressTracker>` component with elapsed time, cancel button, and result display. Passes `transcript`, `departmentId` in generation options. **Task F-4**: Ported all changes to Next.js `_content.tsx` with `'use client'` directive, `next/link`, `LazyProviders` wrapper. 23 new page tests pass. 187 total Vite app tests pass (0 regressions). | Completed |
| 9 | 2026-02-20 | **WS-J Complete**: Implemented all 6 tasks (J-1 through J-6) using strict TDD. **Task J-1**: Route `/dna-style` and navigation link already existed from prior work — verified. **Task J-2**: Added `<StatusBar>` component using `useMonitoring()` for session counts and `useHealthCheck()` for service health status. Renders with `data-testid="dna-status-bar"`. **Task J-3**: Built `<ConsultationSelector>` with searchable, paginated list. Calls `session.listConsultations({ hasSummary: true })` on mount. Displays patient ID, doctor ID, department badge, appointment date. Click loads consultation via `session.load()` + `summary.loadSummaries()` + `dna.getByDoctor()`. **Task J-4**: Built 5-step vertical stepper: (1) Review & Edit Summary — pre-fills editable textarea from loaded summary, (2) Existing DNA Style — shows current report or "no report" message via `getByDoctor()`, (3) Select DNA Prompt — lists `DNA_ANALYSIS` prompts via `usePrompts().list()`, (4) Generate DNA Report — calls `dna.generate()` + `dna.pollJobStatus()` with `<JobProgressTracker>`, (5) Results — displays generated report, time-to-finish metric, `<DiffViewer>` for version comparison, `<VersionTimeline>` for history. **Task J-5**: Collapsible code example section showing full SDK integration with `useArca`, `useDnaStyle`, `usePrompts`. **Task J-6**: Ported to Next.js `_content.tsx` with `'use client'`, `Providers` wrapper, `Navigation`. All 24 new page tests pass. All 440 total Vite app tests pass (0 regressions). | Completed |
| 10 | 2026-02-20 | **WS-D Complete**: Implemented all 5 tasks (D-1 through D-5) using strict TDD. **Task D-1**: Enhanced `BackendConfigCard` — displays API URL, Socket URL, API Key (masked), Tenant ID, Doctor ID with edit mode, connection test button, save & reload (9 tests). **Task D-2**: Enhanced `PersonalizationCard` — added `ThemeToggle` from `@arcaai/ui`, STT workflow toggle (local/remote). Local mode: STT/VAD/Noise Cancellation model selectors, word-level timestamps toggle, speaker embedding toggle. Remote mode: pipeline selector via `usePipelines()`, service health via `useHealthCheck()` with `ServiceStatusBar` (12 tests). **Task D-3**: Added `UserSettingsCard` with voice embedding section — "Coming Soon" badge, disabled "Record My Voice" button (TASK-033 pending). Integrated `useGlobalSettings()` and `useUserSettings()` hooks on mount (4 tests). **Task D-4**: Added `CodeExampleSection` — collapsible code block showing `AgenticProvider` + `useArcaConfig` SDK integration example (3 tests). **Task D-5**: Ported all enhancements to Next.js `_content.tsx` with `'use client'` directive, `Navigation`, and `LazyProviders` wrapper. Updated vitest config with `@arcaai/ui` alias and `server.deps.inline` for workspace packages. All 34 new page tests pass. 75 existing component tests pass (0 regressions). | Completed |
| 11 | 2026-02-20 | **WS-E Complete**: Implemented all 4 tasks (E-1 through E-4) using strict TDD. **Task E-1**: Replaced inline `useServiceHealth` with `useMonitoring()` + `useHealthCheck()` SDK hooks. Health check auto-polls every 10s via `startPolling(10000)`, monitoring refreshes on mount. Service status bar driven by SDK hooks instead of raw `fetch`. Health status badge shows aggregate status. **Task E-2**: Upgraded Live Transcription tab — integrated `<RecordingControls>` and `<TranscriptDisplay>` shared components from WS-C. `audio.start()` now called with `{ language }` option. Transcript display uses `audio.transcriptSegments` for structured diarized output with speaker labels, timestamps, and interim/final styling. Updated code examples to show SDK hook usage (`useMonitoring`, `useHealthCheck`). **Task E-3**: Upgraded Upload Audio File tab — integrated `<FileUploadZone>` and `<JobProgressTracker>` shared components from WS-C. Uses `useConsultationJob()` for job cancellation and status tracking. Consultation ID displayed in upload tab. Updated code examples to show `useConsultationJob().streamJob()` and `pollJob()` patterns. **Task E-4**: Ported all changes to Next.js `_content.tsx` with `'use client'` directive, `Navigation` component, and `LazyProviders` wrapper. 31 new page tests pass. 86 total tests (31 page + 55 component) pass with 0 regressions. | Completed |
| 12 | 2026-02-20 | **WS-I Complete**: Implemented all 8 tasks (I-1 through I-8) using strict TDD. **Task I-1**: Replaced custom `useServiceHealth()` with `useMonitoring()` + `useHealthCheck()` SDK hooks for `ServiceStatusBar`. Maps `health.services` to ServiceHealth array, uses `monitoring.sessions` for active sessions/jobs (9 admin page tests). **Task I-2**: Created `UsersTab` component — paginated user list table with search filter, create/edit user dialogs, delete confirmation, expandable role badges with add/remove via `useRoles()`, API key management section with create (shows raw key once), revoke, list via `useApiKeys()` (12 tests). **Task I-3**: Extracted `PromptsTab` from inline admin.tsx into `components/admin/prompts-tab.tsx` — prompt list with category/department filter, create/edit forms, version history with `VersionTimeline`, diff comparison with `DiffViewer`, department assignment (9 tests). **Task I-4**: Created `ModelsTab` component — model list table with category/task type/download status filters, create/edit dialogs, download status management with progress bar, delete confirmation (18 tests). **Task I-5**: Created `DepartmentsTab` component — hierarchical tree display with `getRoots()`/`getChildren()`, create department dialog, edit form, prompt config management with `updatePromptConfig()`, delete confirmation (11 tests). **Task I-6**: Created `StorageTab` component — bucket cards with file count/size, file browser table with breadcrumb navigation, prefix search, drag-and-drop upload zone, download via presigned URL, delete confirmation, storage health indicator (11 tests). **Task I-7**: Created `AdminCodeExamples` component — collapsible code example section with tab-specific SDK integration code for all 5 tabs, copy-to-clipboard (8 tests). **Task I-8**: Ported all 5 tab components + admin page to Next.js with `'use client'` directives, `@arcaai/ui` imports, `LazyProviders` wrapper. Rewrote admin page from 3 tabs to 5 tabs (Users, Prompts, Models, Departments, Storage). All 479 Vite app tests pass (19 test files, 0 regressions). | Completed |

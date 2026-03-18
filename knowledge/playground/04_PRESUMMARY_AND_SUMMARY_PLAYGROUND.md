# Pre-Summary & Summary Playground — Implementation

## Overview

The Summarization section of the playground provides tools for generating clinical pre-summaries and summaries using the SMR (Summarization) service. It includes five pages: Overview, Pre-Summary, Summary, Live Demo, and History. The feature integrates with prompt templates, DNA writing styles, and supports both synchronous and streaming (SSE) generation modes.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    Summarization Section                          │
│  ┌──────────┬─────────────┬──────────┬───────────┬────────────┐ │
│  │ Overview  │ Pre-Summary │ Summary  │ Live Demo │  History   │ │
│  └──────────┴─────────────┴──────────┴───────────┴────────────┘ │
└──────────────────────────────────────────────────────────────────┘
         │                │                │
         ▼                ▼                ▼
┌─────────────┐  ┌───────────────┐  ┌──────────────┐
│  smrClient  │  │ Admin API     │  │ @arcaai/vox  │
│  (REST+SSE) │  │ (templates,   │  │ useAuth()    │
│             │  │  DNA styles)  │  │              │
└──────┬──────┘  └───────────────┘  └──────────────┘
       │
       ▼
┌──────────────┐
│  SMR Service │
│  (FastAPI)   │
└──────────────┘
```

---

## API Layer

### SMR Client

**File:** `apps/ui-playground/src/features/summarization/api/smr-client.ts` (224 lines)

HTTP client for both the SMR service and API gateway:

- `getHeaders()` — reads from `useAuthStore`: `Authorization: Bearer` or `X-API-Key`, plus `X-Tenant-Id`.
- `getBaseUrl()` — from `usePlaygroundStore.apiBaseUrl`.
- `request(method, path, body, options, isRetry)` — generic HTTP with optional timeout. Includes automatic 401 retry with token refresh via `tryRefreshToken()`.
- `requestSSE(path, onChunk, onDone, isRetry)` — GET-based SSE stream using `fetch` + `ReadableStream` (not `EventSource`). Includes automatic 401 retry with token refresh.
- `requestPostSSE(path, body, callbacks, options)` — POST with SSE response stream.
- Exports: `smrClient.get`, `smrClient.post`, `smrClient.patch`, `smrClient.delete`, `smrClient.sse`, `smrClient.postSSE`.
- Custom error class: `SmrApiError` with `status` and `body`.

**Authentication:** All SSE methods use `fetch` with `Authorization` headers (not native `EventSource` which cannot carry custom headers). The `requestSSE` method automatically retries on 401 by refreshing the JWT token.

### TanStack Query Hooks

**File:** `apps/ui-playground/src/features/summarization/api/summarization.ts` (300+ lines)

| Hook | Endpoint | Behavior |
|------|----------|----------|
| `useSmrProviders()` | `GET /text/providers` | Fetch available LLM providers |
| `useSmrHealth()` | `GET /text/health` | Health check, refetch every 30s |
| `useSmrTaskStatus(taskId)` | `GET /text/tasks/:id` | Poll task status every 2s until terminal |
| `useGenerateSync()` | `POST /text/generate` | Synchronous generation (`stream: false`) |
| `useGenerateAsync()` | `POST /text/generate` | Async generation (`stream: true`) |
| `useCancelTask()` | `POST /text/tasks/:id/cancel` | Cancel running task |
| `useGeneratePreSummary()` | `POST /text/generate` | Pre-summary from context + template (sync) |
| `useGenerateSummary()` | `POST /text/generate` | Summary from transcript + pre-summary + DNA + NER (sync) |
| `useStreamPreSummary()` | `POST /text/generate` + `GET /text/tasks/:id/stream` | **Streaming** pre-summary via SSE with `onChunk` callback |
| `useStreamSummary()` | `POST /text/generate` + `GET /text/tasks/:id/stream` | **Streaming** summary via SSE with `onChunk` callback, supports DNA style |

### Streaming Hooks

The `useStreamPreSummary` and `useStreamSummary` hooks combine task creation (`POST /text/generate` with `stream: true`) and SSE streaming (`GET /text/tasks/:id/stream`) into a single mutation:

```typescript
const streamSummary = useStreamSummary();
streamSummary.mutate({
  transcript: 'Full transcript text...',
  dnaStyleText: 'Use formal medical terminology...',
  format: 'SOAP',
  includeNER: true,
  provider: 'ollama',
  onChunk: (text) => setAccumulated(prev => prev + text),
  onDone: (taskId) => console.log('Complete:', taskId),
});
```

### Types

**File:** `apps/ui-playground/src/features/summarization/api/types.ts` (122 lines)

Key types:
- `SmrGenerateRequest` — provider, model, prompt, temperature, maxTokens, stream
- `SmrGenerateResponse` — text, tokenUsage, latencyMs
- `SmrStreamingResponse` — chunk, done, taskId
- `SmrTaskResponse` — id, status, result, error
- `SmrProvider` — id, name, models, available, isDefault
- `PreSummaryFormData` — clinicalContext, templateId, dnaStyleId, provider, model, temperature, maxTokens
- `SummaryFormData` — transcript, preSummary, additionalContext, templateId, dnaStyleId, provider, model, temperature, maxTokens, includeNer, useStreaming
- `SummaryHistoryEntry` — type, content, provider, model, tokens, latencyMs, createdAt

---

## Pages

### Overview

**File:** `apps/ui-playground/src/features/summarization/overview/index.tsx` (209 lines)

Dashboard showing:
- Stats: available providers, models, capabilities.
- Quick links to Pre-Summary, Summary, Live Demo, History.
- User stories coverage reference (US #127–150, WebSocket + SSE).

### Pre-Summary Page

**File:** `apps/ui-playground/src/features/summarization/pre-summary/index.tsx` (558 lines)

Full pre-summary generation workflow:

**Inputs:**
- Clinical context textarea with sample contexts (followup, new patient, examination).
- Pre-summary template selector with edit and save-new-version capability.
- DNA writing style display with edit and save-new-version capability.
- Provider/model selector via `ProviderModelSelect`.
- Advanced settings: temperature (0–2), max tokens (256–16384).

**Access control:**
- Uses `useDoctorContext()` for impersonation-aware context.
- Shows `ImpersonationGuard` when `ctx.requiresImpersonation` is true.

**Data sources:**
- `useDepartment(ctx.primaryDepartmentId)` — department info.
- `usePromptTemplates({ departmentId, tag: 'pre-summary' })` — filtered templates.
- `useDnaStyleByDoctor(ctx.effectiveUserId)` — doctor's DNA style.
- `useDnaVersions(dnaReportId)` — DNA style version history.

**Generation:**
- `useGeneratePreSummary()` mutation.
- Results displayed via `ResultCard` components.
- Link to Summary page to continue the workflow.

**Template/DNA management:**
- `useUpdatePrompt()` — save new template version.
- `useUpdateDnaReport()` — save new DNA style version.

### Summary Page

**File:** `apps/ui-playground/src/features/summarization/summary/index.tsx` (768 lines)

Full summary generation workflow:

**Inputs:**
- Transcript textarea with sample transcripts.
- Pre-summary textarea (can be pre-filled from Pre-Summary page).
- Additional context textarea.
- Summary template selector with edit and save-new-version.
- DNA writing style with edit and save-new-version.
- Provider/model selector.
- Advanced settings: temperature, max tokens, include NER, use SSE streaming.

**Generation modes:**
1. **Synchronous:** `useGenerateSummary()` mutation → waits for complete response.
2. **Streaming (SSE):** `smrClient.post('/text/generate', body)` → `smrClient.sse('/text/tasks/:id/stream')` → progressive text display.

**Same access control and data sources as Pre-Summary.**

### Live Demo

**File:** `apps/ui-playground/src/features/summarization/live-demo/index.tsx` (81 lines)

Transport comparison page showing two demo components side-by-side:

| Demo | Component | Transport |
|------|-----------|-----------|
| WebSocket Audio → Transcript | `WsAudioTranscriptDemo` | WebSocket (PCM audio) |
| SSE File → Transcript → Summary | `SseTranscriptSummaryDemo` | SSE (file upload + stream) |

### History

**File:** `apps/ui-playground/src/features/summarization/history/index.tsx` (312 lines)

Local history of generated summaries:

- Stored in `localStorage` under key `arcaai-summarization-history`.
- Table: type, content preview, provider/model, tokens, latency, created date.
- Search and type filter (pre_summary | summary).
- Detail dialog with full content, copy, and delete.
- Bulk actions: export JSON, clear all.

---

## Shared Components

### Provider/Model Select

**File:** `apps/ui-playground/src/features/summarization/components/provider-model-select.tsx` (103 lines)

- Uses `useSmrProviders()` to fetch available providers.
- Provider select resets model on change.
- Shows "offline" for unavailable providers, "default" for default model.

### Generation Settings

**File:** `apps/ui-playground/src/features/summarization/components/generation-settings.tsx` (90 lines)

Collapsible advanced settings panel:
- Temperature slider (0–2).
- Max tokens input (256–16384).
- Include NER switch (optional, summary only).

### Result Card

**File:** `apps/ui-playground/src/features/summarization/components/result-card.tsx` (137 lines)

Display card for generation results:
- Actions: copy, download, "Use as context".
- Metadata: provider/model, latency, token usage, created date.
- Variants: `pre-summary` | `summary`.

### SMR Status Badge

**File:** `apps/ui-playground/src/features/summarization/components/smr-status-badge.tsx` (44 lines)

SMR service health indicator:
- Uses `useSmrHealth()`.
- States: Checking, Offline, Online, Degraded.
- Shows uptime when available.

### Impersonation Guard

**File:** `apps/ui-playground/src/features/summarization/components/impersonation-guard.tsx` (48 lines)

Shown when admin users need to impersonate a doctor. Explains that templates and DNA styles are per-doctor. Links to the Playground Overview page.

---

## Live Demo Components

### WebSocket Audio Transcript Demo

**File:** `apps/ui-playground/src/features/summarization/components/ws-audio-transcript-demo.tsx` (~500 lines)

End-to-end WebSocket transcription demo:

1. Create session: `POST /api/v1/audio/transcription-jobs/stream/session` with `{ pipelineId: 'default', language, sampleRate }`.
2. Connect WebSocket: `ws://.../ws/stt-v2/stream?sessionId=...`.
3. Send auth token after connection: `{ type: "auth", token: "Bearer ..." }`.
4. Capture audio via `getUserMedia` → `AudioContext` + `AudioWorkletNode` (inline PCM capture processor).
5. Convert Float32 → Int16 PCM (in AudioWorklet thread) → send as binary `ArrayBuffer` via WebSocket.
6. Receive transcript segments (interim + final).

**Key improvements over previous implementation:**
- **AudioWorkletNode** replaces deprecated `ScriptProcessorNode` — audio processing on audio thread, not main thread
- **Binary PCM** replaces base64 JSON encoding — ~37% bandwidth savings
- **Post-connect auth** — sends JWT token after WebSocket opens (WebSocket API cannot carry HTTP headers)
- **pipelineId** included in session creation request

### SSE Transcript Summary Demo

**File:** `apps/ui-playground/src/features/summarization/components/sse-transcript-summary-demo.tsx` (~680 lines)

End-to-end SSE transcription + summarization demo:

1. Upload audio file: `POST /api/v1/audio/transcription-jobs` with auth headers.
2. Stream transcription: `fetch` + `ReadableStream` to `GET /api/v1/audio/transcription-jobs/:id/stream` with auth headers (not native `EventSource`).
3. Generate summary: `POST /text/generate` with `stream: true`.
4. Stream summary: `fetch` + `ReadableStream` to `GET /text/tasks/:id/stream` with auth headers.
5. Optional auto-summarize after transcription completes.
6. Fallback demo mode when APIs are unavailable.

**Key improvements over previous implementation:**
- **Authenticated SSE** — uses `fetch` + `ReadableStream` instead of native `EventSource` (which cannot carry auth headers)
- **Phase ref** — `phaseRef` prevents stale closure race conditions in async callbacks
- **AbortController** — proper cancellation of in-flight requests
- **Unified error handling** — graceful fallback to demo mode on API errors

---

## Doctor Context Hook

**File:** `apps/ui-playground/src/features/summarization/hooks/use-doctor-context.ts` (63 lines)

Provides impersonation-aware context for all summarization pages:

| Field | Logic |
|-------|-------|
| `effectiveUserId` | Impersonated user ID when impersonating, else logged-in user ID |
| `requiresImpersonation` | `true` when user is admin, not a doctor, and not impersonating |
| `isImpersonated` | Whether impersonation is active |
| `primaryDepartmentId` | Department from effective user |
| `roles` | Effective user's roles |

This hook is the bridge between the auth/impersonation system and the summarization feature. Templates and DNA styles are loaded based on `effectiveUserId` and `primaryDepartmentId`.

---

## SDK Integration

The summarization feature uses `@arcaai/vox` minimally — only `useAuth` for impersonation state:

```typescript
import { useAuth } from '@arcaai/vox';
```

All SMR and transcription calls go through `smrClient` (custom HTTP/SSE client) or raw `fetch`, not via SDK hooks. This is because the summarization feature interacts directly with the SMR service (`/api/v2/`) which is outside the SDK's scope.

### What is NOT used from @arcaai/vox

- `useArca` — consultation API (used by consultation playground instead)
- `useStorage` — storage (used by consultation case notes)
- `useAgenticStore` — agentic state
- `TranscriptionPipeline` — transcription pipeline (live demo uses direct WebSocket/SSE)
- `SttV2WebSocketClient` — the WS demo uses raw `WebSocket` API directly (could be refactored to use SDK class)
- `SSEClient` — the SSE demo uses `fetch` + `ReadableStream` for authenticated SSE (the SDK's `SSEClient` uses `EventSource` which cannot carry auth headers)

---

## Routes

| Route File | URL Path | Component |
|------------|----------|-----------|
| `routes/_authenticated/summarization/overview.tsx` | `/summarization/overview` | `SummarizationOverview` |
| `routes/_authenticated/summarization/pre-summary.tsx` | `/summarization/pre-summary` | `PreSummaryPage` |
| `routes/_authenticated/summarization/summary.tsx` | `/summarization/summary` | `SummaryPage` |
| `routes/_authenticated/summarization/live-demo.tsx` | `/summarization/live-demo` | `LiveDemoPage` |
| `routes/_authenticated/summarization/history.tsx` | `/summarization/history` | `HistoryPage` |

All routes are under `_authenticated`, requiring authentication.

---

## Test Coverage

### `use-doctor-context.test.ts` (252 lines)
- Admin/doctor role detection
- Effective user when impersonating vs not
- Impersonation requirement for admins
- Department-scoped prompt templates
- DNA style per doctor
- Pre-summary template filtering by tag
- Shared context for Summary and Pre-Summary

### `summary-api-integration.test.ts` (236 lines)
- Department prompt template loading
- DNA writing style loading
- Prompt building (template + DNA + NER)
- Prompt template update payload
- DNA style update payload
- Output format handling

---

## File Index

| File | Lines | Purpose |
|------|-------|---------|
| `features/summarization/api/index.ts` | 27 | Barrel exports |
| `features/summarization/api/smr-client.ts` | 223 | HTTP/SSE client for SMR |
| `features/summarization/api/summarization.ts` | 189 | TanStack Query hooks |
| `features/summarization/api/types.ts` | 122 | Type definitions |
| `features/summarization/overview/index.tsx` | 209 | Overview dashboard |
| `features/summarization/pre-summary/index.tsx` | 558 | Pre-summary generation |
| `features/summarization/summary/index.tsx` | 768 | Summary generation |
| `features/summarization/live-demo/index.tsx` | 81 | Live demo page |
| `features/summarization/history/index.tsx` | 312 | Generation history |
| `features/summarization/components/provider-model-select.tsx` | 103 | Provider/model selector |
| `features/summarization/components/generation-settings.tsx` | 90 | Advanced settings |
| `features/summarization/components/result-card.tsx` | 137 | Result display card |
| `features/summarization/components/smr-status-badge.tsx` | 44 | SMR health badge |
| `features/summarization/components/impersonation-guard.tsx` | 48 | Impersonation prompt |
| `features/summarization/components/sse-transcript-summary-demo.tsx` | 479 | SSE demo |
| `features/summarization/components/ws-audio-transcript-demo.tsx` | 378 | WebSocket demo |
| `features/summarization/hooks/use-doctor-context.ts` | 63 | Doctor context hook |
| `features/summarization/hooks/__tests__/use-doctor-context.test.ts` | 252 | Doctor context tests |
| `features/summarization/summary/__tests__/summary-api-integration.test.ts` | 236 | Summary API tests |

# TASK-432 — Playground: SDK Consultation Demo (frames 50 + 50.1)

- **Status**: Review
- **Type**: feature — screen `/playground/consultation` in `apps/admin-console`
- **Created**: 2026-07-06
- **Parent**: TASK-420 row 34 (matrix + approved frames `50 - Consultation Demo`, `50.1 - Documentation Review`, dark variant `50-dark`); foundation TASK-431

## Requirement Analysis

`@arcaai/vox` capture → transcribe → document demo run under the admin's own account (working tenant required — `<WorkingTenantGate>`):

- **Capture pane**: mic permission prompt, device/pipeline picker (`GET /audio/pipelines`), VAD/noise-filter chips, REC indicator + level meter — SDK `useArca().audio` (backend streaming via `pipelineId`).
- **Session flow**: `session.open({ patientId })` → `POST /consultations/:id/recording/start` (returns live-summary `sseUrl`, status → RECORDING) → streaming transcript pane (partial vs final) → stop → generate summary (sync + async job with SSE progress) → `GET :id/summary/latest`, named entities.
- **50.1 Documentation Review sub-view**: harness stage checklist (`/consultations/:id/harness-progress/stream`), per-claim assurance verdicts + gate decision (`/harness-assurance/stream`), draft note with provenance, approve & sign-off (`POST :id/summary/:contextItemId/approve`).
- State variants per frame: loading skeleton / empty / error / NoTenant; light + dark.

## Architecture (fixed by TASK-431 — do not deviate)

- `AgenticProvider` config: `api.baseUrl = <origin>/api/hope` (BFF), NO token, `autoWireTokenRefresh: false`, `tenantId = workingTenantId ?? user.tenantId`, `api.wsUrl = publicEnv.apiHost`.
- Console SSE panes (live summary, harness progress/assurance, job progress) use `useEventStream` with scopes `consultation_live_summary:<id>`, `consultation_harness_progress:<id>`, `consultation_harness_assurance:<id>`, `consultation_job:<jobId>`.
- Feature module `src/features/playground-consultation/` + routes under `(playground)/playground/consultation/`.

## Implementation Plan

Verified against the code before writing (2026-07-06): controller routes in `apps/api/src/modules/consultation/consultation.controller.ts` + `consultation-job.controller.ts` + `pipeline/audio-pipeline-public.controller.ts`; DTOs in `packages/applications/src/services/consultation/{live-documentation,harness,jobs,summary,context}/dto`; SDK surface in `packages/agentic-sdk-v2` (`useArca`, `AgenticProvider`, `ApiConfig.wsUrl` honored since TASK-431). The consultation-job SSE emits DEFAULT `message` events carrying the full `JobStatusResponse` JSON (terminal = COMPLETED/FAILED/CANCELLED); live-summary/harness streams also relay full-state snapshots on `message` — clients stay stateless (fold latest event, close on `closed: true`).

1. **Failing api tests** (`api/__tests__/client.test.ts`, `api/__tests__/hooks.test.tsx`): BFF paths for pipelines / recording start–stop / summary sync+async+latest / named entities / approve / job status; SSE hooks mint tickets with scopes `consultation_live_summary:<id>`, `consultation_harness_progress:<id>`, `consultation_harness_assurance:<id>`, `consultation_job:<jobId>` (FakeEventSource pattern from dna-writing-styles), fold snapshots, close on `closed`, job poll fallback only after stream error.
2. **api layer** (`types.ts` DTO mirrors, `keys.ts`, `client.ts` on `@/shared/api`, `hooks.ts`: queries + mutations + `useConsultationEventStream` folding helper + `useSummaryJobProgress` with 2s poll fallback, `index.ts`).
3. **Failing component tests** (`components/__tests__/playground-consultation-screen.test.tsx`, `review-pane.test.tsx`): `vi.mock('@arcaai/vox')` at the module boundary (test OUR wiring, not the SDK); fetch stubbed by URL (session `/api/auth/session` incl. `user.tenantId`, data `/api/hope/...`); NoTenant gate / loading skeleton / empty+open flow / capture start-stop orchestration / generate sync+async / review checklist + claims + approve.
4. **Screen** (`components/`): `playground-consultation-screen.tsx` = `WorkingTenantGate` → SDK boundary (`AgenticProvider` with `{ api: { baseUrl: <origin>/api/hope, wsUrl: publicEnv.apiHost, tenantId: workingTenantId ?? user.tenantId }, autoWireTokenRefresh: false }`, no token — BFF injects auth) → body over `ScreenTemplate` wrapped in `<Tabs>` (`Demo` / `Documentation Review`, nuqs `view` param); presentational `capture-pane.tsx`, `transcript-pane.tsx` (UI `LiveTranscript`), self-contained `live-summary-pane.tsx`, presentational `review-pane.tsx` (50.1). Header action swaps per tab: `+ Open consultation` ↔ `Approve & sign-off` (as framed).
5. **Route**: `(playground)/playground/consultation/page.tsx` (thin server component + metadata) and `loading.tsx` (skeletons mirroring the 3-pane layout, rule 10).
6. **Verify**: `pnpm --filter @arcaai/admin-console test -- src/features/playground-consultation`, `lint`, `check-types`; evidence pasted below. Playwright E2E + axe + on-app design QA deferred to the parent integration pass.

### Decisions / deviations (agreed architecture, feature-local)

- `POST :id/recording/start` is sent WITHOUT `sessionId`: with `audio.start({ pipelineId })` the SDK owns the STT session internally (`StreamingSessionManager`) and does not expose the session id; the endpoint's `sessionId` is optional and the recording correlates by consultation. (The deprecated ui-playground got it from its own WS hook — not the SDK path.)
- Draft-note provenance renders from `SummaryResponse.structuredData` (modelName / llmProvider / qualityScore); the dedicated `GET :id/summary/:contextItemId/provenance` endpoint exists but is not called in v1 of this screen.
- Harness SSE panes mount only while the Review tab is active (stream tickets are single-use; no idle retry burn).
- Mic-permission chip derives from SDK audio state (`NotAllowedError` ⇒ denied guidance) — no `navigator.permissions` dependency.

### Detailed plan (endpoint/DTO shapes verified against `apps/api/src/modules/consultation/*` + `packages/applications` 2026-07-06)

**Feature module `src/features/playground-consultation/`** (anatomy mirrors `consultations`/`dna-writing-styles`):

- `api/types.ts` — `AudioPipeline` (PipelineResponse subset), `PlaygroundConsultation` (ConsultationResponse subset), `RecordingState` (`{ consultationId, status, recording, sessionId?, sseUrl, updatedAt }`), `SummaryResult` (SummaryResponse: `id` IS the summary's contextItemId), `ConsultationJobStatus` normalized to lowercase states (`POST :id/summary/async` returns lowercase `pending|processing|…`; `GET /consultations/jobs/:jobId` + its SSE return UPPERCASE `PENDING|RUNNING|COMPLETED|FAILED|CANCELLED` — one normalizer folds both), `LiveSummarySnapshot` (LiveSummaryEventDto), `HarnessProgressSnapshot` (HarnessProgressEventDto), `HarnessAssuranceSnapshot` (HarnessAssuranceEventDto incl. `gateDecision/safetyFlag/reducedAssurance/postSignAlert`), `SummaryApproval`, `NamedEntitiesAggregate` (AggregateNerResponse).
- `api/client.ts` — BFF paths (gateway-relative, NO `admin/` prefix): `audio/pipelines`, `consultations/open`, `consultations/:id/recording/{start,stop}`, `consultations/:id/summary[/async]`, `consultations/jobs/:jobId[/cancel]`, `consultations/:id/summary/latest` (404 → null), `consultations/:id/named-entities`, `consultations/:id/summary/:contextItemId/approve`; SSE path builders for the four streams.
- `api/hooks.ts` — TanStack mutations/queries + three fold hooks over `useEventStream` (scopes `consultation_live_summary:<id>`, `consultation_harness_progress:<id>`, `consultation_harness_assurance:<id>`; assurance also subscribes the named `assurance_complete` terminal event) and `useConsultationJobProgress` (SSE `consultation_job:<jobId>` primary via default `message` events carrying JobStatusResponse JSON, 2s poll fallback after stream error, terminal latch — the `useDnaJobProgress` pattern).
- `components/consultation-demo-screen.tsx` — `<WorkingTenantGate>` → mounted-gate (SDK is client-only; skip SSR) → `<AgenticProvider>` (config per TASK-431: BFF baseUrl, `wsUrl: publicEnv.apiHost`, `tenantId: workingTenantId ?? user.tenantId`, no token, `autoWireTokenRefresh: false`) → `ScreenTemplate` with Demo/Review tabs (frames 50/50.1), setup card, capture pane, transcript pane, live-summary pane, generate actions.
- `components/documentation-review-panel.tsx` — 50.1: harness stage checklist, claim verdict list + gate decision + flagged-claim chip, draft note w/ provenance meta, Approve & sign-off → `POST :id/summary/:contextItemId/approve` (contextItemId = latest summary `id`).
- Recording start passes the SDK streaming `sessionId` read via public accessors (`useStoreApi().getState().pluginManager.getTranscriptionPipeline().getConfig().stt.streamingTransport.sessionManager.getSessionId()`, bounded retry) — body field optional; the service falls back to context-item ingestion when absent.

**Routes** — `(playground)/playground/consultation/page.tsx` (thin server page + metadata) and `loading.tsx` (skeletons mirroring the screen).

**Tests (written FIRST, shown RED)** — `api/__tests__/playground-consultation-api.test.ts` (BFF URL contract), `api/__tests__/use-consultation-job-progress.test.tsx` (SSE→poll wiring via FakeEventSource), `components/__tests__/consultation-demo-screen.test.tsx` (vi.mock `@arcaai/vox`; NoTenant gate, setup→open flow, transcript partial/final, live-summary snapshot + closed, async job progress, sync summary) and `components/__tests__/documentation-review-panel.test.tsx` (stage checklist, verdicts incl. running claim, gate decision + flagged chip, approve success toast).

## Implementation Summary

Implemented 2026-07-06 (TDD: api + component tests written first and shown RED, then implemented to GREEN).

### Files created

**Feature module `apps/admin-console/src/features/playground-consultation/`**

| File | Purpose |
|---|---|
| `api/types.ts` | DTO mirrors: `AudioPipeline`, `PlaygroundConsultation`, `RecordingState`, `SummaryResult`, `AsyncSummaryJob`, `ConsultationJobStatus` (+ `isTerminalConsultationJob`/`consultationJobStateLabel`), `LiveSummarySnapshot`, `HarnessProgressSnapshot`, `HarnessAssuranceSnapshot` (+ `claimVerdictBucket`), `SummaryApproval`, `NamedEntitiesAggregate` |
| `api/keys.ts` | TanStack Query keys under `['playground-consultation']` |
| `api/client.ts` | BFF REST: `audio/pipelines`, `consultations/open`, `:id/recording/{start,stop}`, `:id/summary[/async]`, `jobs/:jobId[/cancel]`, `:id/summary/latest` (empty 200 / 404 → `null`), `:id/named-entities?scope=`, `:id/summary/:contextItemId/approve`; SSE path builders for the four gateway streams |
| `api/hooks.ts` | Queries/mutations + snapshot-fold SSE hooks (`useLiveSummaryStream`, `useHarnessProgressStream`, `useHarnessAssuranceStream` incl. named `assurance_complete` terminal event) + `useSummaryJobProgress` (SSE primary, 2s poll fallback after stream error, terminal latch — `useDnaJobProgress` pattern) |
| `api/index.ts` | Barrel |
| `components/consultation-demo-screen.tsx` | Frame 50: `WorkingTenantGate` → hydration gate → `AgenticProvider` (BFF baseUrl, `wsUrl: publicEnv.apiHost`, `tenantId: workingTenantId ?? user.tenantId`, no token, `autoWireTokenRefresh: false`) → `ScreenTemplate` with Demo/Review tabs, setup card (patientId + pipeline picker), capture pane (mic chip, VAD/noise chips, REC + elapsed, `AudioMeter`), transcript pane (final + partial-with-caret, auto-scroll), live-summary SSE pane, sync/async generate + job strip with cancel, `StatusFooter` |
| `components/documentation-review-panel.tsx` | Frame 50.1: harness stage checklist (progress SSE), per-claim verdicts (PASS/REVIEW/running) + gate decision + flagged-claim chip + reduced-assurance notice, draft note with provenance (provider/model/quality/entities), Approve & sign-off (optional safety-flag override) with toast feedback |
| `api/__tests__/client.test.ts` | 14 tests — query-key contract, BFF URL/method/body contract (incl. `consultations/open`, param escaping), empty-200/404→null vs 5xx rethrow, SSE path builders |
| `api/__tests__/streams.test.tsx` | 8 tests — ticket scopes per stream, snapshot folding + heartbeat rejection + per-consultation reset, terminal `closed` handling, named `assurance_complete`, job SSE primary → 2s poll fallback after retry exhaustion, idle/reset semantics |
| `components/__tests__/consultation-demo-screen.test.tsx` | 12 tests — NoTenant gate, pipelines skeleton/error, open flow validation, recording start (SDK `audio.start` + `recording/start` with streaming `sessionId`), mic-denied state, transcript partial/final, live summary + closed, sync summary, async job progress + cancel, tab switch |
| `components/__tests__/documentation-review-panel.test.tsx` | 6 tests — stage checklist, verdicts + gate + flagged chip, empty draft, provenance, approve success, approve with override |

**Routes `apps/admin-console/src/app/(console)/(playground)/playground/consultation/`** — `page.tsx` (thin server component + metadata), `loading.tsx` (skeleton mirroring the screen layout via `ConsultationDemoSkeleton`).

### Evidence (2026-07-06, final pass)

`npx vitest run src/features/playground-consultation` (scoped; note the repo-root `pnpm --filter @arcaai/admin-console test -- src/...` invocation does not scope and runs the whole app suite):

```
Test Files  4 passed (4)
     Tests  40 passed (40)
  Duration  4.37s
```

`npx eslint 'src/features/playground-consultation/**' 'src/app/(console)/(playground)/playground/consultation/**' --max-warnings 0` → clean (0 errors, 0 warnings).

`pnpm --filter @arcaai/admin-console check-types` → passes app-wide (exit 0):

```
> tsc --noEmit
(no output — exit 0)
```

App-wide runs at sign-off (all parallel-ticket files included):

```
pnpm --filter @arcaai/admin-console lint    → eslint src --max-warnings 0 → clean (exit 0)
npx vitest run (whole app)                  → Test Files 95 passed (95) · Tests 729 passed (729)
```

Playwright E2E + axe + design QA against the running app are deferred to the parent integration pass.

### Deviations / notes

- **`AgenticConfig` type is not importable** — `@arcaai/vox` ships `dts: false` (`packages/agentic-sdk-v2/tsup.config.ts`), so the provider config is typed locally as a structural `VoxProviderConfig` subset (runtime-validated by the SDK's own schema). Same limitation independently recorded by TASK-433.
- **`recording/start` sessionId**: implemented per the detailed plan — the SDK streaming session id is read through public store accessors (`useStoreApi().getState().pluginManager.getTranscriptionPipeline()...getSessionId()`) with a bounded retry, and sent as `{ sessionId }` when resolvable; the field is optional so the flow proceeds without it (supersedes the earlier "send without sessionId" note under Decisions).
- **Job status casing**: kept the gateway's UPPERCASE states as canonical in `ConsultationJobStatus`; display mapping via `consultationJobStateLabel` (lowercase POST-response states covered by the same case-insensitive helpers) instead of a lowercase normalizer.
- **Tab state is local `useState`** (not a nuqs `view` URL param) — deep-linking the review phase wasn't a frame requirement; avoids a dependency this feature doesn't otherwise need.
- **Radix `Tabs.Trigger` selects on `mousedown`** — the screen test dispatches `mouseDown` + `click` to model the pointer sequence.
- Harness SSE panes mount only while the Review tab is active (single-use stream tickets; no idle retry burn), as planned.

## Change History

| Date | Change |
|---|---|
| 2026-07-06 | Ticket created from TASK-420 (frames approved 2026-07-06). |
| 2026-07-06 | Implemented feature module (api layer + demo screen + review panel), routes `page.tsx`/`loading.tsx`, 38 colocated tests (TDD). Evidence captured; status → Review. |
| 2026-07-06 | Consolidated the duplicated api test files (two agents transiently wrote parallel suites into this feature folder) into `api/__tests__/client.test.ts` + `api/__tests__/streams.test.tsx`; broadened stream coverage (heartbeat rejection, per-consultation snapshot reset, named `assurance_complete`, poll-fallback gating) → 40 tests. Re-verified: scoped tests 40/40 green, app-wide lint 0 errors/warnings, `check-types` clean, whole-app suite 95 files / 729 tests green. |
| 2026-07-08 | Design-alignment pass against the approved template (`templates/consultation-demo/ConsultationDemo.dc.html`, frames 50/50.1): (1) demo-tab PageHeader now carries a primary `＋ Open consultation` action that scrolls/focuses the Demo-setup patient input (voice-profiles focus-the-form idiom); (2) added the consultation status strip in the `statusBanner` slot — mono consultation id + `(demo)` + mono patient ref, pulsing red `RECORDING` indicator in destructive tokens while recording (muted `StatusBadge` otherwise), opened time, right-aligned mono endpoint hint `POST /consultations/open · recording/start\|stop`; the Demo-setup card's duplicate id/status row was slimmed to the Close/Reopen action row; (3) demo grid becomes 3-pane at `xl` (`minmax(0,20rem) \| 1fr \| minmax(0,22rem)` = Setup+Capture \| Live transcript \| Live summary+Document, via `xl:contents`), keeping 2-col at `lg` and single column below; (4) `StatusFooter` `end` replaced the pipelines count with mono endpoint hints `POST /consultations/open · POST /auth/stream-ticket · SSE live-summary`. Tests updated (header-action focus test added; strip/footer copy assertions) → 41 tests green; scoped eslint clean; `check-types` clean. **Follow-ups deliberately NOT done**: review-tab header `Approve & sign-off` action (approve state lives deep in `DocumentationReviewPanel` — lifting it needed non-trivial restructuring; approve stays in the Draft-note card), mic device picker + session id/sample-rate line in the Capture pane, WS-status chip on the transcript pane, context-items strip (`GET :id/timeline` summary), Edit/Reject draft actions from frame 50.1 (approve-only path kept), 412-specific approve retry messaging. |

# TASK-543 — Consultation Scribe Playground (frame 50 redesign)

- **Status:** Review — **all of Phases A–D + the `useArcaLiveSummary` SDK hook are implemented, wired, and verified** (unit/type/lint across all touched packages). Runtime/browser verification against the live stack is the remaining gate. Work uncommitted on `fix/2605-review`.
- **Type:** feature / refactor (UI rebuild + scoped SDK/backend extensions)
- **Surface:** `apps/admin-console` route `/playground/consultation` (frame 50, tier 50–59)
- **Design source:** Claude Design project `HOPE Design System` → `templates/consultation-playground/ConsultationPlayground.dc.html`
- **Rules in scope:** 00, 01, 04, 05, 07, 08, 10, 11, 13
- **Related tickets:** TASK-230 (playground), TASK-299 (job SSE/DNA), TASK-415 (admin console), TASK-420/431 (playground screens)

---

## Requirement Analysis

Replace the current two-tab Consultation playground with the new **single 3-column live clinical-scribe workspace** from the design, wired to the `@arcaai/vox` SDK. Owner directives (this session):

1. **Full replace, single view** — no tabs. Fold the harness/assurance "Documentation review" data into the note column (see Current State §4) so nothing safety-relevant is lost.
2. **Resizable columns, not fixed** — the design's `grid-template-columns:300px …` becomes a resizable 3-panel layout.
3. **Per-user personalized interface settings** — column sizes persist per user, following the app's existing per-user settings mechanism.
4. **Use the SDK** for the implementation; where the SDK/gateway can't back a design element, surface real signals and enumerate the concrete extension needed (below).
5. **Real consultation list** in column 1.
6. **Real metric signals only** (no fabricated telemetry); list missing/to-be-built items explicitly.

Drop the design's own sidebar and breadcrumb — the console shell (`(console)/layout.tsx` + `PlaygroundPersonaBar`) already provides chrome.

---

## Current State Evaluation

### Screen today
`apps/admin-console/src/features/playground-consultation/` — `consultation-demo-screen.tsx` (874 lines) renders `WorkingTenantGate → SdkBoundary → AgenticProvider → DemoScreen`, a single centered `PlaygroundCanvas` (~760px) with two tabs (Consultation demo / Documentation review). **This scaffolding (gate + hydration `SdkBoundary` + `VoxProviderConfig` + BFF/WS transport split) is preserved verbatim.**

### SDK coverage (verified)
| Capability | SDK path | Status |
|---|---|---|
| Provider / session open·close·reopen · `listConsultations` | `AgenticProvider`, `useArca().session`, `useArcaSession` | ✅ |
| Audio capture + live transcript | `useArca().audio` (`start/stop`, `isCapturing`, `level`, `transcriptSegments`, `currentTranscript`, `droppedFrameCount`) | ✅ |
| Live transcript rendering | `@arcaai/ui` `LiveTranscript` (consumes `transcriptSegments` + `interim`) | ✅ |
| Final note generation | `useArcaSummary.generateSummary / …Async` (personalized by `dnaStyleId` + department prompt) | ✅ |
| Sign-off | admin REST `useApproveSummary` → `POST :id/summary/:ctx/approve` | ✅ |
| Per-user settings persistence | SDK `useUserSettings().list / updateByKey(ns,key,value)` → `PATCH user/me/settings/:ns/:key` | ✅ |

### Personalized SOAP vs. harness draft (owner sub-question)
- **Same artifact.** `useLatestSummary`/`SummaryResult` (persisted `ContextItem`) is what both the plain path and the harness path write. DNA style (**format/tone only** — no redaction/rewrite concept exists in code) and department instructions (**do** select/omit content via 3-tier prompt-template resolution) are applied **identically on both paths** in `PromptAssemblyService.assemble()`.
- **Harness adds an assurance envelope** (harness-only): stage progress SSE (`extracting → assembling → drafting → safety → finalizing`), per-claim assurance SSE (groundedness / citation_verify / safety sensors), a **safety gate** (`approveSummary` hard-blocks on a persisted safety flag — server-enforced regardless of UI), and a bounded regeneration loop.
- **Wrinkle:** the harness auto-starts on `TranscriptionCreated` when the tenant/consultation has `harnessEnabled`; a manual "Generate summary" can race it, and `SummaryResult` has no field for which pipeline produced it. → In a single always-visible note column, **gate/hide manual generate actions when `harnessEnabled`**.

### Live running SOAP is NOT in the SDK
The mid-recording running SOAP + entities + generation stats ride the **admin-console's own SSE plane** (`useLiveSummaryStream` → `GET consultations/:id/live-summary/stream`, `LiveSummarySnapshot{sections, entities}`), not the SDK. `useArcaSummary` is one-shot only. → Column 3's *live preview* uses the console SSE; the *persisted note* uses the SDK/REST latest-summary. (Optional future: a `useArcaLiveSummary` SDK hook — see Extensions.)

### Metric / structured-field availability
| Design element | Real source | Classification |
|---|---|---|
| Throughput (tok/s) | live-summary SSE `metadata.stats.tokens_per_second` (already emitted server-side) | **Console type extension only** — add `metadata.stats` to the console `LiveSummarySnapshot` and render |
| Latency p95 (per session) | same SSE `stats.total_ms` / `ttft_ms` per flush | **Derivable now** — accumulate samples client-side, compute percentile |
| Bandwidth (Mbps) | none | **SDK extension** — byte-rate counter in `SttV2WebSocketClient.sendAudioFrame()` → store → `useArcaAudio().uplinkBitrate` |
| Dropped frames / segments / level | `useArcaAudio()` today | ✅ real now (fallback third stat) |
| ICD-10 chips | NLP `Entity.icd_code` (deterministic `OntologyLinker`, ~15 curated conditions) computed today but **dropped by `callNlp()`** before the SSE | **Plumb-through** (applications + console types); vocabulary widening is future |
| Vitals grid (BP/HR/SpO₂/…) | none — no structured vitals extraction anywhere | **Net-new NLP parser** + plumbing (largest) |

### Building blocks confirmed present
`@arcaai/ui`: `ResizablePanelGroup/ResizablePanel/ResizableHandle` (react-resizable-panels 4.12), `LiveTranscript`, `LiveWaveform`/`Waveform`, `AudioMeter`, `ModelSelector`, `StatCard`, `Skeleton`, `Empty`, `Badge`, `Button`. Persistence reference: `apps/admin-console/src/shared/data/grid-persistence.ts` (per-user `user/me/settings` adapter, best-effort, debounced) — the pattern the column-layout hook mirrors. Backend accepts arbitrary settings namespaces (only `ui.data-grid` and pipeline keys are specifically validated), so a new `ui.consultation-playground` namespace needs **no backend change**.

---

## Implementation Plan

### Design decisions
- **Layout:** the screen fills the console content region (`flex min-h-0 flex-1`), not `100vh`. Top-to-bottom: optional dismissible announcement → `ResizablePanelGroup direction="horizontal"` (`flex-1 min-h-0`) with 3 panels + 2 `ResizableHandle withHandle` → pinned footer (`shrink-0`). Each panel body scrolls internally (`min-h-0 overflow-auto`). One scroll container per panel (rule 11).
- **Persistence:** `onLayout(sizes)` → debounced `useUserSettings().updateByKey('ui.consultation-playground','layout', {v:1,sizes})`; load once on mount via `list()`; best-effort (never blocks/throws), defaults on miss. Sizes drive each `ResizablePanel defaultSize`. (SDK-native — satisfies directive 4.)
- **Column 3 note source:** live running SOAP (`useLiveSummaryStream`) while recording/before a persisted draft; persisted `SummaryResult` (content + provenance) once one exists. Assurance envelope folded in as a compact status strip above the note (Drafting… / Assurance running… / Gate: pass·fail·safety), expandable to per-claim verdicts. Sign-off via `useApproveSummary` with the existing safety-override affordance. Manual generate actions hidden when `harnessEnabled`.
- **Waveform:** drive `Waveform` from a rolling buffer of the SDK `audio.level` (single mic stream, SDK-truthful) rather than `LiveWaveform` (which opens a second `getUserMedia`).
- **Stat cards (Phase A, real-now):** Throughput (tok/s, from consumed SSE stat), Latency p95 (client percentile of SSE `total_ms`), and a real audio card (dropped-frames or segment count). Bandwidth card lands in Phase B.

### Phase A — 3-column resizable scribe (UI + SDK wiring; the committed deliverable)
File layout under `features/playground-consultation/`:
- `components/consultation-scribe-screen.tsx` — rebuild `DemoScreen` inner as `ScribeWorkspace`; keep `ConsultationDemoScreen`/`Skeleton`/`SdkBoundary`/`VoxProviderConfig`.
- `components/columns/consultations-column.tsx` — `useArcaSession().listConsultations`, search, status badges, New/open, REC indicator.
- `components/columns/live-session-column.tsx` — recording bar (REC pill + elapsed + level-driven `Waveform` + Start/Stop) + `LiveTranscript`.
- `components/columns/case-note-column.tsx` — live/persisted note, assurance strip (`useHarnessProgressStream`/`useHarnessAssuranceStream`), Copy/Export/Sign & save (`useApproveSummary`).
- `components/scribe-footer.tsx` — `ModelSelector` ×2 (ASR pipeline via `useAudioPipelines`; note model) + `StatCard` ×3.
- `hooks/use-column-layout.ts` — SDK-backed resizable persistence (load/debounced-save).
- `hooks/use-live-metrics.ts` — consume live-summary SSE stats → `{ tokensPerSecond, latencyP95 }`.
- `api/types.ts` — add `metadata?.stats` to `LiveSummarySnapshot` (console-only; SSE already carries it).

TDD test list (Vitest, colocated `__tests__`):
1. `use-column-layout` — loads persisted sizes; miss → defaults; debounced save calls `updateByKey` with clamped sizes; never throws on reject.
2. `consultations-column` — renders `listConsultations` rows + status badges; empty → `Empty`; select → `session.load`.
3. `live-session-column` — Stop calls `audio.stop`; feeds `LiveTranscript` with `transcriptSegments`+`interim`; timer from capture start.
4. `case-note-column` — shows live SOAP while recording, persisted draft after; Sign & save calls `useApproveSummary`; safety-flag override gating; manual-generate hidden when `harnessEnabled`.
5. `use-live-metrics` — folds SSE stats; p95 over samples; no data → em-dash values.
6. `scribe-footer` — pipeline change calls back; stat cards render real values.

Gate: `pnpm --filter @arcaai/admin-console build lint test` green; axe 0 violations; both themes; runtime verified via `next-dev-loop`.

### Phase B — SDK extension: audio uplink bitrate (`@arcaai/vox`)
Byte counter + rolling-window rate in `SttV2WebSocketClient.sendAudioFrame()` → `agenticStore` (mirror `droppedFrameCount`) → `useArcaAudio().uplinkBitrate`. Wire the Bandwidth stat card. Tests in the SDK suite. (Isolated; `pnpm build:sdk` green.)

### Phase C — ICD-10 plumb-through (curated subset)
`callNlp()` (`live-documentation.service.ts`) keeps `icd_code` → `LiveSummaryEntityDto` → console `LiveSummaryEntity` → ICD chips on the note. Applications unit tests + a console render test. Vocabulary widening (real UMLS/MedCAT) is explicitly out of scope / future.

### Phase D — Vitals extraction (net-new; likely a separate ticket)
Deterministic vitals parser in `apps/nlp` producing `{systolic,diastolic,hr,spo2,temp,weight}` → thread through `LiveSummaryEventDto` → vitals grid. Largest effort; hermetic pytest. **Owner decision needed** on whether this belongs in TASK-543 or a follow-up.

---

## Verification Criteria
- Layout fills the console content region; three columns resize; sizes persist across reload for the same user and are absent for a different user.
- Column 1 lists real consultations; selecting one loads it.
- Column 2 shows live transcript + level-driven waveform from the SDK; Stop/Start work.
- Column 3 shows the personalized note + assurance status; Sign & save enforces the safety gate.
- Footer stat cards show real values (Phase A: tok/s + latency + audio; Phase B adds bandwidth).
- `pnpm --filter @arcaai/admin-console build lint test` green; axe 0; both themes; `next-dev-loop` pass.

## Implementation Summary

### Phase A — 3-column resizable scribe UI ✅ (code-complete, static+unit verified)
Rebuilt `apps/admin-console/src/features/playground-consultation/` into the single live 3-column workspace. SDK bootstrap (`WorkingTenantGate → SdkBoundary → AgenticProvider`, BFF/WS transport split, local `VoxProviderConfig`) preserved verbatim; `DemoScreen` replaced by `ScribeWorkspace`.

Files:
- `components/consultation-demo-screen.tsx` — `ScribeWorkspace`: `ResizablePanelGroup` (v4 `orientation`/`onLayoutChanged`, id-keyed `Layout`) + footer; real list via **TanStack Query** over `sdkSession.listConsultations` (rule 13 — no fetch-in-effect); session open/load, recording start/stop (with `resolveStreamingSessionId`), approve, harnessEnabled-gated manual generate.
- `components/scribe/consultations-column.tsx` · `live-session-column.tsx` (level-buffer `Waveform` + `LiveTranscript`) · `case-note-column.tsx` (live SOAP → persisted draft + `AssuranceStrip` fold-in + safety-gated Sign & save) · `scribe-footer.tsx` (ASR + note `ModelSelector`s + real `StatCard`s).
- `hooks/use-column-layout.ts` — **per-user column persistence via SDK `useUserSettings`** (`ui.consultation-playground/columns`, debounced, best-effort).
- `hooks/use-live-metrics.ts` — real tok/s + per-session latency p95 folded from the live-summary SSE `metadata.stats`.
- `api/types.ts` — added `LiveSummaryStats` + `metadata.stats` to `LiveSummarySnapshot` (console type only; SSE already carried it).

Tests (all green): `use-column-layout` (11), `use-live-metrics` (7), `consultations-column` (8), `case-note-column`/`AssuranceStrip` (11), screen structure/gate/list (3). Gate evidence: `pnpm --filter @arcaai/admin-console` → **eslint clean, tsc 0 errors, 1140/1140 vitest pass** (2026-07-23).

Known limitations / carried to later phases:
- **Runtime (browser) verification pending** — the tenant-gated screen needs the live stack (BFF + gateway + STT/SMR/NLP + a working-tenant session); not exercisable in this environment. Metrics (tok/s, latency) only populate during a live recording. Verify via `next-dev-loop` against a running stack.
- **Bandwidth** stat card renders em-dash until Phase B; **live audio amplitude** waveform idles (SDK `store.audioLevel` isn't wired live — `PluginManager.onAudioLevel` is declared but never invoked); **ICD-10 chips** / **vitals grid** absent until Phases C/D.
- Column-3 live preview currently consumes the console SSE (`useLiveSummaryStream`); swaps to the new `useArcaLiveSummary` SDK hook in the SDK phase.
- `components/documentation-review-panel.tsx` (+ its test) is **superseded** by the folded-in `AssuranceStrip` and now orphaned — safe to delete in the SDK/cleanup phase (its api hooks remain in use).

### Phase C — ICD-10 plumb-through ✅ (done, verified)
NLP already computes `Entity.icd_code` (deterministic `OntologyLinker`, curated vocabulary); `callNlp()` was dropping it. Now carried through:
- `packages/applications` — `LiveSummaryEntityDto.icd10` added; `callNlp()` maps `e.icd_code → icd10` (propagates through `groundEntitiesToNote`'s spread). Test: `live-documentation.groundedness.test.ts` gains an ICD-passthrough case. Gate: **applications `build` clean, full suite 6727 pass**.
- `apps/admin-console` — `LiveSummaryEntity.icd10` added; case-note column renders an ICD-10 code chip when present (falls back to the entity type). Test added; admin-console tsc 0, feature tests green.
- Vocabulary widening (real UMLS/MedCAT) remains out of scope — curated subset only, codes never fabricated (absent when unmatched).

### `useArcaLiveSummary` + SSE best-practice — ✅ (done, wired, verified)
New `@arcaai/vox` hook `useArcaLiveSummary` (`src/hooks/useArcaLiveSummary.ts`): SSEClient subscription to `GET /consultations/:id/live-summary/stream`, ticket scope `consultation_live_summary:<id>`, full-state snapshot fold + close-on-terminal. Endpoint `CONSULTATION_ENDPOINTS.LIVE_SUMMARY_STREAM` + `liveSummaryScopeFor`; types `src/types/liveSummary.ts`; barrels wired. **Wired into col-3** (imperative `start`/`stop` from the record/select handlers), replacing the console `useLiveSummaryStream`.
- **SSE routing done right (no workaround):** added `AgenticClient.getStreamBaseUrl()` — the stream TICKET is minted through the REST client (BFF auth/tenant injection applies) while the EventSource opens against the **gateway** (`wsUrl` → http + `/api/v1`) when a gateway base is configured, else the REST base. This keeps long-lived SSE off the REST BFF (the pattern the console itself uses) and is back-compatible for single-origin consumers. Tests: `useArcaLiveSummary.test.ts` (8), `AgenticClient.streamBaseUrl.test.ts` (3).

### Phase B — SDK audio signals — ✅ (done)
- **Live waveform amplitude**: `useArcaAudio` drives a real `store.audioLevel` via a guarded AnalyserNode on the capture graph (analysis-only, torn down on stop) — the pipeline never surfaced a level before.
- **Bandwidth (`uplinkBitrate`)**: the full push chain, done properly — byte counter in `@arcaai/stt` `StreamingBackendSTTProvider.processAudio` (only counts frames actually sent) → `STTProcessor.getUplinkBytesSent` → `TranscriptionPipeline.getUplinkBytesSent` → a 1 s poll in `useArcaAudio` computing bits/sec from the delta → `store.audioUplinkBitrate` → `useArca().audio.uplinkBitrate` → the footer Bandwidth card. Tests: `StreamingBackendSTTProvider.test.ts` (+2 byte-accounting cases). Gates: **@arcaai/stt 418, @arcaai/vox 3561**.

### Phase D — NLP vitals grid — ✅ (done, verified end-to-end)
Deterministic, cue-gated, range-guarded vitals parser — a mis-parse fails SAFE to `None` (never a wrong vital in a note):
- `apps/nlp` — `services/vitals_extractor.py` (`extract_vitals`) + `Vitals` schema on `TokenClassificationResponse`, wired into `token_classifier`. Test: `tests/test_vitals_extractor.py` (9). Gates: **pytest 9 pass · ruff · mypy clean** (run via `arcaenv`).
- `packages/applications` — `LiveSummaryVitalsDto` on `LiveSummaryEventDto`; `callNlp` maps the snake_case `vitals` → camelCase and the flush merges them field-wise across flushes. Tests: `live-documentation.groundedness.test.ts` (+2). Gate: **applications build + 6733 tests**.
- `apps/admin-console` — `LiveSummaryVitals` type + the Objective vitals grid in `case-note-column.tsx`. Test added.

### SDK now ships type declarations (pre-existing bug fixed)
`@arcaai/vox` had `tsup dts:false` while `exports.types` pointed at `dist/*.d.ts` that were never emitted — so consumers had no real SDK types (the admin console coped with a local `VoxProviderConfig` shim). The `build` script now chains `tsc --emitDeclarationOnly` (`build:dts`), so `pnpm build:sdk` emits correct declarations for every entry point. The app config now type-checks against the real `AgenticConfig`.

## Change History
- 2026-07-22 — Plan authored (research: current screen + SDK map; personalized-SOAP-vs-harness; metrics/entity availability). Scope approved: A–D + `useArcaLiveSummary`.
- 2026-07-23 — Phase A implemented & statically verified (lint/type/unit). SDK/backend extension phases (B–D + hooks) pending; work UNCOMMITTED on `fix/2605-review`.
- 2026-07-23 — Phase C (ICD-10 plumb-through) implemented & verified (applications build + 6727 tests; admin-console tsc/tests).
- 2026-07-23 — `useArcaLiveSummary` SDK hook added (8 tests) + Phase B live audio-level analyser in `useArcaAudio`. Bandwidth/vitals initially deferred (env/cross-package).
- 2026-07-23 (cont.) — Completed the rest end-to-end: SSE best-practice `getStreamBaseUrl()` (gateway-direct streams, ticket via BFF) + col-3 wired to `useArcaLiveSummary`; Phase B bandwidth push-chain (`@arcaai/stt`→pipeline→`useArcaAudio`→footer); Phase D vitals (nlp parser + pytest, applications DTO + flush merge, console grid) — `arcaenv` was available after all; fixed the pre-existing `@arcaai/vox` dts-shipping bug (build now emits declarations). Gates green: **admin-console tsc 0 / lint clean / 1140 · @arcaai/vox 3561 · @arcaai/applications 6733 · @arcaai/stt 418 · nlp vitals 9 (ruff/mypy clean)**. Still UNCOMMITTED on `fix/2605-review`; runtime/browser verification pending the live stack.

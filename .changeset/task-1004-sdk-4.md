---
'@arcaai/vox': major
'@arcaai/vox-node': major
---

TASK-1004 — spoken-language selection end to end, and outright removal of the v1-compat surface (zero production traffic; OD-1/D-8).

**Breaking**

- `@arcaai/vox`: removed the `./compat` entry point (`ArcaCompatProvider`, `useArcaSessionManager`, `useAudioCapture`, `useArcaSpeechToText`, `useText`, `useArcaBatchTranscription`, `useArcaSttProvider`, the v1 type surface, `mapV1ConfigToAgenticConfig`) and its `package.json#exports["./compat"]` entry. `StreamingSessionManager.setCompatSwitchEnabled()` and `useArcaAudio().switchProvider(target, { useCompatEndpoint })` are gone — `switchProvider` is natively bidirectional and needs neither.
- `@arcaai/vox-node`: removed `hope.summarization.*` (the stateless, v1-compat pre-summary/summary surface — `preSummary`/`preSummaryStream`/`summary`/`summaryStream`, their request/response/stream-event types, and the `api/smr/api/v1/*` prefix exemptions). Use `hope.consultations.summaries.*` (consultation-bound) instead, or `hope.agents.invoke()` against a `TEXT_GENERATION` agent for a one-shot call with no consultation.

**Added**

- `LanguageModeId` (a widened catalog id, e.g. `'en'` / `'ml-en'` / `'auto'`) and `LanguageResolution` (the resolution receipt: `requestedMode`, `source`, `appliedMode`, `engine`, `provider`, `params`, `degraded`, `reason`), exported from both packages.
- `@arcaai/vox-node`: `consultations.updateLanguage(consultationId, { languageMode }, { ifMatch? })` — change a consultation's declared spoken-language mode after open (OCC `PATCH`; omits `ifMatch` and it reads the consultation first to build one). `stt.createStreamSession()`'s response, the STT `status`/`ready` socket frames, and `agents.transcribe()`'s job handle/status now carry `languageResolution`. `agents.transcribe()` also gains `languageMode` on both source shapes, and now correctly forwards `consultationId` on the JSON (`{ mediaId }`) route — previously silently dropped.
- `@arcaai/vox`: `session.open()` accepts `languageMode` alongside `language`; `stt.createStreamSession()`'s response and the WS `status`/`ready` frames carry `languageResolution`. Corrected the stale TSDoc on `OpenSessionInput.language` — it is the SPOKEN language, not the note's language (TASK-1001 OD-12).

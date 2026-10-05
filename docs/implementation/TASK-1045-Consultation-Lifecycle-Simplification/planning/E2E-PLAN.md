# TASK-1045 — final end-to-end verification plan (D-43)

Runs ONCE, after wave 6 is merged, the five artifacts regenerated, the SDK family versioned to 5.0.0 and the full gate green. Scope: ALaaS (audio-stream-svc + web_ui, adapter `vox-node5` against the local 5.0.0 build; one pass on `vox-node4` for the shim) → local HOPE (api, stt, text, guardrail, nlp, harness, Temporal worker) → admin console (`apps/admin-console`, port 5176). Also exercises the TASK-1038/1039/1041/1042/1043/1044 surfaces (TASK-1040 is not implemented).

## Environment

| Piece | Setting |
|---|---|
| Database | fresh `hope_1045_e2e` on the dev Postgres (migrate deploy + `RUN_SEED=all`), D-20; dev DB `hope` untouched |
| Model | LM Studio `gemma-4-e2b-it-qat`, context 32768, parallel 10, KV q4_0, temperature 0 (agents) |
| HOPE | api 8868, stt 8861, text 8862, guardrail 8863, nlp 8864, harness 8866, worker; host env `DATABASE_URL`/`DIRECT_URL` → `hope_1045_e2e`; SYSTEM `lm-studio` connection baseUrl → `http://localhost:1234/v1` (local only) |
| ALaaS | detached worktree; pg 5434, redis 6381 (HOPE test infra holds 5433/6380); svc 4000 (`node dist/src/main.js`); web_ui 5173 on `localhost`; mmr stand-in on 5001 (scratchpad); seeded ArcaAI service account; mapping keys `1001…1006` |
| Console | `next dev` 5176, super admin + tenant admin logins |

## Scenarios (each: expected UI → expected API/SSE → expected DB rows → expected logs)

| # | Scenario | Key assertions |
|---|---|---|
| S1 | New visit, encounter 1: launch → open at launch (D-17) → Start → speak → Pause (5 s) → Resume → Stop | status OPEN→RECORDING→PAUSED→RECORDING→STOPPED; one STT session across the pause (D-5); segments idempotent with recording-timeline offsets; `pausedTotalMs` excludes the pause; final transcript pushed before `note.requested`; FULL_TRANSCRIPT version; E1 ledger + recap v2 produced |
| S2 | Auto-generate after stop | broker sends generation after `transcript.final`; progress stepper; processing SUMMARIZING → IDLE+NOTE_READY (or AWAITING_REVIEW with gaps); `isNoteReady`; citations rendered as chips; AiActivityRun rows per STT/ledger/note call with model, tokens, context used/window, cost, duration |
| S3 | Doctor → tests → doctor: re-visit same day, encounter 2 appended (visit type new→re-visit) | `encounter_appended`, `currentEncounterSeq=2`; E1 recap + read-only E1 transcript shown in ALaaS; stop E2 → exactly ONE re-finalize (governed tenant ArcaAI AND a non-governed department) — no duplicate when the broker also calls `summary/async`; note covers BOTH encounters incl. E1 penicillin allergy + metformin 500→1000 mg; coverage `ok` or gaps listed |
| S4 | Feedback | thumbs on note / section / segment / entity (hover; visible on touch); reason codes from HOPE; transcript line edit → SEGMENT correction version; note correction; feedback rows + daily rollup; mining queue entry for thumbs-down/corrections |
| S5 | Attachment | PDF upload (presigned → complete) processed; image → 422; uploaded audio → batch transcript → cited input; a forced batch failure → attachment FAILED, processing leaves PROCESSING_ATTACHMENT (H-85) |
| S6 | Section regenerate | `generateSummary({sectionKeys:['plan']})` → new note version `ai_section_regen`, other sections preserved |
| S7 | Copy to EMR | EMR text has NO citation labels; HOPE note keeps them; no correction sent when text differs only by labels; approve + close → CLOSED_COMPLETE, `closedReason APPROVED`; approval snapshot + WORM attestation; retried copy is a no-op (D-29) |
| S8 | Auto-close + late copy | shorten the tenant auto-close window; sweep → CLOSED_INCOMPLETE `closedReason AUTO`; ALaaS launch state "was auto-closed" (Continue / Start new); late Copy to EMR → reopen + approve + close → CLOSED_COMPLETE, audited late sign-off (D-26) |
| S9 | Reopen policy | reopen CLOSED_COMPLETE refused unless the tenant setting allows; reopen CLOSED_INCOMPLETE explicit (D-7) |
| S10 | Background tab | recording + generation keep running while the ALaaS tab is hidden; panels stay mounted |
| S11 | Notifications | bell receives `note.ready` / `note.failed` / state notices |
| S12 | Old vocabulary | `vox-node4` shim pass: Copy to EMR byte-identical; without `X-Hope-Lifecycle: 2` the API projects PENDING_REVIEW for a written note (D-34) |
| S13 | Console | `/consultations` list chips (Note ready), `/consultations/[id]` timeline oldest-first with the encounter gap band, run metadata per activity, version history + diffs, recap; matches DB; both themes; axe 0 |
| S14 | Webhooks | a webhook subscriber receives lifecycle deliveries with `data.action='lifecycle'` + `data.event` and no PHI (H-86) |
| S15 | Deprecated routes | an old route answers with `Deprecation`/`Sunset`; `hope_api_deprecated_requests_total` increments (D-37) |
| S16 | TASK-1038/1039/1042 | a workflow run via vox-node 5.0 `RunHandle` (text stream, result, resume by seq, cancel); `runWithAudio` standalone live audio run; protocol-v2 frames |
| S17 | TASK-1041/1043 | internal routes refuse without service auth / with a mismatched internal tenant header |

## What is monitored during the run

- Logs (tail + grep error/warn per service, request-id correlated): api, stt, text, guardrail, nlp, harness, worker, ALaaS svc, browser console (web_ui + console).
- Database (`core` schema), after every step: `Consultation` (status, processing, processingReason, currentEncounterSeq, lastActivityAt, autoCloseAt, closedReason, _version), `ConsultationEncounter`, `ContextItem` / `ContextItemVersion` (kinds, versionNumber, changeSource, encounterSeq), `AiActivityRun`, `WorkflowRun` (status, firstErrorCode), `ConsultationApproval` + attestation, `ConsultationFeedback` + `ConsultationFeedbackDailyRollup`, `ConsultationAttachment`, webhook deliveries, `AuditLog` (lifecycle actions). PHI is never printed into the report; ids, counts and states only.
- Metrics: `/metrics` deprecated counter; LM Studio parallel slots.

## Report

Per scenario: verdict, evidence (ids, row states, log lines, screenshots), defects (severity, root cause, fix lane, re-test). Defects → fix lanes; a major change or re-architecture → owner first.

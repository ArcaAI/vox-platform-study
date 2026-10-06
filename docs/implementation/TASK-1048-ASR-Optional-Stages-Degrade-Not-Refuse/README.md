# TASK-1048 — ASR optional stages degrade instead of refusing the session

**Status:** In Progress · **Type:** bugfix + behaviour change · **Branch:** `dev-2.2`

## Requirement Analysis

A tester's realtime session on agent `sarvam-diarization` (tenant ArcaAI `50000000-…0001`) was refused
with 409 `ASR_AGENT_DIARIZATION_MODEL_MISSING`: the agent enables diarization but names no
speaker-embedding model. Owner rules (2026-10-06):

1. An enabled side feature with no model / no data / no input (e.g. no enrolled voice) MUST NOT break the
   session — the core ASR path always runs; broken optional parts are skipped.
2. An admin configuring an agent whose prerequisites are unmet MUST get a notice.
3. A user starting an agent/workflow whose prerequisites are unmet MUST get a notice.

## Current State Evaluation (2026-10-06)

- Loki: 409s on `POST /audio/transcription-jobs/stream/session` (2026-10-05 10:53, 2026-10-06 05:15) and
  ~10× on `GET /voice-profiles/enrollment-target`.
- Cluster DB: `sarvam-diarization` v1 published 2026-10-05 10:06, `audioFrontEnd = {"diarization":{"enabled":true}}`,
  `validationReport.findings = []`. Same latent break: `stt-demo` (tenant `01a0ec5b…`), `radiology-diarization-asr`.
- Root causes:
  - `build-resolved-asr-spec.ts` fails closed on optional stages (`assertDiarizationRunnable` TASK-887,
    `assertVadRunnable` TASK-977 D-3, `assertDiarizationBackendSupported` TASK-980, fallback task
    check :824) → `asr-agent-resolver.service.ts:206` maps to 409.
  - Agent validate/publish has no SPEECH_TO_TEXT prerequisite finding.
  - `diarization.enabled` is tenant-editable but `embeddingModelSlug` is platform-managed (TASK-991/1036):
    a tenant admin can switch diarization on and never fix it.
  - `apps/stt` already degrades for absent/failed diarization, VAD, zero voice profiles — but voice-profile
    seeding (`session_manager.py:1236`) and lexicon correction (`inference.py:480-513`) are unguarded and
    most degradations never reach the client.

## Owner decisions (2026-10-06 — "go with recommendations")

| # | Decision |
|---|---|
| OD-1 | Reverse fail-closed for OPTIONAL stages at session/job time (degrade + warn). CORE refusals stay: no ASR model, no credential, not assigned, provider veto, wrong primary task. |
| OD-2 | Diarization on + no agent slug → platform default `stt.diarization.defaultEmbeddingModelSlug` (tenant → SYSTEM, on absence only, SYSTEM row seeded `wespeaker-voxceleb-resnet34`); if that does not resolve either → skip diarization + warn. |
| OD-3 | Publish/validate prerequisite findings are WARNING (advisory), never blocking. |
| OD-4 | No data change to the three affected agents. |

Voice-profile ENROLLMENT keeps refusing when no diarizing agent with an embedding model resolves (enrolling
genuinely needs the model) — with a clear message.

## Frozen contract

`packages/types/src/asr-degradation.ts` — `AsrSessionWarning`, `ASR_DEGRADATION_CODES`,
`ASR_RUNTIME_DEGRADED_REASONS`, `STT_DIARIZATION_DEFAULT_EMBEDDING_MODEL_SETTING_KEY`.

- Session/job creation responses gain `warnings?: AsrSessionWarning[]` (absent/empty = none).
- Runtime degradations ride the EXISTING `status` frame: `{ status: 'degraded', reason }`.
- Agent finding codes (WARNING): `ASR_DIARIZATION_MODEL_MISSING`, `ASR_DIARIZATION_BACKEND_UNSUPPORTED`,
  `ASR_VAD_MODEL_MISSING`.

## Implementation Plan — lanes (one worktree each, disjoint files)

| Lane | Tier | Owns |
|---|---|---|
| A gateway degrade | opus / deep | `packages/applications/src/services/stt/**`, settings descriptor + seed row for OD-2, `voiceProfile.service.ts`, `apps/api/src/modules/streaming/transcription-job.controller.ts` (+ response DTO) |
| B publish findings | sonnet | `packages/applications/src/services/agent/agent.service.ts`, `agent-findings.ts` |
| C SDKs | sonnet | `packages/agentic-sdk-v2/**`, `packages/vox-node/src/**` (stt types/handles) |
| D STT runtime | sonnet | `apps/stt/src/stt/**` |
| E console | sonnet | `apps/admin-console/src/features/{agents,playground-live-transcription}/**`, `src/shared/sandbox/**` |

TDD test list per lane is in each lane's report (Change History). Lanes run only their own test files;
the orchestrator runs the gates once after all lanes are merged into `dev-2.2`.

## Verification criteria

- `sarvam-diarization` as stored today: stream session 201 with a `DIARIZATION_MODEL_MISSING` warning when
  no platform default resolves, or diarizing with the platform default when it does; transcripts flow.
- Validate on that agent shows a WARNING finding; console editor shows the alert.
- Playground shows the session warning and any runtime `degraded` frame.
- CORE failures still refuse (no ASR model → 409).

## Implementation Summary

_Pending._

## Change History

- 2026-10-06 — ticket opened; investigation + OD round; contract frozen.

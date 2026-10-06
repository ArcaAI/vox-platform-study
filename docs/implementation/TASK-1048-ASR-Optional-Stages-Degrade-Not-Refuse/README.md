# TASK-1048 — ASR optional stages degrade instead of refusing the session

**Status:** Review · **Type:** bugfix + behaviour change · **Branch:** `dev-2.2`

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

**Gateway (`@arcaai/applications`, `apps/api`)**
- `buildResolvedAsrSpec` no longer throws for optional stages: diarization with no resolvable embedding
  model or a retired backend, VAD with no VAD model, and an unrunnable fallback are switched off and
  reported via `onWarning` (`AsrSessionWarning`). CORE refusals (no primary model, wrong primary task,
  credential/veto, not assigned) are unchanged. The `ResolvedAsrSpec` wire shape to `apps/stt` is unchanged.
- OD-2: `stt.diarization.defaultEmbeddingModelSlug` descriptor (`global-kv`, `failMode: closed`, no code
  default) + SYSTEM seed row `wespeaker-voxceleb-resnet34` (`seed/11d-stt-diarization-default-setting.ts`,
  create-only). Used only when the agent names no slug; an agent-named slug that does not resolve never
  borrows it (different vector space).
- `AgentResolverService.materialiseModels`: an invisible OPTIONAL aux model (vad/denoise/embedding/
  punctuation/endpointing) is skipped with a warn log instead of 409; the primary stays a refusal.
- `POST audio/transcription-jobs/stream/session` (incl. `workflowSlug` sessions), `POST transcribe` and
  the JSON batch routes return `warnings?: AsrSessionWarningResponse[]`. The governing-workflow path no
  longer refuses for an optional-stage problem.
- Voice-profile enrollment still requires a diarizing agent with an embedding model, with an
  actionable message; the sibling search is kept.
- Agent validate/publish: WARNING findings `ASR_DIARIZATION_MODEL_MISSING`,
  `ASR_DIARIZATION_BACKEND_UNSUPPORTED`, `ASR_VAD_MODEL_MISSING` (advisory). The platform default is
  consulted; an unset default is reported as missing.

**STT runtime (`apps/stt`)** — `publish_degraded_once` + a never-raising `_report_degraded` guard;
`status: degraded` frames for `diarization_unavailable`, `voice_profiles_unavailable`, `vad_unavailable`,
`segmentation_unavailable`, `lexicon_unavailable`, `gloss_unavailable`. Voice-profile seeding and lexicon
correction are wrapped; batch results carry `metadata.degradations`.

**SDKs** — `@arcaai/vox`: `useArcaAudio()` → `warnings`, `degradations` (store state, reset per session,
cleared on tenant switch; `onSttSessionWarnings` / `onSttDegraded` plugin callbacks). `@arcaai/vox-node`:
`warnings?` on stream-session and batch responses, `ASR_RUNTIME_DEGRADED_REASONS`, `isSttDegradedStatus`.
No version bump (release is the owner's).

**Admin console** — notice under the diarization/VAD switches in the simple agent editor; findings list
shows `path`; persistent `AsrDegradationBanner` + one `toast.warning` in the live-transcription
playground, the shared sandbox recorder and the Studio Test tab.

### Evidence (2026-10-06, after all lanes merged into `dev-2.2`)
- Builds: `@arcaai/types`, `@arcaai/applications`, `api:build` PASS. Typecheck: database, applications,
  api, vox, vox-node, admin-console PASS. Lint: applications, api, vox, vox-node, admin-console, stt (ruff) PASS.
- Tests: applications 17805 passed / 4 failed — the 4 (audit-correlation ×2, queue-admin INFO timeout,
  consultation status gate) pass in isolation (19/19) and are unrelated load flakes; api 5237 passed;
  vox 3422 passed; vox-node PASS; admin-console 4515 passed (4 files failed to LOAD mid-run on a
  concurrent `@arcaai/stt` dist rebuild — 35/35 in isolation); types, database PASS; stt unit 4023 passed.
- Artifacts regenerated (openapi, route-manifest, portal, gen:admin); `api:openapi:check`,
  `api:portal:check`, `gen:admin:check` no drift.
- Live (local API + console): an agent with `diarization: {enabled: true}` and no slug validates with
  `WARNING ASR_DIARIZATION_MODEL_MISSING`; after `PUT admin/settings/registry/stt.diarization.defaultEmbeddingModelSlug`
  = `wespeaker-voxceleb-resnet34` the warning is gone. The editor notice renders under the switch.
- NOT verified live: a stream session returning `warnings` end to end — no ASR model is publishable on
  this machine (no staged weights, no Sarvam connection) and STT is not in the launch configs. Covered by
  unit tests; verify on the cluster after rollout with `sarvam-diarization` as stored.

### Rollout notes
- The cluster has no `stt.diarization.defaultEmbeddingModelSlug` row until seeded: `hope-db-seed` no-ops on
  a seeded DB, so set it once via `PUT /api/v1/admin/settings/registry/stt.diarization.defaultEmbeddingModelSlug`
  (super admin). Without it `sarvam-diarization` transcribes with diarization OFF plus a warning.

### Follow-ups
- Stale comments still describing the old 409s: `packages/types/src/asr-spec.ts` (~187, ~220),
  `packages/workflow-contract/src/agent-schemas.ts` (~395–456), `services/agent/platform-managed-parameters.ts:52`,
  `seed/25-agents.ts:580`, `apps/api/src/modules/voice-profile/voice-profile.controller.ts:37`.
- Batch uploads in the console do not yet display `warnings`.
- `apps/stt`: after a fallback re-assembly in `create_session` a new `ResultPublisher` may re-publish a reason once.
- `seed-global-settings.test.ts` cross-seed uniqueness list does not include the new row.

## Change History

- 2026-10-06 — ticket opened; investigation + OD round; contract frozen.
- 2026-10-06 — lanes A–E merged; integration fixes (aux-model skip, finding codes, guarded degradation reports, editor notice placement); gates + live check; status Review.

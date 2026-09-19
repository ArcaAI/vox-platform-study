# TASK-991 — Voice Enrollment/Diarization & DNA Writing Style: Feature Completion

| Field | Value |
|---|---|
| Status | Review |
| Type | bugfix + feature |
| Branch | `dev-2.2` |
| Opened | 2026-09-19 |

## Requirement Analysis

Owner spec, verbatim.

**Voice enrollment & profile**
1. A user can enroll their voice and store it as a voice profile.
2. The voice profile is used for diarization when diarization is enabled in a transcription
   agent or workflow (any transcription agent with diarization enabled). The generated
   transcript is labelled with the detected speaker from the user's voice profile.
3. User-personalized feature; the tenant admin must enable it per agent/workflow.

**DNA writing style**
1. A user can ingest their writing notes (plain text/markdown) to generate a DNA report.
2. The report is used as the writing rule for redaction when redaction based on the
   available DNA Writing Style is enabled.
3. User-personalized feature; the tenant admin must enable it per agent/workflow.

Readiness must hold across: gateway admin + end-user APIs, `@arcaai/vox` and
`@arcaai/vox-node`, and the admin console (management + playground).

### Owner decisions (2026-09-19)

- **OD-1 — voice/workflow scope.** Enrollment unblocks TENANT-WIDE: if any published
  SPEECH_TO_TEXT agent in the tenant has diarization enabled, enrollment succeeds. The
  session still uses the assigned/explicitly-named agent. A workflow does not select the
  ASR agent. Profiles stay keyed by `modelId`; where the enrolled model and the session's
  model diverge, the UI warns rather than silently mismatching.
- **OD-2 — DNA gating.** ONE `dna.enabled` flag continues to govern both writing-style
  application and redaction. The label and description must say so plainly.

- **OD-3 — embedding models are PLATFORM-FIXED (2026-09-19).** The speaker-embedding model
  (voice feature extraction) and the text-embedding model (text feature extraction) are fixed for
  every tenant. No tenant may change either. They remain CONFIG, not literals: a platform admin
  owns them at the SYSTEM tier, so this is reversible by editing a value rather than a release.
  Rationale beyond policy: changing a speaker-embedding model silently invalidates every enrolled
  voice profile, and changing a text-embedding model silently invalidates every vector already in
  Qdrant — both are different vector spaces, non-comparable, with no error at write time.
- **OD-4 — the embeddings ENDPOINT is fixed with the model.** A tenant may not point embeddings at
  its own account. Fixing the model while allowing a BYO endpoint would send a platform-chosen model
  id to an account that has never heard of it — failing per-tenant at retrieval time, after ingest
  has already written vectors.

## Current State Evaluation

Audited 2026-09-19 against `dev-2.2` @ `acc0e9e62`, with 26,450 passing tests across
TypeScript and Python. Confirmed defects:

| # | Defect | Evidence |
|---|---|---|
| F-1 | DNA automatic corpus issues an invalid Prisma query — `ContextItem` filtered by a nonexistent `doctorId` column; `as any` hid it. Broken since 2026-03-27. | `dna-writing-style.processor.ts:257`; reproduced live |
| F-1b | Same query applies `limit` BEFORE the in-memory type filter, so the 50-row window fills with transcripts. Fixing F-1 alone yields an empty corpus. | `dna-writing-style.processor.ts:257-297` |
| F-2 | Self-plane DNA SSE route carries no `@StreamScope`, so every `?ticket=` 401s and the console silently polls. The admin twin has it plus a regression test. | `dna-writing-style.controller.ts:394` vs `-admin.controller.ts:244` |
| F-3 | The job POLL route echoes `job.failedReason` raw while the SSE route redacts it — leaking container paths, tenant id, doctor id and the full column list to the browser. | `dna-writing-style-job-stream.ts:140` vs `:173` |
| F-4 | `voiceProfileSeeded` is structurally always `false`: `apps/stt` has zero occurrences of `voice_profile_seeded`, `preseed.py`'s return value is discarded, and the gateway reads it off an always-`undefined` cast. User-visible. | `transcription-job.controller.ts:924`; `streaming-tab.tsx:172` |
| F-5 | 180 STT e2e tests error at setup — the hand-maintained `_enums` mirror is missing `AiModelAvailability`. This is the layer that would have caught F-4. | `apps/stt/tests/e2e/conftest.py:180` |
| F-6 | DNA ingest — the spec's entry point — has no UI on any plane. Gateway and `@arcaai/vox` both support it; nothing calls them. | zero `ingest` hits in `apps/admin-console/src` |
| F-7 | `useVoiceEnrollmentStatus` / `createVoiceEnrollmentChecker` are implemented and tested but exported from no public entry point. | absent from `core.ts`/`plugins.ts`/`index.ts`/`compat.ts` |
| F-8 | Browser SDK covers 2 of 16 DNA routes; `DnaUpdateInput` is missing `redactionRules` and `expectedVersion`, the two fields a redaction editor needs. | `types/dna.ts:92-96` vs the gateway DTO |
| F-9 | Admin DNA plane cannot view redaction rules, erase a report, or see a doctor's toggle. | `features/dna-writing-styles/` |
| F-10 | Workflow Studio renders the DNA group label as "Dna"; the switch copy omits redaction entirely (OD-2). | `schema-form.ts:103`; `node-config-schemas.ts:956` |
| F-11 | Enrollment refuses whenever the ONE resolved agent has diarization off, even if another tenant agent has it on (OD-1). | `voiceProfile.service.ts:136-148` |

Conformance before this ticket: V1 ✅ · V2 agent ✅ / workflow ❌ · V3 agent ✅ / workflow ❌ ·
D1 partial · D2 partial · D3 ✅.

## Implementation Plan

Parallel lanes, one writer per file, each in its own worktree off `dev-2.2`.

| Lane | Scope | Owns |
|---|---|---|
| A | F-1, F-1b — corpus query via the `Consultation` relation, type filter pushed into the query, `as any` deleted | `packages/domains/.../ContextItemRepository.ts`, `packages/applications/.../dna-writing-style.processor.ts` + tests |
| B | F-2, F-3 — `@StreamScope` on the self plane + parity test; poll route stops echoing `failedReason` | `apps/api/src/modules/dna-writing-style/**` |
| C | F-4, F-5 — thread the preseed result to the wire; add the missing enum to the e2e conftest | `apps/stt/**`, `packages/applications/.../streaming/**`, `apps/api/.../transcription-job.controller.ts` + dto |
| D | F-11 / OD-1 — tenant-wide enrollment unblock | `packages/applications/.../user/voiceProfile/**` |
| E | F-7, F-8 — export the enrollment-status hook; reconcile `DnaUpdateInput`; add the DNA report/settings/redaction hooks | `packages/agentic-sdk-v2/src/**` |
| F | F-6, F-9, F-10 / OD-2 — ingest UI, admin redaction+erase, "DNA" label and honest copy | `apps/admin-console/src/**`, `packages/workflow-contract/src/node-config-schemas.ts` |
| G | OD-3 voice half — `embeddingModelSlug` becomes platform-managed and tenant-read-only | `packages/workflow-contract/src/agent-schemas.ts`, agent update path, `features/agents/components/parameters-form.tsx` |
| H | OD-3/OD-4 text half — embeddings resolve from the platform tier only; tenant-tier writes refused | `apps/harness/src/harness/core/provider_credentials.py`, `services/ai-provider-connection/**` |

### Process (owner directive, 2026-09-19)

Deviates deliberately from `14-multi-agent-worktrees.md` §5 and is the owner's call:
lane agents **do not run gating tests**. They write and commit only. The orchestrator
merges every lane into `dev-2.2`, then runs the gates and the e2e suite, then removes the
worktrees and branches. **E2E is run by the orchestrator alone.**

## Implementation Summary

Eight lanes, each in its own worktree, merged into `dev-2.2` by the orchestrator. Per the owner's
process directive the lane agents ran no gates; every gate below was run after merge.

| Lane | What shipped |
|---|---|
| A | `ContextItemRepository.findFinalSummariesByDoctor(doctorId, limit)` joins through `Consultation.doctorId` and constrains `type` IN (RAW_SUMMARY, MODIFIED_SUMMARY) **in the query**, so the row budget is not spent on transcripts. The `as any` is gone, so the call is type-checked. |
| B | `@StreamScope` on the self-plane `jobs/:jobId/stream`, asserted **jointly** with the admin twin so they cannot drift again. Both transports now answer through an allow-list `safeJobError()`. |
| C | `seed_voice_profiles`' result is retained per session, echoed as `voice_profile_seeded`, mapped through the gateway DTO, read without a cast. `AiModelAvailability` added to the STT e2e conftest. |
| D | `enrollmentTarget` falls back to any published, active, diarizing SPEECH_TO_TEXT agent of the tenant (OD-1). An explicit `agentSlug` is never substituted. |
| E | `useVoiceEnrollmentStatus`/`createVoiceEnrollmentChecker` exported; `useDnaReport` covers the doctor self-service plane; `DnaUpdateInput` reconciled with the gateway DTO. |
| F | The DNA **ingest** UI (the spec's entry point), admin erase on the tenant-admin grid, "DNA" label fix, and DNA copy that states both effects (OD-2). |
| G | `embeddingModelSlug` is platform-managed: `readOnly` in the schema, refused on the tenant write path with 403 `AGENT_PARAMETER_PLATFORM_MANAGED`, read-only in the console (OD-3). |
| H | Embeddings resolve from the platform tier only — endpoint, key and model — and a tenant-tier `embeddings` upsert is refused. `require_embeddings_model` stays fail-closed (OD-3/OD-4). |

### Orchestrator fix-ups after merge

Lane agents could not compile or run anything, so these surfaced at the gate:

- Three packages are consumed as **built output**, so each needed a rebuild before its dependents
  saw the change: `@arcaai/domains` (lane A), `@arcaai/workflow-contract` (lanes F/G),
  `@arcaai/applications` (lane C — caught only by the real `nest build`, not by any unit test).
- Lane B allow-listed the `notifyFailed` strings my brief named; `job.failedReason` is BullMQ's
  `Error.message`, i.e. the **thrown** strings. Lane B caught this itself and used the right ones.
- Lane F's `Queue ingest` button was `disabled={!canSubmit}`, so its click never landed and the
  validation messages it guards were unreachable — a button disabled with no way to learn why
  (rule 11 §5). It now disables only for an in-flight request and the doctor-context gate.
- Stale contract tests updated rather than relaxed: the admin job-status test asserted the old
  verbatim `failedReason` pass-through; the TASK-958 integration-plane multiplicity example moved
  off `embeddings` to `vector/qdrant` (the only other plane a tenant can still write).
- STT doubles taught about the new seeded map — `get_voice_profile_seeded` is synchronous, so on
  the `AsyncMock` route fixtures it must be an explicit `MagicMock`, the convention that fixture
  already documents twice.
- **Fixed two failures that pre-dated this ticket**: `SPEECH_TO_TEXT` renders "Beam Size" three
  times (flat, `decoding.partial`, `decoding.final`) — correct, and each in its own fieldset — so
  the flat field is now addressed by an unambiguous id suffix instead of a label lookup matching
  all three.
- Ran `pnpm env:sync`, already drifting before this ticket: `STT_CUDA_ARCHITECTURES` arrived with
  `9e745fba1` (TASK-985) declared in the STT Dockerfile but never added to `turbo.json#globalEnv`.

### Verification

Gates (all after merge):

| Surface | Result |
|---|---|
| root (`applications`, `domains`, `database`, `api`) | 27,400 passed / 1 failed* |
| `apps/admin-console` | **3,642 passed, 0 failed** (375 files) |
| `@arcaai/vox` | **3,799 passed, 0 failed** (252 files) |
| `apps/harness` | **2,669 passed, 0 failed** |
| `apps/stt` | 4,066 passed / 26 failed† / 26 errors† |

\* `harness-tts-internal.controller.test.ts` — passes in isolation (120/120); pre-existing
cross-file mock pollution. This ticket touches no file in `apps/api/src/modules/speech`.

† Lane C's conftest fix took STT errors from **206 → 26**, so ~180 e2e tests now execute for the
first time in a long while. 24 of them fail on a contract TASK-861 retired (`pipeline_id` /
`STT_DATABASE_ENABLED=false`) plus a health-message assertion; one is the known `MINIO_ACCESS_KEY`
test-order leak from `e2e/conftest.py:146`. These are **newly exposed, not newly broken** —
see Follow-ups.

End-to-end, driven by the orchestrator against a live gateway (`:8968`) and the admin console:

| # | Check | Result |
|---|---|---|
| 1 | `POST generate {}` — the branch broken since 2026-03-27 | `"No approved text samples available for DNA analysis"` — a clean domain message; the query executes |
| 2 | LLM-unreachable failure | `"Generation failed"`; leak audit found **0** occurrences of a path, `doctorId`, `tenantId`, `findMany` or the axios status text |
| 3 | `POST ingest` with markdown | 202, 2 items accepted, window computed |
| 4 | `GET enrollment-target`, no diarizing agent | 409, message proves it **scanned the tenant** |
| 5 | Same, with a diarizing sibling | 200 → the sibling's slug + embedding model (OD-1) |
| 5b | Explicit slug on a non-diarizing agent | still 409 — never substituted |
| 6a | `PATCH` agent, unrelated change, same embedding slug | 200 — ordinary edits unaffected |
| 6b | `PATCH` agent, changing the embedding slug | 403 `AGENT_PARAMETER_PLATFORM_MANAGED` |
| 7 | Tenant `PUT admin/providers/embeddings/openai` | 403 platform-managed |
| 7b | Control: same shape on `llm` | 200 — the gate is scoped |
| 8 | **Admin console**, `/playground/dna-writing-style` | Ingest pane renders; a real sample submitted → "Accepted 1 sample spanning Sep 1, 2026"; job polled to terminal showing **"Generation failed"** — the safe message, in the very UI where the leak originally surfaced |

The test API booting at all is also the boot smoke for lane D's new `AgentRepository` injection:
deny-by-default route audit and DI graph both passed.

## Follow-ups (not in this ticket)

1. **~24 STT e2e tests assert a retired contract.** Now that they run, they expect the
   `pipeline_id` path TASK-861 disabled (`404` where the service correctly answers `503
   PIPELINE_SELECTION_DISABLED`), and a health `database` component with no `message`. They need
   rewriting for the current posture.
2. **`e2e/conftest.py:146` leaks `MINIO_ACCESS_KEY` into `os.environ`** with no teardown, and
   `e2e` sorts before `unit`, so `test_task799_env_surface` fails on a value the code does not set.
3. **Several `_enums` member lists in that conftest are narrower than the models declare**
   (`AiModelSource` missing `S3`, `ModelCategory` mismatched, `ModelTaskType` missing most values).
   Only bites when a test writes a missing value.
4. **`eslint-comments/require-description` is a warning.** It already flags the exact line this
   ticket's worst defect hid behind; only 2 of 13 `filters: … as any` sites are justified.
   Promoting it to error for `packages/*` would make the class of defect unshippable.
5. **Admin visibility of a doctor's redaction rules** — no gateway route exposes them to an admin.
6. **`voiceProfileSeeded` on the BATCH path** still discards the preseed result; only streaming
   was threaded.
7. **Tenants holding an existing `embeddings` connection row** are now ignored by the harness and
   can only delete it. If any live tenant has one, its Qdrant vectors were written with that
   model and will not match queries embedded with the platform's — that tenant needs a re-ingest.


## Change History

| Date | Change |
|---|---|
| 2026-09-19 | Ticket opened. Audit recorded; OD-1 and OD-2 taken; six lanes defined. |
| 2026-09-19 | Lanes A-H merged, gates run, end-to-end verified against a live gateway and the admin console. Status -> Review. |
| 2026-09-19 | Lanes A-D merged to `dev-2.2` and green. OD-3/OD-4 taken mid-flight (embedding models and the embeddings endpoint are platform-fixed); lanes G and H added. |

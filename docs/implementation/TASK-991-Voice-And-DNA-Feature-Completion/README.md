# TASK-991 — Voice Enrollment/Diarization & DNA Writing Style: Feature Completion

| Field | Value |
|---|---|
| Status | In Progress |
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

_Pending._

## Change History

| Date | Change |
|---|---|
| 2026-09-19 | Ticket opened. Audit recorded; OD-1 and OD-2 taken; six lanes defined. |
| 2026-09-19 | Lanes A-D merged to `dev-2.2` and green. OD-3/OD-4 taken mid-flight (embedding models and the embeddings endpoint are platform-fixed); lanes G and H added. |

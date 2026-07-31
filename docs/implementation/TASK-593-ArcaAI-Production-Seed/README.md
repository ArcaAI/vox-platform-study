# TASK-593 — ArcaAI Production Day-1 Seed

**Status:** In Progress
**Type:** infrastructure (seed data)
**Branch:** dev-2.1

## Requirement Analysis

Make the **ArcaAI** customer tenant (`SEED_CUSTOMER_TENANT_IDS.ARCAAI` =
`50000000-0000-0000-0000-000000000001`, key `ARCAAI`) production-ready on day-1
by bringing its seed up to the richness of the **Global** reference tenant
(`SEED_TENANT_ID` = `50000000-…0000`, key `__GLOBAL__`).

Owner decisions (2026-07-31):
- **Seed scope:** *Full clone of Global* — ArcaAI mirrors Global 1:1, including
  demo consultations/transcripts/DNA reports/audit logs/clinical users/voice
  profiles and the dev/test-gated API-key fixtures.
- **Departments + prompt-instruction templates:** *Out of scope here* — a
  concurrent agent owns `04-department.ts`, `07-prompt-template.ts`, and (by
  extension) `07a-agent-golden-library.ts`. This ticket must NOT touch them.
- **Harness:** ArcaAI gets a `PipelinePolicy` TENANT override pinning
  `harnessEnabled = true` (mirrors Global's demo override).
- **Frontend config:** clone Global exactly — `transcriptionMode = BACKEND`,
  `transcriptionModeLocked = true`, `captureRawAudio = true`.

## Current State Evaluation

Baseline gap (Global vs ArcaAI): ArcaAI was seeded as a deliberately thin
"second tenant" backing cross-tenant isolation E2E tests. Global has 18 wired
departments, ~40 prompt templates, ~17 users, 8 DNA reports, 9 consultations,
harness-ON pipeline override, and a BACKEND-locked + raw-capture frontend
config. ArcaAI had 3 unwired departments, 4 templates, 3 users, 1 DNA report,
2 consultations, no pipeline override (harness OFF), and an unlocked frontend
config with no transcription mode / raw capture.

## Coordination / File Ownership

Because a concurrent agent is editing the department + prompt-template seeds,
work is split to avoid clobbering shared uncommitted files (notably
`00-constants.ts`).

| File | Owner |
|---|---|
| `04-department.ts`, `07-prompt-template.ts`, `07a-agent-golden-library.ts` | **Department agent** (do not touch) |
| `05-tenant.ts` (frontend config), `14-pipeline-policy.ts` | **This ticket — done** |
| `00-constants.ts` (ArcaAI ids), `02-apikey.ts`, `08-dna-writing-style.ts`, `09-consultation.ts`, `10-audit-log.ts`, `91-user.ts` | **This ticket — DEFERRED** until the department agent's work is staged/committed |

## Implementation Plan

### Phase A — decoupled, collision-free (DONE)
1. `05-tenant.ts` — ArcaAI `TenantFrontendConfig`: add `transcriptionMode:
   BACKEND`, `transcriptionModeLocked: true`, `captureRawAudio: true`.
2. `14-pipeline-policy.ts` — add `ARCAAI_PIPELINE_POLICY_OVERRIDE`
   (`harnessEnabled: true`) + a third `ensureTenantRow(...)` call; extend the
   return to `{ system, demo, arcaai }`.
3. Update the live-DB pipeline-policy tests in
   `packages/database/src/__tests__/seed.test.ts` (create-count 2 → 3,
   idempotent + only-missing cases, new `arcaai` assertions).

### Phase B — full demo-data clone (DEFERRED; blocked on the department agent)
Runs only after the department agent's ArcaAI department set is final and its
`00-constants.ts` edits are staged/committed (never edit `00-constants.ts`
concurrently). Clone Global → ArcaAI, mapping every Global department reference
onto the corresponding ArcaAI department:
- `00-constants.ts` — add ArcaAI ids for the new users, voice profiles,
  consultations, transcripts, DNA reports, audit logs, API keys.
- `91-user.ts` — clone Global's clinical doctors/nurses + voice profiles + SDK
  prefs into ArcaAI (tenant `…0001`); keep usernames globally unique (cold-seed
  invariant in `seed/__tests__/seed.test.ts`).
- `08-dna-writing-style.ts` — clone Global's 8 DNA reports/versions/usage,
  bound to ArcaAI doctors in-tenant.
- `09-consultation.ts` — clone Global's 9 consultations + transcripts +
  transcription jobs into ArcaAI.
- `10-audit-log.ts` — clone Global's audit rows into ArcaAI (single-tenant
  coherence: users/consultations referenced must live in `…0001`).
- `02-apikey.ts` — clone Global's SDK/webhook/service keys for ArcaAI
  (dev/test-only, `shouldSeedApiKeys` gate unchanged).
- Keep the cold-seed invariants in `seed/__tests__/seed.test.ts` green (unique
  usernames, in-tenant clinicians/consultations, coherent single-tenant audit).

> Note: control-plane phases 16/17/18/19 and 13-harness seed SYSTEM defaults
> only; Global has zero tenant-scoped rows there, so a faithful clone adds none
> for ArcaAI (it inherits the platform defaults). No entitlement/plan row is
> assigned (Global has none either).

## Implementation Summary (Phase A)

- `packages/database/src/prisma/db_main/seed/05-tenant.ts` — ArcaAI frontend
  config now mirrors Global (BACKEND + locked + raw capture).
- `packages/database/src/prisma/db_main/seed/14-pipeline-policy.ts` — new
  `ARCAAI_PIPELINE_POLICY_OVERRIDE` + `ARCAAI_REASON`; `seedPipelinePolicy`
  ensures the ArcaAI TENANT override (harness ON) and returns `arcaai`.
- `packages/database/src/__tests__/seed.test.ts` — pipeline-policy block updated
  for the third row.

### Verification (Phase A)
- `vitest run src/__tests__/seed.test.ts -t "seedPipelinePolicy"` → 6 passed.
- `vitest run src/__tests__/seed.test.ts -t "Frontend Config"` → 3 passed.
- `tsc --noEmit -p tsconfig.json` (packages/database) → clean (exit 0).

## Change History

- 2026-07-31 — Phase A implemented + verified (frontend config clone + harness
  override + tests). Phase B (full demo-data clone) deferred pending the
  concurrent department-seed agent to avoid `00-constants.ts` collisions.

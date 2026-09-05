# TASK-870 — Configuration Governance Program

| | |
|---|---|
| **Status** | In Progress |
| **Type** | refactor / feature (program) |
| **Branch** | `dev-2.2` (all lanes merge here) |
| **Base** | `c364bb8ec` |
| **Owner decisions** | 10 answers + 4 follow-up directions, recorded in the review artifact and restated below |
| **Review record** | https://claude.ai/code/artifact/d0acc802-b6da-47f2-b83f-0b4b3ff7e541 |

## Requirement Analysis

A two-day review of all 341 settings-registry descriptors, run after the audio-pipeline
retirement (TASK-861/865) and the AI-consolidation program (TASK-859..864), established for
every key whether it is read, whether changing it does anything, and — against the owner's
target model — where it belongs. The owner then answered every open decision. This program
executes the result.

**The target model, as decided (2026-09-05):**

1. BYO keys — a tenant admin provides them; each affects only that tenant.
2. Built-in providers (LM Studio, Ollama, NLP, TTS, vLLM) — the platform admin manages them.
3. Capabilities are agents and workflows, cloned from SYSTEM templates or any existing agent.
   Global (`50000000-…`) is the platform's build-and-test tenant; SYSTEM (`00000000-…`) is the
   template every customer tenant refers to and the tenant template for new tenants. A
   multi-tenant admin syncs among his own tenants; tenant admins import/export JSON.
4. Fallback is a platform HA capability: every agent falls back to the platform default
   provider on outage, by default, metered as platform-funded. The toggle is per agent node.
5. Guardrail is built-in and platform-only. It gates every text-generation request before send
   and every response after receive, for built-in and BYO providers alike. No tenant admin
   manages any guardrail setting.
6. Settings exist for platform admins to control platform behaviour. No tenant-managed
   conditions (department, visit type); developers branch in workflows; tenant admins align
   agents by key:value tags. Admins overwrite an agent's hyperparameters and instruction by
   injected context or hard-coded node values, not by settings.
7. Priorities: transcription, text generation, NLP, and safety against jailbreak/injection
   first; harness policy later. Redundant settings from the old architecture are removed
   completely, not dual-homed.

**Outcome the program lands:** 341 → 208 registry keys; tenant-scoped keys 59 → 6 (the five
clamped security floors plus the platform-written credential ceiling); the old text-selection,
ASR-pipeline, pipeline-policy and tenant-guardrail surfaces removed; nine capability gaps
closed. Per-key decisions, prerequisites and the removal list are in the review artifact.

## Current State Evaluation

Verified facts the lanes build on (file:line references point at `c364bb8ec`):

- `_apply_guardrail_gate` (`apps/text/src/text/api/endpoints/generate.py:149`) is the only
  moderation gate in `apps/text` and runs once, on the request (`:435`). Both `stream.py`
  routes are `GET` replay endpoints over a generation only `POST /generate` can start, so
  input is gated on every path and output on none.
- `asr-agent-resolver.service.ts:169-178` resolves one `fundingTier` per session, first-wins
  from the primary; `record_streaming_usage` (`session_manager.py:4293`) never consults
  `active_engine`. A BYO session that switches to the platform fallback is billed as BYOK.
- `AiRoutingPolicyRepository.findCandidates` (`:93-100`) hard-filters `resourceStatus: ENABLED`
  + `enabled: true`; `resolveDefault` (`ai-routing-policy.service.ts:176-179`) widens to SYSTEM
  on an empty tenant tier. Guardrail (`tenant_config.py:198,517`) treats DISABLED as a veto.
- `svc:admin:*` scopes are renamespaced from `apikey-scopes.registry.ts`; the seed test at
  `service-account-seed.test.ts:113` asserts `tenant-storage:manage → manage:Tenant` while
  30 routes across 8 controllers require a different subject.
- 46 descriptors are dead with no prerequisite (list: `REMOVE-DEAD`/`REMOVE-FALLBACK` rows with
  an empty `prerequisite` in the review's reconciled decisions). No seed writes any of them;
  no live DB row holds any of them.
- `apps/text` has the `pythonpath` half of the worktree guard but not the `conftest.py`
  `assert_source_tree` half (rule 14 §4); `apps/stt` has both.

## Implementation Plan

Waves. A wave's lanes run in parallel in separate worktrees with disjoint file ownership; the
next wave starts only after the previous one is merged into `dev-2.2` and its gates re-run.

### Wave 1 — safety gate, fast wins, dead removal, metering

| Lane | Ticket | Scope | Owns (exclusive) | Tier |
|---|---|---|---|---|
| A | TASK-871 | Post-receive guardrail gate | `apps/text/**` | fable |
| B | TASK-872 | Registry cleanup + routing-policy veto: flip `globalOnly` on 5 keys; align `resolveDefault` to the three-state rule; remove the 46 dead descriptors and the dead plumbing beside them; amend `forcePathStyle` `consumedBy`; re-anchor the tighten-only floor tests | `packages/applications/src/services/settings-registry/**`, `.../ai-routing-policy/**`, `.../effective-config/**`, `packages/domains/src/repositories/generated/core/AiRoutingPolicyRepository.ts`, `packages/database/src/prisma/db_main/seed/16-ai-routing-policy.ts`, `apps/guardrail/src/guardrail/core/effective_config.py`, `apps/{harness,tts}/**/test_effective_config_retention.py` | opus |
| C | TASK-873 | Service-account scope alignment (widen `implies`), delete the two orphaned admin-console feature folders, regenerate the five API artifacts | `packages/applications/src/services/apiKey/**`, `.../serviceAccount/**`, `packages/database/src/prisma/db_main/seed/__tests__/service-account-seed.test.ts`, `apps/admin-console/src/features/audio-pipelines/**`, `.../features/pipeline-policy/**` (+ referencing tests/nav lines), `apps/api/route-manifest.json`, `apps/api/openapi.json`, the `api:portal` output, `packages/vox-node/src/resources/admin/**` | opus |
| D | TASK-874 | STT fallback funding on engine switch | `packages/applications/src/services/stt/**`, `apps/stt/src/stt/streaming/**`, `apps/stt/src/stt/core/api_client/**`, their tests | opus |

Deliberately NOT in wave 1 (shared surfaces the orchestrator serialises, or wave-2 prerequisites):
Prisma schema changes (`AiTaskDefault` table drop, `TenantFrontendConfig` client-AI columns,
display-only `PlanEntitlement` columns); `nlp.logging.*` removal (needs the deployment repo
confirmed for stdout logging); `apps/stt/src/stt/pipeline/spec.py` (wave 2 ASR wiring).

### Wave 2 — agent-first text, ASR spec wiring, schema drops

Agent-first text on both lanes (TEXT_GENERATION `fallback` block + `AgentModelFallback`
reader + realtime `CoreAgentHandler` resolving `agentRef` + `resolveTextSelection`); wire the
dropped `ResolvedAsrSpec` fields and widen `decoding`, then delete the 8 platform duplicates;
the Prisma drops above; `nlp.logging.*`.

### Wave 3 — resolution capabilities and governance

Tag-based agent alignment; agent clone; TEXT_TO_SPEECH agent resolution on the speech path;
per-tenant guardrail availability; provider/routing/metadata moves (27 keys); promotion gate
relaxation; agent/workflow JSON import/export; `pipeline.*` repoints; harness moves; retention
consolidation.

### Rules every lane follows

- TDD: failing test first, evidence pasted (rule 01). Python lanes run under `arcaenv` from the
  worktree; lane A adds the `assert_source_tree` guard to `apps/text` conftest before trusting
  a result.
- No `git stash`, no `pnpm install`, no `db:*`, no Docker, no merges, no artifact regeneration
  except lane C (rule 14 §3). No touching files outside the lane's ownership column.
- Each lane keeps its own `docs/implementation/TASK-87N-*/README.md` through the lifecycle.
- Merge target is `dev-2.2`, merged by the orchestrator from the primary checkout, gates re-run
  after merge, worktree removed only after the merge commit exists (rule 14 §5).

## Implementation Summary

_Pending — filled per wave as lanes merge._

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Program opened; wave 1 partitioned into TASK-871..874 off `c364bb8ec`. |

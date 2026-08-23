# TASK-799 — Python Services Config-Plane Consolidation

| Field | Value |
|---|---|
| Status | In Progress — Phase 0 complete |
| Type | refactor / infrastructure |
| Branch | `dev-2.2` |
| Scope | `apps/{stt,text,guardrail,nlp,harness,tts}`, `packages/applications/src/services/{settings-registry,effective-config,ai-provider-connection,ai-task-default}`, `apps/api/src/modules/internal`, `apps/admin-console` |
| Opened | 2026-08-23 |

## Requirement Analysis

Owner directive: super admins configure platform settings and integrations; tenant
admins configure their own settings and bring their own keys/services. All of it
stored in and loaded from the DATABASE. Environment variables are to be eliminated
wherever possible, and the TOTAL number of configuration knobs must go DOWN — not
merely relocate from env to a table.

Trigger: eight `HARNESS_*` variables (claim-check store/min-bytes/bucket/endpoint,
judge provider/model/base-url/json-response-format) were found still living in
`.env`, contrary to the configuration principles in `.claude/rules/00-project-context.md`
and the tier table in `.claude/rules/09-infrastructure-devops.md`.

Baseline measured 2026-08-23 (`grep -cE '^[A-Z][A-Z0-9_]*=' apps/<svc>/.env.sample`):

| Service | Vars in its `.env.sample` |
|---|---:|
| harness | 88 |
| text | 85 |
| stt | 41 |
| guardrail | 38 |
| nlp | 31 |
| tts | 23 |
| **Total** | **306** |

For contrast, `env-surface.generated.md` declares **163 keys for the entire platform**,
of which **11** carry a `HARNESS_` prefix.

## Current State Evaluation

Full findings, root causes and per-service inventories: [assessment.md](./assessment.md).

Headline: the six services expose **~579 env-reachable settings fields**, of which 306
are documented in `.env.sample` and **40** are declared to any governance gate. ~95 are
dead. The DB→Python channel can carry **22 keys, all numeric, all SYSTEM-scope**.

Five BLOCKERs: BYOK bypassed via ambient SDK credential chains (F-01); a full guardian
engine plane in harness env (F-02); a fictional guardrail `.env.prod` (F-03); two
hardcoded nlp model ids live at runtime (F-04); guardrail resolving `AiRuntimeProfile`
SYSTEM-only (F-05).

Baseline correction: the `.env.sample` files understate the true surface by ~2x, so the
306 figure below is a floor, not the total.

## Implementation Plan

See [plan.md](./plan.md). Four phases plus a Phase 0 of independent correctness fixes.
Three open questions require an owner decision before Phase 1 starts.

## Implementation Summary

### Phase 0 — complete (merged to `dev-2.2`, 2026-08-23)

Four parallel worktree lanes, each TDD, each verified by the orchestrator against
the merged tree rather than on the agents' reports.

| Finding | Fix | Where |
|---|---|---|
| F-01 BLOCKER | Ambient cloud-credential chains closed. Bedrock builds through a single `_bearer_client()` that always takes an explicit token; Vertex passes explicit `credentials=`; both raise `ProviderCredentialsError` (503) when unsupplied. `openai_compat`/`vllm` gained a BYO override path and lost their env credential. STT Azure Foundry now matches Azure Speech (override-only). | `apps/text/providers/{bedrock,vertex,openai_compat}.py`, `apps/stt/models/azure_foundry_loader.py` |
| F-01 durability | The lock test now ITERATES `ProviderRegistry` and the settings tree instead of naming three adapters. An adapter declaring no `CredentialPosture` FAILS — default-deny, so the guarantee survives the next provider. This, not the three missing fields, was the root cause. | `apps/text/.../test_task602_byok_credentials.py` |
| F-07 | Vertex no longer fails open onto the platform ADC client when a tenant credential cannot be built. The old fail-open test was INVERTED, not deleted. | `apps/text/providers/vertex.py:130` |
| F-05 | Guardrail resolves `AiRuntimeProfile` and the `AiModel` slug tie-break tenant-first, widening to SYSTEM only on absence. New `_model_rank` gives the outer-join miss (`None`) its own rank so it loses to any real row. | `apps/guardrail/core/tenant_config.py:799` |
| F-08 | A DB error now raises `TenantConfigUnavailableError` (503) instead of being negative-cached as "no tenant opinion", which had silently downgraded a stricter tenant to the platform safety floor. | `apps/guardrail/core/tenant_config.py:564` |
| F-06 | Nine token-bypass call sites routed through `peer_service_token()` — including a FIFTH harness site (`temporal/worker.py:314`) absent from the brief, found by an AST sweep rather than by working the list. | `apps/{text,guardrail,nlp,harness}` |
| F-09 | `kwargs.setdefault` block removed; all 11 fields carry explicit `validation_alias` so host env > `secrets_dir` > env file > default applies again. | `apps/nlp/core/config.py` |
| F-10 | Tenant enforcement moved into middleware (text) and header/body cross-check added (nlp, 400 on contradiction). | `apps/text/api/middleware/auth.py`, `apps/nlp/api/tenant.py` |
| F-12 | nlp CORS reads the declared `allow_credentials` and refuses wildcard-plus-credentials at validation, so the misconfiguration cannot boot. | `apps/nlp/app.py:44` |
| F-03/F-13/F-14 | `apps/guardrail/.env.prod` deleted (it described a plane that does not exist, via a variable with no reader); GLiNER/vLLM/llama.cpp blocks removed from `.env.sample` and compose; ~40 dead fields deleted across guardrail/nlp/stt. `pnpm env:sync` re-run; `env:sync --check` green. | multiple |

**Held for Phase 1 (owner decision):** C.2 — removing the hardcoded nlp model ids —
is committed at `4fa3d1f15` on `worktree-agent-a8e1c3f6a1cbc58ca` and deliberately NOT
merged. It makes `/diagnosis/suggestions` fail closed until the gateway resolves a
SECOND `AiTaskDefault` for the suggester's internal NER — a two-model route where only
one selection was ever injected, the second silently filled by a literal. The owner
chose not to dark a clinical route between phases. **The Phase 1 gateway brief must
carry this**, or the resequencing reason is lost.

### Post-merge gate evidence (`dev-2.2`, primary checkout)

| Service | Result |
|---|---|
| text | 1287 passed |
| guardrail | 268 passed |
| nlp | 401 passed (C.2 held) |
| harness | 1549 passed |
| stt | 2844 passed, 1 failed |

The single stt failure is `test_streaming_quality_scorecard` — a latency baseline
calibrated on faster hardware. Proven pre-existing: it fails identically on
`006d883ac`, the pre-Phase-0 base, and the stt diff touches only config, the Foundry
loader and tests — nothing on the streaming path.

Two agent claims that did NOT survive verification, recorded so they are not repeated:
a lane's "15 harness failures are pre-existing" (the base and the merged tree are both
fully green — they were worktree artifacts), and a lane's initial dead-field scan that
produced false positives on `internal_access_token` and `qdrant_api_key`.

## Change History

| Date | Change |
|---|---|
| 2026-08-23 | Ticket opened. Five-lane read-only assessment commissioned across the six Python services plus the TypeScript config control plane. |
| 2026-08-23 | Assessment complete (`assessment.md`) and plan drafted (`plan.md`). Awaiting owner decisions on the three open questions before implementation. |
| 2026-08-23 | Owner decisions D-1 (pull route splits by cardinality: platform=PULL, tenant=PUSH), D-2 (`global-kv` default, `db-config` reserved for values with their own table), D-3 (Phase 0 first) recorded in `plan.md`. |
| 2026-08-23 | Phase 0 implemented across four worktree lanes and merged to `dev-2.2`. Gates re-run post-merge. C.2 held at `4fa3d1f15` for Phase 1 per owner decision. |

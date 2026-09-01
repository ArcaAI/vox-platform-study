# TASK-847 — Workflow Node Contract Extension

| Field | Value |
|---|---|
| **Status** | `Pending` — plan written 2026-09-01, awaiting owner approval before code |
| **Type** | `feature` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track D |
| **Tier / Effort** | `opus` / high (contract design — dual-language, parity-gated); `sonnet` / medium (inspector forms) |
| **Depends on** | TASK-843 ✅, TASK-844 ✅ — **both landed; this is unblocked** |
| **Owns** | `packages/workflow-contract/`, `packages/py-workflow-contract/`, the studio inspector |

## 1. Requirement Analysis

Eight node types with the contracts in the owner's specification. Agent nodes bind to **exactly one** provider
configuration, carry an instruction prompt, generation hyper-parameters, optional guardrail nodes on
input/output, and optional tools. Input/Output nodes carry tenant-defined JSON schemas.

**OD-4 applies:** STT and TTS nodes stay IN the day-1 slice, against the research recommendation to defer
them. That decision moves binary audio transport into scope for TASK-849, and it is why TASK-843 (task
taxonomy) was on the critical path for this track.

## 2. Current State Evaluation

Program finding **F-12**, and **F-11** (do not rebuild the substrate).

50 node types exist, dual-language parity-gated. **Missing: Loop, Data, TTS, and any generic Agent** — Agent
exists only as ~13 fixed-purpose types; STT exists ×8 but all are registry-parity **placeholders** returning
`DEGRADED` (`interpreter/nodes/stt_placeholder.py`).

`temperature` / `maxTokens` / `topP` exist. **`frequency_penalty` / `presence_penalty` do not.**

`WorkflowNodeDescriptor` (`node-registry.ts:41-146`) has **zero tool/MCP fields** — the owner's *"tenant admin
can set some tools for agents to call"* has nowhere to live.

**Already landed and must be built on, not around:** TASK-852 items 3–4 folded `enabled` into
`NODE_RUNTIME_PROPERTIES` with a `mandatory`-class exclusion and a drift gate. TASK-846 delivered the
tenant-scoped `McpServer` registry plus its egress guard, so tool REFERENCES now have a real target.

## 3. Implementation Plan

1. **Add a generic Agent node** whose behaviour is configuration, not type. The ~13 fixed-purpose types stay
   for compatibility; new work targets the generic node. **Do not delete the fixed types in this ticket.**
2. Add **Data** and **Loop** node types; promote **STT** from placeholder to real; add **TTS** (OD-4).
3. Add `frequencyPenalty` and `presencePenalty`. **Gate them by provider capability** — not every provider
   accepts them, and silently dropping a parameter the user set is worse than refusing it.
4. **Tool binding fields — references only.** Coordinate with the TASK-846 registry. This is the single most
   important review item in the ticket: see Risks.
5. **Ceiling vs value.** Platform admin sets ceilings; tenant sets values within them. **vLLM cannot enforce
   per-request ceilings** (`--override-generation-config` sets *defaults*; the caller wins) and per-tenant
   concurrency is not a vLLM concept at all. **Ceilings are enforced in `apps/text` against a tenant → SYSTEM
   descriptor**, never at the engine.
6. **Loop bounds — the owner's spec is missing one.** Ship `max_iterations`, `max_time` **and a
   `max_tokens_total` / cost ceiling**; 50 iterations on a large model is an unbounded invoice. Add a
   no-progress check. **`max_time` must be a workflow timer, never wall-clock** — determinism.
7. **Edge validation, three tiers, and ONLY tier 1 blocks:**
   - **Tier 1 — kind check** (`text|object|audio|flag|stream<…>`), blocking via `isValidConnection`. ~80% of
     errors at zero cost.
   - **Tier 2 — shallow structural** (required props, one level of primitive types): **warning only, never
     blocking.** Skip `oneOf`/`allOf`/patterns entirely. *A validator that cries wolf is the most hated
     feature you can ship.*
   - **Tier 3 — runtime schema validation at node boundaries.** Where correctness actually lives.
   - Escape hatch: when tier 2 warns, offer to insert a **Data node** — which is exactly what it is for.
8. Keep the dual-language parity gate green: TS and Python contract packages change together.

## 4. Verification Criteria

- Node-registry parity test and canonical-JSON fixture test green **in both languages**.
- A graph using every new node type compiles to a valid IR.
- A provider that rejects `presencePenalty` produces a clear validation error, not a silent drop.
- `pnpm --filter @arcaai/workflow-contract test`; `pnpm harness:test` incl. replay-compat.
- **Expect a `registryChecksum()` move.** Adding descriptors or config schema changes the checksum, which
  both seeded definitions stamp. Budget the seed regeneration — and note it takes **two** scripts:
  `regen-arcaai-consultation-workflow-seed.ts` WRITES, while `regen-workflow-definition-seed.ts` only
  **REPORTS drift** and its values are applied by hand. Rebuild `@arcaai/workflow-contract` first, or the
  script reports a false `DRIFT: 0` against a stale `dist/`.

## 5. Risks

| Risk | Mitigation |
|---|---|
| **A node schema stores a model id, endpoint or key in graph JSON** — silently bypassing the tenant→SYSTEM cascade AND BYOK funding derivation | **The single most important review item.** Store REFERENCES only; resolve in the activity; fail closed on a disabled connection. Add a test asserting no resolved credential or endpoint can appear in a compiled graph |
| Over-strict validation makes the editor unusable | Tier 2 warns, never blocks (step 7) |
| Fixed-purpose types and the generic node drift | Generic node is the target for new work; document the deprecation path |
| Checksum move breaks the seed silently | Verification criteria above; both regen scripts, contract rebuilt first |

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Plan written and aligned to TASK-837 §4 and OD-4. Awaiting approval before code. |

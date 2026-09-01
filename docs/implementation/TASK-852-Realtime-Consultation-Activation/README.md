# TASK-852 — Realtime Consultation Activation & Per-Node Capability Toggles

| Field | Value |
|---|---|
| **Status** | `In Progress` — items 3, 4, 7 done; items 1, 2, 5, 6, 8 open |
| **Type** | `feature` / `bugfix` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track F |
| **Tier / Effort** | `opus` / high (items 3–4); `sonnet` / medium (items 1–2, 6–8) |
| **Opened** | 2026-09-01 |
| **Merges** | `f1a046b58` (items 3–4), `b4871f427` (seed regen), `366c5b71d` (item 7) |

> **Process note.** Written RETROSPECTIVELY on 2026-09-01, after items 3/4/7 merged. See
> [TASK-837 §10](../TASK-837-AI-Platform-Consolidation-Program/README.md).

## 1. Requirement Analysis (OD-13)

Realtime clinical consultation with admin-configured realtime transcription, partial summarization and NER
extraction.

**The thesis: do not build a realtime runtime — one exists and is switched off.**

## 2. Current State Evaluation

Program findings **F-21 … F-24**.

**F-21 — the runtime is built, graph-driven, and dark.** TASK-811's `runRealtimeLane`
(`live-documentation.service.ts:1969-1976`; executor `realtime/realtime-executor.ts:208`) executes a
data-defined lane derived from the tenant's published graph (`realtime-lane.ts:186-238`), with
`PLATFORM_REALTIME_LANE` as the platform fallback: stage 0 `capture` → stage 1 `extractEntities` **and**
`realtimeSummary` concurrently, both `onError: 'degrade'`. Entry is
`POST /consultations/:id/recording/start` behind `@RequiresConsent(AI_DOCUMENTATION)`.
**Partial summarization and live NER both already exist.** It is NOT the Temporal interpreter — that
deliberately skips every `lane: 'realtime'` node, so two engines can never write one document.

**Why it is dark:** `consultation.realtime.graphExecutor.enabled` defaults **false**
(`consultation-gates.constants.ts:150`) and **no row for that key is seeded anywhere.**

**F-22 — the per-node toggle was implemented but unreachable.** The executor honoured
`enabled: node.config?.enabled !== false` (`realtime-lane.ts:213`), but `enabled` was not a declared property
of any node config schema, and every schema is `additionalProperties: false`.

**F-23 — the Pipeline Policy UI misled admins.** `autoNerEnabled`/`autoSummaryEnabled` have a real cascade
and a real UI but are consumed **only by the post-consultation pipeline**. `LiveDocumentationService` has
**zero** references to them across 3,567 lines. **Turning "Auto-NER" off did not stop live entity extraction.**

**F-24 — the C-8 undercount.** `exposure-palette-policy.ts` cites "four of thirteen" consultation nodes as
`externalWrite`; the palette has grown to **31** descriptors, **11** of them `externalWrite`.

## 3. Implementation Plan

| # | Change | Kind | Days | Status |
|---|---|---|---|---|
| 1 | Set `consultation.realtime.graphExecutor.enabled = true` at tenant scope via the existing registry write route | [exists] | 0.25 | ⬜ **OPEN** — live-tenant runtime action |
| 2 | Land the `WorkflowAssignment` rows (the substrate-exclusivity gate now passes; TASK-798's README claim that it is false is STALE) | [wire-up] | 0.5 | ⬜ **OPEN** |
| 3 | Declare `enabled` in `NODE_RUNTIME_PROPERTIES`, **excluding mandatory nodes** | [build] | 0.75 | ✅ `f1a046b58` |
| 4 | Honour `enabled` in `_dispatch_node` as `reason="disabled_by_config"` | [build] | 0.5 | ✅ `f1a046b58` |
| 5 | Seed `agent.important_findings` into both ArcaAI graphs, prompt bound to a SYSTEM template | [build] | 1.0 | ⬜ **OPEN** |
| 6 | "Realtime capabilities" read-out API (lane source, definition slug+version, per-node enabled) | [build] | 1.5 | ⬜ **OPEN** |
| 7 | Stop the console misleading admins (F-23) | [build] | 0.5 | ✅ `366c5b71d` |
| 8 | One live end-to-end session, then flip one node off and re-record | [wire-up] | 1.0 | ⬜ **OPEN** |

**Items 3 and 4 must ship together** — a toggle honoured by one runtime and ignored by the other is worse
than no toggle. They did.

## 4. Implementation Summary (items 3, 4, 7)

**Items 3–4.** `enabled: {type:'boolean', default:true}` folded into `NODE_RUNTIME_PROPERTIES`; a
`SKIPPED`/`reason="disabled_by_config"` branch added to `_dispatch_node`, placed after the `realtime_lane`
check so exactly one runtime speaks for any node.

**Mandatory-node exclusion** used the registry class `mandatory` — the same class `rule-catalogue.ts` already
uses for *"nothing routes around a gate"* — not a hardcoded name list. `enabled: false` on such a node **is**
that routing-around by another means. Yields 13 node types (a principled superset of the 6 required), and it
is **drift-gated**: a test asserts the withheld set equals the set derived from the registry. `critical` was
rejected as the discriminator: it does not cover `captureBinding`, `phiHop`, `persistDraft` or
`finalizeAssurance`.

**Determinism:** `if node.config.get("enabled") is False:` — a pure read of an already-deserialised
`CompiledNode`. `is False`, never truthiness, so absent means ENABLED and `"false"`/`0` are malformed rather
than "off". A test monkeypatches `workflow.execute_activity`, `workflow.now` and `workflow.random` to raise,
proving the skip returns before touching any Temporal API. Replay-compat green.

**Item 7.** Pipeline Policy retitled → **`Pipeline Policy (Post-Consultation)`** with a pinned banner; five
genuinely-unread `feature-flags` rows marked **Advisory**. Two of the seven keys were **correctly excluded**
because they ARE read: `enable-consultation-sharing` (`consultation.controller.ts:243`) and
`enable-local-raw-capture` (`my-tenant.controller.ts:77,165`). Also found: the SDK constant is
`enable-real-time-transcription` while the seeded key is `enable-transcription` — **doubly disconnected**.

**Consequential side effect.** Declaring `enabled` moved `registryChecksum()`, which hashes every descriptor
including its `configSchema`. Both seeded definitions stamp that checksum, so both drifted. Regenerated in
`b4871f427` — and the handoff named only one of the two regen scripts; `21-workflow-definition.ts` is
drift-**reported**, not written, and its two recomputed values were applied by hand. A first run also
reported a false `DRIFT: 0` against a stale `dist/`; rebuilding `@arcaai/workflow-contract` flipped it to
`DRIFT: 2`. Both now report `DRIFT: 0`.

**Evidence** — workflow-contract 1094 passed; harness 1745 passed incl. 19 replay-compat; admin-console
2224 passed with 4 new axe scans at 0 violations; seed tests 35/35.

## 5. Safe invocation — why no new entry point is needed

The session-bound entry point exists and breaks **every link** of the C-8 chain that keeps `consultation` out
of `EXPOSURE_ALLOWED_PALETTES`:

| C-8 on `/workflows/:slug/invoke` | The recording path |
|---|---|
| `consultationId` from caller-controlled `dto.input` | A **PATH param**, re-resolved by `verifyConsultationOwnership` + `@TenantOwnedResource`, then **frozen** into the session |
| `sandbox: false`, so external-write suppression never fires | The realtime executor **dispatches no Temporal activity at all** — in-process closures over the frozen session. No payload to trust |
| `consultation.persistDraft` reaches the shared activity | `persistDraft` is `lane: 'durable'`, not among the 7 realtime handlers; `buildRealtimeLane` filters it out. **Structurally unreachable** |
| API-key reachable; `paletteKey` is free text | Clinical route behind `UnifiedAuthGuard` + abilities + `@RequiresConsent`. The graph comes from the server-side `WorkflowAssignment` cascade |

**Invariant to preserve:** *consultation identity comes from the URL and is re-resolved against the caller's
tenant — never from a caller-composed payload.* **Do not lift `EXPOSURE_ALLOWED_PALETTES`.**

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-01 | OD-13: activate the existing runtime, do not build one. Core 2.0 engineer-days, full slice 6.0. |
| 2026-09-01 | Items 3–4 merged (`f1a046b58`); seed regenerated (`b4871f427`); item 7 merged (`366c5b71d`). |
| 2026-09-01 | README written retrospectively. Items 1, 2, 5, 6, 8 remain OPEN. |

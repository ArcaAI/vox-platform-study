# TASK-852 — Realtime Consultation Activation & Per-Node Capability Toggles

| Field | Value |
|---|---|
| **Status** | `In Progress` — items 2, 3, 4, 5, 6, 7 done; items **1 and 8 open** (both need a live gateway; 8 needs a real recording) |
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
| 1 | Set `consultation.realtime.graphExecutor.enabled = true` at tenant scope via the existing registry write route | [exists] | 0.25 | ⬜ **OPEN** — live-tenant runtime action; the exact call is in §4.3 |
| 2 | Land the `WorkflowAssignment` rows (the substrate-exclusivity gate now passes; TASK-798's README claim that it is false is STALE) | [wire-up] | 0.5 | ✅ **DONE** — rows landed; resolver proven; `safe` exclusion re-decided |
| 3 | Declare `enabled` in `NODE_RUNTIME_PROPERTIES`, **excluding mandatory nodes** | [build] | 0.75 | ✅ `f1a046b58` |
| 4 | Honour `enabled` in `_dispatch_node` as `reason="disabled_by_config"` | [build] | 0.5 | ✅ `f1a046b58` |
| 5 | Seed `agent.important_findings` into both ArcaAI graphs, prompt bound to a SYSTEM template | [build] | 1.0 | ✅ **ALREADY DONE** — verified complete, TASK-815/821 shipped it; no change needed (§4.2) |
| 6 | "Realtime capabilities" read-out API (lane source, definition slug+version, per-node enabled) | [build] | 1.5 | ✅ **DONE** — `GET /admin/harness/live/capabilities` |
| 7 | Stop the console misleading admins (F-23) | [build] | 0.5 | ✅ `366c5b71d` |
| 8 | One live end-to-end session, then flip one node off and re-record | [wire-up] | 1.0 | ⬜ **OPEN** — needs a live gateway and a real recording |

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

---

## 4.1 Item 2 — the rows are landed, and the RESOLVER proves it

**The gate probe passes.** `detectSubstrateExclusivityGate()` returns `present: true` with **11**
executable references, led by `import { tenantWorkflowGoverns } from '../governing-engine'` and
`standDownForTenantWorkflow(...)`. TASK-798's README claim that the flag is false is confirmed STALE.
`CONSULTATION_ASSIGNMENT_ENABLED` is therefore already `true`, and the seed already wrote both rows —
verified in the live dev DB as `ENABLED`, one `TENANT`-scope and one `DEPARTMENT`-scope
(`arcaai-consultation-soap` / `arcaai-rheum-consultation-soap`, tenant `50000000-…001`).

**Landing a row is not the claim worth testing.** The failure that matters here is SILENT: if the
assignment fails to resolve — wrong slug, unpublished, cross-tenant, or a definition contributing no
realtime nodes — `resolveTenantLane` returns null and the session quietly serves
`PLATFORM_REALTIME_LANE`. A note is still produced, so "my published graph governs consultations" and
"my published graph governs nothing" are indistinguishable from outside. Asserting the seed file's
CONTENTS would prove a row was authored and nothing more.

So `live-documentation.realtime-capabilities.task852.test.ts` drives the REAL chain —
`WorkflowAssignment` cascade → `findPublishedBySlug` → `buildRealtimeLane` — over the REAL committed
compiled config, imported from `packages/database` by computed path (the mirror of what
`task-821-realtime-lane-seeding.test.ts` already does in reverse, and for the same stated reason).
It resolves `source: 'tenant-graph'`, slug `arcaai-consultation-soap`, version 1, and exactly the five
realtime node types the graph authors — `consultation.captureBinding`, `consultation.extractEntities`,
`consultation.realtimeSummary`, `agent.grammar`, `agent.important_findings` — with
`consultation.persistDraft` asserted ABSENT, since that node in both engines is the two-writers-one-
document hazard. A department override resolves the rheumatology graph instead, so the cascade is real
rather than a first-match.

**The `safe`/day-1 exclusion set, re-decided: `23-arcaai-workflow-authoring` STAYS excluded.** The gate
passing makes the rows landable in a DEMO database; it does not make them shippable everywhere. They
carry `createdBy: <the ArcaAI tenant admin>` and publish a CLINICAL workflow under that attribution —
a fabricated governance act in a real environment. Two further reasons, each sufficient alone: every
row is scoped to a CUSTOMER tenant (`50000000-…`), which is not platform configuration; and `createdBy`
plus the department override reference rows a `safe` run does not create, so they would land with
dangling authorship. `21-workflow-definition` (SYSTEM-owned) stays INCLUDED — that is the platform
default a `safe` bootstrap needs so an unassigned tenant still resolves a lane.

Two of the seven deny-list entries were in the array but missing from the docstring's reason table,
while `seed-mode.test.ts` told readers to *"see `seed-mode.ts`'s table for the full reasoning"* — a
cross-reference that did not resolve. Table completed, and an **exact-set gate** added: every prior
assertion was one-way (`toContain`), catching only a demo phase that ESCAPED the list. The opposite
mistake is quieter and worse — a platform-config phase excluded by reflex leaves a production `safe`
bootstrap silently missing configuration.

## 4.2 Item 5 — VERIFIED COMPLETE BEFORE ANY CHANGE; nothing was needed

The brief asked whether `agent.important_findings` is genuinely ACTIVE or merely present. **It is
active, end to end, in both graphs.** Reported before touching anything, and nothing was touched:

| Link | Evidence |
|---|---|
| Present in both graphs | Node `n_findings`, compiled stage 4, in `arcaai-consultation-soap` AND `arcaai-rheum-consultation-soap` |
| Prompt bound | `config.promptTemplateId = 71000000-…041`, `taskKey: text.live` |
| That template EXISTS and is usable | SYSTEM tenant, *"Important Findings Extraction (platform default)"*, `category: SYSTEM`, `scope: TENANT_DEFAULT`, `status: APPROVED`, `approvedVersionNumber: 1` |
| Source is the transcript, not the note | Bound `in` ← `n_capture.out`; TASK-815's guard also asserts no generation node feeds it |
| Handler is real, not a stub | `ImportantFindingsHandler` → `extractImportantFindings` posts to TEXT `/api/v1/generate` with the resolved prompt and parses the response |
| Prompt resolution fails CLOSED | `resolveGovernedNodePrompt` throws on unbound / not-found / not-APPROVED / empty; the executor degrades it visibly rather than substituting a literal |
| Output reaches the clinician | Lane outcome → `groundEntitiesToNote` → payload `findings` (omitted when empty) → `reanchorAnnotations` per section → PHI-safe `findingCount` in stats |
| Guarded against regression | `task-815-lane-n-finalization-chain.test.ts` pins node + prompt binding + edge in both graphs; `task-821` pins its admission into the realtime lane at stage 1 |

**TASK-806 §8's *"no important-information highlighted layer exists anywhere"* is STALE** — it was
closed by TASK-815 (capability + seeding) and TASK-821 (lane admission). Item 5 required no code.

## 4.3 Item 6 — `GET /api/v1/admin/harness/live/capabilities`

Everything it reports already existed and none of it was readable: lane source, definition
slug/version and per-node enabled state were computed at `start()` and written to ONE log line.
Activation was therefore unobservable.

**It resolves; it does not describe.** `getRealtimeCapabilities(tenantId, departmentId?)` calls the
SAME two methods `ensureLaneResolved` calls for a real session. To make that literally true rather
than approximately, `ensureLaneResolved` was split into `isGraphExecutorEnabled` +
`resolveTenantLane`, which the read-out then calls — nothing is restated from a constant or a
catalogue, so the read-out cannot report a lane the runtime would not execute.

`resolveTenantLane` now also returns the assignment's SOURCE, because the tier consulted and the lane
produced answer different questions and can disagree: a tenant assignment pointing at a definition
with no realtime nodes resolves `tenant` + `platform-default`, which is precisely the silent
misconfiguration this read-out exists to surface.

Three honest answers:

| State | Reported |
|---|---|
| Graph executor OFF | `laneSource: null`, `nodes: []` — there IS no lane; the legacy flush runs |
| ON, no resolvable assignment | `platform-default`, null slug, and the platform lane's own three nodes, because those genuinely execute |
| ON + assignment | `tenant-graph`, slug + version, and the tenant's realtime nodes |

Per node: `nodeId`, `type`, `canonicalType` (so an `agent.ner` alias and its canonical form are not
counted as two capabilities), `stageIndex`, `enabled`, `togglable`, `onError`, `timeoutMs`,
`maxAttempts`. **`togglable` is DERIVED from `NODE_CONFIG_SCHEMAS`** — the artifact that actually
decides it — never from a restated mandatory-node list: every schema is `additionalProperties: false`,
so a type without the property cannot be authored with one, and showing it as togglable would
advertise a switch the publish-time validator rejects.

Placed beside `live/sessions` and `live/config`, gated identically (`@Authorize(['read',
'HarnessWorkflow'])` + `resolveReadTenantId`), so a tenant admin is pinned to its own tenant.

**Item 1 — the exact call the orchestrator still owes.** Confirmed by query: there is NO
`consultation.realtime.graphExecutor.enabled` row anywhere (`GlobalSetting` holds only
`consultation.ocr.enabled`), so the code default `false` is live and the whole path is still dark.
The descriptor is `tier: 'global-kv'`, `maxScope: 'tenant'`, `editableBy: 'GlobalSetting'`:

```
GET  /api/v1/admin/settings/registry/consultation.realtime.graphExecutor.enabled?scope=tenant  → ETag
PUT  /api/v1/admin/settings/registry/consultation.realtime.graphExecutor.enabled
     If-Match: <that ETag>          X-Tenant-Id: 50000000-0000-0000-0000-000000000001
     { "value": true, "scope": "tenant" }
```

`scope: 'tenant'` is load-bearing — omitting it defaults to `system` and echoes the platform row's
version, which returns 412. After the write, `GET /admin/harness/live/capabilities` must report
`graphExecutorEnabled: true` and `laneSource: 'tenant-graph'`; that is item 8's entry condition.

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
| 2026-09-02 | **Item 5 closed with NO code change** — verified complete before touching anything. `agent.important_findings` is active in both graphs, bound to the APPROVED SYSTEM template `71000000-…041`, backed by a real TEXT call, surfaced on the payload as `findings`, and guarded by TASK-815 + TASK-821. TASK-806 §8's "no important-information highlighted layer exists anywhere" is STALE. See §4.2. |
| 2026-09-02 | **Item 2 closed.** The gate probe returns `present: true` with 11 executable refs, so the rows were already seeded and are `ENABLED` in the dev DB. Added the missing proof that they RESOLVE: a test driving the real assignment cascade → `findPublishedBySlug` → `buildRealtimeLane` over the real committed compiled config, asserting `tenant-graph` rather than the silent `PLATFORM_REALTIME_LANE` fallback. `23-arcaai-workflow-authoring` deliberately STAYS excluded from `safe` (fabricated governance attribution); the deny-list's reason table was completed and pinned to an exact set. See §4.1. |
| 2026-09-02 | **Item 6 closed.** `GET /api/v1/admin/harness/live/capabilities`. `ensureLaneResolved` split into `isGraphExecutorEnabled` + `resolveTenantLane` so the read-out resolves through the SAME path a session does; `resolveTenantLane` now also returns the assignment source, so a `tenant` assignment yielding a `platform-default` lane is visible. All five API artifacts regenerated, three `:check` gates green. See §4.3. |
| 2026-09-02 | Items **1 and 8 remain OPEN** and are the orchestrator's: both need a live gateway, and item 8 needs a real recording session. The exact registry write for item 1 is in §4.3 — note `scope: "tenant"` is required or the `If-Match` echoes the platform row and returns 412. |

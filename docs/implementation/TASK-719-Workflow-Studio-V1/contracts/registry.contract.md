# Registry contract (TASK-719 Task 3 — re-derived 2026-08-16, TASK-734 pass)

**Supersedes the original 2026-08-16 (commit `718533453`) version of this file.** That version
was written before TASK-734 ("workflow substrate second pass") landed the registry endpoint;
this pass re-derives against the now-DELIVERED code on `feat/loop` at HEAD `3c6505a68`. The
original "NOT YET DELIVERED" verdict text is preserved below the line for history — do not read
it as current.

## Verdict: DELIVERED — read-only, and today it is EMPTY of palette content

`GET /api/v1/admin/workflow-nodes` is real:

| Concern | file:line |
|---|---|
| Controller | `apps/api/src/modules/workflow-node/workflow-node.controller.ts:21-35` — `@Controller('admin/workflow-nodes')`, class-level `@CanRead('WorkflowDefinition')` (read-only gate, not `manage` — comment at `:13-16` explains why: registry metadata has no `ResourceType` of its own) |
| Service method | `WorkflowDefinitionService.listNodes()` (`packages/applications/src/services/workflow-definition/workflow-definition.service.ts:330-338`) — sorts `WORKFLOW_NODE_REGISTRY` by `key`, maps each descriptor through `WorkflowDefinitionDtoMapper.toNodeResponse`, returns `{ nodes, registryChecksum }` |
| Response DTO | `packages/applications/src/services/workflow-definition/dto/workflow-node.response.ts:10-48` — `WorkflowNodeResponse` + `WorkflowNodeRegistryResponse` |
| Source of truth | `packages/workflow-contract/src/node-registry.ts:44-104` — `WorkflowNodeDescriptor` + `WORKFLOW_NODE_REGISTRY` (zero-runtime-deps package; TASK-734 placed it here, not at TASK-715's originally-planned `packages/applications/src/services/workflow-registry/` — see that file's header comment) |

## The delivered response shape

```ts
interface WorkflowNodeResponse {
  type: string;                    // note: DTO field name is `type`, registry's own field is `key` — same value, renamed at the mapper
  implemented: boolean;            // false = observable, non-executable placeholder — never dropped from the list
  activityName: string;            // Temporal activity name the compiler stamps into compiledConfig
  classes: string[];               // open SET, e.g. ['mandatory'] — confirms the R3/original-contract prediction below
  paletteKey: string | null;
  critical: boolean;               // code-owned, never tenant-configurable
  externalWrite: boolean;          // code-owned, never tenant-configurable
  defaultTimeoutSeconds: number;
  defaultMaxAttempts: number;
  entitlementKey: string | null;
}
interface WorkflowNodeRegistryResponse {
  nodes: WorkflowNodeResponse[];
  registryChecksum: string;        // sha256, descriptors sorted by key — compared against a published definition's stamped registryChecksum to detect drift
}
```

## What changed vs. the original contract's predictions

| Original prediction | Delivered reality |
|---|---|
| `classesOf`-shaped open class SET, not a `safetyClass` enum | **Confirmed exactly.** `classes: string[]` on the DTO (`workflow-node.response.ts:21`); `'mandatory'` membership is how the canvas composite (`packages/ui/src/components/workflow-canvas/types.ts:26-28`) already reads it — Task 5's `safetyClasses: readonly string[]` choice needs no rework |
| `entitlementKey` "zero delivered precedent" | **Now delivered.** `entitlementKey: string | null` (`workflow-node.response.ts:38-39`) |
| Per-type config JSON Schema "not present anywhere" | **STILL not present — re-confirmed against the real, delivered DTO, not just the compiler package.** `WorkflowNodeResponse` has no `configSchema`/`schema` field at all (`workflow-node.response.ts:10-40`, exhaustive list above). `WorkflowNodeDescriptor` in `node-registry.ts:44-72` likewise carries no schema field. This is not a gap in *transport* — the registry genuinely has nowhere it stores a schema today |
| Port/handle shape per node type | **Still not present.** Ports stay a graph-document-level concern (`WorkflowGraphEdge.fromPort`/`toPort` are free strings — `graph-model.ts:18-24`); no node-type descriptor declares how many ports it has or whether they're typed |
| `label`/human-readable name per node type | **Not present.** Neither `WorkflowNodeDescriptor` nor `WorkflowNodeResponse` has a `label`. The Studio must derive a display label from `type`/`key` (e.g. humanize the key, same helper `schema-form.ts`'s `humanizeKey` already implements) until/unless TASK-720 adds one |
| Node id grammar | Unchanged: `WORKFLOW_NODE_ID_PATTERN = /^[a-z0-9_]{2,48}$/` (`graph-model.ts:33`), now also used directly by `CreateWorkflowDefinitionRequest.slug` (`create-workflow-definition.request.ts:19-22`, "mirrors" comment) |

## The registry is real but EMPTY of palette content (TASK-720 not landed)

`WORKFLOW_NODE_REGISTRY` (`node-registry.ts:79-104`) ships exactly two entries, both
palette-agnostic utility nodes with no safety classes and no entitlement gate:

| `type` | `implemented` | `classes` | `paletteKey` | `entitlementKey` |
|---|---|---|---|---|
| `noop` | `true` | `[]` | `null` | `null` |
| `passthrough` | `true` | `[]` | `null` | `null` |

The module docstring (`node-registry.ts:74-78`) states this is deliberate: "both intentionally
ship ONLY `noop`/`passthrough` in this pass; TASK-720 adds the five summarization-palette node
types to both sides together" (both = this TS registry and `apps/harness/.../registry.py`, kept
in parity by `__tests__/node-registry-parity.test.ts` + a committed fixture — see that file's
header). **Studio v1's documented "zero hard-coded node types; palette rail renders its empty
state if TASK-720 has not landed" (README §1) is therefore the ACTIVE state today, not a
hypothetical.** The palette rail (Task 12) and inspector (Task 9) must be built and tested
against both (a) this real two-entry registry (neither entry has a `configSchema` to render a
form from — see below) and (b) richer fixture registries shaped to what TASK-720 will add, so
neither component needs rework when that ticket lands.

## Consequence for Task 9 (inspector) — a real, structural gap, not a session-scoped one

Because no delivered node-type descriptor carries a config schema, **the schema→form compiler
(`schema-form.ts`, Task 8, already built) has no real schema to compile against for any node
type the live registry serves today.** The inspector (Task 9) must therefore treat "this node
type has no known config schema" as a first-class, always-possible state — not an edge case —
and fall back to the raw `CodeEditor` over `node.config` directly (the same `raw-json`
degradation Task 8 already uses for an unrepresentable subtree, generalized to "no schema at
all" rather than "schema present but not representable"). A `configSchema` prop on the inspector
is therefore `JsonSchema | undefined`, not `JsonSchema`.

Where does a per-node config schema come from, going forward? Two possibilities, neither
resolvable from delivered code, carried to README §6:

1. TASK-720 adds a `configSchema` field to `WorkflowNodeDescriptor`/`WorkflowNodeResponse` when
   it adds real palette node types (the natural reading of "TASK-720 populates it").
2. The Studio maintains its own node-type → schema mapping client-side, keyed by `type`, as a
   temporary bridge — rejected as a design choice here because it would create exactly the
   second-implementation-that-drifts problem `@arcaai/json-schema-subset`'s README exists to
   prevent, this time for the SOURCE of schemas rather than their evaluation.

## Consequence for Studio v1's build order (updated)

Task 10 (API client) is now written against a REAL, verified route (`GET
admin/workflow-nodes`), not an assumption — see `definition-api.contract.md`. It CAN be
exercised against a live gateway once local infra + the app are both up; that live round-trip
was not exercised in this session (see README §7's "Gated / not run"). The palette rail (Task
12) renders the real two-entry registry correctly today (both entries `paletteKey: null`, so
they render in an "ungrouped/utility" bucket, not under any named palette) and its documented
empty state applies to the **paletteKey-grouped** view being empty, not to the API call
failing.

## Open question carried to §6

Where a per-node-type config JSON Schema will live (registry field vs. a separate lookup) is
unresolved — see "Consequence for Task 9" above. Recorded as an open question, not guessed.

---

## Superseded original text (2026-08-16, commit `718533453`) — history only

<details>
<summary>Original "NOT YET DELIVERED" verdict, kept for the record</summary>

`packages/applications/src/services/workflow-registry/` — the location TASK-715's own README
named for it — did not exist at that commit. `find packages/applications/src -iname
"*workflow*"` returned nothing; `find apps/api/src -iname "*workflow*"` returned only an
unrelated harness DTO. `packages/workflow-contract/src/predicates/context.ts` independently
confirmed the gap from the consumer side ("the registry itself is code-owned… not yet built at
the time this package was authored"). All of that is now stale — see the verdict above.

</details>

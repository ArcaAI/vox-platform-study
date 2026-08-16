# Registry contract (TASK-719 Task 3)

Re-derived against the live tree on `feat/loop` at commit `718533453` (2026-08-16). Per
README §3.3/R3: every claim below cites the `file:line` it was derived from, and every gap is
recorded as a gap rather than invented.

## Verdict: NOT YET DELIVERED

`packages/applications/src/services/workflow-registry/` — the location TASK-715's own README
names for it (`docs/implementation/TASK-715-Workflow-Definition-Model/README.md` §3.2,
"Recommendation: code module served via API… lives at
`packages/applications/src/services/workflow-registry/`, is assembled by
`WORKFLOW_NODE_REGISTRY`, and is served read-only at `GET /api/v1/admin/workflow-nodes`") —
**does not exist**. Verified: `find packages/applications/src -iname "*workflow*"` returns
nothing; `find apps/api/src -iname "*workflow*"` returns only
`apps/api/src/modules/harness-admin/dto/workflow-action.request.ts`, an unrelated harness
action DTO. TASK-715's own status line confirms this: "Phase A — Database — done; Phases B–F
not started" (`TASK-715…/README.md` header table).

`packages/workflow-contract/src/predicates/context.ts:16-24` independently confirms the same
gap from the consumer side — the compiler/validator engine depends on the registry only
through an **interface**, `WorkflowNodeClassLookup` / `WorkflowEvaluationContext`, with the
comment "the registry itself is code-owned (TASK-715's `WORKFLOW_NODE_REGISTRY`, **not yet
built** at the time this package was authored)".

## What IS derivable today — the shape the registry must eventually satisfy

Nothing below is a delivered registry. It is the *contract surface* the delivered compiler
package already depends on, which any future registry module must satisfy, cited by
`file:line`:

| Concern | Derived from | Shape |
|---|---|---|
| Node type identity | `packages/workflow-contract/src/graph-model.ts:12-16` (`WorkflowGraphNode`) | `type: string` — a free string at the graph-document level; the registry is what turns a `type` into something validated |
| Node id grammar | `graph-model.ts:31` | `WORKFLOW_NODE_ID_PATTERN = /^[a-z0-9_]{2,48}$/`, "mirrors `AGENT_KIND_KEY_PATTERN`" |
| Node "safety"/behavior tagging | `packages/workflow-contract/src/predicates/context.ts:18-19` | **`classesOf(nodeType): readonly string[]`** — an open SET of string classes per node type (example given: `['phiBearing', 'mandatory']`), **not** a single `safetyClass: 'mandatory' \| 'locked' \| 'optional'` enum field |
| Palette membership | `context.ts:20` | `paletteOf(nodeType): string \| undefined` |
| Per-type config schema | Not present anywhere in `@arcaai/workflow-contract` or the Prisma model | **No delivered code declares a config-schema shape for a node type.** `workflow-contract`'s `WF-C-*` schema-class rules (the ones that would need it) are explicitly NOT implemented in this package — see `rule-catalogue.ts:19-24`, "SCOPE NOTE" |
| Port/handle shape | `graph-model.ts:18-24` (`WorkflowGraphEdge`) | Edges carry `fromPort`/`toPort` as free strings on the *graph document* side; no delivered code declares, per node type, how many ports exist or whether they are typed |
| Entitlement gate | Not present in `@arcaai/workflow-contract`; the *pattern* for it is documented at `docs/implementation/TASK-715-.../README.md` §2.8 (entitlement gating is column-per-key via `ResolvedFeatures`, and §3.2 point 1: "returns every node type with an `available: boolean` + `gatedBy` field rather than silently omitting gated ones") | Plan text only — no `entitlementKey` field exists on any delivered type |

## Divergence from this ticket's own plan (§2, §4 Task 3 wording) — recorded, not silently reconciled

The README's Task 3 approach text assumes the registry descriptor carries
`safetyClass: 'mandatory' | 'locked' | 'optional'`. **The one piece of the registry contract
that IS derivable from delivered code (`WorkflowNodeClassLookup.classesOf`, above) models this
as an open multi-membership class SET, not a closed three-value enum.** This is exactly the
kind of registry/report-shape mismatch R3 anticipates. Consequence for this ticket's build
(recorded here per the Task 3 "Approach" instruction, not resolved unilaterally):

- The palette rail (Task 12) and the graph store (Task 11) are written against a
  **`safetyClasses: readonly string[]`**-shaped field (containing values such as `'mandatory'`)
  rather than a single `safetyClass` enum, so they compose with `classesOf()` once a real
  registry lands, instead of requiring a second reconciliation ticket. A node is "mandatory"
  iff `'mandatory'` is a member of its classes — this is a strict generalization of the
  three-value enum the plan assumed (an enum is representable as a same-shaped one-element
  set), so nothing downstream regresses if the eventual registry narrows back to three fixed
  values.
- `entitlementKey` and the per-type config JSON Schema have **zero delivered precedent**.
  Studio v1's registry-consuming code (palette rail, inspector form generator) is written
  against a local `WorkflowNodeDescriptor` TypeScript type (defined in this ticket's own
  `api/types.ts`, Task 10) that is a superset of what's provable today — `entitlementKey?:
  string`, `configSchema: JsonSchema` — and is explicitly documented in that file as
  **provisional, to be reconciled against the real endpoint once TASK-715 Phases B–F ship**,
  per the file's own header comment (Task 10 obligation).

## Consequence for Studio v1's build order

Because no registry endpoint exists, **Studio v1 cannot fetch real node types today.** Task 10
(API client) can and does define the request shape (`GET /api/v1/admin/workflow-nodes`,
following the `settings-catalog` precedent at
`apps/api/src/modules/settings-catalog/settings-catalog.controller.ts:24,31`) and the
TanStack Query hook, but the hook cannot be exercised against a live server in this session —
LOCAL INFRA IS DOWN (Postgres/API), and even with infra up there is no controller to call. The
palette rail (Task 12) and inspector (Task 9) are therefore built and unit-tested against
**fixture** registry responses shaped to this contract, and render their documented empty
state — "Studio v1 renders whatever node types the registry serves… if TASK-720 has not
landed, the palette rail renders its empty state" (README §1) — when the fetch 404s/fails, so
the UI degrades correctly against the real gap rather than assuming a shape.

## Open question carried to §6

Whether the eventual registry exposes `classesOf` results as an array on each descriptor
(`classes: string[]`) or the Studio must derive it by calling a `classesOf`-shaped predicate
per node is a TASK-715 Phase B design decision, not this ticket's to make. Recorded as an open
question rather than guessed.

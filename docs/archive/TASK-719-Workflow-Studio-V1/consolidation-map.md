# Consolidation map (TASK-719 Task 17)

Re-derived 2026-08-16 against the live tree (`feat/loop`, post-Phase-D). Per README §4 Task 17,
the test for whether a row folds is: **does the Studio own that backend resource at v1?** A
screen whose resource the Studio does not yet write cannot fold — folding it would leave the
resource with no authoritative editor (rule 13's one-authoritative-editor rule).

| Existing screen/route | Feature module | Backend resource it writes | Studio home | Fold wave | Retirement action |
|---|---|---|---|---|---|
| `/harness/pipeline-policy` (tier 30-49, `nav-config.ts`) | `features/pipeline-policy/` — `pipeline-policy-screen.tsx`, `scope-row-editor.tsx`, `cascade.ts` | `PipelinePolicy` rows, cascade `SYSTEM → TENANT → DEPARTMENT → DOCTOR` | Would be a definition-level settings surface once the registry models pipeline toggles as node/definition config | **DOES NOT FOLD in v1** | No action. `WORKFLOW_NODE_REGISTRY` (`packages/workflow-contract/src/node-registry.ts`) ships exactly `noop`/`passthrough` today — no node type carries a `PipelinePolicy`-shaped config field, so there is nothing in the Studio's `WorkflowDefinition.graph` for a pipeline-policy toggle to become. Folding now would delete the only working editor for a resource the Studio cannot yet express. Re-evaluate once TASK-720 (or a successor) adds palette node types whose config schema covers the cascade's scope levels. |
| `/departments` prompt-config panel (tier 30-49) | `features/departments/components/department-prompt-config-panel.tsx` | `PATCH admin/departments/:id/prompt-config` (`departments/api/client.ts:69-70`) | Out of scope for v1 per the ticket's own §2 "Explicitly OUT of scope" table (per-department workflow assignment = TASK-733) | **DOES NOT FOLD** | Task 19 would demote it to a read-only summary + a plain-href deep link to the Studio — **NOT executed this session** (see below). Full ownership transfer is TASK-733's, not this ticket's. |
| `/agentic-policy` loop settings (tier **10-19**, `['manage','all']`) | `features/agentic-policy/` — `agentic-knobs.ts`, `live-engine-tab.tsx` | `harness/policy/global`, `harness/live/config` (rule 13 §Routing: "`/agentic-policy` owns `harness/policy/global` + `harness/live/config`") | N/A this ticket | **HUMAN-GATED — does not fold** | No action taken. Folding would move a **tier 10-19 global-admin-only** control into **tier 30-49 tenant** reach — a privilege change (R2/`00-project-context.md` "global-admin-only is a deliberate, documented exception… that needs an owner decision"), not a UI move. This ticket's orchestrator instructions confirmed the gate remains: "DECISION #11 REMAINS GATED… Do NOT perform that fold-in." A product/security decision is still required on whether any of those knobs may become tenant-settable (likely as an entitlement ceiling, never a plain move). |
| `/prompt-templates` (tier 30-49) | `features/agents/components/prompt-templates-screen.tsx` | `admin/prompt-templates` | **Never folds** — design.md is explicit: prompt templates keep their own authoritative editor | **NEVER FOLDS** | Task 19 would give the Studio's node inspector a `PromptTemplatePicker` that lists templates through the SAME `admin/prompt-templates` endpoint the console already calls, plus a plain `href` deep link to `/prompt-templates` — no cross-feature import (rule 13). **NOT executed this session** — no `prompt-template-picker.tsx` exists yet. |

## Verdict

**No fold executes in this pass.** Every candidate row is either gated by an owner decision
(`/agentic-policy`), blocked on upstream substance the registry does not yet have
(`/harness/pipeline-policy`), explicitly out of this ticket's scope (`/departments`, deferred to
TASK-733), or never eligible by design (`/prompt-templates`). This matches the README's own
"Expected outcome" list under Task 17 — re-verified here against the ACTUAL Task-3-updated
registry contract, not assumed.

Task 18 (fold pipeline policy + retire its route) is therefore **not executed** — its own
precondition ("gated on Task 17's verdict for this row") resolves to "does not fold". No
`redirect()` page is added for `/harness/pipeline-policy`; the route and its feature module are
untouched.

Task 19 (demote the department prompt-config panel; add the prompt-template picker) — **NOT
executed in this session either**, for the same reason Phase D's autosave-metadata wiring
(name/description) was not completed: session time did not extend to it. `department-prompt-
config-panel.tsx` still has no reciprocal link to the Studio, and no `prompt-template-picker.tsx`
exists yet. Recorded honestly here rather than claimed done — see README §7.

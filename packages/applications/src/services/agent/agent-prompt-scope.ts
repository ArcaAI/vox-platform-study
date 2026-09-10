/**
 * TASK-890 §3.3 — the ONE render scope every TypeScript prompt renderer builds.
 *
 * The grammar lives in `@arcaai/workflow-contract` (`renderTemplate`); this is the VOCABULARY
 * that grammar resolves against, so the same agent instruction means the same thing on the
 * realtime `core.agent` lane, on `POST /agents/:slug/invocations`, and — through the
 * hand-written mirror `_prompt_scope` in
 * `apps/harness/src/harness/temporal/interpreter/nodes/core.py` — on the durable lane.
 *
 * | Root | Workflow run | Standalone invocation |
 * |---|---|---|
 * | `trigger.*` | the `core.trigger`-validated run payload | — |
 * | `context.*` | ALIAS of `trigger.*` | the request's validated `context` |
 * | `input.*` | — | the body validated against `inputSchema` |
 * | `vars.*` | merged `core.variable` outputs | — |
 * | `nodes.<id>.*` | prior node outputs | — |
 * | bare `name` | `instruction.variables`, overlaid by the node's `overrides.promptVariables` | same, overlaid by the request's `variables` |
 *
 * Three ordering decisions that are load-bearing:
 *
 *  - the `context` alias is bound BEFORE the bare names, so an agent that genuinely declares a
 *    variable called `context` still wins its own name;
 *  - a root is bound only when the caller actually HAS it. Binding an absent `trigger` to `{}`
 *    would turn "this call shape has no trigger" into "that field does not exist", and the two
 *    are different findings for whoever has to fix the prompt;
 *  - a `{ path }` binding is RESOLVED against the roots before the bare names are assigned, so
 *    `{{age}}` and `{{context.patientAge}}` are the same value (§3.3). Resolution happens here,
 *    in the one shared builder, because the alternative was measured and is worse: three of the
 *    four renderers passed the raw binding map through and rendered `{"value":"concise"}` where
 *    the prompt bench — the ONLY site that resolved bindings — rendered `concise`. An author who
 *    tests a prompt on the bench must not get different bytes in production.
 */

import { renderTemplate } from '@arcaai/workflow-contract';

export interface AgentPromptScopeInput {
  /**
   * Bare names: `instruction.variables` already overlaid by the node's / caller's overrides.
   *
   * Each entry is either a BINDING (`{ value }` — a literal; `{ path }` — resolved from the
   * roots) or a plain value. An override supplies plain values, so one merged map carries both
   * shapes and the resolver is a safe superset of "use it verbatim".
   */
  readonly variables?: Readonly<Record<string, unknown>>;
  /** The run payload (workflow) or the request `context` (invocation). Also published as `context` unless `context` is given. */
  readonly trigger?: Readonly<Record<string, unknown>> | null;
  /**
   * TASK-947 R1 #1 — the CONTEXT VIEW of the trigger when the caller has already applied the J3-5
   * single-kind unwrap (`unwrapSingleKindContextPayload(payloadSchema, trigger)`). The durable
   * lane's `_prompt_scope` publishes `trigger` verbatim and `context` unwrapped; a TypeScript lane
   * whose trigger IS the run payload (`{ context: {...} }`) passes the unwrapped object here so
   * `context.visit_type` means the same thing on every renderer. Absent ⇒ `context` aliases
   * `trigger`, exactly as before.
   */
  readonly context?: Readonly<Record<string, unknown>> | null;
  /** The invocation body validated against the agent's `inputSchema`. */
  readonly input?: Readonly<Record<string, unknown>> | null;
  /** Merged `core.variable` outputs. */
  readonly vars?: Readonly<Record<string, unknown>> | null;
  /** Prior node outputs, keyed by node id. */
  readonly nodes?: Readonly<Record<string, unknown>> | null;
  /** Names the template in a `PromptVariableUnresolved` raised while resolving a `{ path }` binding. */
  readonly templateRef?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Build the render scope. Pure; no defaults are invented for a root the caller does not have. */
export function buildAgentPromptScope(input: AgentPromptScopeInput): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  if (isRecord(input.trigger)) {
    scope.trigger = input.trigger;
    scope.context = input.trigger;
  }
  // The explicit view wins over the alias; it is bound BEFORE the bare names for the same reason
  // the alias is (an agent that declares a variable called `context` still wins its own name).
  if (isRecord(input.context)) scope.context = input.context;
  if (isRecord(input.input)) scope.input = input.input;
  if (isRecord(input.vars)) scope.vars = input.vars;
  if (isRecord(input.nodes)) scope.nodes = input.nodes;

  const declared = isRecord(input.variables) ? input.variables : {};
  const variables: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(declared)) {
    variables[name] = resolveBinding(binding, scope, input.templateRef ?? `instruction.variables.${name}`);
  }
  Object.assign(scope, variables);
  // The pre-890 durable scope also exposed the bound map under its own key; a seeded instruction
  // may reference `{{variables.x}}`, so both renderers keep it — RESOLVED, so `{{variables.age}}`
  // and `{{age}}` cannot disagree.
  scope.variables = variables;
  return scope;
}

/**
 * One `instruction.variables` entry, resolved against the roots.
 *
 * `{ value }` is a literal and `{ path }` is a reference; anything else — a plain string an
 * override supplied, a number, a shape nobody declared — is the value itself. A `{ path }` that
 * resolves to nothing raises `PromptVariableUnresolvedError` NAMING THE PATH, which every caller
 * already maps to a 400 / a named degrade: a binding that silently vanished is what makes a
 * prompt lose a variable without anyone noticing.
 */
function resolveBinding(binding: unknown, scope: Readonly<Record<string, unknown>>, templateRef: string): unknown {
  if (!isRecord(binding)) return binding;
  if (typeof binding.value === 'string') return binding.value;
  if (typeof binding.path === 'string') return renderTemplate(`{{${binding.path}}}`, scope, { templateRef });
  return binding;
}

/**
 * The ONE render scope every prompt renderer builds — the VOCABULARY the template grammar
 * (`renderTemplate`) resolves against, so one agent instruction means the same thing on every
 * lane: the realtime `core.agent` lane, `POST /agents/:slug/invocations`, the draft bench, and —
 * through the hand-written mirror `build_prompt_scope` in
 * `apps/harness/src/harness/temporal/interpreter/prompt_composition.py` — the durable lane.
 * Both are held to `tests/contracts/compose-messages.fixture.json`.
 *
 * | Root | Workflow run | Standalone invocation |
 * |---|---|---|
 * | `trigger.*` | the `core.trigger`-validated run payload | ALIAS of `context.*` |
 * | `context.*` | ALIAS of `trigger.*` (or the caller's unwrapped view) | the request's validated `context` |
 * | `input.*` | — | the body validated against `inputSchema` |
 * | `vars.*` | merged `core.variable` outputs | — |
 * | `nodes.<id>.*` | prior node outputs | — |
 * | bare `name` | `instruction.variables`, overlaid by the node's `overrides.promptVariables` | same, overlaid by the request's `variables` |
 *
 * `context` is the canonical root and `trigger` its alias: whichever ONE of the two a caller
 * supplies, both resolve to the same object, so a prompt written against either spelling renders
 * on every lane. When a caller supplies BOTH (a workflow run whose trigger is the envelope and
 * whose context is the single-kind unwrap of it) they are kept as given — they are two honest
 * views of one payload.
 *
 * Three ordering decisions that are load-bearing:
 *
 *  - the roots are bound BEFORE the bare names, so an agent that genuinely declares a variable
 *    called `context` still wins its own name;
 *  - a root is bound only when the caller actually HAS it. Binding an absent root to `{}` would
 *    turn "this call shape has no trigger" into "that field does not exist", and the two are
 *    different findings for whoever has to fix the prompt;
 *  - a `{ path }` binding is RESOLVED against the roots before the bare names are assigned, so
 *    `{{age}}` and `{{context.patientAge}}` are the same value. An author who tests a prompt on
 *    the bench must not get different bytes in production.
 */
import { renderTemplate } from './template';

export interface PromptScopeParts {
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
   * The CONTEXT VIEW. On a workflow lane this is the trigger after the single-kind unwrap
   * (`{ context: {...} }` → `{...}`); on an invocation it is the request's `context`. Also
   * published as `trigger` unless `trigger` is given.
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
export function buildPromptScope(parts: PromptScopeParts): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  const trigger = isRecord(parts.trigger) ? parts.trigger : undefined;
  const context = isRecord(parts.context) ? parts.context : undefined;
  if (trigger !== undefined) {
    scope.trigger = trigger;
    scope.context = trigger;
  }
  // The explicit view wins over the alias.
  if (context !== undefined) {
    scope.context = context;
    if (trigger === undefined) scope.trigger = context;
  }
  if (isRecord(parts.input)) scope.input = parts.input;
  if (isRecord(parts.vars)) scope.vars = parts.vars;
  if (isRecord(parts.nodes)) scope.nodes = parts.nodes;

  const declared = isRecord(parts.variables) ? parts.variables : {};
  const variables: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(declared)) {
    variables[name] = resolveBinding(binding, scope, parts.templateRef ?? `instruction.variables.${name}`);
  }
  Object.assign(scope, variables);
  // The pre-890 durable scope also exposed the bound map under its own key; a seeded instruction
  // may reference `{{variables.x}}`, so it stays — RESOLVED, so `{{variables.age}}` and `{{age}}`
  // cannot disagree.
  scope.variables = variables;
  return scope;
}

/**
 * One `instruction.variables` entry, resolved against the roots.
 *
 * `{ value }` is a literal and `{ path }` is a reference; anything else — a plain string an
 * override supplied, a number, a shape nobody declared — is the value itself. A `{ path }` that
 * resolves to nothing raises `PromptVariableUnresolvedError` NAMING THE PATH: a binding that
 * silently vanished is how a prompt loses a variable without anyone noticing.
 */
function resolveBinding(binding: unknown, scope: Readonly<Record<string, unknown>>, templateRef: string): unknown {
  if (!isRecord(binding)) return binding;
  if (typeof binding.value === 'string') return binding.value;
  if (typeof binding.path === 'string') return renderTemplate(`{{${binding.path}}}`, scope, { templateRef });
  return binding;
}

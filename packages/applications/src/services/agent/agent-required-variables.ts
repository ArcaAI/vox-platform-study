/**
 * TASK-983 R9 — what an invocation of a published agent MUST supply, derived ONCE.
 *
 * The defect this closes: the business-plane summary (`GET /api/v1/agents/{slug}`) described an
 * agent's input and output schemas but said nothing about the PLACEHOLDERS its instruction
 * reads, and the renderer throws on the FIRST unresolved one. A nine-variable prompt was
 * therefore discoverable only as nine consecutive 400s, one per call — a contract a developer
 * cannot build a body from.
 *
 * Both halves of the fix read this module, which is the point:
 *
 *  · PUBLISH stamps {@link agentRequiredVariables} into `compiledConfig.requiredVariables`
 *    (`AgentService.compile`), so the read is a projection and never a render;
 *  · the INVOCATION diffs the same vocabulary against what the caller sent
 *    (`AgentInvocationService`), so what is published and what is enforced cannot drift.
 *
 * Everything here is pure. The placeholder grammar itself lives in `@arcaai/workflow-contract`
 * (`collectPlaceholders` / `requiredPromptVariables`); this file only adds the two facts the
 * contract has no way to know — which names the AGENT already binds, and which request key
 * satisfies a given root.
 */
import { requiredPromptVariables, type ComposableResolvedPrompt } from '@arcaai/workflow-contract';

/** The request key a caller supplies a path under, on the invocation plane. */
export type PromptVariableSlot = 'context' | 'input' | 'variables';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The agent's own `instruction.variables`, or `{}`. */
function boundVariablesOf(instruction: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return asRecord(asRecord(instruction ?? null)?.variables) ?? {};
}

/**
 * A binding's `{ path }`, or `null` for a literal (`{ value }`) / a plain value.
 *
 * This is `agent-prompt-scope.ts`'s `resolveBinding` read backwards: a `{ path }` binding is a
 * REFERENCE, resolved through the grammar on every render, so it is a requirement of the call
 * even when no placeholder mentions the bound name. A `{ value }` binding is a literal and
 * requires nothing.
 */
function bindingPath(binding: unknown): string | null {
  const record = asRecord(binding);
  if (record === null) return null;
  if (typeof record.value === 'string') return null;
  return typeof record.path === 'string' ? record.path : null;
}

/**
 * Which request key satisfies `path`.
 *
 * `trigger` and `context` are the SAME root on this plane (`buildAgentPromptScope` publishes the
 * request's validated `context` under both), so both answer `context`. A bare name — or a dotted
 * path whose root the agent BINDS — is a caller `variables` entry. `vars` / `nodes` are
 * workflow-only roots: an invocation cannot supply them at all, so the honest answer is `null`
 * rather than a key that would not work.
 */
export function promptVariableSlot(path: string, boundNames: readonly string[]): PromptVariableSlot | null {
  const [root, ...rest] = path.split('.');
  if (rest.length === 0) return 'variables';
  if (root === 'trigger' || root === 'context') return 'context';
  if (root === 'input') return 'input';
  if (root === 'variables') return 'variables';
  if (boundNames.includes(root as string)) return 'variables';
  return null;
}

/**
 * Every placeholder path a call must supply: undefaulted, not already bound by the agent, and
 * including the path of every `{ path }` binding the agent declares. Sorted, de-duplicated.
 *
 * EVERY fragment of a composite is walked, conditional ones included — publish cannot know which
 * branch a future call takes, and the worst case is the only honest thing to publish. The
 * per-call, selection-aware narrowing is `unresolvedPromptVariables` at invocation time.
 */
export function agentRequiredVariables(instruction: Record<string, unknown> | null | undefined, resolvedPrompt: ComposableResolvedPrompt): string[] {
  const bound = boundVariablesOf(instruction);
  const required = new Set<string>();

  for (const path of requiredPromptVariables(resolvedPrompt)) {
    const [root, ...rest] = path.split('.');
    // A bare `{{tone}}`, or `{{variables.tone}}` — the scope publishes the resolved map under
    // both spellings, so one rule covers them.
    const boundName = rest.length === 0 ? (root as string) : root === 'variables' && rest.length === 1 ? (rest[0] as string) : null;
    if (boundName !== null && Object.prototype.hasOwnProperty.call(bound, boundName)) continue;
    required.add(path);
  }
  for (const binding of Object.values(bound)) {
    const path = bindingPath(binding);
    if (path !== null) required.add(path);
  }
  return [...required].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

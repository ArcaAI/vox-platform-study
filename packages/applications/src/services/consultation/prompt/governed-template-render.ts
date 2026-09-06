/**
 * TASK-890 §3.2 — rendering a GOVERNED prompt body: one grammar, one missing-value policy.
 *
 * Two planes assemble a tenant's governed instruction into a clinical prompt — the native
 * `PromptAssemblyService` and the v1-compat pre-summary builder (`apps/api`
 * `text-compat/summary-prompt.builder.ts`) — and they must agree, because they render THE SAME
 * seeded rows. They did not: the v1-compat plane still ran the single-brace substituter, so a
 * body converted to `{{context.x}}` reached the model with the literal placeholder in it while
 * the native plane rendered the value.
 *
 * ## The missing-value policy is deliberately not `renderTemplate`'s
 *
 * `renderTemplate` RAISES on an unresolved, undefaulted reference, which is right for an agent
 * invocation (a 400 the caller can fix) and wrong here: this body assembles a clinical note a
 * clinician is waiting for, and refusing to produce one because a template mentions a variable
 * this encounter has no value for is a worse outcome than an empty slot. So an unresolved
 * reference is bound to the EMPTY STRING — never left as a literal placeholder, which is what
 * reaches the model otherwise.
 *
 * A reference that CARRIES a `default("…")` is not missing: the author already said what an
 * absent value should read as, and pre-binding an empty string would silence them.
 *
 * A single brace is NOT a placeholder (§3.11): an unconverted `{language_name}` renders
 * verbatim, so the omission stays visible instead of being honoured by a fallback pass.
 */
import { PromptTemplateSyntaxError, renderTemplate, templateReferences } from '@arcaai/workflow-contract';

/**
 * Is this body written in the ONE grammar, or in the retired single-brace one?
 *
 * The discriminator is the CONTENT, never the caller: the v1-compat plane and the native plane
 * assemble THE SAME seeded rows, so a tenant that converts its row must move planes with it and
 * one that has not must be unaffected. `{{` is the whole test — an escape (`{{{{`) and a
 * malformed placeholder both belong to the new grammar, and `renderGovernedTemplate` already
 * uses a body that does not parse verbatim, which is exactly what the old substituter did.
 */
export function usesTemplateGrammar(content: string): boolean {
  return content.includes('{{');
}

/** True when `path` names an own, non-null value reachable by dotted traversal of `scope`. */
export function resolvesInScope(scope: Record<string, unknown>, path: string): boolean {
  let current: unknown = scope;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return false;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== null && current !== undefined;
}

/** Bind `path` to the empty string, creating the intermediate objects it names. */
export function bindEmpty(scope: Record<string, unknown>, path: string): void {
  const segments = path.split('.');
  let current: Record<string, unknown> = scope;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1] as string] = '';
}

/** The unresolved, undefaulted references of `content` against `scope`, in source order. */
export function unresolvedReferences(content: string, scope: Record<string, unknown>): string[] {
  return templateReferences(content)
    .filter((reference) => !reference.hasDefault && !resolvesInScope(scope, reference.path))
    .map((reference) => reference.path);
}

/**
 * Render a governed body: unresolved references bound empty, a malformed body used VERBATIM.
 *
 * The syntax fallback matters as much as the empty binding. A template that does not parse is a
 * governance defect (publish reports it as `PROMPT_TEMPLATE_SYNTAX`); it must not cost the
 * clinician this note, so the body is used as authored and the caller logs it loudly.
 *
 * `onUnresolved` / `onSyntaxError` are how a caller reports; this function never logs, so it
 * stays pure enough to test and callers keep their own structured fields.
 */
export function renderGovernedTemplate(
  content: string,
  scope: Record<string, unknown>,
  options: { templateRef: string; onUnresolved?: (paths: string[]) => void; onSyntaxError?: (error: PromptTemplateSyntaxError) => void },
): string {
  const unresolved = unresolvedReferences(content, scope);
  if (unresolved.length > 0) {
    options.onUnresolved?.(unresolved);
    for (const path of unresolved) bindEmpty(scope, path);
  }
  try {
    return renderTemplate(content, scope, { templateRef: options.templateRef });
  } catch (error) {
    if (error instanceof PromptTemplateSyntaxError) {
      options.onSyntaxError?.(error);
      return content;
    }
    throw error;
  }
}

/**
 * TASK-947 §4.1 — prompt COMPOSITION: which fragments of a composite instruction run, and how
 * they become one system prompt.
 *
 * A composite `compiledConfig.resolvedPrompt` carries every fragment's content FROZEN at publish
 * (the TASK-890 freeze, per fragment). At render time:
 *
 * ```
 * scope := buildAgentPromptScope(...)                  // the ONE scope (§3.3); built BEFORE any condition
 * for f in fragments (authored order):
 *   f.when == null              → include
 *   evaluateCondition(f.when)   → error   ⇒ excluded { reason: 'condition_error' }   (OD-5: never fatal)
 *                               → false   ⇒ excluded { reason: 'condition_false' }
 *                               → true    ⇒ include
 * selected empty                → PromptCompositionEmptyError   (defensive — publish enforced a base, OD-6)
 * parts := selected.map(f → renderTemplate(f.content, scope, { templateRef: `<ref>#<key>` }))   // one pass PER fragment
 * prompt := parts.join(join)
 * ```
 *
 * Two properties are load-bearing and pinned by the cross-language fixture
 * (`tests/contracts/prompt-composition.fixture.json`, mirrored by the harness's
 * `prompt_composition.py`):
 *
 * - **The condition sees exactly what the template sees.** No second scope, no projection: a
 *   `when` that can read `context.visit_type` is one whose template can render
 *   `{{context.visit_type}}`, and vice versa. That is also why a bare bound name is a STRING in
 *   a condition — `{ path }` bindings resolve through the grammar (§3.3) — so numeric branches
 *   read the root (`context.patient_age > 65`), never the bare name.
 * - **Each fragment is rendered on its own, then joined.** A substituted value is never
 *   re-interpreted (the grammar's one-pass rule) and a `{{` can never pair with a `}}` across a
 *   fragment boundary.
 *
 * The two pre-947 shapes (`template`, `inline`) pass through `composePrompt` unchanged, so every
 * renderer has ONE entry point and no `source` sniffing of its own.
 */
import { evaluateCondition, expressionRootIdentifiers, parseExpression, type ExpressionValue } from './expressions';
import { renderTemplate } from './template';

/** The roots a `when` may read — the render scope's own (`buildAgentPromptScope`), by name. */
export const AGENT_CONDITION_ROOTS: readonly string[] = Object.freeze(['context', 'trigger', 'input', 'vars', 'nodes', 'variables']);

/** The fixed joiner (OD-7). Stamped into the artifact as `join` so a later release can widen it without a shape change. */
export const PROMPT_COMPOSITION_JOIN = '\n\n';

export interface ResolvedPromptFragment {
  readonly key: string;
  readonly source: 'template' | 'inline';
  readonly promptTemplateId?: string;
  readonly promptVersionNumber?: number;
  /** The fragment's content, frozen at publish. */
  readonly content: string;
  /** The authored CEL condition, or `null` for an unconditional fragment. */
  readonly when: string | null;
}

export interface TemplateResolvedPrompt {
  readonly source: 'template';
  readonly promptTemplateId: string;
  readonly promptVersionNumber: number;
  readonly content: string;
}

export interface InlineResolvedPrompt {
  readonly source: 'inline';
  readonly content: string;
}

export interface CompositeResolvedPrompt {
  readonly source: 'composite';
  /** The STATIC PROJECTION — the unconditional fragments joined — for a reader that predates fragments (OD-3). */
  readonly content: string;
  readonly join: string;
  readonly fragments: readonly ResolvedPromptFragment[];
}

export type ComposableResolvedPrompt = TemplateResolvedPrompt | InlineResolvedPrompt | CompositeResolvedPrompt | null | undefined;

export type FragmentExclusionReason = 'condition_false' | 'condition_error';

export interface FragmentExclusion {
  readonly key: string;
  readonly reason: FragmentExclusionReason;
  /** The evaluator's own message for `condition_error`. Diagnostic; not pinned across languages. */
  readonly detail?: string;
}

export interface ComposedPrompt {
  /** The system prompt, or `null` when the agent carries no instruction at all. */
  readonly prompt: string | null;
  /** Selected fragment KEYS in order — empty for the two single-body shapes. */
  readonly selected: readonly string[];
  readonly excluded: readonly FragmentExclusion[];
}

export interface ComposePromptOptions {
  /** What to name the agent in errors — an agent slug, a bench id. Fragments are named `<templateRef>#<key>`. */
  readonly templateRef?: string;
}

/** Every fragment's condition was false or failed. Publish enforces a base fragment (OD-6), so this is defensive. */
export class PromptCompositionEmptyError extends Error {
  readonly templateRef: string | null;
  readonly excluded: readonly FragmentExclusion[];
  constructor(excluded: readonly FragmentExclusion[], templateRef: string | null) {
    super(
      templateRef === null
        ? `No prompt fragment was selected (${excluded.length} excluded).`
        : `No prompt fragment of \`${templateRef}\` was selected (${excluded.length} excluded).`,
    );
    this.name = 'PromptCompositionEmpty';
    this.templateRef = templateRef;
    this.excluded = excluded;
  }
}

/** Select the fragments whose `when` holds over `scope`. Pure; never throws; the scope is read, not written. */
export function selectPromptFragments(
  fragments: readonly ResolvedPromptFragment[],
  scope: Readonly<Record<string, unknown>>,
): { selected: ResolvedPromptFragment[]; excluded: FragmentExclusion[] } {
  const selected: ResolvedPromptFragment[] = [];
  const excluded: FragmentExclusion[] = [];
  // The scope is JSON by construction (`buildAgentPromptScope` builds it from validated JSON
  // inputs and rendered strings), which is what the evaluator's `ExpressionValue` names.
  const context = scope as unknown as { [key: string]: ExpressionValue };
  for (const fragment of fragments) {
    // R1 #4/#5 — a malformed artifact composes or refuses BY NAME, exactly like the Python mirror:
    // a non-object entry is skipped, a non-string key is stringified (the type says `string[]`
    // all the way into telemetry).
    if (typeof fragment !== 'object' || fragment === null) continue;
    const key = String(fragment.key);
    if (fragment.when === null || fragment.when === undefined) {
      selected.push({ ...fragment, key });
      continue;
    }
    const verdict = evaluateCondition(fragment.when, context);
    if (verdict.error !== undefined) {
      excluded.push({ key, reason: 'condition_error', detail: verdict.error });
      continue;
    }
    if (!verdict.taken) {
      excluded.push({ key, reason: 'condition_false' });
      continue;
    }
    selected.push({ ...fragment, key });
  }
  return { selected, excluded };
}

/** A fragment's content, or the empty string for a malformed artifact that carries none (R1 #4). */
function contentOf(holder: { readonly content?: unknown }): string {
  return typeof holder.content === 'string' ? holder.content : '';
}

/** The §4.1 algorithm. Throws only what `renderTemplate` throws, plus `PromptCompositionEmptyError`. */
export function composePrompt(
  resolvedPrompt: ComposableResolvedPrompt,
  scope: Readonly<Record<string, unknown>>,
  options: ComposePromptOptions = {},
): ComposedPrompt {
  if (resolvedPrompt === null || resolvedPrompt === undefined) return { prompt: null, selected: [], excluded: [] };
  const templateRef = options.templateRef ?? null;

  if (resolvedPrompt.source !== 'composite') {
    const prompt = renderTemplate(contentOf(resolvedPrompt), scope, templateRef === null ? undefined : { templateRef });
    return { prompt, selected: [], excluded: [] };
  }

  // A composite that carries no fragment list cannot be published (publish always stamps one),
  // but a malformed artifact must refuse by NAME, not by a `TypeError` from iterating `undefined`
  // — and the Python mirror already refuses it as an empty composition (Lane C).
  const fragments = Array.isArray(resolvedPrompt.fragments) ? resolvedPrompt.fragments : [];
  const { selected, excluded } = selectPromptFragments(fragments, scope);
  if (selected.length === 0) throw new PromptCompositionEmptyError(excluded, templateRef);

  const join = typeof resolvedPrompt.join === 'string' ? resolvedPrompt.join : PROMPT_COMPOSITION_JOIN;
  const parts = selected.map((fragment) =>
    renderTemplate(contentOf(fragment), scope, { templateRef: templateRef === null ? `#${fragment.key}` : `${templateRef}#${fragment.key}` }),
  );
  return { prompt: parts.join(join), selected: selected.map((fragment) => fragment.key), excluded };
}

/** The unconditional fragments' RAW content joined — what publish stamps as `content` (OD-3). */
export function staticProjection(fragments: readonly ResolvedPromptFragment[], join: string = PROMPT_COMPOSITION_JOIN): string {
  return fragments
    .filter((fragment) => typeof fragment === 'object' && fragment !== null && (fragment.when === null || fragment.when === undefined))
    .map((fragment) => contentOf(fragment))
    .join(join);
}

/**
 * The publish-time root check (OD-4): every root identifier of `when` must be one of
 * `AGENT_CONDITION_ROOTS` or a bound variable name. `[]` for an expression that does not parse —
 * syntax is its own finding, reported once, by `expressionProblems`.
 */
export function conditionRootProblems(when: string, boundNames: readonly string[] = []): string[] {
  if ('error' in parseExpression(when)) return [];
  const allowed = new Set<string>([...AGENT_CONDITION_ROOTS, ...boundNames]);
  return expressionRootIdentifiers(when)
    .filter((root) => !allowed.has(root))
    .map(
      (root) =>
        `\`${root}\` is neither a context root (${AGENT_CONDITION_ROOTS.join(', ')}) nor a bound variable name${
          boundNames.length > 0 ? ` (${boundNames.join(', ')})` : ''
        }.`,
    );
}

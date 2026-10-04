/**
 * TASK-1036 §3.1 — "Derive v2": the ONE function that turns a prompt template's content into its
 * variable declarations, given the declarations it already has.
 *
 * Two callers, one rule: the console's "Derive from content" button and the server's prompt
 * create/update validation both call it, so the list an author sees and the list the server
 * stores cannot disagree. Mirrored in Python in wave B; both read
 * `tests/contracts/derive-variables.fixture.json`.
 *
 * The rules, each load-bearing:
 *
 *  - **Roots only.** `{{patient.name}}` declares `patient`, never `patient.name`: a declaration is
 *    a bare variable the scope binds, and its fields are its own business. A root referenced with
 *    a sub-path is derived as `type: "json"`; a bare one as `"string"`.
 *  - **Existing declarations are kept VERBATIM**, in their order — the author's type, description,
 *    default and source survive every derive. New ones are appended, sorted by name in code-unit
 *    order (never `localeCompare`: the list is stored and compared across machines).
 *  - **Never delete.** A declaration no longer referenced is reported in `stale`, and stays in
 *    `declarations`; the UI strikes it through and asks before removing it.
 *  - **Namespace roots are not variables.** `context`, `trigger`, `input`, `vars`, `nodes`,
 *    `variables`, `consultation`, `run` are bound by the platform, and so is every name in
 *    `PLATFORM_CONTEXT_VARIABLES` (also as a bare name) — declaring one would invite a tenant to
 *    "supply" a value the platform overwrites.
 *  - **`required = !hasDefault`**, where `hasDefault` is the AND over every occurrence
 *    (`collectPlaceholders`): one undefaulted use is the one that throws, so the variable is
 *    required.
 *  - Malformed placeholders are skipped — a syntax problem is its own finding
 *    (`templateSyntaxProblems`). Fragments are scanned one by one, so a `{{` never pairs with a
 *    `}}` across a fragment boundary.
 *
 * Pure: neither argument is mutated.
 */
import { PLATFORM_CONTEXT_VARIABLES } from './platform-context-variables';
import { collectPlaceholders } from './template';

/** The value shapes a declared prompt variable may take (TASK-890 §3.6). */
export type PromptVariableType = 'string' | 'number' | 'boolean' | 'date' | 'json';

/** One stored declaration — the `PromptTemplate.variables` / `PromptVersion.variables` element. */
export interface PromptVariableDeclaration {
  readonly name: string;
  readonly type: PromptVariableType;
  readonly required: boolean;
  readonly default?: string;
  readonly description?: string;
  readonly source?: { readonly kind: 'context' | 'static'; readonly path?: string };
}

export interface DerivedVariableDeclarations {
  /** Existing declarations verbatim (in order), then the added ones (sorted by name). */
  readonly declarations: PromptVariableDeclaration[];
  /** Names declared by this derive, sorted. */
  readonly added: string[];
  /** Names of EXISTING declarations the content no longer references, in declaration order. Kept, never deleted. */
  readonly stale: string[];
}

/** Roots the platform binds; a template referencing them declares nothing. */
export const PROMPT_VARIABLE_NAMESPACE_ROOTS: readonly string[] = Object.freeze([
  'context',
  'trigger',
  'input',
  'vars',
  'nodes',
  'variables',
  'consultation',
  'run',
]);

const PLATFORM_VARIABLE_NAMES: ReadonlySet<string> = new Set(PLATFORM_CONTEXT_VARIABLES.map((entry) => entry.path.slice(entry.path.indexOf('.') + 1)));
const NAMESPACE_ROOTS: ReadonlySet<string> = new Set(PROMPT_VARIABLE_NAMESPACE_ROOTS);

function isDeclaration(value: unknown): value is PromptVariableDeclaration {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { name?: unknown }).name === 'string';
}

/**
 * Derive the declarations for `content` (one template, or an ordered list of fragment bodies),
 * keeping every `existing` declaration. A non-object `existing` entry (or one without a `name`)
 * is not a declaration and is dropped from the result — it could never be stored.
 */
export function deriveVariableDeclarations(
  content: string | readonly (string | null | undefined)[],
  existing?: readonly PromptVariableDeclaration[] | null,
): DerivedVariableDeclarations {
  const kept = (Array.isArray(existing) ? existing : []).filter(isDeclaration);

  // root → { required, dotted }, over every placeholder (namespace roots included, so a
  // declaration that happens to share a namespace name is not reported stale while referenced).
  const roots = new Map<string, { required: boolean; dotted: boolean }>();
  for (const reference of collectPlaceholders(content)) {
    const dot = reference.path.indexOf('.');
    const root = dot < 0 ? reference.path : reference.path.slice(0, dot);
    const seen = roots.get(root);
    roots.set(root, {
      required: (seen?.required ?? false) || !reference.hasDefault,
      dotted: (seen?.dotted ?? false) || dot >= 0,
    });
  }

  const declaredNames = new Set(kept.map((declaration) => declaration.name));
  const added = [...roots.keys()]
    .filter((root) => !declaredNames.has(root) && !NAMESPACE_ROOTS.has(root) && !PLATFORM_VARIABLE_NAMES.has(root))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const derived: PromptVariableDeclaration[] = added.map((name) => {
    const usage = roots.get(name) as { required: boolean; dotted: boolean };
    return { name, type: usage.dotted ? 'json' : 'string', required: usage.required };
  });

  return {
    declarations: [...kept, ...derived],
    added,
    stale: kept.filter((declaration) => !roots.has(declaration.name)).map((declaration) => declaration.name),
  };
}

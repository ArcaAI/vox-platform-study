/**
 * TASK-890 §3.2 — the ONE prompt-template grammar: renderer, reference reader and the two
 * publish-time checks.
 *
 * Before this ticket the same prompts were rendered by SIX different flavours (§2.4): two
 * single-brace regexes in the gateway, three flat-key `{{ }}` copies that could not traverse a
 * dotted path, and one Python resolver that could. The realtime and durable lanes rendered the
 * SAME `core.agent` node with two of them, so `{{trigger.patientAge}}` resolved on one lane and
 * was emitted as a literal on the other. This module is the single grammar all of them collapse
 * into; `apps/harness/src/harness/temporal/interpreter/templating.py` is its hand-written mirror
 * and both are held to one committed fixture (`tests/contracts/prompt-template.fixture.json`) by
 * two loaders — the `expressions.ts` / `expressions.py` discipline, applied to templating.
 *
 * ```
 * template    := ( text | escape | placeholder )*
 * escape      := "{{{{"                                   ; renders the literal "{{"
 * placeholder := "{{" WS? path ( WS? "|" WS? filter )? WS? "}}"
 * path        := ident ( "." ident )*
 * ident       := [A-Za-z_][A-Za-z0-9_]*
 * filter      := "default" WS? "(" string ")"             ; the ONLY filter
 * string      := '"' ( [^"\\] | "\\" . )* '"'
 * WS          := [ \t]+
 * ```
 *
 * Semantics that are load-bearing and easy to get wrong:
 *
 * - **Exactly one pass.** A `{{` inside a SUBSTITUTED value is never re-interpreted. This
 *   promotes the guard `pre-summary-variables.ts` carried into the contract before that file is
 *   deleted: a patient-supplied string cannot smuggle a placeholder into the prompt.
 * - **A single brace is literal.** `{language_name}` renders verbatim. The deleted single-brace
 *   grammar is not silently honoured by a fallback pass — a template that was never converted
 *   shows its unconverted variable instead of quietly resolving one.
 * - **Own-property traversal over PLAIN OBJECTS only.** `constructor` / `__proto__` / `toString`
 *   are not variables, and an array is a VALUE (`{{list.0}}` does not resolve) — an index is not
 *   a namespace.
 * - **`null` is missing**, so `default(...)` covers it.
 * - **Non-string values are canonical JSON** (sorted keys, no spaces), which is byte-identical to
 *   the Python mirror's `json.dumps(..., sort_keys=True, ensure_ascii=False, separators=(",",":"))`.
 *
 * Pure and dependency-free, like everything else in this package. `renderTemplate` is the only
 * export that throws, and only with the two named errors below.
 */
import { canonicalJson } from './canonical-json';

// =============================================================================================
// Public types
// =============================================================================================

export interface TemplateReference {
  /** The dotted path exactly as authored, e.g. `trigger.patient.age` or a bare `department`. */
  readonly path: string;
  /** Whether the placeholder carries `| default("…")` — a defaulted miss is never a problem. */
  readonly hasDefault: boolean;
  /** Index of the opening `{{` in the source template (for an editor to place a marker). */
  readonly offset: number;
}

/**
 * TASK-983 (R9) — one placeholder of a template, DE-DUPLICATED: the path and whether every
 * occurrence of it carries `default("…")`. `TemplateReference` above is per OCCURRENCE (it
 * carries an offset, which an editor wants); this is per NAME, which is what a published
 * contract and a request-time diff want.
 */
export interface PlaceholderReference {
  readonly path: string;
  /** `true` only when EVERY occurrence carries `default("…")` — one undefaulted use makes the path required. */
  readonly hasDefault: boolean;
}

export interface RenderTemplateOptions {
  /**
   * What to name this template in a `PromptVariableUnresolved` error — a template id, an agent
   * slug, a node path. The renderer never invents one; a caller that has an identity supplies it.
   */
  readonly templateRef?: string;
}

/**
 * The namespaces a template may reference, as resolved BY THE CALLER (§3.3). The contract has no
 * database, so it cannot know an agent's bound context schema or a graph's `core.variable` keys;
 * it only knows how to cross-check a template against them.
 *
 * A root whose schema is `null`/`undefined` — or whose schema does not close itself with
 * `additionalProperties: false` — is UNKNOWN-SHAPED and admits any sub-path. That is deliberate:
 * an inline tenant schema that declares `additionalProperties: true` genuinely cannot say which
 * fields exist, and guessing would turn a legitimate template into a finding.
 */
export interface DeclaredNamespaces {
  /** Root name (`context`, `trigger`, `input`, `vars`, `nodes`, …) → its payload schema or `null`. */
  readonly roots?: Readonly<Record<string, unknown>>;
  /** Bare variable names — the agent's `instruction.variables` keys plus the template's own declarations. */
  readonly variables?: readonly string[];
}

/** The template did not parse. Publish reports it as `PROMPT_TEMPLATE_SYNTAX` (ERROR). */
export class PromptTemplateSyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.name = 'PromptTemplateSyntaxError';
    this.offset = offset;
  }
}

/** A placeholder resolved to nothing and carried no `default(...)`. Named, never silent. */
export class PromptVariableUnresolvedError extends Error {
  readonly path: string;
  readonly templateRef: string | null;
  constructor(path: string, templateRef: string | null) {
    super(
      templateRef === null
        ? `Prompt variable \`${path}\` did not resolve and declares no \`default(...)\`.`
        : `Prompt variable \`${path}\` did not resolve in \`${templateRef}\` and declares no \`default(...)\`.`,
    );
    this.name = 'PromptVariableUnresolved';
    this.path = path;
    this.templateRef = templateRef;
  }
}

// =============================================================================================
// Scanner
// =============================================================================================

interface TextSegment {
  readonly kind: 'text';
  readonly value: string;
}

interface PlaceholderSegment {
  readonly kind: 'placeholder';
  readonly path: string;
  readonly defaultValue: string | null;
  readonly offset: number;
}

type Segment = TextSegment | PlaceholderSegment;

interface ScanResult {
  readonly segments: readonly Segment[];
  readonly problems: readonly string[];
  /** Offset of the first problem, so `renderTemplate` can throw with a position. */
  readonly firstProblemOffset: number;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t';
}

function skipWs(content: string, index: number): number {
  let i = index;
  while (i < content.length && isWs(content[i])) i += 1;
  return i;
}

function readIdent(content: string, index: number): { ident: string; next: number } | null {
  if (index >= content.length || !IDENT_START.test(content[index] as string)) return null;
  let i = index + 1;
  while (i < content.length && IDENT_CHAR.test(content[i] as string)) i += 1;
  return { ident: content.slice(index, i), next: i };
}

/**
 * `'"' ( [^"\\] | "\\" . )* '"'` — a backslash yields the NEXT CHARACTER VERBATIM (`\"` → `"`,
 * `\\` → `\`, `\n` → the letter `n`). No C-style escape table, in either language: a default
 * string is display text, and two hand-written parsers agree on "take the next character" far
 * more reliably than on a table.
 */
function readString(content: string, index: number): { value: string; next: number } | null {
  if (content[index] !== '"') return null;
  let i = index + 1;
  let out = '';
  while (i < content.length) {
    const ch = content[i] as string;
    if (ch === '\\') {
      if (i + 1 >= content.length) return null;
      out += content[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') return { value: out, next: i + 1 };
    out += ch;
    i += 1;
  }
  return null;
}

interface PlaceholderParse {
  readonly path: string;
  readonly defaultValue: string | null;
  readonly next: number;
}

/** Parses one placeholder starting AT its `{{`. Returns a problem string on any deviation. */
function parsePlaceholder(content: string, start: number): PlaceholderParse | string {
  const near = `at offset ${start}`;
  let i = skipWs(content, start + 2);

  const first = readIdent(content, i);
  if (first === null) {
    return `\`{{\` ${near}: expected a variable path (\`[A-Za-z_][A-Za-z0-9_]*\`, dot-separated), found ${JSON.stringify(content.slice(i, i + 8))}.`;
  }
  let path = first.ident;
  i = first.next;
  while (content[i] === '.') {
    const segment = readIdent(content, i + 1);
    if (segment === null) return `\`{{\` ${near}: \`${path}.\` is not followed by an identifier.`;
    path += `.${segment.ident}`;
    i = segment.next;
  }

  let defaultValue: string | null = null;
  let j = skipWs(content, i);
  if (content[j] === '|') {
    j = skipWs(content, j + 1);
    const filter = readIdent(content, j);
    if (filter === null || filter.ident !== 'default') {
      return `\`{{${path}}}\` ${near}: \`${filter?.ident ?? content.slice(j, j + 8)}\` is not a filter — \`default("…")\` is the only one.`;
    }
    j = skipWs(content, filter.next);
    if (content[j] !== '(') return `\`{{${path}}}\` ${near}: \`default\` must be called — \`default("…")\`.`;
    j = skipWs(content, j + 1);
    const literal = readString(content, j);
    if (literal === null) return `\`{{${path}}}\` ${near}: \`default(…)\` takes ONE double-quoted string.`;
    defaultValue = literal.value;
    j = skipWs(content, literal.next);
    if (content[j] !== ')') return `\`{{${path}}}\` ${near}: \`default("…")\` is not closed.`;
    j = skipWs(content, j + 1);
  }

  if (content.slice(j, j + 2) !== '}}') {
    return `\`{{${path}}}\` ${near}: unterminated placeholder — expected \`}}\`.`;
  }
  return { path, defaultValue, next: j + 2 };
}

/**
 * One left-to-right pass. A malformed placeholder records a problem and the scan RESUMES two
 * characters later, so a template with three mistakes reports three — the house `problems`
 * idiom, which exists so an author fixes everything in one edit instead of three round-trips.
 */
function scan(content: string): ScanResult {
  const segments: Segment[] = [];
  const problems: string[] = [];
  let firstProblemOffset = -1;
  let buffer = '';
  let i = 0;

  const flush = (): void => {
    if (buffer.length > 0) {
      segments.push({ kind: 'text', value: buffer });
      buffer = '';
    }
  };

  while (i < content.length) {
    if (content.slice(i, i + 2) !== '{{') {
      buffer += content[i];
      i += 1;
      continue;
    }
    if (content.slice(i, i + 4) === '{{{{') {
      buffer += '{{';
      i += 4;
      continue;
    }
    const parsed = parsePlaceholder(content, i);
    if (typeof parsed === 'string') {
      problems.push(parsed);
      if (firstProblemOffset < 0) firstProblemOffset = i;
      buffer += '{{';
      i += 2;
      continue;
    }
    flush();
    segments.push({ kind: 'placeholder', path: parsed.path, defaultValue: parsed.defaultValue, offset: i });
    i = parsed.next;
  }
  flush();
  return { segments, problems, firstProblemOffset };
}

// =============================================================================================
// Resolution
// =============================================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Dotted traversal, own-property, plain objects only. `undefined` means "did not resolve" and
 * covers all four ways that happens: a missing segment, a non-object on the way down, an array
 * (an index is not a namespace), and a `null`/`undefined` leaf.
 */
function resolvePath(scope: unknown, path: string): unknown {
  let current: unknown = scope;
  for (const segment of path.split('.')) {
    if (!isPlainObject(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current === null ? undefined : current;
}

// =============================================================================================
// Public API
// =============================================================================================

/**
 * Renders `content` against `scope`. Throws `PromptTemplateSyntaxError` if the template does not
 * parse and `PromptVariableUnresolvedError` on the first unresolved, undefaulted placeholder —
 * the two named failures §3.2 requires. It never returns a partially-substituted string: a
 * prompt that silently lost a variable is the failure mode this grammar exists to end.
 */
export function renderTemplate(content: string, scope: Readonly<Record<string, unknown>>, options?: RenderTemplateOptions): string {
  const scanned = scan(content);
  if (scanned.problems.length > 0) {
    throw new PromptTemplateSyntaxError(scanned.problems[0] as string, scanned.firstProblemOffset);
  }
  const templateRef = options?.templateRef ?? null;
  let out = '';
  for (const segment of scanned.segments) {
    if (segment.kind === 'text') {
      out += segment.value;
      continue;
    }
    const value = resolvePath(scope, segment.path);
    if (value === undefined) {
      if (segment.defaultValue === null) throw new PromptVariableUnresolvedError(segment.path, templateRef);
      out += segment.defaultValue;
      continue;
    }
    out += typeof value === 'string' ? value : canonicalJson(value);
  }
  return out;
}

/** Every placeholder the template references, in source order. Malformed ones are skipped. */
export function templateReferences(content: string): TemplateReference[] {
  return scan(content)
    .segments.filter((segment): segment is PlaceholderSegment => segment.kind === 'placeholder')
    .map((segment) => ({ path: segment.path, hasDefault: segment.defaultValue !== null, offset: segment.offset }));
}

/**
 * TASK-983 (R9) — every placeholder of one template, or of a COMPOSED instruction's fragments,
 * as a sorted, de-duplicated set of names.
 *
 * Fragments are walked one by one rather than concatenated, for the same reason `composePrompt`
 * renders them one by one: a `{{` must never pair with a `}}` across a fragment boundary.
 *
 * `hasDefault` is the AND of every occurrence. A path defaulted in one place and bare in another
 * is REQUIRED — the bare occurrence is the one that throws, and calling it optional would be a
 * published lie. Malformed placeholders are skipped exactly as `templateReferences` skips them:
 * a syntax problem is its own finding (`templateSyntaxProblems`), reported once, by publish.
 *
 * Sorted by code unit, never `localeCompare`: this set is frozen into an artifact and compared
 * across machines, so the order must not depend on a locale.
 */
export function collectPlaceholders(template: string | readonly (string | null | undefined)[]): PlaceholderReference[] {
  const templates = typeof template === 'string' ? [template] : template;
  const byPath = new Map<string, boolean>();
  for (const one of templates) {
    if (typeof one !== 'string' || one.length === 0) continue;
    for (const reference of templateReferences(one)) {
      const seen = byPath.get(reference.path);
      byPath.set(reference.path, seen === undefined ? reference.hasDefault : seen && reference.hasDefault);
    }
  }
  return [...byPath.entries()].map(([path, hasDefault]) => ({ path, hasDefault })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The renderer's OWN traversal, exported so a caller can ask "would this path resolve?" without
 * rendering and without a second implementation of the rules (own properties, plain objects
 * only, an array is a value, `null` is missing). `undefined` means it did not resolve — which is
 * exactly when `renderTemplate` throws `PromptVariableUnresolvedError`.
 */
export function resolveTemplatePath(scope: Readonly<Record<string, unknown>>, path: string): unknown {
  return resolvePath(scope, path);
}

/** Every way the template fails to parse. `[]` means `renderTemplate` will not throw a syntax error. */
export function templateSyntaxProblems(content: string): string[] {
  return [...scan(content).problems];
}

/**
 * Whether the schema for a namespace root can say anything about `segments`. Returns `null` when
 * the shape is UNKNOWN (no schema, no `properties`, or an open `additionalProperties`) — the
 * caller then admits the reference rather than guessing.
 */
function schemaAdmits(schema: unknown, segments: readonly string[]): boolean | null {
  let current: unknown = schema;
  for (const segment of segments) {
    if (!isPlainObject(current)) return null;
    const properties = isPlainObject(current.properties) ? current.properties : undefined;
    if (properties !== undefined && Object.prototype.hasOwnProperty.call(properties, segment)) {
      current = properties[segment];
      continue;
    }
    // Not declared here: a CLOSED object says the field does not exist; anything else cannot say.
    if (properties !== undefined && current.additionalProperties === false) return false;
    return null;
  }
  return true;
}

/**
 * Publish-time cross-validation (§3.3): every reference must name a declared bare variable, or a
 * declared namespace root whose schema admits the rest of the path, or carry `default(...)`.
 *
 * Severity is the CALLER's (`PublishContext.templateReferenceSeverity`, WARNING in release 1 and
 * ERROR in release +1 — the OD-C ramp), because the same problem is authoring feedback in a draft
 * and a publish refusal later. This function only decides WHETHER, never how loudly.
 */
export function templateReferenceProblems(content: string, declared: DeclaredNamespaces): string[] {
  const roots = declared.roots ?? {};
  const variables = new Set(declared.variables ?? []);
  const problems: string[] = [];
  // ONE problem per undeclared NAME (J3-6). A prompt that repeats `{{context.safe_age}}` in its
  // header and again in its body is ONE authoring mistake and the author fixes it once; reporting
  // it per occurrence inflates the report (measured: 17 findings for 9 distinct placeholders) and
  // buries the names that appear only once. `templateReferences` still yields every occurrence
  // with its offset — that is a fact about the SOURCE, and an editor wants all of them.
  const reported = new Set<string>();

  for (const reference of templateReferences(content)) {
    if (reference.hasDefault) continue;
    if (reported.has(reference.path)) continue;
    reported.add(reference.path);
    const segments = reference.path.split('.');
    const [root, ...rest] = segments as [string, ...string[]];

    if (rest.length === 0) {
      if (variables.has(root) || Object.prototype.hasOwnProperty.call(roots, root)) continue;
      problems.push(
        `\`{{${reference.path}}}\`: \`${root}\` is not a declared variable. Declare it on the prompt/agent, reference a declared namespace (${Object.keys(roots).sort().join(', ') || 'none declared'}), or give it a \`default("…")\`.`,
      );
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(roots, root)) {
      problems.push(
        `\`{{${reference.path}}}\`: \`${root}\` is not a declared namespace (${Object.keys(roots).sort().join(', ') || 'none declared'}). Bind a context schema, or give it a \`default("…")\`.`,
      );
      continue;
    }
    if (schemaAdmits(roots[root], rest) === false) {
      problems.push(`\`{{${reference.path}}}\`: \`${rest.join('.')}\` is not declared by the schema bound to \`${root}\`.`);
    }
  }
  return problems;
}

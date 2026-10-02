/**
 * The flat `context.*` prompt vocabulary the GATEWAY derives and binds itself — department name,
 * visit type, the v1 `safe_*` demographics, the formatted vitals / tests / prior visits, the output
 * language name and the clinician's DNA texts. No context-schema kind declares these names: they
 * are computed per encounter, never supplied by a client, so a schema cannot be their source.
 *
 * Declared ONCE here so the two readers that need the list agree: agent publish admits them as
 * declared under the `context` root (`withPlatformContextVariables`), and the console offers them
 * in the template editor's completion list beside the schema's own paths.
 *
 * Where each value is bound (gateway, `@arcaai/applications`):
 *  - PROMPT ASSEMBLY (`PromptAssemblyService`, also behind the harness `assemble` call and the live
 *    warm-start pre-summary) binds every name flat under `context`, rendering an absent one empty.
 *  - the REALTIME live lane binds the nine pre-summary names under `trigger.context` (and so under
 *    `context` only when the agent's frozen schema is a single `context` kind); no DNA texts.
 *  - the live HANDOFF to the durable lane overlays the nine names plus the DNA texts (each behind
 *    its own gate) onto the run's `trigger.context`.
 *
 * Every value is a string. `phiClass` uses the context-schema kind vocabulary (`PHI` / `NON_PHI`).
 */

export interface PlatformContextVariable {
  readonly path: string;
  readonly type: string;
  readonly required: false;
  readonly phiClass: 'PHI' | 'NON_PHI' | null;
  readonly description: string;
  readonly deprecated: false;
  readonly source: 'platform';
}

const ALL_LANES = 'Bound by prompt assembly (flat `context`), and under `trigger.context` by the realtime live lane and the durable handoff.';
const ASSEMBLY_AND_HANDOFF =
  'Bound by prompt assembly (flat `context`, empty when absent) and by the durable handoff under `trigger.context` when its gate applies; NOT by the realtime live lane.';

function variable(name: string, phiClass: PlatformContextVariable['phiClass'], description: string): PlatformContextVariable {
  return Object.freeze({ path: `context.${name}`, type: 'string', required: false, phiClass, description, deprecated: false, source: 'platform' });
}

/** Sorted by path in code-unit order. */
export const PLATFORM_CONTEXT_VARIABLES: readonly PlatformContextVariable[] = Object.freeze([
  variable('current_department', 'NON_PHI', `The consultation's department name ("General" when unknown). ${ALL_LANES}`),
  variable('dna_redaction_rules_text', 'PHI', `The clinician's DNA redaction/rewrite rules as a bullet list. ${ASSEMBLY_AND_HANDOFF}`),
  variable('dna_style_text', 'NON_PHI', `The clinician's effective DNA writing style (style guidance, not patient data). ${ASSEMBLY_AND_HANDOFF}`),
  variable('formatted_previous_visits', 'PHI', `The client-supplied prior-visit history, newest first ('' when none). ${ALL_LANES}`),
  variable('formatted_test_results', 'PHI', `The client-supplied investigations, one line per result ('' when none). ${ALL_LANES}`),
  variable('language_name', 'NON_PHI', `The name of the language the note is written in ("English" by default). ${ALL_LANES}`),
  variable('safe_age', 'PHI', `The patient's age ("Unknown" when not held). ${ALL_LANES}`),
  variable('safe_dob', 'PHI', `The patient's date of birth ("Unknown" when not held). ${ALL_LANES}`),
  variable('safe_gender', 'PHI', `The patient's gender ("Unknown" when not held). ${ALL_LANES}`),
  variable('safe_vitals', 'PHI', `The client-measured vitals ("Not available" when none). ${ALL_LANES}`),
  variable('visit_type', 'NON_PHI', `The visit type of this consultation. ${ALL_LANES}`),
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `declared` with the platform names admitted under the `context` root, for a TEXT_GENERATION
 * prompt. Never mutates its input and never touches another root.
 *
 *  - no `context` root → one is declared, CLOSED over the platform names only;
 *  - a `context` root whose schema lists `properties` → the platform names are added beside them,
 *    the schema's own declaration of a name winning;
 *  - any other `context` root (`null`, an open or property-less schema) already admits every name
 *    and is left as it is.
 */
export function withPlatformContextVariables<T extends { readonly roots?: Readonly<Record<string, unknown>> }>(declared: T): T {
  const roots = declared.roots ?? {};
  const platformProperties = Object.fromEntries(
    PLATFORM_CONTEXT_VARIABLES.map((entry) => [entry.path.slice('context.'.length), { type: entry.type, description: entry.description }]),
  );

  if (!Object.prototype.hasOwnProperty.call(roots, 'context')) {
    return { ...declared, roots: { ...roots, context: { type: 'object', additionalProperties: false, properties: platformProperties } } };
  }
  const schema = roots.context;
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return declared;
  return { ...declared, roots: { ...roots, context: { ...schema, properties: { ...platformProperties, ...schema.properties } } } };
}

import { createHash } from 'node:crypto';
import { authorableJsonSchemaProblems } from '@arcaai/json-schema-subset';

/**
 * The shape of a `ConsultationContextSchemaVersion.definition`, and
 * the validator that decides whether a tenant may publish one.
 *
 * ## The load-bearing idea (/ )
 *
 * A tenant invents its OWN vocabulary — `referral_letter`, `triage_form`,
 * whatever its clinic actually uses — but every kind must declare exactly one
 * of five PLATFORM PRIMITIVES, and the primitive is what the engine reasons
 * about:
 *
 * | Primitive | Substrate it resolves to |
 * |---|---|
 * | `STREAM_AUDIO` | STT session + AudioRecording |
 * | `TEXT`         | encrypted `ContextItem.content` (today's CASE_NOTE path) |
 * | `DOCUMENT`     | Media + object storage, text via OCR |
 * | `IMAGE`        | Media + object storage |
 * | `STRUCTURED`   | encrypted JSON validated against `fields` |
 *
 * **Rejecting an unknown primitive is the enforcement point that keeps tenant
 * vocabulary on platform substrate.** Without it, a tenant could declare a
 * kind the loop has no way to process, and the failure would surface deep
 * inside a live consultation rather than at authoring time.
 *
 * Validation is fail-closed on shape (unknown keys are rejected, mirroring the
 * gateway's `forbidNonWhitelisted` posture) and returns EVERY problem at once
 * rather than throwing on the first — an admin editing a large definition
 * should not discover its faults one round-trip at a time.
 */

/** The CLOSED set of platform primitives. Extending it is a platform change, never a tenant one. */
export const CONTEXT_PRIMITIVES = ['STREAM_AUDIO', 'TEXT', 'DOCUMENT', 'IMAGE', 'STRUCTURED'] as const;
export type ContextPrimitive = (typeof CONTEXT_PRIMITIVES)[number];

export const CONTEXT_PHI_CLASSES = ['PHI', 'NON_PHI'] as const;
export const CONTEXT_CARDINALITIES = ['ONE', 'MANY'] as const;
export const CONTEXT_LIFECYCLES = ['PRE', 'DURING', 'POST', 'ANY'] as const;
export const CONTEXT_PRODUCERS = ['CLIENT', 'AGENT', 'SYSTEM'] as const;

/**
 * TASK-890 §3.4 — the SLUG of the legacy bridge schema: the SYSTEM reference row that declares
 * the v1 consultation prompt vocabulary, cloned into every tenant by the reference set.
 *
 * The prompt path resolves the TENANT's clone by `sourceTemplateSlug`, never the SYSTEM row —
 * context schemas are CONTENT (§1.5), so SYSTEM is a reference set, not a runtime tier.
 *
 * Underscores because a schema slug is validated against `CONTEXT_KIND_KEY_PATTERN` below: a
 * hyphenated slug could not be authored through the API, and the clone path goes through the
 * same `create()` the API does. Mirrored in
 * `packages/database/src/prisma/db_main/seed/07g-consultation-legacy-context-schema.ts`, which
 * cannot import this package; the seed test asserts the two agree.
 */
export const LEGACY_CONTEXT_SCHEMA_SLUG = 'consultation_note_context';

/** The only `schemaVersion` this platform understands. */
export const CONTEXT_SCHEMA_DEFINITION_VERSION = '1.0';

/** Grammar for `kinds[].key`, `outputs[].key` and the schema `slug`. */
export const CONTEXT_KIND_KEY_PATTERN = /^[a-z0-9_]{2,48}$/;

/** Hard ceiling on the number of declared kinds + outputs in one definition. */
export const MAX_DECLARED_KINDS = 64;

const TOP_LEVEL_KEYS = ['schemaVersion', 'kinds', 'outputs'] as const;
const KIND_KEYS = [
  'key',
  'label',
  'primitive',
  'phiClass',
  'cardinality',
  'lifecycle',
  'producedBy',
  'required',
  'fields',
  'constraints',
  'description',
  'deprecated',
] as const;
const OUTPUT_KEYS = ['key', 'label', 'primitive', 'fields', 'description'] as const;
const CONSTRAINT_KEYS = ['mimeTypes', 'maxBytes'] as const;
/** The only keys a `deprecated` block may carry. */
const DEPRECATED_KEYS = ['since', 'migrateBy', 'message'] as const;
/** `YYYY-MM-DD`, deliberately loose (a calendar date, not a full timestamp). */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Deprecation signalling for a kind, authored INSIDE the same
 * `definition` document a kind already lives in (no new column, no
 * migration). Purely informational: `validateContextPayload` does not
 * consult it — a deprecated kind is still accepted for the length of its
 * stated migration window, which is the whole point of deprecating rather
 * than deleting.
 */
export interface KindDeprecation {
  /** ISO date (`YYYY-MM-DD`) the kind was deprecated. */
  since: string;
  /** ISO date after which clients should have migrated. Open-ended when absent. */
  migrateBy?: string;
  /** Free-text guidance surfaced to a client reading the discovery bundle. */
  message?: string;
}

export interface ContextKindDeclaration {
  key: string;
  label: string;
  primitive: ContextPrimitive;
  phiClass: (typeof CONTEXT_PHI_CLASSES)[number];
  cardinality: (typeof CONTEXT_CARDINALITIES)[number];
  lifecycle: (typeof CONTEXT_LIFECYCLES)[number];
  producedBy: (typeof CONTEXT_PRODUCERS)[number][];
  required?: boolean;
  description?: string;
  fields?: Record<string, unknown>;
  constraints?: { mimeTypes?: string[]; maxBytes?: number };
  deprecated?: KindDeprecation;
}

export interface ContextOutputDeclaration {
  key: string;
  label?: string;
  description?: string;
  primitive: ContextPrimitive;
  fields?: Record<string, unknown>;
}

export interface ContextSchemaDefinition {
  schemaVersion: string;
  kinds: ContextKindDeclaration[];
  outputs?: ContextOutputDeclaration[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every structural problem with a candidate definition. Empty ⇒ publishable.
 */
export function contextSchemaDefinitionProblems(value: unknown): string[] {
  if (!isPlainObject(value)) {
    return ['definition must be a JSON object'];
  }

  const problems: string[] = [];

  for (const key of Object.keys(value)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      problems.push(`definition: unknown top-level key \`${key}\``);
    }
  }

  if (value.schemaVersion !== CONTEXT_SCHEMA_DEFINITION_VERSION) {
    problems.push(`definition.schemaVersion must be "${CONTEXT_SCHEMA_DEFINITION_VERSION}"`);
  }

  if (!Array.isArray(value.kinds)) {
    problems.push('definition.kinds must be an array');
    return problems;
  }
  if (value.kinds.length === 0) {
    problems.push('definition.kinds must declare at least one kind');
  }

  const outputs = value.outputs === undefined ? [] : value.outputs;
  if (!Array.isArray(outputs)) {
    problems.push('definition.outputs must be an array when present');
  }

  const declaredCount = value.kinds.length + (Array.isArray(outputs) ? outputs.length : 0);
  if (declaredCount > MAX_DECLARED_KINDS) {
    problems.push(`definition declares ${declaredCount} kinds/outputs, exceeding the maximum of ${MAX_DECLARED_KINDS}`);
  }

  const seenKindKeys = new Set<string>();
  value.kinds.forEach((kind, index) => problems.push(...kindProblems(kind, `definition.kinds[${index}]`, seenKindKeys)));

  if (Array.isArray(outputs)) {
    const seenOutputKeys = new Set<string>();
    outputs.forEach((output, index) => problems.push(...outputProblems(output, `definition.outputs[${index}]`, seenOutputKeys)));
  }

  return problems;
}

function kindProblems(kind: unknown, at: string, seen: Set<string>): string[] {
  const problems: string[] = [];
  if (!isPlainObject(kind)) {
    return [`${at}: must be a JSON object`];
  }

  for (const key of Object.keys(kind)) {
    if (!(KIND_KEYS as readonly string[]).includes(key)) {
      problems.push(`${at}: unknown key \`${key}\``);
    }
  }

  problems.push(...keyProblems(kind.key, at, seen));

  if (typeof kind.label !== 'string' || kind.label.trim().length === 0 || kind.label.length > 120) {
    problems.push(`${at}.label must be a non-empty string of at most 120 characters`);
  }

  // THE enforcement point: tenant vocabulary is free, the
  // substrate it maps onto is not.
  if (!(CONTEXT_PRIMITIVES as readonly unknown[]).includes(kind.primitive)) {
    problems.push(`${at}.primitive \`${String(kind.primitive)}\` is not one of ${CONTEXT_PRIMITIVES.join(' | ')}`);
  }

  problems.push(...enumProblems(kind.phiClass, CONTEXT_PHI_CLASSES, `${at}.phiClass`));
  problems.push(...enumProblems(kind.cardinality, CONTEXT_CARDINALITIES, `${at}.cardinality`));
  problems.push(...enumProblems(kind.lifecycle, CONTEXT_LIFECYCLES, `${at}.lifecycle`));

  if (!Array.isArray(kind.producedBy) || kind.producedBy.length === 0) {
    problems.push(`${at}.producedBy must be a non-empty array`);
  } else {
    const seenProducers = new Set<unknown>();
    kind.producedBy.forEach((producer, index) => {
      problems.push(...enumProblems(producer, CONTEXT_PRODUCERS, `${at}.producedBy[${index}]`));
      if (seenProducers.has(producer)) {
        problems.push(`${at}.producedBy: duplicate value \`${String(producer)}\``);
      }
      seenProducers.add(producer);
    });
  }

  if (kind.required !== undefined && typeof kind.required !== 'boolean') {
    problems.push(`${at}.required must be a boolean when present`);
  }
  if (kind.description !== undefined && typeof kind.description !== 'string') {
    problems.push(`${at}.description must be a string when present`);
  }

  // A STRUCTURED kind with no `fields` declares nothing — the payload could
  // not be validated at all, which is the whole point of the primitive.
  if (kind.primitive === 'STRUCTURED' && !isPlainObject(kind.fields)) {
    problems.push(`${at}.fields is required for a STRUCTURED kind`);
  }
  if (kind.fields !== undefined) {
    problems.push(...authorableJsonSchemaProblems(kind.fields, `${at}.fields`));
  }

  if (kind.constraints !== undefined) {
    problems.push(...constraintProblems(kind.constraints, `${at}.constraints`));
  }

  if (kind.deprecated !== undefined) {
    problems.push(...deprecatedProblems(kind.deprecated, `${at}.deprecated`));
  }

  return problems;
}

/** Validate a `kinds[].deprecated` block. */
function deprecatedProblems(deprecated: unknown, at: string): string[] {
  if (!isPlainObject(deprecated)) {
    return [`${at} must be a JSON object when present`];
  }

  const problems: string[] = [];
  for (const key of Object.keys(deprecated)) {
    if (!(DEPRECATED_KEYS as readonly string[]).includes(key)) {
      problems.push(`${at}: unknown key \`${key}\``);
    }
  }

  if (typeof deprecated.since !== 'string' || !ISO_DATE_PATTERN.test(deprecated.since)) {
    problems.push(`${at}.since is required and must be an ISO date (YYYY-MM-DD)`);
  }
  if (deprecated.migrateBy !== undefined && (typeof deprecated.migrateBy !== 'string' || !ISO_DATE_PATTERN.test(deprecated.migrateBy))) {
    problems.push(`${at}.migrateBy must be an ISO date (YYYY-MM-DD) when present`);
  }
  if (deprecated.message !== undefined && (typeof deprecated.message !== 'string' || deprecated.message.length > 500)) {
    problems.push(`${at}.message must be a string of at most 500 characters when present`);
  }

  return problems;
}

function outputProblems(output: unknown, at: string, seen: Set<string>): string[] {
  const problems: string[] = [];
  if (!isPlainObject(output)) {
    return [`${at}: must be a JSON object`];
  }

  for (const key of Object.keys(output)) {
    if (!(OUTPUT_KEYS as readonly string[]).includes(key)) {
      problems.push(`${at}: unknown key \`${key}\``);
    }
  }

  problems.push(...keyProblems(output.key, at, seen));

  if (!(CONTEXT_PRIMITIVES as readonly unknown[]).includes(output.primitive)) {
    problems.push(`${at}.primitive \`${String(output.primitive)}\` is not one of ${CONTEXT_PRIMITIVES.join(' | ')}`);
  }
  if (output.label !== undefined && typeof output.label !== 'string') {
    problems.push(`${at}.label must be a string when present`);
  }
  if (output.description !== undefined && typeof output.description !== 'string') {
    problems.push(`${at}.description must be a string when present`);
  }
  if (output.fields !== undefined) {
    problems.push(...authorableJsonSchemaProblems(output.fields, `${at}.fields`));
  }

  return problems;
}

function keyProblems(key: unknown, at: string, seen: Set<string>): string[] {
  if (typeof key !== 'string' || !CONTEXT_KIND_KEY_PATTERN.test(key)) {
    return [`${at}.key \`${String(key)}\` must match ${CONTEXT_KIND_KEY_PATTERN.source}`];
  }
  if (seen.has(key)) {
    return [`${at}.key: duplicate key \`${key}\``];
  }
  seen.add(key);
  return [];
}

function enumProblems(value: unknown, allowed: readonly string[], at: string): string[] {
  return (allowed as readonly unknown[]).includes(value) ? [] : [`${at} must be one of ${allowed.join(' | ')}`];
}

function constraintProblems(constraints: unknown, at: string): string[] {
  if (!isPlainObject(constraints)) {
    return [`${at} must be a JSON object when present`];
  }
  const problems: string[] = [];
  for (const key of Object.keys(constraints)) {
    if (!(CONSTRAINT_KEYS as readonly string[]).includes(key)) {
      problems.push(`${at}: unknown key \`${key}\``);
    }
  }
  if (constraints.mimeTypes !== undefined) {
    if (!Array.isArray(constraints.mimeTypes) || constraints.mimeTypes.some((entry) => typeof entry !== 'string')) {
      problems.push(`${at}.mimeTypes must be an array of strings`);
    }
  }
  if (constraints.maxBytes !== undefined) {
    if (typeof constraints.maxBytes !== 'number' || !Number.isInteger(constraints.maxBytes) || constraints.maxBytes <= 0) {
      problems.push(`${at}.maxBytes must be a positive integer`);
    }
  }
  return problems;
}

/**
 * TASK-890 §3.4 — the DERIVED payload schema of a context declaration: what a run's
 * `context.*` / `trigger.*` namespace actually looks like.
 *
 * One implementation, three consumers, deliberately: the workflow publish gate (a
 * `{{context.x}}` that no bound schema declares is a finding), the agent pin (the same
 * schema is FROZEN into `compiledConfig` so the runtime validates a request's `context`
 * without re-reading Postgres), and the console's variable chips. Two derivations would
 * eventually disagree about what a prompt may reference, which is the failure this
 * function exists to make impossible.
 *
 * The mapping:
 *
 *  - one property per declared KIND, keyed by its `key`;
 *  - a `STRUCTURED` kind contributes its own `fields` schema verbatim — it is already an
 *    authorable JSON Schema, validated at publish;
 *  - every other primitive contributes `{ type: 'object' }`, an open reference STUB: the
 *    platform decides that substrate's shape (a media reference, a transcript), so the
 *    schema declares that the name EXISTS without pretending to know its fields;
 *  - `required: true` kinds are listed in `required`, and the key is omitted entirely when
 *    no kind declares itself required (an empty `required: []` is noise in a checksummed,
 *    frozen artifact);
 *  - `outputs` are IGNORED — an output is produced BY the run, never supplied to it.
 *
 * `additionalProperties: false`: the declared kinds are the whole vocabulary, so a payload
 * carrying an undeclared one is a caller error rather than something to pass through
 * silently.
 *
 * Total: a definition this cannot read yields the empty object schema rather than throwing.
 * A caller that has no schema at all passes `null` to its own consumers instead — "unbound"
 * and "bound to a schema that declares nothing" are different facts and stay different here.
 */
export function payloadSchemaFromDefinition(definition: unknown): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  if (isPlainObject(definition) && Array.isArray(definition.kinds)) {
    for (const kind of definition.kinds) {
      if (!isPlainObject(kind) || typeof kind.key !== 'string' || kind.key.length === 0) continue;
      properties[kind.key] = kind.primitive === 'STRUCTURED' && isPlainObject(kind.fields) ? kind.fields : { type: 'object' };
      if (kind.required === true) required.push(kind.key);
    }
  }

  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * The `context.*` / `trigger.*` namespace ROOT of the §3.3 render scope.
 *
 * Named once so the unwrap rule below, the Python mirror (`_prompt_scope` in
 * `apps/harness/.../interpreter/nodes/core.py`) and the seed's `LEGACY_CONTEXT_KIND_KEY` cannot
 * drift on the spelling.
 */
export const CONTEXT_NAMESPACE_ROOT = 'context';

/**
 * J3-5 — the payload schema of a declaration whose ENVELOPE adds nothing, or `null`.
 *
 * {@link payloadSchemaFromDefinition} keys the payload under each declared kind, which is right
 * whenever a schema declares several: `{ audio: …, patient: … }` is genuinely an envelope and
 * the key is the only thing saying which kind a value belongs to.
 *
 * It is wrong for EXACTLY ONE case, and that case is the one the platform seeds. The bridge
 * schema `consultation_legacy_v1` declares a single kind keyed `context`, so the envelope is
 * `{ context: { safe_age, … } }` while every seeded template reads `{{context.safe_age}}` and
 * the render scope aliases `context` to the envelope — the reference resolves to nothing and the
 * only spelling that could work is `{{context.context.safe_age}}`. The seed ships that pairing,
 * so the seeded combination could not run on an agent at all.
 *
 * The rule is therefore as narrow as the problem: ONE kind, and its key is the namespace root.
 * Then the kind IS the context and the wrapper carries no information. Anything else — several
 * kinds, or one kind under a different name — is returned as `null` and stays verbatim.
 */
export function soleContextKindSchema(payloadSchema: unknown): Record<string, unknown> | null {
  if (!isPlainObject(payloadSchema)) return null;
  const properties = payloadSchema.properties;
  if (!isPlainObject(properties)) return null;
  const keys = Object.keys(properties);
  if (keys.length !== 1 || keys[0] !== CONTEXT_NAMESPACE_ROOT) return null;
  const kindSchema = properties[CONTEXT_NAMESPACE_ROOT];
  return isPlainObject(kindSchema) ? kindSchema : null;
}

/**
 * The object a `context.*` reference resolves against, given a supplied payload.
 *
 * Under the {@link soleContextKindSchema} rule both call shapes converge here: an invocation
 * caller sends the FLAT kind object, and a workflow run's validated trigger is the ENVELOPE —
 * one unwrap answers both, so the same agent prompt renders identically on the invocation route,
 * the draft bench, the realtime lane and the durable lane.
 *
 * The envelope is recognised only when it is UNAMBIGUOUS: an object whose sole key is
 * `context` and whose value is itself an object. A flat payload that merely happens to carry a
 * `context` field alongside others is left alone rather than guessed at.
 */
export function unwrapSingleKindContextPayload(payloadSchema: unknown, payload: unknown): unknown {
  if (soleContextKindSchema(payloadSchema) === null) return payload;
  if (!isPlainObject(payload)) return payload;
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== CONTEXT_NAMESPACE_ROOT) return payload;
  const inner = payload[CONTEXT_NAMESPACE_ROOT];
  return isPlainObject(inner) ? inner : payload;
}

/** The declared kind with this key, or undefined. */
export function findKind(definition: unknown, kindKey: string): ContextKindDeclaration | undefined {
  if (!isPlainObject(definition) || !Array.isArray(definition.kinds)) return undefined;
  return (definition.kinds as ContextKindDeclaration[]).find((kind) => isPlainObject(kind) && kind.key === kindKey);
}

/**
 * Canonical JSON: object keys sorted, array order PRESERVED. Key order is a
 * formatting accident and must not create a new version; array order is
 * authored intent (the order kinds are presented in) and must.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * sha256 over the canonical JSON. Drives BOTH the idempotent-republish check
 * (identical checksum ⇒ no new version, pin unmoved) and the discovery ETag,
 * deliberately from one implementation — two would eventually disagree about
 * whether anything changed.
 */
export function computeDefinitionChecksum(definition: unknown): string {
  return createHash('sha256').update(canonicalJson(definition)).digest('hex');
}

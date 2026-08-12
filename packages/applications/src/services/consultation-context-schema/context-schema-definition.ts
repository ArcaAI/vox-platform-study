import { createHash } from 'node:crypto';
import { authorableJsonSchemaProblems } from '@arcaai/json-schema-subset';

/**
 * TASK-658 — the shape of a `ConsultationContextSchemaVersion.definition`, and
 * the validator that decides whether a tenant may publish one.
 *
 * ## The load-bearing idea (TASK-654 D2 / §4.1)
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
/** TASK-661 — the only keys a `deprecated` block may carry. */
const DEPRECATED_KEYS = ['since', 'migrateBy', 'message'] as const;
/** `YYYY-MM-DD`, deliberately loose (a calendar date, not a full timestamp). */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * TASK-661 — deprecation signalling for a kind, authored INSIDE the same
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

  // THE enforcement point (TASK-654 §4.1): tenant vocabulary is free, the
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

/** TASK-661 — validate a `kinds[].deprecated` block. */
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

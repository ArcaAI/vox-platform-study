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
 *
 * ## The `userIdentity` marker is a MAPPING declaration, never authorization
 *
 * TASK-950 D-1 lets a kind name ONE of its own string properties as the field
 * carrying the tenant's staff identifier ({@link userIdentityBindingFromDefinition}).
 * That is a reversal of TASK-933 §2.3 in exactly one respect — the schema may now say
 * WHICH field holds the identifier — and in no other: the marker authorizes nobody
 * (a caller is still authorized by its own credential's scopes and abilities), it
 * changes no payload contract ({@link payloadSchemaFromDefinition} is byte-identical
 * with and without it), and the row column every consumer reads is still the one the
 * gateway writes. It declares a MAPPING from a declared field to
 * `UserProfile.staffId`, and nothing more.
 *
 * ## The OPEN-TIME markers generalise that idea, one key per role
 *
 * TASK-951 D-1/OD-10 adds four siblings to `userIdentity`, in the same grammar and for the
 * same reason: a client states a fact in a kind it already declares, and the schema says what
 * HOPE does with it at `open`.
 *
 * | Marker | Declares | Shape |
 * |---|---|---|
 * | `userIdentity` | the field carrying the tenant's staff identifier | `{ field }` |
 * | `department` | the field naming the department that selects the workflow | `{ field, by: 'code' \| 'name' }` |
 * | `visitType` | the field stating the visit type that selects the prompt | `{ field }` |
 * | `externalRef` | the field carrying the caller's own encounter/event id | `{ field }` |
 * | `streamContext` | that this kind IS the stream-identity object echoed on transcripts | `true` |
 * | `materializeAs` | that this kind is ALSO written as platform context items | `'CASE_NOTE'` |
 *
 * Five of the six are **one per definition** — a second `department` is not a fault of either
 * kind, it is a fault of the pair, so it is a DEFINITION-level problem. `materializeAs` is
 * deliberately not: several kinds may each materialise, because materialising is a property of
 * the kind's own payload rather than a role only one kind can hold.
 *
 * Everything the `userIdentity` paragraph above says still holds for all six: they authorize
 * nobody, {@link payloadSchemaFromDefinition} is byte-identical with and without them, and a
 * definition-diff classifies adding, moving or removing one as ADDITIVE — they name properties
 * a client already sends, so no previously valid payload stops being valid.
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
  'userIdentity',
  'department',
  'visitType',
  'externalRef',
  'materializeAs',
  'streamContext',
] as const;
const OUTPUT_KEYS = ['key', 'label', 'primitive', 'fields', 'description'] as const;
const CONSTRAINT_KEYS = ['mimeTypes', 'maxBytes'] as const;
/** The only keys a `deprecated` block may carry. */
const DEPRECATED_KEYS = ['since', 'migrateBy', 'message'] as const;
/** The only keys a `userIdentity` block may carry. */
const USER_IDENTITY_KEYS = ['field'] as const;
/** The only keys a `department` block may carry. `by` is REQUIRED — see {@link DEPARTMENT_RESOLVE_BY}. */
const DEPARTMENT_KEYS = ['field', 'by'] as const;
/**
 * TASK-951 D-2 — how a stated department is looked up. `code` is unique per tenant
 * (`@@unique([tenantId, code])`); `name` is NOT, so it resolves case-insensitively and answers
 * `DEPARTMENT_AMBIGUOUS` on more than one match. Which of the two a schema declares is an
 * authoring decision and therefore REQUIRED — a marker that left it unstated would make the
 * resolution rule depend on a default nobody wrote down.
 */
const DEPARTMENT_RESOLVE_BY = ['code', 'name'] as const;
/** The only keys a `visitType` block may carry. */
const VISIT_TYPE_KEYS = ['field'] as const;
/** The only keys an `externalRef` block may carry. */
const EXTERNAL_REF_KEYS = ['field'] as const;
/**
 * TASK-951 D-3 — the visit-type KEYS a `visitType`-marked property may enumerate.
 *
 * A deliberate HARD PIN of the two keys in
 * `packages/applications/src/services/consultation/visit-type/visit-type.catalogue.ts`
 * (`CONSULTATION_VISIT_TYPES_DEFAULT` — `new-visit`, `revisit`), NOT an import: this module is the
 * publish-time grammar and importing the consultation catalogue would make a schema
 * definition depend on the consultation service tree. The catalogue is the source of truth;
 * this list mirrors it, and the mirror is pinned by test. Aliases (`follow-up`,
 * `new-patient`, …) are for `VisitTypeService.match` at RUNTIME — a schema declares the
 * canonical keys so the console can render a fixed picker.
 */
const CONTEXT_VISIT_TYPE_KEYS = ['new-visit', 'revisit'] as const;
/** The only values `materializeAs` may take. Extending it is a platform change, never a tenant one. */
const CONTEXT_MATERIALIZE_TARGETS = ['CASE_NOTE'] as const;
/**
 * The kind-level markers that name a ROLE only ONE kind in a definition may hold.
 *
 * `materializeAs` is deliberately ABSENT: materialising is a property of a kind's own payload,
 * not a role, so several kinds may each declare it.
 */
const SINGLETON_KIND_ROLES = ['userIdentity', 'department', 'visitType', 'externalRef', 'streamContext'] as const;
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

/**
 * TASK-950 D-1/D-3 — WHERE the tenant's staff identifier is carried, resolved from a
 * definition by {@link userIdentityBindingFromDefinition}.
 *
 * `kindKey` names the declared kind, `field` one of that kind's own `fields.properties`.
 * Both halves are needed because a payload is keyed by kind
 * ({@link payloadSchemaFromDefinition}), so the field alone would not locate a value.
 */
export interface UserIdentityBinding {
  kindKey: string;
  field: string;
}

/**
 * TASK-951 D-1 — WHERE one open-time fact is carried: a declared kind, and one of that kind's
 * own `fields.properties`.
 *
 * The same two halves {@link UserIdentityBinding} carries, and for the same reason — a payload
 * is keyed by kind ({@link payloadSchemaFromDefinition}), so the field alone would not locate a
 * value. Named separately rather than reusing `UserIdentityBinding` because the two say
 * different things: that one is about identity, this one is the shape every ROLE shares.
 */
export interface KindFieldBinding {
  kindKey: string;
  field: string;
}

/**
 * TASK-951 D-1 — every open-time mapping a definition declares, derived in one pass by
 * {@link openBindingsFromDefinition}.
 *
 * **A key is ABSENT when the definition declares no marker for that role.** Never `null`,
 * never an empty array: this object is frozen into checksummed artifacts (an agent's
 * `compiledConfig`, a workflow's compiled trigger), so a key that always appeared would move
 * the checksum of every artifact that never used it.
 *
 * `userIdentity` is restated here rather than left to
 * {@link userIdentityBindingFromDefinition} so a consumer reading open-time mappings reads ONE
 * object. The older accessor stays — it is what TASK-950's freeze sites call, and it answers
 * `null` where this one omits the key.
 */
export interface OpenBindings {
  /** The field carrying the tenant's staff identifier (TASK-950's marker, restated). */
  userIdentity?: KindFieldBinding;
  /** The field naming the department, and HOW to look it up. */
  department?: KindFieldBinding & { by: 'code' | 'name' };
  /** The field stating the visit type, whose values are visit-type catalogue keys. */
  visitType?: KindFieldBinding;
  /** The field carrying the caller's own encounter/event id. */
  externalRef?: KindFieldBinding;
  /**
   * Kinds that are ALSO written as platform context items, in DECLARATION order.
   *
   * A list, not a single binding: materialising is a property of a kind's payload rather than
   * a role only one kind may hold. Omitted entirely when no kind declares one.
   */
  materialize?: { kindKey: string; as: 'CASE_NOTE' }[];
  /** The kind that IS the stream-identity object echoed on every transcript segment. */
  streamContext?: { kindKey: string };
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
  /**
   * TASK-950 D-1 — this kind's `fields.properties[field]` carries the tenant's staff
   * identifier. At most ONE kind in a definition may declare it, and only a `STRUCTURED`
   * kind with `cardinality: 'ONE'` can (a stream, a document or a repeated kind has no
   * single property to read an identifier out of).
   *
   * A MAPPING declaration, never authorization — see the module docstring. PRESENCE is
   * still governed by the schema's own `required` flags (D-2): the marker says what to do
   * with a value when there is one, never that there must be one.
   */
  userIdentity?: { field: string };
  /**
   * TASK-951 D-1/D-2 — this kind's `fields.properties[field]` names the DEPARTMENT that
   * selects the consultation workflow, looked up `by` code (unique per tenant) or name
   * (case-insensitive, ambiguous on duplicates). `by` is required — see
   * {@link DEPARTMENT_RESOLVE_BY}.
   */
  department?: { field: string; by: 'code' | 'name' };
  /**
   * TASK-951 D-1/D-3 — this kind's `fields.properties[field]` states the VISIT TYPE that
   * selects the prompt. The named property must declare an `enum` whose every value is a
   * visit-type catalogue key ({@link CONTEXT_VISIT_TYPE_KEYS}).
   */
  visitType?: { field: string };
  /**
   * TASK-951 D-1/D-4 — this kind's `fields.properties[field]` carries the CALLER's own
   * encounter/event id. Recorded against the consultation; never part of the re-open
   * idempotency key.
   */
  externalRef?: { field: string };
  /**
   * TASK-951 D-5 — this kind's payload is ALSO written as platform context items of the named
   * type. `CASE_NOTE` requires the payload to be `{ notes: [{ text, … }] }` (one item per
   * entry), which is what makes the existing warm-start `findCaseNotes()` read see them.
   *
   * Unlike the five role markers, SEVERAL kinds in one definition may declare this.
   */
  materializeAs?: 'CASE_NOTE';
  /**
   * TASK-951 D-8 — this kind IS the stream-identity object: what a client sends when it
   * creates an STT stream session, echoed VERBATIM on every transcript segment of that
   * session. Literally `true`; there is nothing else to configure.
   */
  streamContext?: true;
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

  // TASK-950 D-1, generalised over the five roles by TASK-951 OD-10 — a DEFINITION-level
  // invariant, so it cannot be checked per kind: a second marker is not a fault of either
  // kind, it is a fault of the pair. One problem PER ROLE naming both, because the admin has
  // to choose between them, and one problem per role rather than one for all of them because
  // the two choices are independent.
  //
  // `materializeAs` is deliberately not in this list — see SINGLETON_KIND_ROLES.
  for (const role of SINGLETON_KIND_ROLES) {
    const markedKindKeys = value.kinds
      .filter((kind): kind is Record<string, unknown> => isPlainObject(kind) && kind[role] !== undefined)
      .map((kind) => (typeof kind.key === 'string' ? kind.key : String(kind.key)));
    if (markedKindKeys.length > 1) {
      problems.push(
        `definition: at most one kind may declare \`${role}\`; ${markedKindKeys.length} do (${markedKindKeys.map((key) => `\`${key}\``).join(', ')})`,
      );
    }
  }

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

  if (kind.userIdentity !== undefined) {
    problems.push(...userIdentityProblems(kind.userIdentity, kind, `${at}.userIdentity`));
  }
  if (kind.department !== undefined) {
    problems.push(...departmentProblems(kind.department, kind, `${at}.department`));
  }
  if (kind.visitType !== undefined) {
    problems.push(...visitTypeProblems(kind.visitType, kind, `${at}.visitType`));
  }
  if (kind.externalRef !== undefined) {
    problems.push(...fieldMarkerProblems(kind.externalRef, kind, `${at}.externalRef`, EXTERNAL_REF_KEYS).problems);
  }
  if (kind.materializeAs !== undefined) {
    problems.push(...materializeAsProblems(kind.materializeAs, kind, `${at}.materializeAs`));
  }
  if (kind.streamContext !== undefined) {
    problems.push(...streamContextProblems(kind.streamContext, kind, `${at}.streamContext`));
  }

  return problems;
}

/**
 * TASK-950 D-1, TASK-951 D-1 — the HOST checks every kind-level marker shares.
 *
 * A marker points at (or stands for) a single object the caller sends, so the primitive
 * decides whether there IS a property table and the cardinality decides whether one value is
 * even meaningful. Both are checked at AUTHORING time rather than anywhere later, because a
 * mapping that cannot be located is a defect the author can fix and a live consultation
 * cannot.
 */
function markerHostProblems(kind: Record<string, unknown>, at: string): string[] {
  const problems: string[] = [];
  if (kind.primitive !== 'STRUCTURED') {
    problems.push(`${at} is only allowed on a STRUCTURED kind (this kind is \`${String(kind.primitive)}\`)`);
  }
  if (kind.cardinality !== 'ONE') {
    problems.push(`${at} is only allowed on a kind with cardinality ONE (this kind is \`${String(kind.cardinality)}\`)`);
  }
  return problems;
}

/**
 * The shape shared by `userIdentity`, `department`, `visitType` and `externalRef`: an object
 * whose `field` names a `string` property of the kind's own `fields.properties`.
 *
 * Returns the DECLARED property schema alongside the problems, so a caller with a further
 * constraint on it (`visitType`'s enum) checks the same object this resolved rather than
 * walking `fields.properties` a second time.
 */
function fieldMarkerProblems(
  marker: unknown,
  kind: Record<string, unknown>,
  at: string,
  allowedKeys: readonly string[],
): { problems: string[]; declared?: Record<string, unknown> } {
  if (!isPlainObject(marker)) {
    return { problems: [`${at} must be a JSON object when present`] };
  }

  const problems: string[] = [];
  for (const key of Object.keys(marker)) {
    if (!allowedKeys.includes(key)) {
      problems.push(`${at}: unknown key \`${key}\``);
    }
  }

  problems.push(...markerHostProblems(kind, at));

  const field = marker.field;
  if (typeof field !== 'string' || field.trim().length === 0) {
    problems.push(`${at}.field must be a non-empty string naming a property of \`fields.properties\``);
    return { problems };
  }

  const fields = kind.fields;
  const properties = isPlainObject(fields) ? fields.properties : undefined;
  const declared = isPlainObject(properties) ? properties[field] : undefined;
  if (declared === undefined) {
    problems.push(`${at}.field \`${field}\` names a property that \`fields.properties\` does not declare`);
    return { problems };
  }
  if (!isPlainObject(declared) || declared.type !== 'string') {
    problems.push(`${at}.field \`${field}\` must name a property of type \`string\``);
    return { problems };
  }

  return { problems, declared };
}

/**
 * TASK-950 D-1 — validate a `kinds[].userIdentity` marker AGAINST ITS OWN KIND.
 *
 * The marker points at a property of the kind it sits on, so it cannot be checked in
 * isolation: the primitive decides whether there IS a property table, the cardinality
 * decides whether one value is even meaningful, and `fields.properties` decides whether
 * the named property exists and is a string. All four are checked here rather than
 * anywhere later, because an identifier that cannot be located is a defect the AUTHOR can
 * fix and a live consultation cannot.
 */
function userIdentityProblems(marker: unknown, kind: Record<string, unknown>, at: string): string[] {
  return fieldMarkerProblems(marker, kind, at, USER_IDENTITY_KEYS).problems;
}

/**
 * TASK-951 D-2 — `kinds[].department`: the field marker plus a REQUIRED `by`.
 *
 * `by` is checked even when the field half failed, because the two are independent authoring
 * mistakes and an admin fixing a large definition should see both at once.
 */
function departmentProblems(marker: unknown, kind: Record<string, unknown>, at: string): string[] {
  const { problems } = fieldMarkerProblems(marker, kind, at, DEPARTMENT_KEYS);
  if (!isPlainObject(marker)) return problems;

  if (!(DEPARTMENT_RESOLVE_BY as readonly unknown[]).includes(marker.by)) {
    problems.push(`${at}.by is required and must be one of ${DEPARTMENT_RESOLVE_BY.join(' | ')}`);
  }
  return problems;
}

/**
 * TASK-951 D-3 — `kinds[].visitType`: the field marker, plus the ENUM the named property must
 * declare.
 *
 * The enum is what makes a stated visit type resolvable: HOPE matches it through
 * `VisitTypeService.match` at runtime, so a schema enumerating a value the catalogue has never
 * heard of would publish cleanly and then fail at `open`. Checking the enum here moves that to
 * authoring time. Values are the CANONICAL keys ({@link CONTEXT_VISIT_TYPE_KEYS}); aliases are
 * a runtime matching concern, not a declarable vocabulary.
 */
function visitTypeProblems(marker: unknown, kind: Record<string, unknown>, at: string): string[] {
  const { problems, declared } = fieldMarkerProblems(marker, kind, at, VISIT_TYPE_KEYS);
  if (declared === undefined) return problems;

  const values = declared.enum;
  if (!Array.isArray(values) || values.length === 0) {
    problems.push(`${at}.field must name a property declaring a non-empty \`enum\` of ${CONTEXT_VISIT_TYPE_KEYS.join(' | ')}`);
    return problems;
  }

  const unknownValues = values.filter((value) => !(CONTEXT_VISIT_TYPE_KEYS as readonly unknown[]).includes(value));
  if (unknownValues.length > 0) {
    problems.push(
      `${at}.field declares enum value(s) ${unknownValues.map((value) => `\`${String(value)}\``).join(', ')} that are not visit types (${CONTEXT_VISIT_TYPE_KEYS.join(' | ')})`,
    );
  }
  return problems;
}

/**
 * TASK-951 D-5 — `kinds[].materializeAs`: the target, and the PAYLOAD SHAPE it implies.
 *
 * `CASE_NOTE` means "write one `CASE_NOTE` context item per entry", so the payload has to BE a
 * list of entries each carrying text. Declaring the target without that shape would produce a
 * kind HOPE accepts at publish and cannot materialise at `open` — the shape is checked here
 * for exactly the reason the field markers are.
 */
function materializeAsProblems(marker: unknown, kind: Record<string, unknown>, at: string): string[] {
  if (!(CONTEXT_MATERIALIZE_TARGETS as readonly unknown[]).includes(marker)) {
    return [`${at} must be one of ${CONTEXT_MATERIALIZE_TARGETS.join(' | ')}`];
  }

  const problems = markerHostProblems(kind, at);

  const fields = kind.fields;
  if (!isPlainObject(fields) || fields.type !== 'object') {
    problems.push(`${at} requires \`fields\` to be an object schema`);
    return problems;
  }
  const properties = isPlainObject(fields.properties) ? fields.properties : undefined;
  const notes = properties !== undefined && isPlainObject(properties.notes) ? properties.notes : undefined;
  if (notes === undefined || notes.type !== 'array') {
    problems.push(`${at} requires \`fields.properties.notes\` to be an array`);
    return problems;
  }
  const items = isPlainObject(notes.items) ? notes.items : undefined;
  if (items === undefined || items.type !== 'object') {
    problems.push(`${at} requires \`fields.properties.notes.items\` to be an object schema`);
    return problems;
  }
  const itemProperties = isPlainObject(items.properties) ? items.properties : undefined;
  const text = itemProperties !== undefined && isPlainObject(itemProperties.text) ? itemProperties.text : undefined;
  if (text === undefined || text.type !== 'string') {
    problems.push(`${at} requires \`fields.properties.notes.items.properties.text\` to be a property of type \`string\``);
  }
  const required = Array.isArray(items.required) ? items.required : [];
  if (!required.includes('text')) {
    problems.push(`${at} requires \`fields.properties.notes.items.required\` to include \`text\``);
  }
  return problems;
}

/**
 * TASK-951 D-8 — `kinds[].streamContext`: literally `true`, on a STRUCTURED/ONE kind.
 *
 * `true` rather than an object because there is nothing to configure: the kind IS the
 * echoed object, whole. `false` is rejected rather than treated as absent — a marker that
 * can be written two ways to mean the same thing is a marker two readers will disagree about.
 */
function streamContextProblems(marker: unknown, kind: Record<string, unknown>, at: string): string[] {
  if (marker !== true) {
    return [`${at} must be \`true\` when present`];
  }
  return markerHostProblems(kind, at);
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
 * TASK-950 D-3 — {@link userIdentityBindingFromDefinition} is the SECOND derivation off the
 * same definition, and it is a sibling rather than a branch of this one for the reason
 * above: the two answer different questions ("what may a payload contain" vs "which field
 * carries the staff identifier"), and both are frozen at the same two moments — agent
 * publish and workflow compile. This function's OUTPUT is unaffected by the marker: a
 * `userIdentity` block lives on the KIND, never inside `fields`, so a definition's payload
 * schema is byte-identical with and without it and no frozen artifact's checksum moves.
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
 * TASK-950 D-3 — WHERE a payload carries the tenant's staff identifier, or `null`.
 *
 * The one implementation of the binding derivation, beside
 * {@link payloadSchemaFromDefinition} and frozen by the same two callers (agent publish,
 * workflow compile) so no plane re-reads a schema row at run time. A second copy of these
 * few lines would eventually disagree about which field HOPE resolves a user from, which
 * is the whole reason this lives here rather than at each call site.
 *
 * TOTAL, like its sibling: a definition this cannot read yields `null` rather than
 * throwing. The publish gate ({@link contextSchemaDefinitionProblems}) already refused
 * anything malformed, so `null` here means "this schema declares no identity field" — a
 * fact in its own right, never "unknown". At most one kind can carry the marker (the
 * definition-level gate), so the first match IS the answer.
 */
export function userIdentityBindingFromDefinition(definition: unknown): UserIdentityBinding | null {
  if (!isPlainObject(definition) || !Array.isArray(definition.kinds)) return null;

  for (const kind of definition.kinds) {
    if (!isPlainObject(kind) || typeof kind.key !== 'string' || kind.key.length === 0) continue;
    const marker = kind.userIdentity;
    if (!isPlainObject(marker)) continue;
    const field = marker.field;
    if (typeof field !== 'string' || field.length === 0) continue;
    return { kindKey: kind.key, field };
  }

  return null;
}

/**
 * TASK-951 D-1 — EVERY open-time mapping a definition declares, in ONE pass.
 *
 * The THIRD derivation off the same definition, beside
 * {@link payloadSchemaFromDefinition} and {@link userIdentityBindingFromDefinition}, and a
 * sibling of both for the same reason they are siblings of each other: they answer different
 * questions off one document, and all of them are frozen at the same two moments (agent
 * publish, workflow compile) so no plane re-reads a schema row at run time.
 *
 * One function rather than five accessors because the CALLER wants all of them: `open` reads
 * every mapping the tenant declared and acts on each. Five accessors would walk `kinds` five
 * times and, worse, would let a later change teach one of them a rule the others never learnt.
 *
 * Two properties the freeze sites depend on:
 *
 *  - **TOTAL.** A definition this cannot read yields `{}` rather than throwing — the publish
 *    gate already refused anything malformed, so an unreadable marker here means "not
 *    declared", never "unknown". A `department` whose `by` is neither `code` nor `name` is
 *    skipped for the same reason: the gate refuses it, so honouring it would mean inventing a
 *    resolution rule no author wrote.
 *  - **Keys are ABSENT when unset**, never `null` and never `[]`. The result is frozen into
 *    checksummed artifacts; a key that always appeared would move the checksum of every
 *    artifact that declares no mappings, including the committed seed agents.
 *
 * At most one kind may hold each of the five ROLES (the definition-level gate), so the first
 * match IS the answer for those. `materialize` is a LIST in declaration order, because several
 * kinds may each materialise.
 */
export function openBindingsFromDefinition(definition: unknown): OpenBindings {
  const bindings: OpenBindings = {};
  if (!isPlainObject(definition) || !Array.isArray(definition.kinds)) return bindings;

  const materialize: { kindKey: string; as: 'CASE_NOTE' }[] = [];

  for (const kind of definition.kinds) {
    if (!isPlainObject(kind) || typeof kind.key !== 'string' || kind.key.length === 0) continue;
    const kindKey = kind.key;

    const userIdentityField = markedField(kind.userIdentity);
    if (userIdentityField !== null && bindings.userIdentity === undefined) {
      bindings.userIdentity = { kindKey, field: userIdentityField };
    }

    const departmentMarker = kind.department;
    const departmentField = markedField(departmentMarker);
    const by = isPlainObject(departmentMarker) ? departmentMarker.by : undefined;
    if (departmentField !== null && (DEPARTMENT_RESOLVE_BY as readonly unknown[]).includes(by) && bindings.department === undefined) {
      bindings.department = { kindKey, field: departmentField, by: by as 'code' | 'name' };
    }

    const visitTypeField = markedField(kind.visitType);
    if (visitTypeField !== null && bindings.visitType === undefined) {
      bindings.visitType = { kindKey, field: visitTypeField };
    }

    const externalRefField = markedField(kind.externalRef);
    if (externalRefField !== null && bindings.externalRef === undefined) {
      bindings.externalRef = { kindKey, field: externalRefField };
    }

    if (kind.streamContext === true && bindings.streamContext === undefined) {
      bindings.streamContext = { kindKey };
    }

    const materializeAs = kind.materializeAs;
    if ((CONTEXT_MATERIALIZE_TARGETS as readonly unknown[]).includes(materializeAs)) {
      materialize.push({ kindKey, as: materializeAs as 'CASE_NOTE' });
    }
  }

  if (materialize.length > 0) bindings.materialize = materialize;

  return bindings;
}

/** The `field` of a `{ field }`-shaped marker, or `null` when there is no usable one. */
function markedField(marker: unknown): string | null {
  if (!isPlainObject(marker)) return null;
  const field = marker.field;
  return typeof field === 'string' && field.length > 0 ? field : null;
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

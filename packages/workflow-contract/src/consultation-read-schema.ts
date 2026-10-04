/**
 * TASK-1036 §9.3 (OD-30 / OD-31 / OD-34) — the `consultation.*` READ SCHEMA.
 *
 * Today consultation data reaches a prompt as eleven FLAT, gateway-derived `context.<name>`
 * strings (`platform-context-variables.ts`), bound three different ways by three lanes, with a
 * PHI class per variable rather than per field. This module replaces that vocabulary with one
 * typed, versioned, platform-owned read model:
 *
 *  - **Platform-owned CONFIGURATION, not tenant content** (OD-34). It ships with this package,
 *    is never cloned into a tenant, and changes only by a new `CONSULTATION_READ_SCHEMA_V<n>`.
 *  - **Every leaf carries `x-phiClass`** (`PHI` / `NON_PHI`), so a picker can badge it, a trace
 *    can hide it and an audit can say which PHI a node read. A container is PHI when anything
 *    beneath it is (`consultationPathInfo`). The classification is conservative: dates tied to an
 *    encounter and every clinical value are PHI; only opaque ids, codes and configuration are not.
 *  - **Read-only** (OD-31). A node writes to the consultation only through an explicit action node;
 *    nothing here is a write path.
 *  - **Declared reads** (§9.3). `declaredConsultationReads(graph)` is the exact set of paths each
 *    node references, so the harness fetches only those (least privilege, small payloads), at node
 *    start by default or at run start when the binding says so (OD-30).
 *
 * `PLATFORM_CONTEXT_ALIASES` maps each of the eleven flat names onto its read-schema path, with
 * the formatting the gateway applies today, for the one-release deprecation of the flat names.
 *
 * Mirrored in Python (lane B1) against `tests/contracts/consultation-read-schema.fixture.json`.
 */
import type { WorkflowGraph } from './graph-model';
import { ioTypeOfJsonSchema, type IoType, type PhiClass } from './node-io';
import { templateReferences } from './template';

type JsonSchema = Readonly<Record<string, unknown>>;

export const CONSULTATION_READ_SCHEMA_VERSION = 1 as const;

/** The binding/template root this schema is published under. */
export const CONSULTATION_ROOT = 'consultation';

function leaf(
  type: 'string' | 'integer' | 'number' | 'boolean',
  phiClass: PhiClass,
  description: string,
  extra: Record<string, unknown> = {},
): JsonSchema {
  return Object.freeze({ type, ...extra, description, 'x-phiClass': phiClass });
}

function object(description: string, properties: Record<string, JsonSchema>): JsonSchema {
  return Object.freeze({ type: 'object', additionalProperties: false, description, properties: Object.freeze(properties) });
}

function list(description: string, items: JsonSchema): JsonSchema {
  return Object.freeze({ type: 'array', description, items });
}

const PHI = 'PHI' as const;
const NON_PHI = 'NON_PHI' as const;

const ATTACHMENT = object('A file attached to the consultation, by reference.', {
  mediaId: leaf('string', NON_PHI, 'The stored media id (a reference, never the bytes).'),
  mime: leaf('string', NON_PHI, 'The media type (`text/plain`, `text/markdown`, `application/pdf`, `image/jpeg`).'),
  name: leaf('string', PHI, 'The file name as uploaded — may name the patient.'),
  size: leaf('integer', NON_PHI, 'Size in bytes.'),
});

const VITAL = object('One measured vital sign.', {
  name: leaf('string', NON_PHI, 'The vital measured (blood pressure, pulse, temperature, …).'),
  value: leaf('string', PHI, 'The measured value, as recorded.'),
  unit: leaf('string', NON_PHI, 'The unit of the value.'),
  measuredAt: leaf('string', PHI, 'When it was measured.', { format: 'date-time' }),
});

const TEST_RESULT = object('One investigation result.', {
  name: leaf('string', PHI, 'The investigation (a test name can itself disclose a condition).'),
  value: leaf('string', PHI, 'The result value, as reported.'),
  unit: leaf('string', NON_PHI, 'The unit of the value.'),
  flag: leaf('string', PHI, 'Abnormal flag or reference-range note, when reported.'),
  takenAt: leaf('string', PHI, 'When the sample was taken or the result reported.', { format: 'date-time' }),
});

const PREVIOUS_VISIT = object('One earlier visit of this patient.', {
  consultationId: leaf('string', NON_PHI, 'The earlier consultation`s id.'),
  date: leaf('string', PHI, 'When the visit took place.', { format: 'date' }),
  department: leaf('string', NON_PHI, 'The department of that visit.'),
  summary: leaf('string', PHI, 'That visit`s note or summary.'),
});

const SEGMENT = object('One transcribed utterance.', {
  text: leaf('string', PHI, 'What was said.'),
  speaker: leaf('string', PHI, 'Who said it (a diarization label or a role).'),
  start: leaf('number', NON_PHI, 'Seconds from the capture start.'),
  end: leaf('number', NON_PHI, 'Seconds from the capture start.'),
});

const ITEM = object('One context item of the consultation, in arrival order.', {
  id: leaf('string', NON_PHI, 'The context item id.'),
  kind: leaf('string', NON_PHI, 'What the item is.', { enum: Object.freeze(['CASE_NOTE', 'ATTACHMENT', 'VITALS', 'TEST_RESULT', 'PRIOR_VISIT']) }),
  text: leaf('string', PHI, 'The item`s text content (a case note, a formatted result).'),
  createdAt: leaf('string', PHI, 'When the item was added.', { format: 'date-time' }),
  attachment: ATTACHMENT,
});

/**
 * Version 1 of the read schema. Structure follows §9.3; `outputLanguage` is an addition the
 * alias map needs — the flat `language_name` is the language the NOTE is written in, which is not
 * the SPOKEN `language` of the consultation (TASK-1001 OD-12).
 */
export const CONSULTATION_READ_SCHEMA_V1: JsonSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/consultation-read-schema.v1.json',
  title: 'consultation.* — the platform read model of one consultation (v1)',
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    id: leaf('string', NON_PHI, 'The consultation id.'),
    visitType: leaf('string', NON_PHI, 'The visit type (for example `new-visit`, `revisit`).'),
    department: object('The consultation`s department.', {
      id: leaf('string', NON_PHI, 'The department id.'),
      code: leaf('string', NON_PHI, 'The department code.'),
      name: leaf('string', NON_PHI, 'The department name.'),
    }),
    language: leaf('string', NON_PHI, 'The SPOKEN language of the consultation (for example `en`, `ml-en`).'),
    outputLanguage: object('The language the note is written in (the tenant`s output-language policy).', {
      code: leaf('string', NON_PHI, 'The language code.'),
      name: leaf('string', NON_PHI, 'The language name (for example `English`).'),
    }),
    patient: object('The patient, as held on the consultation.', {
      age: leaf('integer', PHI, 'Age in years.'),
      gender: leaf('string', PHI, 'Gender, as recorded.'),
      dob: leaf('string', PHI, 'Date of birth.', { format: 'date' }),
    }),
    clinician: object('The treating clinician.', {
      dna: object('The clinician`s DNA writing profile.', {
        style: leaf('string', NON_PHI, 'The effective writing-style guidance (style, not patient data).'),
        rules: leaf('string', PHI, 'The clinician`s redaction / rewrite rules.'),
      }),
    }),
    transcript: object('The consultation transcript so far.', {
      text: leaf('string', PHI, 'The transcript text, utterances joined in spoken order.'),
      segments: list('Per-utterance timing and speaker.', SEGMENT),
    }),
    items: list('Every context item: case notes, attachments, vitals, tests, prior visits.', ITEM),
    notes: object('The notes generated for this consultation.', {
      preSummary: leaf('string', PHI, 'The pre-summary of the prior record.'),
      summary: leaf('string', PHI, 'The current running note or summary.'),
    }),
    vitals: list('The measured vitals.', VITAL),
    testResults: list('The investigation results.', TEST_RESULT),
    previousVisits: list('Earlier visits of this patient, newest first.', PREVIOUS_VISIT),
  }),
});

// =============================================================================================
// Path lookup
// =============================================================================================

export interface ConsultationPathInfo {
  readonly path: string;
  readonly type: IoType;
  readonly phiClass: PhiClass;
  readonly description: string;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** PHI when the schema, or anything beneath it, is PHI. */
function phiOf(schema: Record<string, unknown>): PhiClass {
  if (schema['x-phiClass'] === PHI) return PHI;
  const properties = asObject(schema.properties);
  if (properties !== undefined && Object.values(properties).some((child) => phiOf(asObject(child) ?? {}) === PHI)) return PHI;
  const items = asObject(schema.items);
  if (items !== undefined && phiOf(items) === PHI) return PHI;
  return NON_PHI;
}

function info(path: string, schema: Record<string, unknown>): ConsultationPathInfo {
  return Object.freeze({
    path,
    type: ioTypeOfJsonSchema(schema),
    phiClass: phiOf(schema),
    description: typeof schema.description === 'string' ? schema.description : '',
  });
}

/**
 * The type, PHI class and description of one `consultation.*` path, or `undefined` when the read
 * schema does not declare it. A path addresses OBJECT fields only; a list is read whole (OD-32).
 */
export function consultationPathInfo(path: string, schema: JsonSchema = CONSULTATION_READ_SCHEMA_V1): ConsultationPathInfo | undefined {
  const segments = path.split('.');
  if (segments[0] !== CONSULTATION_ROOT || segments.length < 2) return undefined;
  let current: Record<string, unknown> | undefined = schema as Record<string, unknown>;
  for (const segment of segments.slice(1)) {
    const properties = asObject(current?.properties);
    if (properties === undefined || !Object.prototype.hasOwnProperty.call(properties, segment)) return undefined;
    current = asObject(properties[segment]);
    if (current === undefined) return undefined;
  }
  return info(path, current);
}

/** Every addressable `consultation.*` path, containers included, in document order. */
export function consultationReadPaths(schema: JsonSchema = CONSULTATION_READ_SCHEMA_V1): ConsultationPathInfo[] {
  const out: ConsultationPathInfo[] = [];
  const walk = (prefix: string, node: Record<string, unknown>): void => {
    const properties = asObject(node.properties);
    if (properties === undefined) return;
    for (const [key, raw] of Object.entries(properties)) {
      const child = asObject(raw);
      if (child === undefined) continue;
      const path = `${prefix}.${key}`;
      out.push(info(path, child));
      walk(path, child);
    }
  };
  walk(CONSULTATION_ROOT, schema as Record<string, unknown>);
  return out;
}

// =============================================================================================
// Declared reads
// =============================================================================================

/** When a `consultation.*` value is snapshotted (OD-30): at node start by default, or once at run start. */
export type ConsultationReadAt = 'nodeStart' | 'runStart';

export interface ConsultationRead {
  readonly path: string;
  readonly at: ConsultationReadAt;
}

function isConsultationPath(path: string): boolean {
  return path === CONSULTATION_ROOT || path.startsWith(`${CONSULTATION_ROOT}.`);
}

/** Every `{{ … }}` path in every string under `value`, recursively. */
function templatePathsIn(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.includes('{{')) for (const reference of templateReferences(value)) out.push(reference.path);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) templatePathsIn(entry, out);
    return;
  }
  const object = asObject(value);
  if (object !== undefined) for (const entry of Object.values(object)) templatePathsIn(entry, out);
}

/** The consultation reads ONE node declares: its `inputs` `from` bindings and every template in its config. */
export function nodeConsultationReads(config: Readonly<Record<string, unknown>> | undefined): ConsultationRead[] {
  const byPath = new Map<string, ConsultationReadAt>();
  const note = (path: string, at: ConsultationReadAt): void => {
    if (!isConsultationPath(path)) return;
    // A node-start read is the fresher snapshot; when both are declared, it is the one taken.
    if (byPath.get(path) !== 'nodeStart') byPath.set(path, at);
  };
  const inputs = asObject(config?.inputs);
  for (const binding of Object.values(inputs ?? {})) {
    const entry = asObject(binding);
    if (typeof entry?.from === 'string') note(entry.from, entry.at === 'runStart' ? 'runStart' : 'nodeStart');
  }
  const templated: string[] = [];
  templatePathsIn(config, templated);
  for (const path of templated) note(path, 'nodeStart');
  return [...byPath.entries()].map(([path, at]) => ({ path, at })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Per node id, the `consultation.*` paths it references (§9.3 "declared reads"). Nodes that read
 * nothing are absent. The harness fetches exactly these, through one tenant-checked activity.
 */
export function declaredConsultationReads(graph: Pick<WorkflowGraph, 'nodes'>): Record<string, ConsultationRead[]> {
  const out: Record<string, ConsultationRead[]> = {};
  for (const node of graph.nodes ?? []) {
    if (typeof node?.id !== 'string') continue;
    const reads = nodeConsultationReads(asObject(node.config));
    if (reads.length > 0) out[node.id] = reads;
  }
  return out;
}

// =============================================================================================
// The flat-alias deprecation map
// =============================================================================================

export interface PlatformContextAlias {
  /** The `consultation.*` path the flat name now reads. */
  readonly path: string;
  /** How the gateway formats the value under the flat name today — kept for the deprecation release. */
  readonly formatting: string;
}

/**
 * The eleven flat `context.<name>` platform variables → their `consultation.*` path, for ONE
 * release. A prompt that still names the flat variable renders the same text; the Studio offers
 * the consultation path instead; the deprecation register retires the flat names after.
 */
export const PLATFORM_CONTEXT_ALIASES: Readonly<Record<string, PlatformContextAlias>> = Object.freeze({
  'context.current_department': Object.freeze({ path: 'consultation.department.name', formatting: 'The department name; "General" when unknown.' }),
  'context.dna_redaction_rules_text': Object.freeze({
    path: 'consultation.clinician.dna.rules',
    formatting: 'The rules as a bullet list; empty when none.',
  }),
  'context.dna_style_text': Object.freeze({ path: 'consultation.clinician.dna.style', formatting: 'The effective style text; empty when none.' }),
  'context.formatted_previous_visits': Object.freeze({
    path: 'consultation.previousVisits',
    formatting: 'One block per visit, newest first; "" when none.',
  }),
  'context.formatted_test_results': Object.freeze({ path: 'consultation.testResults', formatting: 'One line per result; "" when none.' }),
  'context.language_name': Object.freeze({ path: 'consultation.outputLanguage.name', formatting: 'The language name; "English" by default.' }),
  'context.safe_age': Object.freeze({ path: 'consultation.patient.age', formatting: 'The age as text; "Unknown" when not held.' }),
  'context.safe_dob': Object.freeze({ path: 'consultation.patient.dob', formatting: 'The date as text; "Unknown" when not held.' }),
  'context.safe_gender': Object.freeze({ path: 'consultation.patient.gender', formatting: 'The gender as text; "Unknown" when not held.' }),
  'context.safe_vitals': Object.freeze({ path: 'consultation.vitals', formatting: 'One line per vital; "Not available" when none.' }),
  'context.visit_type': Object.freeze({ path: 'consultation.visitType', formatting: 'The visit type as stored.' }),
});

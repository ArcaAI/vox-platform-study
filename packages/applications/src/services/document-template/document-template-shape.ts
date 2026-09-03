import { authorableJsonSchemaProblems } from '@arcaai/json-schema-subset';

/**
 * The shape of a `DocumentTemplateVersion.shape`, and the validator that
 * decides whether a tenant may publish one.
 *
 * ## The load-bearing idea
 *
 * A clinical document is a SHAPE: an ordered list of sections, each with a
 * form, a purpose, and — the part everything else hangs off — a statement of
 * whether it may legitimately be empty.
 *
 * Before this module, that shape was four string literals
 * (`SOAP_SECTION_TITLES`) and a frozen `json_schema` object
 * (`LIVE_SOAP_RESPONSE_FORMAT`), so SOAP was not one supported shape among
 * many — it was the ONLY expressible one. A tenant wanting a discharge summary
 * or a referral letter had nowhere to put it. DD-1: templates are shapes, and
 * SOAP is a row in this catalog like any other.
 *
 * ## Three separate things, deliberately not one prompt blob
 *
 * | Field | What it governs |
 * |---|---|
 * | `sections[].form` | The FORM the value takes — prose, bullets, or a structured object |
 * | `sections[].instruction` | What THIS section is for |
 * | `globalInstruction` | How the whole document should be written |
 *
 * A single free-text prompt blob would express all three at once and none of
 * them separately, which makes it unversionable (a change to tone is
 * indistinguishable from a change to structure), untestable (nothing to assert
 * against) and un-diffable (an admin reviewing a change sees a paragraph, not a
 * moved section). Keeping them apart is what lets the compiler turn the FORM
 * half into a decoding constraint while the instruction halves stay prose.
 *
 * Validation is fail-closed on shape (unknown keys are rejected, mirroring the
 * gateway's `forbidNonWhitelisted` posture) and returns EVERY problem at once
 * rather than throwing on the first — an admin editing a ten-section discharge
 * summary should not discover its faults one round-trip at a time. Exactly the
 * `contextSchemaDefinitionProblems` contract.
 */

/** The CLOSED set of section forms. Extending it is a platform change, never a tenant one. */
export const DOCUMENT_SECTION_FORMS = ['PROSE', 'BULLETS', 'STRUCTURED'] as const;
export type DocumentSectionForm = (typeof DOCUMENT_SECTION_FORMS)[number];

/** The only `schemaVersion` this platform understands. */
export const DOCUMENT_TEMPLATE_SHAPE_VERSION = '1.0';

/** Grammar for `sections[].key`. Identical to the context-schema kind-key grammar. */
export const DOCUMENT_SECTION_KEY_PATTERN = /^[a-z0-9_]{2,48}$/;

/** Hard ceiling on the number of sections in one document. */
export const MAX_DOCUMENT_SECTIONS = 64;

const TOP_LEVEL_KEYS = ['schemaVersion', 'title', 'globalInstruction', 'sections'] as const;
const SECTION_KEYS = ['key', 'title', 'form', 'instruction', 'required', 'description', 'fields', 'maxChars'] as const;

export interface DocumentSectionDeclaration {
  key: string;
  title: string;
  form: DocumentSectionForm;
  /** What this section is for. Compiled into the section's schema `description`. */
  instruction?: string;
  /**
   * Whether the model MUST produce content for this section.
   *
   * **Defaults to `false`, and that default is the whole of D-21.** The
   * previous `LIVE_SOAP_RESPONSE_FORMAT` marked all four SOAP sections
   * `required` under `strict: true`, which does not mean "these sections
   * matter" — it means the decoder is forbidden from emitting anything but a
   * string for each, so a section nobody discussed gets filled with invention.
   * Mild across four sections; a ten-section discharge summary is nine
   * invitations to confabulate. An optional section compiles to a nullable
   * property, and `null` is the "not discussed" sentinel.
   */
  required?: boolean;
  description?: string;
  /** Required for a STRUCTURED section; an authorable JSON Schema subset document. */
  fields?: Record<string, unknown>;
  /** Advisory ceiling surfaced to the model in the compiled instruction. */
  maxChars?: number;
}

export interface DocumentTemplateShape {
  schemaVersion: string;
  title: string;
  globalInstruction?: string;
  sections: DocumentSectionDeclaration[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every structural problem with a candidate shape. Empty ⇒ publishable. */
export function documentTemplateShapeProblems(value: unknown): string[] {
  if (!isPlainObject(value)) {
    return ['shape must be a JSON object'];
  }

  const problems: string[] = [];

  for (const key of Object.keys(value)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      problems.push(`shape: unknown top-level key \`${key}\``);
    }
  }

  if (value.schemaVersion !== DOCUMENT_TEMPLATE_SHAPE_VERSION) {
    problems.push(`shape.schemaVersion must be "${DOCUMENT_TEMPLATE_SHAPE_VERSION}"`);
  }

  if (typeof value.title !== 'string' || value.title.trim().length === 0 || value.title.length > 200) {
    problems.push('shape.title must be a non-empty string of at most 200 characters');
  }

  if (value.globalInstruction !== undefined && (typeof value.globalInstruction !== 'string' || value.globalInstruction.length > 10_000)) {
    problems.push('shape.globalInstruction must be a string of at most 10000 characters when present');
  }

  if (!Array.isArray(value.sections)) {
    problems.push('shape.sections must be an array');
    return problems;
  }
  if (value.sections.length === 0) {
    problems.push('shape.sections must declare at least one section');
  }
  if (value.sections.length > MAX_DOCUMENT_SECTIONS) {
    problems.push(`shape declares ${value.sections.length} sections, exceeding the maximum of ${MAX_DOCUMENT_SECTIONS}`);
  }

  const seen = new Set<string>();
  value.sections.forEach((section, index) => problems.push(...sectionProblems(section, `shape.sections[${index}]`, seen)));

  return problems;
}

function sectionProblems(section: unknown, at: string, seen: Set<string>): string[] {
  if (!isPlainObject(section)) {
    return [`${at}: must be a JSON object`];
  }

  const problems: string[] = [];

  for (const key of Object.keys(section)) {
    if (!(SECTION_KEYS as readonly string[]).includes(key)) {
      problems.push(`${at}: unknown key \`${key}\``);
    }
  }

  if (typeof section.key !== 'string' || !DOCUMENT_SECTION_KEY_PATTERN.test(section.key)) {
    problems.push(`${at}.key \`${String(section.key)}\` must match ${DOCUMENT_SECTION_KEY_PATTERN.source}`);
  } else if (seen.has(section.key)) {
    problems.push(`${at}.key: duplicate key \`${section.key}\``);
  } else {
    seen.add(section.key);
  }

  if (typeof section.title !== 'string' || section.title.trim().length === 0 || section.title.length > 200) {
    problems.push(`${at}.title must be a non-empty string of at most 200 characters`);
  }

  if (!(DOCUMENT_SECTION_FORMS as readonly unknown[]).includes(section.form)) {
    problems.push(`${at}.form \`${String(section.form)}\` is not one of ${DOCUMENT_SECTION_FORMS.join(' | ')}`);
  }

  if (section.instruction !== undefined && (typeof section.instruction !== 'string' || section.instruction.length > 5000)) {
    problems.push(`${at}.instruction must be a string of at most 5000 characters when present`);
  }
  if (section.description !== undefined && (typeof section.description !== 'string' || section.description.length > 2000)) {
    problems.push(`${at}.description must be a string of at most 2000 characters when present`);
  }
  if (section.required !== undefined && typeof section.required !== 'boolean') {
    problems.push(`${at}.required must be a boolean when present`);
  }
  if (section.maxChars !== undefined && (typeof section.maxChars !== 'number' || !Number.isInteger(section.maxChars) || section.maxChars <= 0)) {
    problems.push(`${at}.maxChars must be a positive integer when present`);
  }

  // A STRUCTURED section with no `fields` declares nothing — the compiler
  // could not constrain the model's output at all, which is the whole point of
  // the form. Mirrors the `STRUCTURED` kind rule in `context-schema-definition.ts`.
  if (section.form === 'STRUCTURED' && !isPlainObject(section.fields)) {
    problems.push(`${at}.fields is required for a STRUCTURED section`);
  }
  if (section.form !== 'STRUCTURED' && section.fields !== undefined) {
    problems.push(`${at}.fields is only meaningful for a STRUCTURED section`);
  }
  if (section.fields !== undefined) {
    problems.push(...authorableJsonSchemaProblems(section.fields, `${at}.fields`));
  }

  return problems;
}

/** The declared section with this key, or undefined. */
export function findSection(shape: unknown, sectionKey: string): DocumentSectionDeclaration | undefined {
  if (!isPlainObject(shape) || !Array.isArray(shape.sections)) return undefined;
  return (shape.sections as DocumentSectionDeclaration[]).find((section) => isPlainObject(section) && section.key === sectionKey);
}

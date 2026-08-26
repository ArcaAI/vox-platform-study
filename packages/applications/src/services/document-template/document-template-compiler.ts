import { DocumentSectionDeclaration, DocumentSectionForm, DocumentTemplateShape } from './document-template-shape';

/**
 * The TEMPLATE COMPILER (TASK-810 Task 8).
 *
 * ## Why a compiler and not a prompt
 *
 * "Please follow this template" is a request a model may decline. A decoding
 * constraint is not. This module turns an authored SHAPE into three artifacts
 * that are frozen onto the immutable version row at publish:
 *
 * | Artifact | What it does |
 * |---|---|
 * | `responseFormat` | A strict `json_schema` the provider decodes against — the model *cannot* emit a key the template did not declare, and cannot omit one it did |
 * | `checklist` | The frozen per-section checklist a reviewer (human or sensor) walks |
 * | `sectionStates` | The per-section state machine, including which sections may legitimately rest in `NOT_DISCUSSED` |
 *
 * A fourth output, `promptInstruction`, is prose — it is what a provider that
 * IGNORES `response_format` (Ollama, today) gets instead. It is generated from
 * the same shape so the two can never describe different documents, which is
 * exactly what the hand-maintained `SOAP_OUTPUT_INSTRUCTION` /
 * `LIVE_SOAP_RESPONSE_FORMAT` pair risked.
 *
 * ## D-21 — how an undiscussed section stops being confabulated
 *
 * The old `LIVE_SOAP_RESPONSE_FORMAT` was `strict: true` with all four
 * sections in `required`. Under strict decoding that is not a statement about
 * importance; it forbids the model from producing anything except a string for
 * every heading. A consultation that never touched examination findings still
 * had to emit an `objective` string, so it invented one. At four sections that
 * is a nuisance; at a ten-section discharge summary it is nine standing
 * invitations to fabricate clinical content.
 *
 * The fix is NOT to drop keys out of `required` — strict structured-output
 * modes reject a schema whose `required` is not the full property set, so that
 * would silently disable strictness altogether and lose the guarantee we came
 * for. Instead every key stays required and **an optional section compiles to a
 * NULLABLE property**: `null` is the explicit "not discussed" sentinel, it is
 * always available to the decoder, and it is distinguishable from `""` (tried
 * and found nothing) and from prose. `promptInstruction` names the sentinel in
 * words for the prose path.
 *
 * ## Determinism
 *
 * Compilation is a pure function of the shape: same shape in, byte-identical
 * artifacts out. That is what lets `compilerVersion` participate in the
 * idempotent-republish predicate — an identical shape run through a NEWER
 * compiler is genuinely a different artifact and must mint a new version,
 * rather than leaving the pin serving a stale compile forever.
 */

/**
 * Bump on ANY change to the emitted artifacts. It is persisted on every version
 * row and is half of the idempotent-republish predicate, so bumping it means
 * the next publish of an unchanged shape legitimately mints a new version.
 */
export const DOCUMENT_TEMPLATE_COMPILER_VERSION = '1.0.0';

/** The lifecycle a single section moves through while a document is produced. */
export const DOCUMENT_SECTION_STATES = ['PENDING', 'NOT_DISCUSSED', 'DRAFTED', 'CONFIRMED'] as const;
export type DocumentSectionState = (typeof DOCUMENT_SECTION_STATES)[number];

/** The events that move a section between states. */
export const DOCUMENT_SECTION_EVENTS = ['CONTENT_EMITTED', 'EMITTED_NULL', 'CLINICIAN_CONFIRMED'] as const;
export type DocumentSectionEvent = (typeof DOCUMENT_SECTION_EVENTS)[number];

export interface CompiledChecklistEntry {
  key: string;
  title: string;
  form: DocumentSectionForm;
  required: boolean;
  instruction?: string;
}

export interface CompiledSectionTransition {
  from: DocumentSectionState;
  to: DocumentSectionState;
  on: DocumentSectionEvent;
}

export interface CompiledSectionStateMachine {
  states: readonly DocumentSectionState[];
  initial: DocumentSectionState;
  terminal: readonly DocumentSectionState[];
  transitions: readonly CompiledSectionTransition[];
  /**
   * Per-section rules the generic transition table cannot express.
   * `allowNotDiscussed` is the D-21 half made checkable: a REQUIRED section
   * that reaches `NOT_DISCUSSED` is a defect, not a valid resting state.
   */
  sections: Record<string, { allowNotDiscussed: boolean }>;
}

export interface CompiledResponseFormat {
  type: 'json_schema';
  strict: true;
  json_schema: Record<string, unknown>;
}

export interface CompiledDocumentTemplate {
  compilerVersion: string;
  title: string;
  /** Section keys in AUTHORED order — array order is intent, not formatting. */
  sectionKeys: string[];
  responseFormat: CompiledResponseFormat;
  checklist: CompiledChecklistEntry[];
  sectionStates: CompiledSectionStateMachine;
  promptInstruction: string;
}

/** Transitions are shape-independent; only `sections` below varies per template. */
const TRANSITIONS: readonly CompiledSectionTransition[] = Object.freeze([
  { from: 'PENDING', to: 'DRAFTED', on: 'CONTENT_EMITTED' },
  { from: 'PENDING', to: 'NOT_DISCUSSED', on: 'EMITTED_NULL' },
  { from: 'NOT_DISCUSSED', to: 'DRAFTED', on: 'CONTENT_EMITTED' },
  { from: 'DRAFTED', to: 'DRAFTED', on: 'CONTENT_EMITTED' },
  // A running note re-generates the whole document on every flush, so a
  // section that had content can legitimately come back null when the later
  // transcript no longer supports it. Refusing that transition would force the
  // very retention-of-invented-content this design exists to prevent.
  { from: 'DRAFTED', to: 'NOT_DISCUSSED', on: 'EMITTED_NULL' },
  { from: 'DRAFTED', to: 'CONFIRMED', on: 'CLINICIAN_CONFIRMED' },
  { from: 'NOT_DISCUSSED', to: 'CONFIRMED', on: 'CLINICIAN_CONFIRMED' },
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Make an authored object sub-schema safe for STRICT structured decoding:
 * every object closes (`additionalProperties: false`) and lists all of its
 * properties in `required`.
 *
 * Strict modes reject a schema that leaves either implicit, so an authored
 * `fields` document that is merely VALID would be rejected at generation time —
 * i.e. the tenant's template would publish fine and then fail on the first real
 * consultation. Normalising here means the failure is impossible rather than
 * merely reported. Optionality inside a structured section is expressed the
 * same way it is at the document level: a nullable type, never a missing key.
 */
function strictify(schema: unknown, depth = 0): unknown {
  if (!isPlainObject(schema) || depth > 12) return schema;

  const out: Record<string, unknown> = { ...schema };

  if (isPlainObject(out.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [key, sub] of Object.entries(out.properties)) {
      properties[key] = strictify(sub, depth + 1);
    }
    out.properties = properties;
    out.additionalProperties = false;
    out.required = Object.keys(properties);
  }

  if (out.items !== undefined) {
    out.items = strictify(out.items, depth + 1);
  }

  return out;
}

/** Add `null` to a compiled property's permitted types — the "not discussed" sentinel. */
function nullable(property: Record<string, unknown>): Record<string, unknown> {
  const declared = property.type;
  if (declared === undefined) {
    // No declared type (an `anyOf`/`oneOf` document). Widen with an explicit
    // null branch rather than guessing a type.
    return { anyOf: [property, { type: 'null' }] };
  }
  const types = Array.isArray(declared) ? declared : [declared];
  return { ...property, type: types.includes('null') ? types : [...types, 'null'] };
}

function sectionProperty(section: DocumentSectionDeclaration): Record<string, unknown> {
  const description = [section.instruction, section.description].filter((part): part is string => Boolean(part && part.trim())).join(' ');

  let property: Record<string, unknown>;
  if (section.form === 'STRUCTURED') {
    property = strictify(section.fields ?? { type: 'object' }) as Record<string, unknown>;
    if (property.type === undefined) property = { ...property, type: 'object' };
  } else {
    property = { type: 'string' };
    if (section.maxChars !== undefined) property.maxLength = section.maxChars;
  }

  if (description) property = { ...property, description };

  return section.required === true ? property : nullable(property);
}

function promptInstruction(shape: DocumentTemplateShape): string {
  const lines = shape.sections.map((section) => {
    const form = section.form === 'BULLETS' ? 'bullet points' : section.form === 'STRUCTURED' ? 'a JSON object' : 'prose';
    const purpose = section.instruction?.trim() ? ` ${section.instruction.trim()}` : '';
    const optionality = section.required === true ? ' [required]' : '';
    return `  "${section.key}" — ${section.title} (${form})${optionality}:${purpose}`;
  });

  const optional = shape.sections.filter((section) => section.required !== true).map((section) => `"${section.key}"`);

  const parts = [
    `Output a single JSON object with EXACTLY these keys, in this order, and nothing else:`,
    '',
    ...lines,
    '',
    'Every key must be present.',
  ];

  if (optional.length > 0) {
    // The sentence that closes D-21 on the prose path. Naming the sentinel and
    // the near-miss answers explicitly matters: a model told only "you may
    // leave it out" reliably writes "N/A" or "Not discussed." instead, which
    // reads as documented-negative rather than never-asked.
    parts.push(
      `If a section was not discussed, set its value to null — do NOT write "none", "N/A", "not discussed", ` +
        `or invent content to fill the heading. Nullable sections: ${optional.join(', ')}.`,
    );
  }

  parts.push('Do not add sections that are not listed above.');

  if (shape.globalInstruction?.trim()) {
    parts.push('', shape.globalInstruction.trim());
  }

  return parts.join('\n');
}

/**
 * Compile a VALIDATED shape into its frozen artifacts.
 *
 * The caller must have run `documentTemplateShapeProblems` first — this
 * function assumes a structurally valid shape and does not re-validate, for
 * the same reason `compile()` in `@arcaai/workflow-contract` separates the two:
 * a compiler that also validates ends up with two subtly different opinions
 * about what is publishable.
 */
export function compileDocumentTemplate(shape: DocumentTemplateShape): CompiledDocumentTemplate {
  const properties: Record<string, unknown> = {};
  const checklist: CompiledChecklistEntry[] = [];
  const sections: Record<string, { allowNotDiscussed: boolean }> = {};

  for (const section of shape.sections) {
    properties[section.key] = sectionProperty(section);
    checklist.push({
      key: section.key,
      title: section.title,
      form: section.form,
      required: section.required === true,
      ...(section.instruction ? { instruction: section.instruction } : {}),
    });
    sections[section.key] = { allowNotDiscussed: section.required !== true };
  }

  const sectionKeys = shape.sections.map((section) => section.key);

  return {
    compilerVersion: DOCUMENT_TEMPLATE_COMPILER_VERSION,
    title: shape.title,
    sectionKeys,
    responseFormat: {
      type: 'json_schema',
      strict: true,
      json_schema: {
        title: shape.title,
        type: 'object',
        additionalProperties: false,
        properties,
        // EVERY key, always. Optionality lives in the property's nullability,
        // not here — see the D-21 note in this module's docstring. Dropping a
        // key from `required` under `strict: true` disables strict decoding
        // instead of making the section optional.
        required: sectionKeys,
      },
    },
    checklist,
    sectionStates: {
      states: DOCUMENT_SECTION_STATES,
      initial: 'PENDING',
      terminal: ['CONFIRMED'],
      transitions: TRANSITIONS,
      sections,
    },
    promptInstruction: promptInstruction(shape),
  };
}

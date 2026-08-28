/**
 * Types for the clinical-document SHAPE catalog (`/admin/document-templates`).
 *
 * Mirrors the response/request DTOs in
 * `packages/applications/src/services/document-template/dto/` and the shape
 * document in `document-template-shape.ts` — hand-written rather than
 * imported, because `apps/admin-console` does not depend on
 * `@arcaai/applications` (a server-side package). Same posture as
 * `features/context-schemas/api/types.ts`.
 *
 * The closed sets below (`DOCUMENT_SECTION_FORMS`, the status list, the shape
 * version, the key grammar) are copies of platform constants. Extending any of
 * them is a platform change, never a tenant one — the console must never let an
 * author type a value outside them.
 */

export type DocumentTemplateStatus = 'DRAFT' | 'PUBLISHED' | 'APPROVED';

export interface DocumentTemplate {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  status: DocumentTemplateStatus;
  /** The version generation serves. Null until the first publish. */
  pinnedVersionNumber: number | null;
  isDefault: boolean;
  sourceTemplateSlug: string | null;
  templateLocked: boolean;
  /** Optimistic-concurrency counter; rendered as the strong `ETag` by the global interceptor. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Compatibility judgement of an older version against the CURRENT pin. */
export type DocumentTemplateVersionSkew = 'IDENTICAL' | 'ADDITIVE' | 'BREAKING';

export interface DocumentTemplateVersion {
  id: string;
  templateId: string;
  versionNumber: number;
  /** The AUTHORED shape. */
  shape: DocumentTemplateShape;
  /** The DERIVED artifacts frozen with it — `responseFormat`, `checklist`, `sectionStates`, `promptInstruction`. */
  compiled: Record<string, unknown>;
  compilerVersion: string;
  /** sha256 over the canonical JSON of `shape`. */
  checksum: string;
  changeReason: string | null;
  createdBy: string | null;
  createdAt: string;
  /** Absent for the pinned version itself, and for a template with no pin yet. */
  versionSkew?: DocumentTemplateVersionSkew;
}

// ---------------------------------------------------------------------------
// The `shape` document
// ---------------------------------------------------------------------------

/** The CLOSED set of section forms. */
export const DOCUMENT_SECTION_FORMS = ['PROSE', 'BULLETS', 'STRUCTURED'] as const;
export type DocumentSectionForm = (typeof DOCUMENT_SECTION_FORMS)[number];

/** The only `schemaVersion` the platform understands. */
export const DOCUMENT_TEMPLATE_SHAPE_VERSION = '1.0';

/** Grammar for `sections[].key` and the template `slug`. */
export const DOCUMENT_SECTION_KEY_PATTERN = /^[a-z0-9_]{2,48}$/;

/** Hard ceiling on the number of sections in one document. */
export const MAX_DOCUMENT_SECTIONS = 64;

export interface DocumentSectionDeclaration {
  key: string;
  title: string;
  form: DocumentSectionForm;
  /** What THIS section is for. Compiled into the section's schema `description`. */
  instruction?: string;
  /**
   * Whether the model MUST produce content for this section. Defaults to
   * FALSE, and that default is the whole of D-21: an optional section compiles
   * to a NULLABLE property, so `null` is the "not discussed" sentinel instead
   * of an invitation to invent content to fill the heading.
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
  /** How the WHOLE document should be written — kept separate from per-section instructions on purpose. */
  globalInstruction?: string;
  /** ORDERED. Array order is authorial intent, not formatting. */
  sections: DocumentSectionDeclaration[];
}

/** A fresh, unpublished draft — the Shape tab's starting point for a brand-new template. */
export function emptyShape(): DocumentTemplateShape {
  return { schemaVersion: DOCUMENT_TEMPLATE_SHAPE_VERSION, title: '', sections: [] };
}

/**
 * The platform's SOAP shape, as an authoring STARTING POINT.
 *
 * A verbatim copy of `SOAP_NOTE_SHAPE` (`platform-document-shapes.ts`), which
 * is what generation falls open to when a tenant has configured nothing. Note
 * that not one section is `required` — that is D-21, not an oversight: under
 * the old `strict: true` + all-`required` format the decoder could not
 * represent "nobody examined this patient", so it invented findings.
 */
export function soapStarterShape(): DocumentTemplateShape {
  return {
    schemaVersion: DOCUMENT_TEMPLATE_SHAPE_VERSION,
    title: 'SOAP Note',
    globalInstruction: 'Be concise and faithful to the transcript; never fabricate findings.',
    sections: [
      { key: 'subjective', title: 'Subjective', form: 'PROSE', instruction: 'Patient-reported history and symptoms.' },
      { key: 'objective', title: 'Objective', form: 'PROSE', instruction: 'Exam findings, vitals, labs.' },
      { key: 'assessment', title: 'Assessment', form: 'PROSE', instruction: 'Clinical impressions and diagnoses.' },
      { key: 'plan', title: 'Plan', form: 'PROSE', instruction: 'Next steps, medications, follow-up.' },
    ],
  };
}

/** The section list the platform fallback produces, for the "what is served today" banner. */
export const PLATFORM_FALLBACK_SECTION_TITLES = ['Subjective', 'Objective', 'Assessment', 'Plan'] as const;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface CreateDocumentTemplateRequest {
  slug: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  sourceTemplateSlug?: string;
  templateLocked?: boolean;
}

export interface UpdateDocumentTemplateRequest {
  name?: string;
  description?: string;
  isDefault?: boolean;
  status?: DocumentTemplateStatus;
  expectedVersion?: number;
  templateLocked?: boolean;
}

export interface PublishDocumentTemplateRequest {
  shape: DocumentTemplateShape;
  changeReason?: string;
  /** Acknowledges a breaking change; without it a breaking publish is refused with 400. */
  allowBreakingChange?: boolean;
}

export interface PinDocumentTemplateVersionRequest {
  versionNumber: number;
}

import { DocumentTemplateShape } from './document-template-shape';

/**
 * Platform-default document shapes — the golden library a tenant clones from
 * and, for `SOAP_NOTE_SHAPE`, the code-default the live loop falls open to when
 * a tenant has configured no template of its own.
 *
 * DD-1: **these are rows, not privileges.** Nothing in the parser, the
 * compiler, the service or the live loop knows the word "SOAP" any more; this
 * module simply happens to declare a shape that has four sections called
 * Subjective, Objective, Assessment and Plan. A tenant that publishes a
 * discharge summary gets identical treatment through identical code, which is
 * exactly what was structurally impossible before.
 *
 * The one place SOAP retains a privilege is here, as the FAIL-OPEN default: a
 * running consultation must never die because a template could not be
 * resolved, and the shape it degrades to has to be something. That mirrors the
 * live chain's existing tier-3 prompt fallback rather than inventing a new
 * posture.
 */

/** Slug of the platform default. A tenant row with this slug shadows it. */
export const SOAP_NOTE_SLUG = 'soap_note';

/**
 * The four SOAP sections, now DECLARED rather than hardcoded.
 *
 * Note what changed besides the location: not one of them is `required`.
 * Under the old `LIVE_SOAP_RESPONSE_FORMAT` all four were, which under
 * `strict: true` forced the model to emit an examination-findings string for a
 * consultation that never examined anyone (D-21). `Assessment` is arguably the
 * one a clinician always forms — but "usually present" is not "the decoder may
 * not represent its absence", and encoding the former as the latter is what
 * produced invented findings. A tenant that genuinely wants a section it can
 * never leave blank sets `required: true` on its own row, deliberately.
 */
export const SOAP_NOTE_SHAPE: DocumentTemplateShape = Object.freeze({
  schemaVersion: '1.0',
  title: 'SOAP Note',
  globalInstruction: 'Be concise and faithful to the transcript; never fabricate findings.',
  sections: [
    { key: 'subjective', title: 'Subjective', form: 'PROSE', instruction: 'Patient-reported history and symptoms.' },
    { key: 'objective', title: 'Objective', form: 'PROSE', instruction: 'Exam findings, vitals, labs.' },
    { key: 'assessment', title: 'Assessment', form: 'PROSE', instruction: 'Clinical impressions and diagnoses.' },
    { key: 'plan', title: 'Plan', form: 'PROSE', instruction: 'Next steps, medications, follow-up.' },
  ],
}) as DocumentTemplateShape;

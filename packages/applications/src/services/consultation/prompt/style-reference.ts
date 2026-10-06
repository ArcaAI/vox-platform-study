/**
 * TASK-1047 D1 — the STYLE REFERENCE data section: the clinician's DNA writing style, their
 * redaction rules and the few-shot exemplars. Per-doctor (and per exemplar set) RUNTIME values, so
 * DATA in the user message, never system text; only the static guidance about how to use each part
 * is instruction (a keyed output-contract part). Shared by every gateway composer that carries a
 * style, so the block reads the same wherever it is sent.
 */

/** The block, placed first wherever it is sent (stable across a consultation's calls). */
export const STYLE_REFERENCE_BLOCK = { key: 'style_reference', label: 'STYLE REFERENCE' } as const;

/** Static contract part: how the few-shot exemplars in the STYLE REFERENCE section may be used. */
export const STYLE_REFERENCE_EXEMPLARS_GUIDANCE =
  "The STYLE REFERENCE data section's APPROVED NOTES FROM DIFFERENT PATIENTS were written for OTHER patients and are included ONLY as a reference for house formatting, section order and tone. They are NOT this patient's history: never carry a clinical fact, finding, or medication across from them.";

/** Static contract part: the clinician's writing style is in the STYLE REFERENCE section. */
export const DNA_STYLE_GUIDANCE =
  "The STYLE REFERENCE data section's CLINICIAN WRITING STYLE is this clinician's own style: apply it to tone, formatting, and section phrasing. It is style guidance, not patient data.";

/** Static contract part: the clinician's redaction rules are in the STYLE REFERENCE section. */
export const DNA_REDACTION_GUIDANCE =
  "The STYLE REFERENCE data section's CLINICIAN REDACTION RULES are this clinician's own documentation rules: never include what they say to leave out, and always rewrite what they say to rewrite. They are documentation preferences, not patient data.";

/** The STYLE REFERENCE block's content, or `null` when there is nothing in it. */
export function styleReferenceContent(parts: {
  style?: string | null;
  rules?: string | null;
  exemplars?: { version: string; text: string } | null;
}): string | null {
  const sections = [
    parts.style ? `--- CLINICIAN WRITING STYLE ---\n${parts.style}` : null,
    parts.rules ? `--- CLINICIAN REDACTION RULES (never include / always rewrite) ---\n${parts.rules}` : null,
    parts.exemplars ? `--- APPROVED NOTES FROM DIFFERENT PATIENTS (set ${parts.exemplars.version}) ---\n${parts.exemplars.text}` : null,
  ].filter((section): section is string => section !== null);
  return sections.length > 0 ? sections.join('\n\n') : null;
}

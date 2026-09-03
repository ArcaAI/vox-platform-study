/**
 * v1's pre-summary-into-summary injection prefix, from
 * `JsonPromptFactory.build_template_by_department`
 * (`apps/text/src/text/models/prompts_json.py`):
 *
 * ```python
 * if pre_summary_text:
 *     prior_context =
 *         "\n\nPRIOR MEDICAL CONTEXT (authoritative, use to fill missing details):\n"
 *         + pre_summary_text.strip()
 *     )
 * ```
 *
 * A consumer appends `pre_summary_text.strip()` (JS: `.trim()`) directly
 * after this prefix — there is no placeholder token, it is a plain
 * concatenation prefix, carried through byte-exact including its two
 * leading newlines and trailing single newline.
 *
 * Source: the RUNNING v1 TEXT pod (Rancher cluster c-9lwv8, namespace apps,
 * pod apps-text-84c9774997-zhp2l), NOT a local v1 checkout — the two have
 * diverged (see
 * ). Extracted 2026-08-07 via a chunked base64 pipeline (never
 * retyped) with every chunk sha256-verified against the pod before
 * concatenation, then cross-checked two independent reconstruction methods
 * (direct Python execution vs. `ast`-based literal extraction) for
 * byte-for-byte agreement. See D-12 and the README Phase 5.
 *
 * GENERATED, DO NOT HAND-EDIT — regenerate from the pod, never retype.
 * sha256 3e27c925249b312edaedd577c66d969908c4c769f17f0b7d893cec4cc45631ca 70 bytes
 */

/** Byte-exact v1 "PRIOR MEDICAL CONTEXT" injection prefix (concatenation, not a template). */
export const V1_PRIOR_MEDICAL_CONTEXT_PREFIX: string = '\n\nPRIOR MEDICAL CONTEXT (authoritative, use to fill missing details):\n';

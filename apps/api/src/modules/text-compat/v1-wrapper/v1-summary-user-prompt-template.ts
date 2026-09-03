/**
 * v1 TEXT summary user-prompt scaffold — `ConversationalPrompts.USER_PROMPT_TEMPLATE`
 * (`apps/text/src/text/models/prompts.py`), rendered via
 * `ConversationalPrompts.build_user_prompt(...)` inside
 * `JsonPromptFactory.build_template_by_department`
 * (`apps/text/src/text/models/prompts_json.py`), which ALWAYS calls it with
 * `encounter_type=None, specialty=None` — so `{encounter_type}` /
 * `{specialty}` are pre-resolved to the literal strings "General" /
 * "General Medicine" that `build_user_prompt` substitutes for that case,
 * baked in below. The five REMAINING placeholders are genuinely per-request
 * and are single-brace `str.format()` tokens, carried through VERBATIM:
 * `{session_id}`, `{session_date}`, `{patient_info}`, `{conversation_text}`,
 * `{conversation_language}`.
 *
 * v2 has NO `str.format()`-style interpolator wired to this template today —
 * `interpolateTemplate` (`prompt-management.service.ts:985`) is `{{var}}`-style
 * and test-path only (D-08). A consumer of this constant MUST
 * substitute all five placeholders itself (e.g. `String.prototype.replaceAll`
 * per token) before sending it to an LLM, or literal `{braces}` reach the
 * model. This module deliberately does NOT wire that substitution — see the
 * module docstring in `index.ts`.
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
 * sha256 e322b23fba40846904bc11c33025cb948c5e2dc65768a5f062ad534fcb3d4ddd 1840 bytes
 */

/**
 * Byte-exact v1 user-prompt scaffold with `{encounter_type}`/`{specialty}`
 * pre-resolved to "General"/"General Medicine" (the only values v1 ever
 * passes for a department-routed summary). Placeholders still open:
 * `{session_id}`, `{session_date}`, `{patient_info}`, `{conversation_text}`,
 * `{conversation_language}`.
 */
export const V1_SUMMARY_USER_PROMPT_TEMPLATE: string =
  'Please analyze this medical conversation and create a comprehensive clinical summary.\n\nSESSION INFORMATION:\n- Session ID: {session_id}\n- Date: {session_date}\n- Encounter Type: General\n- Medical Specialty: General Medicine\n\nCONVERSATION LANGUAGE:\n{conversation_language}\n\nPATIENT INFORMATION:\n{patient_info}\n\nCONVERSATION TRANSCRIPT:\n{conversation_text}\n\nINSTRUCTIONS:\nPlease analyze the conversation and provide a response in the following JSON format. Ensure all fields are completed with relevant information or "Not documented" if information is not available.\n\nIMPORTANT LANGUAGE REQUIREMENT: \n- Respond in the {conversation_language}\n- Maintain language consistency across ALL JSON fields\n\nIMPORTANT: Format ALL text fields using markdown syntax for better readability and structure. Use appropriate headers, lists, emphasis, and formatting.\n\n{{\n    "subjective": "## Subjective\n\nPatient-reported symptoms, onset/duration, associated symptoms, functional impact, and relevant history from the conversation.",\n    "objective": "## Objective\n\nClinician-reported findings: vitals, exam findings, investigations/results reviewed or ordered (include dates if provided).",\n    "assessment": "## Assessment\n\nWorking diagnosis/differentials and clinical reasoning based on the conversation and available context.",\n    "plan": "## Plan\n\nTreatment/medications (dose/frequency if stated), investigations ordered, referrals, follow-up instructions, and safety-net advice."\n}}\n\nFocus on extracting accurate medical information from the conversation. Use medical terminology appropriately and ensure clinical accuracy. Format each field with appropriate markdown syntax (headers, lists, bold text, etc.) for enhanced readability. If specific information is not mentioned in the conversation, use "**Not documented**" rather than making assumptions.';

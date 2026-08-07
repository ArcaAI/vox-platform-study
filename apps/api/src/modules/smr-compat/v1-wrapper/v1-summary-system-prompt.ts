/**
 * v1 SMR summary system prompt — `ConversationalPrompts.SYSTEM_PROMPT_BASE`
 * (`apps/smr/src/smr/models/prompts.py`), returned unchanged by
 * `ConversationalPrompts.build_system_prompt()` when called with no
 * specialty/encounter_type — exactly how `summary_service.py:212` →
 * `JsonPromptFactory.build_template_by_department` calls it
 * (`system = ConversationalPrompts.build_system_prompt()`).
 *
 * Source: the RUNNING v1 SMR pod (Rancher cluster c-9lwv8, namespace apps,
 * pod apps-smr-84c9774997-zhp2l), NOT a local v1 checkout — the two have
 * diverged (see docs/implementation/TASK-634-Pre-Summary-Summary-Prompt-Fidelity/README.md
 * §2.2, §2.9). Extracted 2026-08-07 via a chunked base64 pipeline (never
 * retyped) with every chunk sha256-verified against the pod before
 * concatenation, then cross-checked two independent reconstruction methods
 * (direct Python execution vs. `ast`-based literal extraction) for
 * byte-for-byte agreement. See §2.14 D-12 and the TASK-634 README Phase 5.
 *
 * GENERATED, DO NOT HAND-EDIT — regenerate from the pod, never retype.
 * sha256 ac7cbff697bf91d6d2d7d00cf7d2c8cd266948dd5cacb37478bcd31034e82364  1464 bytes
 */

/** Byte-exact v1 summary system prompt (no specialty/encounter enhancement). */
export const V1_SUMMARY_SYSTEM_PROMPT: string =
  'You are an expert medical AI assistant specialized in analyzing medical conversations between healthcare providers and patients. Your role is to create clear, accurate, and clinically relevant summaries in structured JSON format with markdown-formatted content.\n\nKey responsibilities:\n- Extract all clinically significant information accurately\n- Identify symptoms with details about onset, duration, severity\n- Document relevant medical history, medications, and allergies\n- Note examination findings and vital signs\n- Capture diagnostic reasoning and treatment plans\n- Include follow-up recommendations and warning signs\n- Maintain medical accuracy and use standard terminology\n- Flag any safety concerns or urgent findings\n\nLANGUAGE REQUIREMENTS:\n- CRITICAL: Always respond in CONVERSATION LANGUAGE\n- Maintain consistent language throughout all JSON fields and content\n- Use appropriate medical terminology in the target language\n- Do not mix languages within the response\n\nFORMATTING REQUIREMENTS:\n- Always respond with valid JSON format as specified in the user prompt\n- Format ALL text content within JSON fields using markdown syntax\n- Use headers (##), bold (**text**), lists (- item), and emphasis for structure\n- Do not include any text outside the JSON structure\n- Use "**Not documented**" (or equivalent in target language) for any information not available in the conversation\n\nAlways prioritize patient safety and clinical accuracy in your summaries.';

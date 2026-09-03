/**
 * v1's "STRICT JSON RESPONSE FORMAT (CRITICAL)" rule block, from
 * `JsonPromptFactory.build_template_by_department`
 * (`apps/text/src/text/models/prompts_json.py`). v1 branches on whether
 * `get_department_schema(department, visit_type)` produced a truthy schema:
 *
 * - WITH-SCHEMA branch: used when a department/visit-type schema (or the
 *   generic 4-field `JSON_RESPONSE_SPEC` fallback) is available — carries the
 *   `{conversation_language}` placeholder and a
 *   `Conform EXACTLY to this JSON schema (types are illustrative):` line
 *   followed by `json.dumps(schema, indent=2)`, exposed here as the
 *   `{schema_example}` placeholder.
 * - WITHOUT-SCHEMA branch: v1's `else` arm, reached only if
 *   `get_department_schema` ever returned a falsy value. In the CURRENT v1
 *   source it never does (the fallback is the always-truthy
 *   `JSON_RESPONSE_SPEC`, see `v1-department-schemas.ts`), so this branch is
 *   presently DEAD CODE in the running pod — extracted anyway per the ticket's
 *   1:1 instruction ("copy exactly, including both branches").
 *
 * Both branches share every line except the final "Conform..." sentence;
 * carried through as two SEPARATE byte-exact templates (not derived from one
 * another) so neither can silently drift out of sync with the source.
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
 * with-schema sha256 89cea88b9f95d658d8bee6cb2181f2a84ce87a357d7dd74ba44829818c9b8b57 1118 bytes
 * without-schema sha256 0beafca7cc6767da840396e7a9036182329e05633d5614ae032fabdcdbe0f583 1152 bytes
 */

/**
 * Byte-exact v1 "STRICT JSON RESPONSE FORMAT" block — WITH a resolved schema.
 * Placeholders: `{conversation_language}`, `{schema_example}` (a
 * `JSON.stringify(schema, null, 2)`-equivalent of the department schema, or
 * the `JSON_RESPONSE_SPEC` fallback — v1 uses Python's `json.dumps(indent=2)`,
 * which matches Node's `JSON.stringify(value, null, 2)` byte-for-byte for
 * these ASCII-only schema dicts).
 */
export const V1_JSON_RULES_WITH_SCHEMA_TEMPLATE: string =
  "\n\nSTRICT JSON RESPONSE FORMAT (CRITICAL):\n- Return ONLY valid JSON. No code fences or extra text.\n- Use the {conversation_language} for all values. Keep JSON keys in English.\n- Monolingual policy: All headings/labels and descriptive content inside values MUST be in the conversation language.\n- MARKDOWN FORMATTING REQUIRED: Format all content using proper markdown syntax:\n  * Use numbered lists (1. 2. 3.) for sequential items\n  * Use bullet points (- or *) for non-sequential lists\n  * Use **bold** for emphasis on key terms\n  * Use ## for section headers within content\n  * Ensure proper line breaks between list items and sections\n- If information is missing from the conversation, consult PRIOR MEDICAL CONTEXT to populate fields.\n- Never use placeholders for the 'summary' field; always provide a concise, best‑effort summary.\n- For other fields, if neither the conversation nor PRIOR MEDICAL CONTEXT provides information, write a brief sentence indicating absence in the conversation language (avoid literal 'Not documented').\n- Conform EXACTLY to this JSON schema (types are illustrative):\n{schema_example}\n";

/**
 * Byte-exact v1 "STRICT JSON RESPONSE FORMAT" block — WITHOUT a resolved
 * schema (v1's `else` arm; unreachable in the current pod, see docstring
 * above). Placeholders: `{conversation_language}` only.
 */
export const V1_JSON_RULES_WITHOUT_SCHEMA_TEMPLATE: string =
  "\n\nSTRICT JSON RESPONSE FORMAT (CRITICAL):\n- Return ONLY valid JSON. No code fences or extra text.\n- Use the {conversation_language} for all values. Keep JSON keys in English.\n- Monolingual policy: All headings/labels and descriptive content inside values MUST be in the conversation language.\n- MARKDOWN FORMATTING REQUIRED: Format all content using proper markdown syntax:\n  * Use numbered lists (1. 2. 3.) for sequential items\n  * Use bullet points (- or *) for non-sequential lists\n  * Use **bold** for emphasis on key terms\n  * Use ## for section headers within content\n  * Ensure proper line breaks between list items and sections\n- If information is missing from the conversation, consult PRIOR MEDICAL CONTEXT to populate fields.\n- Never use placeholders for the 'summary' field; always provide a concise, best‑effort summary.\n- For other fields, if neither the conversation nor PRIOR MEDICAL CONTEXT provides information, write a brief sentence indicating absence in the conversation language (avoid literal 'Not documented').\n- Conform to the schema defined by the active department/visit template. Do NOT invent fields beyond the template.\n";

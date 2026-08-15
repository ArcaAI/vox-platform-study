/**
 * V1 SMR summary WRAPPER artifacts (D-12), byte-exact from
 * the running v1 pod.
 *
 * `summary_service.py:212` selects the department body template
 * (`select_prompt_template`, ported in `../dept-templates.ts`), then wraps it
 * via `JsonPromptFactory.build_template_by_department`, which composes FIVE
 * further artifacts this directory captures 1:1:
 *
 *   1. `v1-summary-system-prompt.ts`          — `ConversationalPrompts.build_system_prompt()`
 *   2. `v1-department-schemas.ts`              — `get_department_schema` / `DEPT_VISIT_SCHEMAS`
 *   3. `v1-summary-user-prompt-template.ts`    — `ConversationalPrompts.build_user_prompt(...)`
 *   4. `v1-prior-medical-context.ts`           — the pre-summary-into-summary injection prefix
 *   5. `v1-strict-json-response-format.ts`     — the STRICT JSON RESPONSE FORMAT rule block (both branches)
 *
 * A byte-exact port of the 14 department × visit-type template BODIES
 * (`../dept-templates.ts`) is necessary but not sufficient for v1 output
 * parity — these five artifacts are the rest of what v1 actually sends.
 *
 * WIRING STATUS: WIRED (was: deliberately unwired pending the follow-up phase
 * this note anticipated — README Phase 5/6). The consumer is
 * `../v1-summary-prompt.builder.ts`, which performs the assembly-time
 * placeholder substitution these templates require (see
 * `v1-summary-user-prompt-template.ts`) and is used by the two compat routes in
 * `smr-compat.controller.ts`. The constants below remain GENERATED and
 * byte-exact — the checksum gate is unchanged; assembly happens entirely in the
 * builder. `summary-prompt.builder.ts` (the native Vox v2 path) still does not
 * import this module.
 *
 * For the checksum drift gate, see `__tests__/fixtures/checksum-manifest.json`
 * and `__tests__/checksum-manifest.test.ts`.
 */

export { V1_SUMMARY_SYSTEM_PROMPT } from './v1-summary-system-prompt';
export { V1_SUMMARY_USER_PROMPT_TEMPLATE } from './v1-summary-user-prompt-template';
export { V1_PRIOR_MEDICAL_CONTEXT_PREFIX } from './v1-prior-medical-context';
export { V1_JSON_RULES_WITH_SCHEMA_TEMPLATE, V1_JSON_RULES_WITHOUT_SCHEMA_TEMPLATE } from './v1-strict-json-response-format';
export { V1_DEPT_VISIT_SCHEMAS, V1_JSON_RESPONSE_SPEC_FALLBACK_JSON, type V1DeptVisitSchema } from './v1-department-schemas';

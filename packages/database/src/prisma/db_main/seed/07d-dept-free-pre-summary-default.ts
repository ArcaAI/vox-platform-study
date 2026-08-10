/**
 * TASK-635 D2 — the department-free pre-summary FORK served to NATIVE callers.
 *
 * Owner decision OD-1(b) + refinement RF-1 (README §3.1): R-C3 flagged that the
 * pre-summary resolution chain is department-agnostic in SELECTION but the
 * v1-parity prompt BODY still interpolates `{current_department}`/`{visit_type}`
 * and its three "(Latest Dept Note)" FORMAT headings. RF-1 forbids stripping
 * those out of the shared v1 body: the v1-compat response mapper
 * (`apps/api/src/modules/smr-compat/summary-response.mapper.ts`,
 * `PRE_SUMMARY_DISPLAY_TITLES`) title-matches those exact headings, so a
 * dept-free body on the compat surface would return empty
 * `structured_data.sections` to every v1 client. The fix is this NEW,
 * NATIVE-ONLY fork — the v1-parity template (`SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT`,
 * `07-prompt-template.ts`) and its byte-locked ArcaAI sibling
 * (`PRE_SUMMARY_CONTENT`, `07b-arcaai-clinical-content.ts`) are left untouched.
 *
 * DERIVATION (from `SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT`, hand-applied, not
 * generated — this file's own checksum test locks the result so it cannot
 * silently drift from the diff below):
 *   - dropped `- **Department:** {current_department}`
 *   - dropped `- **Visit Type:** {visit_type}`
 *   - dropped `- Notes from {current_department}` from PRIORITIZE (replaced by
 *     the pre-existing sibling bullet, "Most recent encounters")
 *   - "the latest note in the current department" / "the latest department
 *     note" → "the latest note" (CAPTURE section, 3 occurrences)
 *   - FORMAT headings: "(Latest Department Note)" → "(Latest Note)" (3
 *     occurrences — Investigations, Plan of Care, Medications Prescribed). RF-1
 *     permits this: native does not go through the compat title-matching mapper.
 *   - Nothing else changed: the FORMAT section order, the five FORMAT items,
 *     the STYLE/INSTRUCTIONS/EXCLUDE blocks, and the remaining seven variables
 *     (`safe_age`, `safe_dob`, `safe_gender`, `safe_vitals`,
 *     `formatted_test_results`, `formatted_previous_visits`, `language_name`)
 *     are byte-identical to the v1-parity body.
 *
 * This row is SYSTEM-owned, resolved DIRECTLY by
 * `SYSTEM_DEFAULTS.deptFreePreSummaryPromptId`
 * (`prompt-resolution.service.ts`) — never by a tag scan — exactly like the
 * live-summarization SYSTEM default this file's shape is modeled on
 * (`07c-live-agent-defaults.ts`). Its content is locked by
 * `packages/database/src/__tests__/system-dept-free-pre-summary-default-checksum.test.ts`.
 *
 * NOT added to `v1-clinical-prompt-checksums.fixture.ts` (that fixture asserts
 * exactly 15 entries with v1-live-pod provenance; this body has neither — it
 * is a hand-derived fork, not an extraction from the running v1 pod).
 */
import type { CorePrismaClient } from '../../../client';
import { Prisma } from '../../../generated/core-prisma-client/client';
import type { PromptTemplateCategory, PromptTemplateScope, PromptTemplateStatus } from '../../../generated/core-prisma-client/enums';
import {
  SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE_ID,
  SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION_ID,
  SYSTEM_TENANT_ID,
  SYSTEM_USER_ID,
} from './00-constants';

/**
 * The department-free pre-summary body served to native callers
 * (`preSummaryVariant: 'dept-free'`). See the file header for the exact diff
 * against `SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT` (`07-prompt-template.ts`).
 */
export const SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT =
  '## Medical AI Pre-Summary Prompt\n\n' +
  '> **You are a medical AI assistant tasked with creating a CRISP, CLINICALLY-RELEVANT pre-summary from multiple data sources.\n\n' +
  'Do not carry over information from any other patient. Treat each request independently..**\n\n' +
  '---\n\n' +
  '### ** Contextual data is provided by **\n\n' +
  '- **Demographics:** Age {safe_age}, DOB {safe_dob}, Gender {safe_gender}\n\n' +
  '- **Recent Vitals:** {safe_vitals} (two most recent encounters)\n\n' +
  '- **Test Results:** {formatted_test_results}\n\n' +
  '- **Previous Visits:** {formatted_previous_visits}\n\n' +
  '---\n\n' +
  '## REQUIREMENTS\n\n' +
  '### PRIORITIZE:\n\n' +
  '- Most recent encounters\n\n' +
  '### CAPTURE:\n\n' +
  '- All provisional and confirmed diagnoses mentioned in any past case note\n\n' +
  '- The Plan of Care from the latest note, documented in full\n\n' +
  '- All investigation results reported in the latest note\n\n' +
  '- All medications prescribed in the latest note, including doses and schedules\n\n' +
  '### INCLUDE ONLY clinically significant items:\n\n' +
  '- Active or ongoing conditions\n\n' +
  '- Key treatments and responses\n\n' +
  '- Current medications and tolerance\n\n' +
  '- Important test results or procedures\n\n' +
  '- Allergies/contraindications\n\n' +
  '- Notable trends (e.g., weight changes, lab trajectories)\n\n' +
  '### EXCLUDE:\n\n' +
  '- Routine follow-ups without new findings\n\n' +
  '- Minor resolved complaints\n\n' +
  '- Administrative text\n\n' +
  '- Repetitive details\n\n' +
  '### STYLE:\n\n' +
  '- Use bullet points\n\n' +
  '- Group by clinical importance, not strictly chronology\n\n' +
  '- Maintain brevity: keep each bullet to one sentence or phrase\n\n' +
  '- Language: {language_name}\n\n' +
  '### INSTRUCTIONS\n\n' +
  '- Use the following section headers EXACTLY as written (in English) and do NOT translate them.\n' +
  '- Write ALL bullet content in {language_name}, including any text inside parentheses.\n' +
  '- Translate ALL English descriptors from context into {language_name}\n' +
  '- Translate ALL text that appears in parentheses into {language_name}\n' +
  '- Parentheses Localization Policy: For any parentheses that contain English words, translate them into {language_name}. If a direct translation is unclear, paraphrase briefly in {language_name}. Only leave English inside parentheses for standard clinical abbreviations (BP, HR, RR, Temp, SpO2) and measurement units (°C, mmHg, mg, ml).\n' +
  '- Do NOT include English words in bullet items or parentheses, except for:\n' +
  '- Standard clinical abbreviations (e.g., BP, HR, RR, Temp, SpO2)\n' +
  '- Measurement units (e.g., °C, mmHg, mg, ml)\n' +
  '- Before finalizing, perform a self-check: scan every pair of parentheses and ensure there are no English words inside (except the allowed abbreviations/units). If any are found, replace them with {language_name} equivalents.\n' +
  '- Translate or localize any status or qualifier terms or any text inside parentheses into {language_name}.\n\n' +
  '---\n\n' +
  '## FORMAT\n\n' +
  'Pre-Summary of Medical History  \n\n' +
  '- Confirmed & Provisional Diagnoses:  \n\n' +
  '- Plan of Care (Latest Note):  \n\n' +
  '- Investigations (Latest Note):  \n\n' +
  '- Medications Prescribed (Latest Note):  \n\n' +
  '- Diagnostics & Trends:\n\n' +
  '---\n\n' +
  'Now generate the pre-summary.';

export const SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE = {
  id: SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE_ID,
  tenantId: SYSTEM_TENANT_ID,
  name: 'Pre-Summary Default Template (Department-Free)',
  description:
    'Native-only department-free pre-summary template (TASK-635 D2 / OD-1b / RF-1). No {current_department} or ' +
    '{visit_type} placeholder and no "(Latest Dept Note)" heading; served to native callers via ' +
    "preSummaryVariant: 'dept-free'. The v1-compat surface never resolves this row — it keeps the v1-parity body " +
    'forever (RF-1 wire contract, PRE_SUMMARY_DISPLAY_TITLES title-match).',
  content: SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT,
  category: 'SYSTEM' as PromptTemplateCategory,
  status: 'APPROVED' as PromptTemplateStatus,
  scope: 'TENANT_DEFAULT' as PromptTemplateScope,
  // Pinned to v1 so the resolver serves the IMMUTABLE PromptVersion snapshot.
  approvedVersionNumber: 1,
  currentVersionNumber: 1,
  departmentId: null as string | null,
  variables: {
    safe_age: 'Patient age',
    safe_dob: 'Patient date of birth',
    safe_gender: 'Patient gender',
    safe_vitals: 'Recent vitals data',
    formatted_test_results: 'Formatted test results',
    formatted_previous_visits: 'Formatted previous visit summaries',
    language_name: 'Output language name',
  } as Prisma.InputJsonValue,
  // RF-2 surface tag: 'dept-free' discriminates this row from the tenant's
  // 'smr-v1' pre-summary row so the tenant tier never sees two candidates for
  // the same surface. 'system-default' matches the C1 D2 fork contract.
  tags: ['pre-summary', 'dept-free', 'system-default'],
};

export const SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION = {
  id: SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION_ID,
  tenantId: SYSTEM_TENANT_ID,
  promptTemplateId: SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE_ID,
  versionNumber: 1,
  content: SYSTEM_DEPT_FREE_PRE_SUMMARY_CONTENT,
  changeReason: 'Initial version — department-free fork of SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT (TASK-635 D2)',
  changedBy: SYSTEM_USER_ID,
};

/**
 * Idempotent upsert-by-id. Runs in Phase 3, alongside `seedLiveAgentDefaults`
 * (shares the PromptTemplate / PromptVersion tables); nothing binds this row
 * except the explicit `SYSTEM_DEFAULTS.deptFreePreSummaryPromptId` pointer the
 * native pre-summary call sites now pass `preSummaryVariant: 'dept-free'` to
 * reach.
 */
export const seedDeptFreePreSummaryDefault = async (client: CorePrismaClient) => {
  console.log('Seeding SYSTEM department-free pre-summary default (TASK-635 D2)...');

  const { variables, ...rest } = SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE;
  const templateData = { ...rest, variables };
  await client.promptTemplate.upsert({
    where: { id: SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE.id },
    update: templateData,
    create: templateData,
  });

  await client.promptVersion.upsert({
    where: { id: SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION.id },
    update: SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION,
    create: SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION,
  });

  console.log('Seeded 1 SYSTEM department-free pre-summary default prompt template + v1 version');
};

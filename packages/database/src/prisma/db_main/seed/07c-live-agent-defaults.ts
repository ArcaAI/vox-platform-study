/**
 * TASK-635 C2 — SYSTEM platform defaults for the live-summarization agent.
 *
 * Seeds ONE SYSTEM-tenant `PromptTemplate` (+ its v1 `PromptVersion` snapshot)
 * whose content is BYTE-IDENTICAL to the live loop's currently hardcoded
 * prompt constants in
 * `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts`:
 *
 *   content                            ← `LIVE_SOAP_STABLE_SYSTEM_PREFIX`
 *   metaData.promptConfig.systemPrompt ← the `system_prompt` literal in `callSmr`
 *
 * WHY BYTE-IDENTICAL MATTERS. Lane C3 turns the live prompt into a resolved,
 * governed template with a three-tier chain: agent binding → this SYSTEM
 * default → the in-code constants (a deliberate, documented FAIL-OPEN, because
 * a live consultation must never fail on a prompt-resolution error). Tier 3 is
 * only safe because its bytes are PROVEN identical to tier 2's — "fail-open"
 * then degrades to *identical behavior*, not different behavior. Two tests
 * enforce that, from opposite sides of the package boundary:
 *
 *   packages/database/src/__tests__/system-live-soap-default-checksum.test.ts
 *     — sha256(the constants below) === the pinned hashes
 *   packages/applications/src/services/consultation/live-documentation/__tests__/
 *     live-soap-prompt-checksum.test.ts
 *     — sha256(LIVE_SOAP_STABLE_SYSTEM_PREFIX / the system_prompt literal)
 *       === THE SAME pinned hashes
 *
 * A cross-package `import` is deliberately NOT used: `packages/database` may
 * not depend on `packages/applications` (that is the dependency direction), and
 * the seed modules are not part of the database package's public exports. The
 * paired-checksum shape is the same divergence guard
 * `07b-arcaai-clinical-templates.ts` uses for `PRE_SUMMARY_VARIABLES`, and it is
 * exactly as strong: neither side can change without turning its own test RED.
 *
 * CATEGORY/TAG CHOICE (C1 item 4 — "category or tag": TAG). `PromptTemplateCategory`
 * has no `LIVE_SUMMARY` member and adding one means an `ALTER TYPE` plus
 * enum-parity churn for zero resolver benefit — resolution targets this row by
 * the explicit `SYSTEM_DEFAULTS.livePromptId` pointer, never by scanning a
 * category. It is seeded `SYSTEM` + tagged `live-summary` / `system-default`.
 *
 * The system-role string rides under `metaData.promptConfig.systemPrompt`,
 * reusing the existing metaData convention (`PromptAssemblyService` already
 * reads `promptConfig.hyperparameters` / `promptConfig.outputSchema` the same
 * way) — no schema change, no new column.
 */
import type { CorePrismaClient } from '../../../client';
import { Prisma } from '../../../generated/core-prisma-client/client';
import type { PromptTemplateCategory, PromptTemplateScope, PromptTemplateStatus } from '../../../generated/core-prisma-client/enums';
import { SYSTEM_LIVE_SOAP_TEMPLATE_ID, SYSTEM_LIVE_SOAP_VERSION_ID, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/**
 * Byte-for-byte copy of `SOAP_OUTPUT_INSTRUCTION`
 * (live-documentation.service.ts). Split out exactly as the source does so the
 * two are diffable line-by-line.
 */
const SOAP_OUTPUT_INSTRUCTION =
  'Output EXACTLY these four sections, each header on its own line, in this order, and nothing else:\n\n' +
  'Subjective: <patient-reported history and symptoms>\n' +
  'Objective: <exam findings, vitals, labs>\n' +
  'Assessment: <clinical impressions / diagnoses>\n' +
  'Plan: <next steps, medications, follow-up>\n\n' +
  'Leave a section blank after its header if there is nothing yet. Do not invent details or add other sections.';

/**
 * Byte-for-byte copy of `LIVE_SOAP_STABLE_SYSTEM_PREFIX`. This is the stable,
 * prefix-cache-friendly lead-in the live loop emits FIRST on every flush of a
 * session; freezing it per session is what keeps a vLLM / llama.cpp KV cache
 * warm across flushes.
 */
export const SYSTEM_LIVE_SOAP_PROMPT_CONTENT =
  'You are assisting a clinician during a live consultation, maintaining a concise, factual ' +
  'running clinical note structured as SOAP. ' +
  SOAP_OUTPUT_INSTRUCTION;

/** Byte-for-byte copy of the `system_prompt` literal in `callSmr`. */
export const SYSTEM_LIVE_SOAP_SYSTEM_PROMPT =
  'You are a clinical documentation assistant generating an in-progress, structured SOAP running note. ' +
  'Be concise and faithful to the transcript; never fabricate findings.';

export const SYSTEM_LIVE_SOAP_TEMPLATE = {
  id: SYSTEM_LIVE_SOAP_TEMPLATE_ID,
  tenantId: SYSTEM_TENANT_ID,
  name: 'Live SOAP Running Note — System Default',
  description:
    'Platform default prompt for the live-summarization loop. Byte-identical to the in-code ' +
    "LIVE_SOAP_STABLE_SYSTEM_PREFIX constant, so the live chain's code-default fail-open tier " +
    'degrades to identical behavior (TASK-635 C1 §4.4).',
  content: SYSTEM_LIVE_SOAP_PROMPT_CONTENT,
  category: 'SYSTEM' as PromptTemplateCategory,
  status: 'APPROVED' as PromptTemplateStatus,
  scope: 'TENANT_DEFAULT' as PromptTemplateScope,
  // Pinned to v1 so the resolver serves the IMMUTABLE PromptVersion snapshot,
  // never the mutable `content` column (the F-02 integrity path).
  approvedVersionNumber: 1,
  currentVersionNumber: 1,
  departmentId: null as string | null,
  variables: null as Prisma.InputJsonValue | null,
  tags: ['live-summary', 'system-default'],
  metaData: { promptConfig: { systemPrompt: SYSTEM_LIVE_SOAP_SYSTEM_PROMPT } } as Prisma.InputJsonValue,
};

export const SYSTEM_LIVE_SOAP_VERSION = {
  id: SYSTEM_LIVE_SOAP_VERSION_ID,
  tenantId: SYSTEM_TENANT_ID,
  promptTemplateId: SYSTEM_LIVE_SOAP_TEMPLATE_ID,
  versionNumber: 1,
  content: SYSTEM_LIVE_SOAP_PROMPT_CONTENT,
  changeReason: 'Initial version (ported verbatim from the in-code live-summarization prompt constants)',
  changedBy: SYSTEM_USER_ID,
};

/**
 * Idempotent upsert-by-id. Runs in Phase 3 AFTER `seedPromptTemplate` /
 * `seedArcaaiClinicalTemplates` (shares the PromptTemplate / PromptVersion
 * tables) and BEFORE `seedAgentGoldenLibrary` is irrelevant — nothing binds
 * this row yet (the live chain resolves it by explicit id in C3).
 */
export const seedLiveAgentDefaults = async (client: CorePrismaClient) => {
  console.log('Seeding SYSTEM live-agent defaults (TASK-635)...');

  const { metaData, variables, ...rest } = SYSTEM_LIVE_SOAP_TEMPLATE;
  const templateData = {
    ...rest,
    ...(variables != null ? { variables } : {}),
    metaData,
  };
  await client.promptTemplate.upsert({
    where: { id: SYSTEM_LIVE_SOAP_TEMPLATE.id },
    update: templateData,
    create: templateData,
  });

  await client.promptVersion.upsert({
    where: { id: SYSTEM_LIVE_SOAP_VERSION.id },
    update: SYSTEM_LIVE_SOAP_VERSION,
    create: SYSTEM_LIVE_SOAP_VERSION,
  });

  console.log('Seeded 1 SYSTEM live-summarization default prompt template + v1 version');
};

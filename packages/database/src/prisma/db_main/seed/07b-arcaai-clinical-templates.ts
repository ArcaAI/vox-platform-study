/**
 * TASK-592 Workstream D — ArcaAI clinical prompt library.
 *
 * Ports HOPE v1's department × visit-type clinical instruction templates into
 * the v2 seed for the **ArcaAI customer tenant** (50000000-…0001), wired so
 * `PromptResolutionService` resolves them PER VISIT TYPE.
 *
 * Wiring model — TWO paths that resolve the SAME template, by construction:
 *   - tier-1a (preferred, since TASK-635 RF-3): the SEVEN departments seeded by
 *     TASK-592 have ONE default `DepartmentAgent` whose per-visit-type bindings
 *     (`newPatientTemplateId` / `revisitTemplateId`) name the ids below —
 *     ARCAAI_TENANT_AGENTS in 07a-agent-golden-library.ts. The FOUR departments
 *     added by TASK-634 Phase 8b carry NO agent and reach their templates
 *     through tier-1b only;
 *   - tier-1b: the LEGACY Department prompt-id columns (`newPatientPromptId` /
 *     `revisitPromptId` in 04-department.ts), set on all eleven and pointing at
 *     the very same ids.
 * Before TASK-635 the agent tier could not be used at all here, because a
 * DepartmentAgent was a single prompt pointer that ignored visit type and would
 * have collapsed v1's new-referral vs follow-up split. C2 added the visit-type
 * axis, which is what makes the agent tier safe for this tenant.
 *
 * 23 rows: 22 department × visit-type SUMMARY templates (11 v1 departments ×
 * {new referral, follow-up} — exactly v1's `DEPT_VISIT_SCHEMAS` cardinality) +
 * 1 shared TENANT-scoped pre-summary template.
 * Each has a matching v1-content PromptVersion, and each
 * is seeded APPROVED with `approvedVersionNumber = 1` so the resolver serves the
 * pinned `PromptVersion` snapshot (never the mutable `content` row) — the F-01 /
 * F-02 integrity path (see PromptResolutionService.resolveGovernedContent).
 *
 * The verbatim v1 CONTENT strings live in 07b-arcaai-clinical-content.ts
 * (generated, byte-exact). This module owns only the structure/wiring.
 *
 * ID blocks (documented in 00-constants.ts): ArcaAI tenant templates use the
 * `71000000-…-0001-…` group, slots 010-032; their versions mirror in
 * `72000000-…-0001-…` via the deterministic `72${id.slice(2)}` convention.
 */
import type { CorePrismaClient } from '../../../client';
import { Prisma } from '../../../generated/core-prisma-client/client';
import type { PromptTemplateCategory, PromptTemplateScope, PromptTemplateStatus } from '../../../generated/core-prisma-client/enums';
import { SEED_CUSTOMER_TENANT_IDS, SEED_DEPARTMENT_IDS, SYSTEM_USER_ID } from './00-constants';
import {
  BREAST_ENDOCRINE_FOLLOWUP_CONTENT,
  BREAST_ENDOCRINE_NEW_REFERRAL_CONTENT,
  DERMATOLOGY_FOLLOWUP_CONTENT,
  DERMATOLOGY_NEW_REFERRAL_CONTENT,
  DIETETICS_FOLLOWUP_CONTENT,
  DIETETICS_NEW_REFERRAL_CONTENT,
  HEMATOLOGY_NEW_REFERRAL_CONTENT,
  HEMATOLOGY_REVISIT_CONTENT,
  MEDICINE_FOLLOWUP_CONTENT,
  MEDICINE_NEW_REFERRAL_CONTENT,
  NEPHROLOGY_FOLLOWUP_CONTENT,
  NEPHROLOGY_NEW_REFERRAL_CONTENT,
  NEUROLOGY_FOLLOWUP_CONTENT,
  NEUROLOGY_NEW_REFERRAL_CONTENT,
  ORTHOPEDICS_NEW_REFERRAL_CONTENT,
  ORTHOPEDICS_REVIEW_CONTENT,
  PRE_SUMMARY_CONTENT,
  RHEUMATOLOGY_FOLLOWUP_CONTENT,
  RHEUMATOLOGY_NEW_REFERRAL_CONTENT,
  SURGERY_FOLLOWUP_CONTENT,
  SURGERY_NEW_REFERRAL_CONTENT,
  SURGICAL_ONCOLOGY_FOLLOWUP_CONTENT,
  SURGICAL_ONCOLOGY_NEW_REFERRAL_CONTENT,
} from './07b-arcaai-clinical-content';

const ARCAAI_TENANT_ID = SEED_CUSTOMER_TENANT_IDS.ARCAAI;

const ARCAAI_DEPARTMENT_ID_BY_CODE = {
  GEN: SEED_DEPARTMENT_IDS.GEN_ARCAAI,
  SURG: SEED_DEPARTMENT_IDS.SURG_ARCAAI,
  RHEUM: SEED_DEPARTMENT_IDS.RHEUM_ARCAAI,
  NEUR: SEED_DEPARTMENT_IDS.NEUR_ARCAAI,
  ORTH: SEED_DEPARTMENT_IDS.ORTH_ARCAAI,
  HEME: SEED_DEPARTMENT_IDS.HEME_ARCAAI,
  BREN: SEED_DEPARTMENT_IDS.BREN_ARCAAI,
  DERM: SEED_DEPARTMENT_IDS.DERM_ARCAAI,
  DIET: SEED_DEPARTMENT_IDS.DIET_ARCAAI,
  NEPH: SEED_DEPARTMENT_IDS.NEPH_ARCAAI,
  SONC: SEED_DEPARTMENT_IDS.SONC_ARCAAI,
} as const;

const ARCAAI_DEPARTMENT_CODES = Object.keys(ARCAAI_DEPARTMENT_ID_BY_CODE) as Array<keyof typeof ARCAAI_DEPARTMENT_ID_BY_CODE>;

/**
 * ArcaAI clinical template ids. Exported so 04-department.ts can wire the
 * legacy Department prompt-id columns to them.
 */
export const ARCAAI_CLINICAL_TEMPLATE_IDS = {
  SURGERY_NEW_REFERRAL: '71000000-0000-0000-0001-000000000010',
  SURGERY_FOLLOWUP: '71000000-0000-0000-0001-000000000011',
  MEDICINE_NEW_REFERRAL: '71000000-0000-0000-0001-000000000012',
  MEDICINE_FOLLOWUP: '71000000-0000-0000-0001-000000000013',
  RHEUMATOLOGY_NEW_REFERRAL: '71000000-0000-0000-0001-000000000014',
  RHEUMATOLOGY_FOLLOWUP: '71000000-0000-0000-0001-000000000015',
  NEUROLOGY_NEW_REFERRAL: '71000000-0000-0000-0001-000000000016',
  NEUROLOGY_FOLLOWUP: '71000000-0000-0000-0001-000000000017',
  ORTHOPEDICS_NEW_REFERRAL: '71000000-0000-0000-0001-000000000018',
  ORTHOPEDICS_REVIEW: '71000000-0000-0000-0001-000000000019',
  HEMATOLOGY_NEW_REFERRAL: '71000000-0000-0000-0001-000000000020',
  HEMATOLOGY_REVISIT: '71000000-0000-0000-0001-000000000021',
  BREAST_ENDOCRINE_NEW_REFERRAL: '71000000-0000-0000-0001-000000000022',
  BREAST_ENDOCRINE_FOLLOWUP: '71000000-0000-0000-0001-000000000023',
  PRE_SUMMARY: '71000000-0000-0000-0001-000000000024',
  // TASK-634 Phase 8b — the four remaining v1 departments. Slots continue after
  // the pre-summary (…024); the block is contiguous, not grouped by department.
  DERMATOLOGY_NEW_REFERRAL: '71000000-0000-0000-0001-000000000025',
  DERMATOLOGY_FOLLOWUP: '71000000-0000-0000-0001-000000000026',
  DIETETICS_NEW_REFERRAL: '71000000-0000-0000-0001-000000000027',
  DIETETICS_FOLLOWUP: '71000000-0000-0000-0001-000000000028',
  NEPHROLOGY_NEW_REFERRAL: '71000000-0000-0000-0001-000000000029',
  NEPHROLOGY_FOLLOWUP: '71000000-0000-0000-0001-000000000030',
  SURGICAL_ONCOLOGY_NEW_REFERRAL: '71000000-0000-0000-0001-000000000031',
  SURGICAL_ONCOLOGY_FOLLOWUP: '71000000-0000-0000-0001-000000000032',
} as const;

// The initial version of each template reuses the template UUID with the `72…`
// (PromptVersion) prefix — the deterministic cross-reference convention from
// 07-prompt-template.ts.
const versionId = (templateId: string): string => `72${templateId.slice(2)}`;

interface ClinicalTemplateSpec {
  id: string;
  name: string;
  description: string;
  content: string;
  departmentId: string | null;
  scope: PromptTemplateScope;
  tags: string[];
  /** Declared placeholder names, when the body carries v1 `{single-brace}` variables. */
  variables?: Prisma.InputJsonValue;
}

/**
 * The nine v1 pre-summary placeholders, in the order they first appear in the
 * body. Declared here (not imported) because `packages/database` must not depend
 * on `apps/api`; the runtime substituter that consumes them is
 * `renderPreSummaryTemplate` / `PRE_SUMMARY_TEMPLATE_VARIABLES` in
 * apps/api/src/modules/smr-compat/summary-prompt.builder.ts. A test there asserts
 * the declared set equals the placeholders actually present in the body, so the
 * two lists cannot silently diverge.
 */
const PRE_SUMMARY_VARIABLES = [
  'current_department',
  'visit_type',
  'safe_age',
  'safe_dob',
  'safe_gender',
  'safe_vitals',
  'formatted_test_results',
  'formatted_previous_visits',
  'language_name',
] as const;

const SUMMARY_SPECS: ClinicalTemplateSpec[] = [
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.SURGERY_NEW_REFERRAL,
    name: 'Surgery - New Referral',
    description: 'ArcaAI Surgery — New/Referral patient clinical note prompt (v1 port).',
    content: SURGERY_NEW_REFERRAL_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.SURG_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'surgery', 'new_referral', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.SURGERY_FOLLOWUP,
    name: 'Surgery - Follow-up',
    description: 'ArcaAI Surgery — Follow-up/Revisit clinical note prompt (v1 port).',
    content: SURGERY_FOLLOWUP_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.SURG_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'surgery', 'followup', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.MEDICINE_NEW_REFERRAL,
    name: 'General Medicine - New Referral',
    description: 'ArcaAI General Medicine — New/Referral patient clinical note prompt (v1 port).',
    content: MEDICINE_NEW_REFERRAL_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.GEN_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'medicine', 'new_referral', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.MEDICINE_FOLLOWUP,
    name: 'General Medicine - Follow-up',
    description: 'ArcaAI General Medicine — Follow-up/Revisit clinical note prompt (v1 port).',
    content: MEDICINE_FOLLOWUP_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.GEN_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'medicine', 'followup', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.RHEUMATOLOGY_NEW_REFERRAL,
    name: 'Rheumatology - New Referral',
    description: 'ArcaAI Rheumatology — New/Referral patient clinical note prompt (v1 port).',
    content: RHEUMATOLOGY_NEW_REFERRAL_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.RHEUM_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'rheumatology', 'new_referral', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.RHEUMATOLOGY_FOLLOWUP,
    name: 'Rheumatology - Follow-up',
    description: 'ArcaAI Rheumatology — Follow-up/Revisit clinical note prompt (v1 port).',
    content: RHEUMATOLOGY_FOLLOWUP_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.RHEUM_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'rheumatology', 'followup', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.NEUROLOGY_NEW_REFERRAL,
    name: 'Neurology - New Referral',
    description: 'ArcaAI Neurology — New/Referral patient clinical note prompt (v1 port).',
    content: NEUROLOGY_NEW_REFERRAL_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.NEUR_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'neurology', 'new_referral', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.NEUROLOGY_FOLLOWUP,
    name: 'Neurology - Follow-up',
    description: 'ArcaAI Neurology — Follow-up/Revisit clinical note prompt (v1 port).',
    content: NEUROLOGY_FOLLOWUP_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.NEUR_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'neurology', 'followup', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.ORTHOPEDICS_NEW_REFERRAL,
    name: 'Orthopedics - New Referral',
    description: 'ArcaAI Orthopedics — New/Referral patient clinical note prompt (v1 port).',
    content: ORTHOPEDICS_NEW_REFERRAL_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.ORTH_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'orthopedics', 'new_referral', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.ORTHOPEDICS_REVIEW,
    name: 'Orthopedics - Review',
    description: 'ArcaAI Orthopedics — Review/Revisit clinical note prompt (v1 port).',
    content: ORTHOPEDICS_REVIEW_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.ORTH_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'orthopedics', 'review', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.HEMATOLOGY_NEW_REFERRAL,
    name: 'Hematology - New Referral',
    description: 'ArcaAI Hematology — New/Referral patient clinical note prompt (v1 port).',
    content: HEMATOLOGY_NEW_REFERRAL_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.HEME_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'hematology', 'new_referral', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.HEMATOLOGY_REVISIT,
    name: 'Hematology - Revisit',
    description: 'ArcaAI Hematology — Revisit/Follow-up clinical note prompt (v1 port).',
    content: HEMATOLOGY_REVISIT_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.HEME_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'hematology', 'revisit', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.BREAST_ENDOCRINE_NEW_REFERRAL,
    name: 'Breast & Endocrine - New Referral',
    description: 'ArcaAI Breast & Endocrine — New/Referral patient clinical note prompt (v1 port).',
    content: BREAST_ENDOCRINE_NEW_REFERRAL_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.BREN_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'breast_endocrine', 'new_referral', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.BREAST_ENDOCRINE_FOLLOWUP,
    name: 'Breast & Endocrine - Follow-up',
    description: 'ArcaAI Breast & Endocrine — Follow-up/Revisit clinical note prompt (v1 port).',
    content: BREAST_ENDOCRINE_FOLLOWUP_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.BREN_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'breast_endocrine', 'followup', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.DERMATOLOGY_NEW_REFERRAL,
    name: 'Dermatology - New Referral',
    description: 'ArcaAI Dermatology — New/Referral patient clinical note prompt (v1 port).',
    content: DERMATOLOGY_NEW_REFERRAL_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.DERM_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'dermatology', 'new_referral', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.DERMATOLOGY_FOLLOWUP,
    name: 'Dermatology - Follow-up',
    description: 'ArcaAI Dermatology — Follow-up/Revisit clinical note prompt (v1 port).',
    content: DERMATOLOGY_FOLLOWUP_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.DERM_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'dermatology', 'followup', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.DIETETICS_NEW_REFERRAL,
    name: 'Dietetics - New Referral',
    description: 'ArcaAI Dietetics — New/Referral patient clinical note prompt (v1 port).',
    content: DIETETICS_NEW_REFERRAL_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.DIET_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'dietetics', 'new_referral', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.DIETETICS_FOLLOWUP,
    name: 'Dietetics - Follow-up',
    description: 'ArcaAI Dietetics — Follow-up/Revisit clinical note prompt (v1 port).',
    content: DIETETICS_FOLLOWUP_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.DIET_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'dietetics', 'followup', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.NEPHROLOGY_NEW_REFERRAL,
    name: 'Nephrology - New Referral',
    description: 'ArcaAI Nephrology — New/Referral patient clinical note prompt (v1 port).',
    content: NEPHROLOGY_NEW_REFERRAL_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.NEPH_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'nephrology', 'new_referral', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.NEPHROLOGY_FOLLOWUP,
    name: 'Nephrology - Follow-up',
    description: 'ArcaAI Nephrology — Follow-up/Revisit clinical note prompt (v1 port).',
    content: NEPHROLOGY_FOLLOWUP_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.NEPH_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'nephrology', 'followup', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.SURGICAL_ONCOLOGY_NEW_REFERRAL,
    name: 'Surgical Oncology - New Referral',
    description: 'ArcaAI Surgical Oncology — New/Referral patient clinical note prompt (v1 port).',
    content: SURGICAL_ONCOLOGY_NEW_REFERRAL_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.SONC_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'surgical_oncology', 'new_referral', 'smr-v1'],
  },
  {
    id: ARCAAI_CLINICAL_TEMPLATE_IDS.SURGICAL_ONCOLOGY_FOLLOWUP,
    name: 'Surgical Oncology - Follow-up',
    description: 'ArcaAI Surgical Oncology — Follow-up/Revisit clinical note prompt (v1 port).',
    content: SURGICAL_ONCOLOGY_FOLLOWUP_CONTENT,
    departmentId: SEED_DEPARTMENT_IDS.SONC_ARCAAI,
    scope: 'DEPARTMENT_DEFAULT',
    tags: ['arcaai', 'clinical', 'surgical_oncology', 'followup', 'smr-v1'],
  },
];

// Shared pre-summary — TENANT-scoped, no department binding.
//
// Pre-summary has NO department axis and NO visit-type axis. In v1 there is
// exactly ONE pre-summary prompt for the whole tenant; department and visit type
// are VARIABLES INSIDE it, never selectors for a different prompt (v1
// `select_prompt_template` is called only from the summary path). The ArcaAI
// departments therefore no longer set `preSummaryPromptId` (see
// 04-department.ts) — this tenant-wide spec is the single pre-summary row.
const PRE_SUMMARY_SPEC: ClinicalTemplateSpec = {
  id: ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY,
  name: 'Clinical Pre-Summary',
  description: 'ArcaAI tenant-wide pre-summary instruction prompt — department-agnostic fallback for every pre-summary request (v1 port).',
  content: PRE_SUMMARY_CONTENT,
  departmentId: null,
  scope: 'TENANT_DEFAULT',
  tags: ['arcaai', 'clinical', 'pre-summary', 'smr-v1'],
  variables: [...PRE_SUMMARY_VARIABLES],
};

const ALL_SPECS: ClinicalTemplateSpec[] = [...SUMMARY_SPECS, PRE_SUMMARY_SPEC];

/**
 * ArcaAI's DEFAULT / FALLBACK templates — what to use when the request carries
 * no department, an unknown department, or a department with no configured
 * agent or visit-type template.
 *
 * `PRE_SUMMARY` is the tenant-wide pre-summary prompt for EVERY request (there
 * is no per-department pre-summary; it is not a fallback so much as the only
 * one). `SUMMARY` is the department-agnostic clinical note prompt, used when the
 * department × visit-type lookup finds nothing — mirroring v1, where an
 * unmatched department falls through to the generic conversational prompt with
 * an empty department schema rather than to another department's prompt.
 *
 * NOTE — the pre-summary chain (PromptResolutionService.resolvePreSummaryPromptId,
 * TASK-634) deliberately skips the preferred/agent/department tiers and resolves
 * tenant TENANT_DEFAULT row (tag-convention lookup: scope=TENANT_DEFAULT,
 * departmentId null, tag 'pre-summary', APPROVED, via findTenantPreSummaryTemplateId)
 * → SYSTEM_DEFAULTS.preSummaryPromptId → 503 fail-closed. This seed's PRE_SUMMARY_SPEC
 * is exactly the tenant-tier row that convention matches.
 */
/** Full PromptTemplate rows — APPROVED + approvedVersionNumber-pinned. */
export const ARCAAI_CLINICAL_TEMPLATES = ALL_SPECS.map((spec) => ({
  id: spec.id,
  tenantId: ARCAAI_TENANT_ID,
  name: spec.name,
  description: spec.description,
  content: spec.content,
  category: 'SUMMARY' as PromptTemplateCategory,
  status: 'APPROVED' as PromptTemplateStatus,
  scope: spec.scope,
  variables: (spec.variables ?? null) as Prisma.InputJsonValue | null,
  currentVersionNumber: 1,
  // Pin the approval to v1 so the resolver serves the PromptVersion snapshot
  // (never the mutable content row) — avoids the F-02 unpinned-latest caveat.
  approvedVersionNumber: 1,
  departmentId: spec.departmentId,
  tags: spec.tags,
}));

/** One v1-content PromptVersion snapshot per template. */
export const ARCAAI_CLINICAL_VERSIONS = ARCAAI_CLINICAL_TEMPLATES.map((tpl) => ({
  id: versionId(tpl.id),
  tenantId: ARCAAI_TENANT_ID,
  promptTemplateId: tpl.id,
  versionNumber: 1,
  content: tpl.content,
  changeReason: 'Initial version (ported from HOPE v1 SMR prompt library)',
  changedBy: SYSTEM_USER_ID,
}));

/**
 * Seed the ArcaAI clinical prompt library. Runs in Phase 3 AFTER
 * seedPromptTemplate (shares the PromptTemplate / PromptVersion tables) and
 * AFTER seedDepartment (the ArcaAI departments carry the legacy prompt-id
 * columns that reference these rows — plain String columns, no FK). Idempotent
 * upsert-by-id.
 */
export const seedArcaaiClinicalTemplates = async (client: CorePrismaClient) => {
  console.log('Seeding ArcaAI clinical prompt library (TASK-592 Workstream D)...');

  const departments = await client.department.findMany({
    where: {
      tenantId: ARCAAI_TENANT_ID,
      code: { in: ARCAAI_DEPARTMENT_CODES },
    },
    select: { id: true, code: true },
  });
  const persistedDepartmentIdBySeedId = new Map<string, string>();
  for (const department of departments) {
    const seedId = ARCAAI_DEPARTMENT_ID_BY_CODE[department.code as keyof typeof ARCAAI_DEPARTMENT_ID_BY_CODE];
    if (seedId) persistedDepartmentIdBySeedId.set(seedId, department.id);
  }

  const templates = ARCAAI_CLINICAL_TEMPLATES.map((template) => {
    if (!template.departmentId) return template;
    const departmentId = persistedDepartmentIdBySeedId.get(template.departmentId);
    if (!departmentId) {
      throw new Error(`Missing ArcaAI department for seeded department ID ${template.departmentId}`);
    }
    return { ...template, departmentId };
  });

  for (const template of templates) {
    const { variables, ...rest } = template;
    const data = {
      ...rest,
      ...(variables != null ? { variables } : {}),
    };
    await client.promptTemplate.upsert({
      where: { id: template.id },
      update: data,
      create: data,
    });
  }
  console.log(`Seeded ${ARCAAI_CLINICAL_TEMPLATES.length} ArcaAI clinical prompt templates`);

  for (const version of ARCAAI_CLINICAL_VERSIONS) {
    await client.promptVersion.upsert({
      where: { id: version.id },
      update: version,
      create: version,
    });
  }
  console.log(`Seeded ${ARCAAI_CLINICAL_VERSIONS.length} ArcaAI clinical prompt versions`);
};

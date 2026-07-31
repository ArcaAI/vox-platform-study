/**
 * TASK-592 Workstream D — ArcaAI clinical prompt library.
 *
 * Ports HOPE v1's department × visit-type clinical instruction templates into
 * the v2 seed for the **ArcaAI customer tenant** (50000000-…0001), wired so
 * `PromptResolutionService` resolves them PER VISIT TYPE.
 *
 * Wiring model — the LEGACY Department prompt-id columns, NOT DepartmentAgent:
 * each ArcaAI clinical department (see 04-department.ts) sets its
 * `newPatientPromptId` / `revisitPromptId` / `preSummaryPromptId` to APPROVED
 * template ids defined here, and carries NO default `DepartmentAgent`. The
 * resolver therefore skips tier-1a (agent) and uses the visit-type-faithful
 * tier-1 legacy columns. This is mandatory: a default agent resolves ONE
 * template per department and ignores visit type, collapsing v1's new-referral
 * vs follow-up split.
 *
 * 15 rows: 14 department × visit-type SUMMARY templates + 1 shared TENANT-scoped
 * pre-summary template. Each has a matching v1-content PromptVersion, and each
 * is seeded APPROVED with `approvedVersionNumber = 1` so the resolver serves the
 * pinned `PromptVersion` snapshot (never the mutable `content` row) — the F-01 /
 * F-02 integrity path (see PromptResolutionService.resolveGovernedContent).
 *
 * The verbatim v1 CONTENT strings live in 07b-arcaai-clinical-content.ts
 * (generated, byte-exact). This module owns only the structure/wiring.
 *
 * ID blocks (documented in 00-constants.ts): ArcaAI tenant templates use the
 * `71000000-…-0001-…` group, slots 010-024; their versions mirror in
 * `72000000-…-0001-…` via the deterministic `72${id.slice(2)}` convention.
 */
import type { CorePrismaClient } from '../../../client';
import { Prisma } from '../../../generated/core-prisma-client/client';
import type { PromptTemplateCategory, PromptTemplateScope, PromptTemplateStatus } from '../../../generated/core-prisma-client/enums';
import { SEED_CUSTOMER_TENANT_IDS, SEED_DEPARTMENT_IDS, SYSTEM_USER_ID } from './00-constants';
import {
  BREAST_ENDOCRINE_FOLLOWUP_CONTENT,
  BREAST_ENDOCRINE_NEW_REFERRAL_CONTENT,
  HEMATOLOGY_NEW_REFERRAL_CONTENT,
  HEMATOLOGY_REVISIT_CONTENT,
  MEDICINE_FOLLOWUP_CONTENT,
  MEDICINE_NEW_REFERRAL_CONTENT,
  NEUROLOGY_FOLLOWUP_CONTENT,
  NEUROLOGY_NEW_REFERRAL_CONTENT,
  ORTHOPEDICS_NEW_REFERRAL_CONTENT,
  ORTHOPEDICS_REVIEW_CONTENT,
  PRE_SUMMARY_CONTENT,
  RHEUMATOLOGY_FOLLOWUP_CONTENT,
  RHEUMATOLOGY_NEW_REFERRAL_CONTENT,
  SURGERY_FOLLOWUP_CONTENT,
  SURGERY_NEW_REFERRAL_CONTENT,
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
}

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
];

// Shared pre-summary — TENANT-scoped, no department binding (every ArcaAI
// clinical department points its `preSummaryPromptId` at this single row, v1's
// one department-interpolated pre-summary prompt normalized to a static body).
const PRE_SUMMARY_SPEC: ClinicalTemplateSpec = {
  id: ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY,
  name: 'Clinical Pre-Summary',
  description: 'ArcaAI shared pre-summary instruction prompt for all clinical departments (v1 port).',
  content: PRE_SUMMARY_CONTENT,
  departmentId: null,
  scope: 'TENANT_DEFAULT',
  tags: ['arcaai', 'clinical', 'pre-summary', 'smr-v1'],
};

const ALL_SPECS: ClinicalTemplateSpec[] = [...SUMMARY_SPECS, PRE_SUMMARY_SPEC];

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
  variables: null as Prisma.InputJsonValue | null,
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

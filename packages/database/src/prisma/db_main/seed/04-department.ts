import type { CorePrismaClient } from '../../../client';
import { SEED_CUSTOMER_TENANT_IDS, SEED_DEPARTMENT_IDS } from './00-constants';
import { TEMPLATE_IDS } from './07-prompt-template';
import { ARCAAI_CLINICAL_TEMPLATE_IDS } from './07b-arcaai-clinical-templates';

// Default tenant ID for seed data
export const DEFAULT_TENANT_ID = '50000000-0000-0000-0000-000000000000';

// =============================================================================
// Global customer tenant — the PLATFORM-GENERIC day-1 department catalog.
//
// This array is load-bearing FAR beyond the Global fixture tenant:
// `07a-agent-golden-library.ts` promotes it 1:1 onto the SYSTEM tenant to build
// GOLDEN_DEPARTMENTS. Whatever is written here becomes every future customer's
// day-1 department catalog.
//
// It no longer decides the PROMPT catalog: since TASK-890 J7-1 the eight
// new-encounter bodies are authored on SYSTEM in `07-prompt-template.ts` and
// reach a tenant through `TenantReferenceSetService` / `seed/26`, not through a
// promotion of this array. `GOLDEN_TEMPLATE_SOURCE_BY_CODE` (07a) still maps a
// care-setting CODE to its platform body, so this array's `code` values remain
// the join key.
//
// OWNER RULING (2026-08-20, OD-8): "what belong to BCMCH keep those
// in ArcaAI, for SYSTEM and GLOBAL, use different ones." The previous 18 rows
// duplicated ArcaAI's BCMCH v1 specialty roster (11 identical codes/names) and
// carried BCMCH's house section vocabulary, so the golden library was shipping
// one hospital's configuration as the platform default.
//
// THE AXIS IS DELIBERATE. These eight are CARE SETTINGS, not specialties.
// Every healthcare organisation runs an outpatient clinic, a ward, an emergency
// front door, a periprocedural pathway, imaging, a lab, behavioural health, and
// paediatrics — so the set is a defensible floor for a tenant that has told us
// nothing about itself. A SPECIALTY roster (Rheumatology, Surgical Oncology, …)
// is a tenant's own configuration; it belongs to the tenant that has it, which
// is now exclusively ArcaAI (ARCAAI_ALL_CLINICAL_DEPARTMENTS below).
//
// PROMPT BODIES ARE GENERIC TOO. The `preferredSections` below are the section
// names in the standard clinical-documentation literature (SOAP and its
// setting-specific relatives), NOT BCMCH's 'BIODATA' / 'Fitness for Surgery' /
// 'MDT Plan' / 'style_DNA_doctor_department_*'. The templates they bind are
// authored in 07-prompt-template.ts as GENERIC_* and share the same property.
//
// `preSummaryPromptId` is null on every row: pre-summary has no department axis
// (see ARCAAI_FALLBACK_TEMPLATE_IDS / the SYSTEM tier-2 default …040).
//
// `newPatientPromptId` is ALSO null on all eight care-setting rows (TASK-890
// J7-1). It used to name the setting's `GENERIC_*_NEW` body, and those eight
// bodies are now authored on the SYSTEM tenant so every tenant — Global
// included — receives them as a stamped reference-set clone. A GLOBAL
// department may not point at a SYSTEM template: these columns are plain
// strings with no FK, so the row would seed fine and then resolve to nothing
// once the tenant-scoped read refuses it (`isApprovedTemplate` fails safe and
// skips the tier), which is a pointer that looks provisioned and is not.
// `GOLDEN_DEPARTMENTS` (07a) already nulls all three for the same reason: the
// binding lives on the workflow node / agent now, not on these legacy columns.
// The `revisitPromptId` values stay — those follow-up bodies are still
// Global-authored fixture content.
//
// Exported for testing purposes.
export const DEFAULT_DEPARTMENTS = [
  {
    id: SEED_DEPARTMENT_IDS.OPD,
    tenantId: DEFAULT_TENANT_ID,
    code: 'OPD',
    name: 'General Outpatient',
    description: 'Ambulatory consultations across primary and general specialty outpatient care',
    defaultSummaryTemplate: 'SOAP',
    preSummaryPromptId: null,
    newPatientPromptId: null,
    revisitPromptId: TEMPLATE_IDS.GENERIC_OUTPATIENT_REVISIT,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
      preferredSections: ['Chief Complaint', 'History of Present Illness', 'Examination', 'Assessment', 'Plan'],
      abbreviationDensity: 'low',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.IPD,
    tenantId: DEFAULT_TENANT_ID,
    code: 'IPD',
    name: 'Inpatient Ward',
    description: 'Admitted-patient ward rounds, daily progress review, and discharge planning',
    defaultSummaryTemplate: 'Progress-Note',
    preSummaryPromptId: null,
    newPatientPromptId: null,
    revisitPromptId: TEMPLATE_IDS.GENERIC_INPATIENT_PROGRESS,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'Active Medications'],
      preferredSections: ['Interval History', 'Vitals & Observations', 'Examination', 'Assessment', 'Plan for Today'],
      abbreviationDensity: 'medium',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.ER,
    tenantId: DEFAULT_TENANT_ID,
    code: 'ER',
    name: 'Emergency & Urgent Care',
    description: 'Unscheduled presentations requiring triage, stabilisation, and disposition',
    defaultSummaryTemplate: 'ED-Encounter',
    preSummaryPromptId: null,
    newPatientPromptId: null,
    revisitPromptId: null,
    promptConfig: {
      contextVariables: ['Triage Assessment', 'Recent Vitals', 'Allergies'],
      preferredSections: ['Presenting Problem', 'Triage Category', 'History', 'Examination', 'Investigations', 'Disposition'],
      abbreviationDensity: 'high',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.PERI,
    tenantId: DEFAULT_TENANT_ID,
    code: 'PERI',
    name: 'Perioperative Care',
    description: 'Pre-procedure assessment, procedural record, and post-procedure recovery',
    defaultSummaryTemplate: 'Periop-Assessment',
    preSummaryPromptId: null,
    newPatientPromptId: null,
    revisitPromptId: TEMPLATE_IDS.GENERIC_PERIOP_REVIEW,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'Active Medications'],
      preferredSections: ['Indication', 'Relevant History', 'Examination', 'Risk Assessment', 'Plan'],
      abbreviationDensity: 'medium',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.RAD,
    tenantId: DEFAULT_TENANT_ID,
    code: 'RAD',
    name: 'Diagnostic Imaging',
    description: 'Imaging studies reported against a stated clinical question',
    defaultSummaryTemplate: 'Imaging-Report',
    preSummaryPromptId: null,
    newPatientPromptId: null,
    revisitPromptId: null,
    promptConfig: {
      contextVariables: ['Clinical Indication', 'Prior Imaging'],
      preferredSections: ['Clinical Indication', 'Technique', 'Findings', 'Impression'],
      abbreviationDensity: 'high',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.LAB,
    tenantId: DEFAULT_TENANT_ID,
    code: 'LAB',
    name: 'Laboratory Medicine',
    description: 'Specimen-based diagnostics and interpretive laboratory reporting',
    defaultSummaryTemplate: 'Lab-Report',
    preSummaryPromptId: null,
    newPatientPromptId: null,
    revisitPromptId: null,
    promptConfig: {
      contextVariables: ['Test Orders', 'Previous Results'],
      preferredSections: ['Specimen', 'Results', 'Reference Ranges', 'Interpretation'],
      abbreviationDensity: 'high',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.BEH,
    tenantId: DEFAULT_TENANT_ID,
    code: 'BEH',
    name: 'Behavioral Health',
    description: 'Mental health assessment, therapy, and ongoing psychiatric review',
    defaultSummaryTemplate: 'Behavioral-Assessment',
    preSummaryPromptId: null,
    newPatientPromptId: null,
    revisitPromptId: TEMPLATE_IDS.GENERIC_BEHAVIORAL_REVIEW,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Medication History', 'Risk Assessment'],
      preferredSections: ['Presenting Concern', 'History', 'Mental State Examination', 'Risk Assessment', 'Formulation', 'Plan'],
      abbreviationDensity: 'low',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.PEDS,
    tenantId: DEFAULT_TENANT_ID,
    code: 'PEDS',
    name: 'Pediatrics & Child Health',
    description: 'Infant, child, and adolescent care including growth and development review',
    defaultSummaryTemplate: 'Pediatric-SOAP',
    preSummaryPromptId: null,
    newPatientPromptId: null,
    revisitPromptId: TEMPLATE_IDS.GENERIC_PEDIATRIC_REVISIT,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'Growth Chart', 'Immunization History'],
      preferredSections: ['Chief Complaint', 'History of Present Illness', 'Growth & Development', 'Examination', 'Assessment', 'Plan'],
      abbreviationDensity: 'low',
    },
  },
];

// ArcaAI customer-tenant CLINICAL departments — the AGENT-BOUND seven

//
// ⚠ THIS IS NOT THE WHOLE SET. ArcaAI carries ELEVEN clinical departments; the
// other four live in ARCAAI_CLINICAL_DEPARTMENTS_WITHOUT_AGENT below and the
// union is ARCAAI_ALL_CLINICAL_DEPARTMENTS, which is what `seedDepartment`
// writes. The split is load-bearing, not cosmetic: `ARCAAI_TENANT_AGENTS`
// (07a-agent-golden-library.ts) derives exactly one default `DepartmentAgent`
// per row of THIS array, so membership here IS the "has a default agent"
// predicate.
//
// The DEFAULT_DEPARTMENTS above all belong to the Global customer tenant
// (DEFAULT_TENANT_ID). These seven — Surgery, General Medicine, Rheumatology,
// Neurology, Orthopedics, Hematology, Breast & Endocrine — are each wired via
// the LEGACY Department prompt-id columns (newPatientPromptId /
// revisitPromptId / preSummaryPromptId, plain String, no FK) to their own
// APPROVED, per-visit-type `PromptTemplate`s owned by the ArcaAI tenant (see
// 07b-arcaai-clinical-templates.ts).
//
// UPDATE: these departments DO now carry a default
// `DepartmentAgent` (ARCAAI_TENANT_AGENTS in 07a-agent-golden-library.ts). The
// former "no default agent" rule existed only because a DepartmentAgent used to
// be a single prompt pointer that ignored visit type; gave the agent
// per-visit-type bindings (`newPatientTemplateId` / `revisitTemplateId`) wired to
// exactly the ids below, so tier-1a now resolves the SAME template these columns
// name. The columns below are therefore RETAINED as the DEPRECATED tier-1b
// fallback — reached only when a department has no default agent or the agent's
// selected binding fails the APPROVED/snapshot checks. Equality of the two paths
// is locked by seed/__tests__/arcaai-agent-column-equality.test.ts (ids) and by
// the C2-T2 resolver suite in packages/applications (ids + version + bytes).
//
// GEN_ARCAAI is RETAINED (existing consultation / user / DNA / audit seed
// references) and REPURPOSED as General Medicine; the former CARD_ARCAAI /
// ER_ARCAAI demo departments were retired.
//
// Exported for testing purposes.
export const ARCAAI_CLINICAL_DEPARTMENTS = [
  {
    id: SEED_DEPARTMENT_IDS.GEN_ARCAAI,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    code: 'GEN',
    name: 'General Medicine',
    description: 'Internal medicine and general medical consultations',
    defaultSummaryTemplate: 'Medicine-Structured',
    // Pre-summary is NOT department-scoped — the tenant-wide PRE_SUMMARY_SPEC
    // row in 07b-arcaai-clinical-templates.ts serves every department.
    preSummaryPromptId: null,
    newPatientPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.MEDICINE_NEW_REFERRAL,
    revisitPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.MEDICINE_FOLLOWUP,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
      preferredSections: [
        'Presenting Complaints',
        'Past History',
        'Drug History',
        'General Examination & Vitals',
        'Current Diagnosis',
        'Plan of Care',
      ],
      abbreviationDensity: 'low',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.SURG_ARCAAI,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    code: 'SURG',
    name: 'Surgery',
    description: 'General surgery and surgical specialties',
    defaultSummaryTemplate: 'Surgery-Structured',
    // Pre-summary is NOT department-scoped — the tenant-wide PRE_SUMMARY_SPEC
    // row in 07b-arcaai-clinical-templates.ts serves every department.
    preSummaryPromptId: null,
    newPatientPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.SURGERY_NEW_REFERRAL,
    revisitPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.SURGERY_FOLLOWUP,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
      preferredSections: [
        'BIODATA',
        'Presenting Complaints',
        'Comorbidities',
        'Investigations',
        'Current Diagnosis',
        'Plan of Care',
        'Fitness for Surgery',
      ],
      abbreviationDensity: 'medium',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.RHEUM_ARCAAI,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    code: 'RHEUM',
    name: 'Rheumatology',
    description: 'Autoimmune and musculoskeletal disease specialists',
    defaultSummaryTemplate: 'Rheumatology-Structured',
    // Pre-summary is NOT department-scoped — the tenant-wide PRE_SUMMARY_SPEC
    // row in 07b-arcaai-clinical-templates.ts serves every department.
    preSummaryPromptId: null,
    newPatientPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.RHEUMATOLOGY_NEW_REFERRAL,
    revisitPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.RHEUMATOLOGY_FOLLOWUP,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
      preferredSections: ['Symptoms', 'Current Issues', 'Local Examination', 'Impression', 'Plan', 'Lab Reports'],
      abbreviationDensity: 'medium',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.NEUR_ARCAAI,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    code: 'NEUR',
    name: 'Neurology',
    description: 'Brain and nervous system specialists',
    defaultSummaryTemplate: 'Neurology-Structured',
    // Pre-summary is NOT department-scoped — the tenant-wide PRE_SUMMARY_SPEC
    // row in 07b-arcaai-clinical-templates.ts serves every department.
    preSummaryPromptId: null,
    newPatientPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.NEUROLOGY_NEW_REFERRAL,
    revisitPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.NEUROLOGY_FOLLOWUP,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'Neurological Assessment'],
      preferredSections: ['Chief Complaint', 'Neurological History', 'Examination', 'Investigations', 'Assessment', 'Plan'],
      abbreviationDensity: 'medium',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.ORTH_ARCAAI,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    code: 'ORTH',
    name: 'Orthopedics',
    description: 'Musculoskeletal system and bone specialists',
    defaultSummaryTemplate: 'Orthopedics-Structured',
    // Pre-summary is NOT department-scoped — the tenant-wide PRE_SUMMARY_SPEC
    // row in 07b-arcaai-clinical-templates.ts serves every department.
    preSummaryPromptId: null,
    newPatientPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.ORTHOPEDICS_NEW_REFERRAL,
    revisitPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.ORTHOPEDICS_REVIEW,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'Imaging Results'],
      preferredSections: ['Chief Complaint', 'History', 'MSK Examination', 'Imaging', 'Assessment', 'Plan'],
      abbreviationDensity: 'medium',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.HEME_ARCAAI,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    code: 'HEME',
    name: 'Hematology',
    description: 'Blood disorders and hematology-oncology specialists',
    defaultSummaryTemplate: 'Hematology-Structured',
    // Pre-summary is NOT department-scoped — the tenant-wide PRE_SUMMARY_SPEC
    // row in 07b-arcaai-clinical-templates.ts serves every department.
    preSummaryPromptId: null,
    newPatientPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.HEMATOLOGY_NEW_REFERRAL,
    revisitPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.HEMATOLOGY_REVISIT,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
      preferredSections: ['Presenting Complaints', 'Treatment History', 'Investigations', 'Diagnosis', 'Plan of Care'],
      abbreviationDensity: 'medium',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.BREN_ARCAAI,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    code: 'BREN',
    name: 'Breast & Endocrine',
    description: 'Breast and endocrine surgery specialists',
    defaultSummaryTemplate: 'BreastEndocrine-Structured',
    // Pre-summary is NOT department-scoped — the tenant-wide PRE_SUMMARY_SPEC
    // row in 07b-arcaai-clinical-templates.ts serves every department.
    preSummaryPromptId: null,
    newPatientPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.BREAST_ENDOCRINE_NEW_REFERRAL,
    revisitPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.BREAST_ENDOCRINE_FOLLOWUP,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
      preferredSections: ['Patient Demographics', 'Presenting Complaints', 'Physical Examination', 'Investigations', 'Diagnosis', 'Plan of Care'],
      abbreviationDensity: 'medium',
    },
  },
];

// The remaining FOUR v1 clinical departments.
//
// WHY THIS ARRAY EXISTS SEPARATELY. v1 recognises ELEVEN departments (verified
// on the running v1 TEXT pod: `DEPT_VISIT_SCHEMAS` = 22 = 11 × {new_referral,
// followup}; `select_prompt_template` = 11 branches), and the ArcaAI tenant must
// carry exactly those eleven — no more, no fewer. The seven above were ported by
// ; these four complete the set.
//
// They are held apart from ARCAAI_CLINICAL_DEPARTMENTS because
// `ARCAAI_TENANT_AGENTS` (07a-agent-golden-library.ts) maps ONE default
// `DepartmentAgent` over every row of that array. These four must carry NO
// default agent: the per-visit-type legacy columns below are the v1-faithful
// resolution path, and an agent tier adds a second way to answer the same
// question for no benefit. Splitting the arrays makes "no agent" a structural
// property rather than a rule someone has to remember.
//
// Everything else matches the seven exactly: ArcaAI-owned, both visit-type
// columns wired to APPROVED per-department templates, and `preSummaryPromptId`
// NULL — pre-summary has no department axis.
//
// Exported for testing purposes.
export const ARCAAI_CLINICAL_DEPARTMENTS_WITHOUT_AGENT = [
  {
    id: SEED_DEPARTMENT_IDS.DERM_ARCAAI,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    code: 'DERM',
    name: 'Dermatology',
    description: 'Skin, hair, and nail specialists',
    defaultSummaryTemplate: 'Dermatology-Structured',
    preSummaryPromptId: null,
    newPatientPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.DERMATOLOGY_NEW_REFERRAL,
    revisitPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.DERMATOLOGY_FOLLOWUP,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
      preferredSections: [
        'Presenting Complaints',
        'Evolution of Symptoms',
        'Clinical Examination',
        'Impression',
        'Treatment Plan',
        'Follow-Up Advice',
      ],
      abbreviationDensity: 'low',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.DIET_ARCAAI,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    code: 'DIET',
    name: 'Dietetics',
    description: 'Clinical nutrition and dietetic services',
    defaultSummaryTemplate: 'Dietetics-Structured',
    preSummaryPromptId: null,
    newPatientPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.DIETETICS_NEW_REFERRAL,
    revisitPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.DIETETICS_FOLLOWUP,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
      preferredSections: [
        'Patient History',
        'Anthropometric Measurements',
        'Diet History',
        'Nutrition Screening',
        'Nutritional Status',
        'Plan of Care',
      ],
      abbreviationDensity: 'low',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.NEPH_ARCAAI,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    code: 'NEPH',
    name: 'Nephrology',
    description: 'Kidney disease and renal care specialists',
    defaultSummaryTemplate: 'Nephrology-Structured',
    preSummaryPromptId: null,
    newPatientPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.NEPHROLOGY_NEW_REFERRAL,
    revisitPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.NEPHROLOGY_FOLLOWUP,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
      preferredSections: ['Diagnosis', 'History', 'Examination', 'Investigations', 'Medicine', 'Plan of Care'],
      abbreviationDensity: 'medium',
    },
  },
  {
    id: SEED_DEPARTMENT_IDS.SONC_ARCAAI,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    code: 'SONC',
    name: 'Surgical Oncology',
    description: 'Surgical management of cancer and tumors',
    defaultSummaryTemplate: 'SurgicalOncology-Structured',
    preSummaryPromptId: null,
    newPatientPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.SURGICAL_ONCOLOGY_NEW_REFERRAL,
    revisitPromptId: ARCAAI_CLINICAL_TEMPLATE_IDS.SURGICAL_ONCOLOGY_FOLLOWUP,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
      preferredSections: ['Patient Demographics', 'History', 'Presenting Complaints', 'Investigations Done', 'Impression', 'Plan', 'MDT Plan'],
      abbreviationDensity: 'medium',
    },
  },
];

/**
 * ALL eleven ArcaAI clinical departments — v1's canonical department set,
 * department-for-department. This is what `seedDepartment` writes; the two
 * arrays above are a wiring detail (agent vs no agent), not two catalogs.
 *
 * Exported for testing purposes.
 */
export const ARCAAI_ALL_CLINICAL_DEPARTMENTS = [...ARCAAI_CLINICAL_DEPARTMENTS, ...ARCAAI_CLINICAL_DEPARTMENTS_WITHOUT_AGENT];

export const seedDepartment = async (client: CorePrismaClient) => {
  console.log('Seeding departments...');

  try {
    const allDepartments = [...DEFAULT_DEPARTMENTS, ...ARCAAI_ALL_CLINICAL_DEPARTMENTS];
    for (const dept of allDepartments) {
      const { id, ...department } = dept;
      await client.department.upsert({
        where: { tenantId_code: { tenantId: dept.tenantId, code: dept.code } },
        update: department,
        create: { id, ...department },
      });
    }

    console.log(`Seeded ${allDepartments.length} departments`);
  } catch (error) {
    console.error('Error seeding departments:', error);
    throw error;
  }
};

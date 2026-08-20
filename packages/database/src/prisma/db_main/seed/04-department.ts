import type { CorePrismaClient } from '../../../client';
import { SEED_CUSTOMER_TENANT_IDS, SEED_DEPARTMENT_IDS } from './00-constants';
import { ARCAAI_CLINICAL_TEMPLATE_IDS } from './07b-arcaai-clinical-templates';

// Default tenant ID for seed data
export const DEFAULT_TENANT_ID = '50000000-0000-0000-0000-000000000000';

// Common medical departments with prompt configuration (GAP-3)
//
// Summary templates align with department clinical workflow patterns
// Prompt IDs reference prompt template entries (null = use system default)
//
// Exported for testing purposes
export const DEFAULT_DEPARTMENTS = [
  {
    id: '70000000-0000-0000-0000-000000000001',
    tenantId: DEFAULT_TENANT_ID,
    code: 'GEN',
    name: 'General Practice',
    description: 'General medical consultations and primary care',
    defaultSummaryTemplate: 'SOAP',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: '71000000-0000-0000-0000-000000000001',
    revisitPromptId: '71000000-0000-0000-0000-000000000005',
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
      preferredSections: ['Chief Complaint', 'HPI', 'Assessment', 'Plan'],
      abbreviationDensity: 'low',
    },
  },
  {
    id: '70000000-0000-0000-0000-000000000002',
    tenantId: DEFAULT_TENANT_ID,
    code: 'CARD',
    name: 'Cardiology',
    description: 'Heart and cardiovascular system specialists',
    defaultSummaryTemplate: 'SOAP',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: '71000000-0000-0000-0000-000000000004',
    revisitPromptId: '71000000-0000-0000-0000-000000000002',
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'ECG Results'],
      preferredSections: ['Chief Complaint', 'Cardiac History', 'Physical Examination', 'Investigations', 'Assessment', 'Plan'],
      abbreviationDensity: 'medium',
    },
  },
  {
    id: '70000000-0000-0000-0000-000000000003',
    tenantId: DEFAULT_TENANT_ID,
    code: 'RAD',
    name: 'Radiology',
    description: 'Medical imaging and diagnostic radiology',
    defaultSummaryTemplate: 'Radiology-Report',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
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
    id: '70000000-0000-0000-0000-000000000004',
    tenantId: DEFAULT_TENANT_ID,
    code: 'LAB',
    name: 'Laboratory',
    description: 'Clinical laboratory and pathology services',
    defaultSummaryTemplate: 'Lab-Report',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
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
    id: '70000000-0000-0000-0000-000000000005',
    tenantId: DEFAULT_TENANT_ID,
    code: 'NEUR',
    name: 'Neurology',
    description: 'Brain and nervous system specialists',
    defaultSummaryTemplate: 'Neurology-Structured',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: '71000000-0000-0000-0000-000000000020',
    revisitPromptId: '71000000-0000-0000-0000-000000000021',
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'Neurological Assessment'],
      preferredSections: ['Chief Complaint', 'Neurological History', 'Examination', 'Investigations', 'Assessment', 'Plan'],
      abbreviationDensity: 'medium',
    },
  },
  {
    id: '70000000-0000-0000-0000-000000000006',
    tenantId: DEFAULT_TENANT_ID,
    code: 'ORTH',
    name: 'Orthopedics',
    description: 'Musculoskeletal system and bone specialists',
    defaultSummaryTemplate: 'Orthopedics-Structured',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: '71000000-0000-0000-0000-000000000018',
    revisitPromptId: '71000000-0000-0000-0000-000000000019',
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'Imaging Results'],
      preferredSections: ['Chief Complaint', 'History', 'MSK Examination', 'Imaging', 'Assessment', 'Plan'],
      abbreviationDensity: 'medium',
    },
  },
  {
    id: '70000000-0000-0000-0000-000000000007',
    tenantId: DEFAULT_TENANT_ID,
    code: 'DERM',
    name: 'Dermatology',
    description: 'Skin, hair, and nail specialists',
    defaultSummaryTemplate: 'Dermatology-Structured',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: '71000000-0000-0000-0000-000000000028',
    revisitPromptId: '71000000-0000-0000-0000-000000000029',
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'prior_visit_summary', 'style_DNA_doctor_department_dermatology'],
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
    id: '70000000-0000-0000-0000-000000000008',
    tenantId: DEFAULT_TENANT_ID,
    code: 'PSYCH',
    name: 'Psychiatry',
    description: 'Mental health and psychiatric care',
    defaultSummaryTemplate: 'Psychiatric-Assessment',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: null,
    revisitPromptId: null,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Medication History', 'Risk Assessment'],
      preferredSections: [
        'Presenting Complaint',
        'Psychiatric History',
        'Mental State Examination',
        'Risk Assessment',
        'Diagnosis',
        'Management Plan',
      ],
      abbreviationDensity: 'low',
    },
  },
  {
    id: '70000000-0000-0000-0000-000000000009',
    tenantId: DEFAULT_TENANT_ID,
    code: 'PEDS',
    name: 'Pediatrics',
    description: 'Child and adolescent healthcare',
    defaultSummaryTemplate: 'SOAP',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: null,
    revisitPromptId: null,
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'Growth Chart', 'Immunization History'],
      preferredSections: ['Chief Complaint', 'HPI', 'Growth & Development', 'Examination', 'Assessment', 'Plan'],
      abbreviationDensity: 'low',
    },
  },
  {
    id: '70000000-0000-0000-0000-000000000010',
    tenantId: DEFAULT_TENANT_ID,
    code: 'ER',
    name: 'Emergency',
    description: 'Emergency and urgent care services',
    defaultSummaryTemplate: 'ER-Triage',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: null,
    revisitPromptId: null,
    promptConfig: {
      contextVariables: ['Triage Assessment', 'Recent Vitals', 'Allergies'],
      preferredSections: ['Chief Complaint', 'Triage Category', 'HPI', 'Examination', 'Investigations', 'Disposition'],
      abbreviationDensity: 'high',
    },
  },
  {
    id: '70000000-0000-0000-0000-000000000011',
    tenantId: DEFAULT_TENANT_ID,
    code: 'SURG',
    name: 'Surgery',
    description: 'General surgery and surgical specialties',
    defaultSummaryTemplate: 'Surgery-Structured',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: '71000000-0000-0000-0000-000000000010',
    revisitPromptId: '71000000-0000-0000-0000-000000000011',
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
    id: '70000000-0000-0000-0000-000000000012',
    tenantId: DEFAULT_TENANT_ID,
    code: 'MED',
    name: 'General Medicine',
    description: 'Internal medicine and general medical consultations',
    defaultSummaryTemplate: 'Medicine-Structured',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: '71000000-0000-0000-0000-000000000012',
    revisitPromptId: '71000000-0000-0000-0000-000000000013',
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
    id: '70000000-0000-0000-0000-000000000013',
    tenantId: DEFAULT_TENANT_ID,
    code: 'BREN',
    name: 'Breast & Endocrine',
    description: 'Breast and endocrine surgery specialists',
    defaultSummaryTemplate: 'BreastEndocrine-Structured',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: '71000000-0000-0000-0000-000000000014',
    revisitPromptId: '71000000-0000-0000-0000-000000000015',
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
      preferredSections: ['Patient Demographics', 'Presenting Complaints', 'Physical Examination', 'Investigations', 'Diagnosis', 'Plan of Care'],
      abbreviationDensity: 'medium',
    },
  },
  {
    id: '70000000-0000-0000-0000-000000000014',
    tenantId: DEFAULT_TENANT_ID,
    code: 'RHEUM',
    name: 'Rheumatology',
    description: 'Autoimmune and musculoskeletal disease specialists',
    defaultSummaryTemplate: 'Rheumatology-Structured',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: '71000000-0000-0000-0000-000000000016',
    revisitPromptId: '71000000-0000-0000-0000-000000000017',
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
      preferredSections: ['Symptoms', 'Current Issues', 'Local Examination', 'Impression', 'Plan', 'Lab Reports'],
      abbreviationDensity: 'medium',
    },
  },
  {
    id: '70000000-0000-0000-0000-000000000015',
    tenantId: DEFAULT_TENANT_ID,
    code: 'HEME',
    name: 'Hematology',
    description: 'Blood disorders and hematology-oncology specialists',
    defaultSummaryTemplate: 'Hematology-Structured',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: '71000000-0000-0000-0000-000000000022',
    revisitPromptId: '71000000-0000-0000-0000-000000000023',
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
      preferredSections: ['Presenting Complaints', 'Treatment History', 'Investigations', 'Diagnosis', 'Plan of Care'],
      abbreviationDensity: 'medium',
    },
  },
  {
    id: '70000000-0000-0000-0000-000000000016',
    tenantId: DEFAULT_TENANT_ID,
    code: 'DIET',
    name: 'Dietetics',
    description: 'Clinical nutrition and dietetic services',
    defaultSummaryTemplate: 'Dietetics-Structured',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: '71000000-0000-0000-0000-000000000030',
    revisitPromptId: '71000000-0000-0000-0000-000000000031',
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'prior_visit_summary', 'style_DNA_doctor_department_dietetics'],
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
    id: '70000000-0000-0000-0000-000000000017',
    tenantId: DEFAULT_TENANT_ID,
    code: 'NEPH',
    name: 'Nephrology',
    description: 'Kidney disease and renal care specialists',
    defaultSummaryTemplate: 'Nephrology-Structured',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: '71000000-0000-0000-0000-000000000032',
    revisitPromptId: '71000000-0000-0000-0000-000000000033',
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'prior_visit_summary', 'style_DNA_doctor_department_nephrology'],
      preferredSections: ['Diagnosis', 'History', 'Examination', 'Investigations', 'Medicine', 'Plan of Care'],
      abbreviationDensity: 'medium',
    },
  },
  {
    id: '70000000-0000-0000-0000-000000000018',
    tenantId: DEFAULT_TENANT_ID,
    code: 'SONC',
    name: 'Surgical Oncology',
    description: 'Surgical management of cancer and tumors',
    defaultSummaryTemplate: 'SurgicalOncology-Structured',
    // Pre-summary is NOT department-scoped — see ARCAAI_FALLBACK_TEMPLATE_IDS.
    preSummaryPromptId: null,
    newPatientPromptId: '71000000-0000-0000-0000-000000000034',
    revisitPromptId: '71000000-0000-0000-0000-000000000035',
    promptConfig: {
      contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'prior_visit_summary', 'style_DNA_doctor_department_surgical_oncology'],
      preferredSections: ['Patient Demographics', 'History', 'Presenting Complaints', 'Investigations Done', 'Impression', 'Plan', 'MDT Plan'],
      abbreviationDensity: 'medium',
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
      preferredSections: ['Presenting Complaints', 'Past History', 'Drug History', 'General Examination & Vitals', 'Current Diagnosis', 'Plan of Care'],
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
      preferredSections: ['BIODATA', 'Presenting Complaints', 'Comorbidities', 'Investigations', 'Current Diagnosis', 'Plan of Care', 'Fitness for Surgery'],
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
      preferredSections: ['Presenting Complaints', 'Evolution of Symptoms', 'Clinical Examination', 'Impression', 'Treatment Plan', 'Follow-Up Advice'],
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
      preferredSections: ['Patient History', 'Anthropometric Measurements', 'Diet History', 'Nutrition Screening', 'Nutritional Status', 'Plan of Care'],
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

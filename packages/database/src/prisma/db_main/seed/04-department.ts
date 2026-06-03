import type { CorePrismaClient } from '../../../client';
import { SEED_CUSTOMER_TENANT_IDS, SEED_DEPARTMENT_IDS } from './00-constants';

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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
        newPatientPromptId: '71000000-0000-0000-0000-000000000028',
        revisitPromptId: '71000000-0000-0000-0000-000000000029',
        promptConfig: {
            contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'same_day_prequel_summary', 'style_DNA_doctor_department_dermatology'],
            preferredSections: ['Presenting Complaints', 'Evolution of Symptoms', 'Clinical Examination', 'Impression', 'Treatment Plan', 'Follow-Up Advice'],
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
        newPatientPromptId: null,
        revisitPromptId: null,
        promptConfig: {
            contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Medication History', 'Risk Assessment'],
            preferredSections: ['Presenting Complaint', 'Psychiatric History', 'Mental State Examination', 'Risk Assessment', 'Diagnosis', 'Management Plan'],
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
        newPatientPromptId: '71000000-0000-0000-0000-000000000010',
        revisitPromptId: '71000000-0000-0000-0000-000000000011',
        promptConfig: {
            contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
            preferredSections: ['BIODATA', 'Presenting Complaints', 'Comorbidities', 'Investigations', 'Current Diagnosis', 'Plan of Care', 'Fitness for Surgery'],
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
        newPatientPromptId: '71000000-0000-0000-0000-000000000012',
        revisitPromptId: '71000000-0000-0000-0000-000000000013',
        promptConfig: {
            contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
            preferredSections: ['Presenting Complaints', 'Past History', 'Drug History', 'General Examination & Vitals', 'Current Diagnosis', 'Plan of Care'],
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
        newPatientPromptId: '71000000-0000-0000-0000-000000000030',
        revisitPromptId: '71000000-0000-0000-0000-000000000031',
        promptConfig: {
            contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'same_day_prequel_summary', 'style_DNA_doctor_department_dietetics'],
            preferredSections: ['Patient History', 'Anthropometric Measurements', 'Diet History', 'Nutrition Screening', 'Nutritional Status', 'Plan of Care'],
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
        newPatientPromptId: '71000000-0000-0000-0000-000000000032',
        revisitPromptId: '71000000-0000-0000-0000-000000000033',
        promptConfig: {
            contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'same_day_prequel_summary', 'style_DNA_doctor_department_nephrology'],
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
        preSummaryPromptId: '71000000-0000-0000-0000-000000000040',
        newPatientPromptId: '71000000-0000-0000-0000-000000000034',
        revisitPromptId: '71000000-0000-0000-0000-000000000035',
        promptConfig: {
            contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'same_day_prequel_summary', 'style_DNA_doctor_department_surgical_oncology'],
            preferredSections: ['Patient Demographics', 'History', 'Presenting Complaints', 'Investigations Done', 'Impression', 'Plan', 'MDT Plan'],
            abbreviationDensity: 'medium',
        },
    },
];

// Per-customer-tenant General Practice departments (TASK-305 Phase F).
//
// The DEFAULT_DEPARTMENTS above all belong to the Global customer tenant
// (DEFAULT_TENANT_ID). The remaining customer tenants need at least a GEN
// department of their own so their non-exempt admins can satisfy the
// role + department membership invariant enforced at login. Prompt IDs are
// intentionally null here — they reference Global-tenant prompt templates.
//
// Exported for testing purposes.
export const CUSTOMER_TENANT_GEN_DEPARTMENTS = [
    {
        id: SEED_DEPARTMENT_IDS.GEN_ARCAAI,
        tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
        code: 'GEN',
        name: 'General Practice',
        description: 'General medical consultations and primary care',
        defaultSummaryTemplate: 'SOAP',
        preSummaryPromptId: null,
        newPatientPromptId: null,
        revisitPromptId: null,
        promptConfig: {
            contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
            preferredSections: ['Chief Complaint', 'HPI', 'Assessment', 'Plan'],
            abbreviationDensity: 'low',
        },
    },
    {
        id: SEED_DEPARTMENT_IDS.GEN_FOURBITS,
        tenantId: SEED_CUSTOMER_TENANT_IDS.FOURBITS,
        code: 'GEN',
        name: 'General Practice',
        description: 'General medical consultations and primary care',
        defaultSummaryTemplate: 'SOAP',
        preSummaryPromptId: null,
        newPatientPromptId: null,
        revisitPromptId: null,
        promptConfig: {
            contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
            preferredSections: ['Chief Complaint', 'HPI', 'Assessment', 'Plan'],
            abbreviationDensity: 'low',
        },
    },
    {
        id: SEED_DEPARTMENT_IDS.GEN_MUMBAI,
        tenantId: SEED_CUSTOMER_TENANT_IDS.MUMBAI_HOSPITAL,
        code: 'GEN',
        name: 'General Practice',
        description: 'General medical consultations and primary care',
        defaultSummaryTemplate: 'SOAP',
        preSummaryPromptId: null,
        newPatientPromptId: null,
        revisitPromptId: null,
        promptConfig: {
            contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals'],
            preferredSections: ['Chief Complaint', 'HPI', 'Assessment', 'Plan'],
            abbreviationDensity: 'low',
        },
    },
];

// Per-customer-tenant specialty departments (TASK-331 r2605 #6).
//
// In addition to the bare GEN above, each customer tenant gets a small
// realistic specialty catalog — Cardiology (`CARD`) and Emergency (`ER`) —
// so cross-tenant demos look like real hospitals rather than empty shells.
// Shapes mirror the Global-tenant `CARD`/`ER` entries in DEFAULT_DEPARTMENTS,
// but prompt IDs are intentionally null (they reference Global-tenant prompt
// templates).
//
// Exported for testing purposes.
export const CUSTOMER_TENANT_SPECIALTY_DEPARTMENTS = [
    {
        id: SEED_DEPARTMENT_IDS.CARD_ARCAAI,
        tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
        code: 'CARD',
        name: 'Cardiology',
        description: 'Heart and cardiovascular system specialists',
        defaultSummaryTemplate: 'SOAP',
        preSummaryPromptId: null,
        newPatientPromptId: null,
        revisitPromptId: null,
        promptConfig: {
            contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'ECG Results'],
            preferredSections: ['Chief Complaint', 'Cardiac History', 'Physical Examination', 'Investigations', 'Assessment', 'Plan'],
            abbreviationDensity: 'medium',
        },
    },
    {
        id: SEED_DEPARTMENT_IDS.ER_ARCAAI,
        tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
        code: 'ER',
        name: 'Emergency',
        description: 'Emergency and urgent care services',
        defaultSummaryTemplate: 'ER-Triage',
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
        id: SEED_DEPARTMENT_IDS.CARD_FOURBITS,
        tenantId: SEED_CUSTOMER_TENANT_IDS.FOURBITS,
        code: 'CARD',
        name: 'Cardiology',
        description: 'Heart and cardiovascular system specialists',
        defaultSummaryTemplate: 'SOAP',
        preSummaryPromptId: null,
        newPatientPromptId: null,
        revisitPromptId: null,
        promptConfig: {
            contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'ECG Results'],
            preferredSections: ['Chief Complaint', 'Cardiac History', 'Physical Examination', 'Investigations', 'Assessment', 'Plan'],
            abbreviationDensity: 'medium',
        },
    },
    {
        id: SEED_DEPARTMENT_IDS.ER_FOURBITS,
        tenantId: SEED_CUSTOMER_TENANT_IDS.FOURBITS,
        code: 'ER',
        name: 'Emergency',
        description: 'Emergency and urgent care services',
        defaultSummaryTemplate: 'ER-Triage',
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
        id: SEED_DEPARTMENT_IDS.CARD_MUMBAI,
        tenantId: SEED_CUSTOMER_TENANT_IDS.MUMBAI_HOSPITAL,
        code: 'CARD',
        name: 'Cardiology',
        description: 'Heart and cardiovascular system specialists',
        defaultSummaryTemplate: 'SOAP',
        preSummaryPromptId: null,
        newPatientPromptId: null,
        revisitPromptId: null,
        promptConfig: {
            contextVariables: ['PREVIOUS CASE NOTES SUMMARY', 'Recent Vitals', 'ECG Results'],
            preferredSections: ['Chief Complaint', 'Cardiac History', 'Physical Examination', 'Investigations', 'Assessment', 'Plan'],
            abbreviationDensity: 'medium',
        },
    },
    {
        id: SEED_DEPARTMENT_IDS.ER_MUMBAI,
        tenantId: SEED_CUSTOMER_TENANT_IDS.MUMBAI_HOSPITAL,
        code: 'ER',
        name: 'Emergency',
        description: 'Emergency and urgent care services',
        defaultSummaryTemplate: 'ER-Triage',
        preSummaryPromptId: null,
        newPatientPromptId: null,
        revisitPromptId: null,
        promptConfig: {
            contextVariables: ['Triage Assessment', 'Recent Vitals', 'Allergies'],
            preferredSections: ['Chief Complaint', 'Triage Category', 'HPI', 'Examination', 'Investigations', 'Disposition'],
            abbreviationDensity: 'high',
        },
    },
];

export const seedDepartment = async (client: CorePrismaClient) => {
    console.log('Seeding departments...');

    try {
        const allDepartments = [...DEFAULT_DEPARTMENTS, ...CUSTOMER_TENANT_GEN_DEPARTMENTS, ...CUSTOMER_TENANT_SPECIALTY_DEPARTMENTS];
        for (const dept of allDepartments) {
            await client.department.upsert({
                where: { id: dept.id },
                update: dept,
                create: dept,
            });
        }

        console.log(`Seeded ${allDepartments.length} departments`);
    } catch (error) {
        console.error('Error seeding departments:', error);
        throw error;
    }
};

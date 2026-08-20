import type { CorePrismaClient } from '../../../client';
import { Prisma } from '../../../generated/core-prisma-client/client';
import {
  SEED_TENANT_ID,
  SEED_CUSTOMER_TENANT_IDS,
  SEED_DEPARTMENT_IDS,
  SEED_USER_IDS,
  SEED_DNA_REPORT_IDS,
  SEED_TEMPLATE_IDS,
  SYSTEM_USER_ID,
} from './00-constants';
// The plaintext `reportData`/`styleText` columns were dropped;
// seed rows must persist Vault-Transit ciphertext into the `encrypted*` columns.
import { encryptSeedRow } from './phi-encryption';

export const DEFAULT_TENANT_ID = SEED_TENANT_ID;

export const REPORT_1_OLD_ID = SEED_DNA_REPORT_IDS.REPORT_DOCTOR_OLD;
export const REPORT_1_ID = SEED_DNA_REPORT_IDS.REPORT_DOCTOR;
export const REPORT_2_ID = SEED_DNA_REPORT_IDS.REPORT_DOCTOR2;
export const REPORT_DEPT_FALLBACK_ID = SEED_DNA_REPORT_IDS.REPORT_DEPT_HEAD;
export const REPORT_SURGERY_ID = SEED_DNA_REPORT_IDS.REPORT_SURGERY;
export const REPORT_NEURO_ID = SEED_DNA_REPORT_IDS.REPORT_NEURO;

export const DEFAULT_DNA_REPORTS = [
  {
    id: SEED_DNA_REPORT_IDS.REPORT_DOCTOR_OLD,
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DOCTOR,
    reportData: {
      formality: 'casual',
      sentenceLength: 'short',
      medicalTermUsage: 'low',
      abbreviationStyle: 'heavy',
    },
    styleText: 'Dr. Smith initially used casual, abbreviated documentation. This style was superseded by a more professional analysis.',
    isLatest: false,
    currentVersionNumber: 1,
  },
  {
    id: SEED_DNA_REPORT_IDS.REPORT_DOCTOR,
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DOCTOR,
    reportData: {
      formality: 'professional',
      sentenceLength: 'medium',
      medicalTermUsage: 'moderate',
      abbreviationStyle: 'standard',
    },
    styleText:
      'Dr. Smith prefers concise, professional documentation with moderate use of medical terminology. Sentences are typically medium length with standard clinical abbreviations. Documentation follows SOAP format with clear assessment and plan sections.',
    isLatest: true,
    currentVersionNumber: 2,
  },
  {
    id: SEED_DNA_REPORT_IDS.REPORT_DOCTOR2,
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DOCTOR2,
    reportData: {
      formality: 'formal',
      sentenceLength: 'long',
      medicalTermUsage: 'extensive',
      abbreviationStyle: 'minimal',
    },
    styleText:
      'Dr. Doe uses formal, detailed documentation with extensive medical terminology. Prefers longer, descriptive sentences and minimal abbreviations, often spelling out terms in full. Cardiology-specific terminology is used consistently.',
    isLatest: true,
    currentVersionNumber: 1,
  },
  {
    id: SEED_DNA_REPORT_IDS.REPORT_DEPT_HEAD,
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DEPT_HEAD,
    reportData: {
      formality: 'professional',
      sentenceLength: 'medium',
      medicalTermUsage: 'moderate',
      abbreviationStyle: 'standard',
    },
    styleText:
      'Department-level default writing style for General Practice. Professional tone, moderate medical terminology, SOAP-structured documentation with clear clinical reasoning.',
    isLatest: true,
    currentVersionNumber: 1,
  },
  {
    id: SEED_DNA_REPORT_IDS.REPORT_SURGERY,
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DOCTOR_SURGERY,
    reportData: {
      formality: 'formal',
      sentenceLength: 'short',
      medicalTermUsage: 'extensive',
      abbreviationStyle: 'heavy',
    },
    styleText:
      'Dr. Patel uses highly structured, formal surgical documentation. Prefers short, decisive sentences with heavy use of standard surgical abbreviations (RIF, McBurney, NPO, OT). Operative notes follow a strict template: Indication → Procedure → Findings → Post-op Plan.',
    isLatest: true,
    currentVersionNumber: 1,
  },
  {
    id: SEED_DNA_REPORT_IDS.REPORT_NEURO,
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DOCTOR_NEURO,
    reportData: {
      formality: 'formal',
      sentenceLength: 'long',
      medicalTermUsage: 'extensive',
      abbreviationStyle: 'minimal',
    },
    styleText:
      'Dr. Chen favours detailed, narrative-style neurological documentation. Uses extensive neurological terminology with minimal abbreviations, preferring to spell out clinical terms. Includes thorough differential diagnoses and reasoning chains in assessments. Descriptions of neurological examination findings are particularly granular.',
    isLatest: true,
    currentVersionNumber: 1,
  },
  {
    id: SEED_DNA_REPORT_IDS.REPORT_BREN,
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DOCTOR_BREN,
    reportData: {
      formality: 'formal',
      sentenceLength: 'medium',
      medicalTermUsage: 'extensive',
      abbreviationStyle: 'moderate',
    },
    styleText:
      'Dr. Sharma writes thorough, formal breast and endocrine documentation. Includes detailed reproductive history and hormonal assessment. Uses moderate abbreviations with full spelling for uncommon terms. Documentation emphasises risk factor analysis and screening protocols.',
    isLatest: true,
    currentVersionNumber: 1,
  },
  {
    id: SEED_DNA_REPORT_IDS.REPORT_RHEUM,
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DOCTOR_RHEUM,
    reportData: {
      formality: 'formal',
      sentenceLength: 'medium',
      medicalTermUsage: 'extensive',
      abbreviationStyle: 'moderate',
    },
    styleText:
      'Dr. Park uses structured rheumatology documentation with emphasis on joint counts, inflammatory markers, and disease activity scores. Moderate abbreviation usage with standard rheumatology shorthand (DAS28, ESR, CRP). Lab values are always presented in tabular format.',
    isLatest: true,
    currentVersionNumber: 1,
  },
];

export const DEFAULT_DNA_VERSIONS = [
  {
    id: '74000000-0000-0000-0000-000000000001',
    tenantId: SEED_TENANT_ID,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_DOCTOR,
    versionNumber: 1,
    reportData: {
      formality: 'casual',
      sentenceLength: 'short',
      medicalTermUsage: 'low',
      abbreviationStyle: 'heavy',
    },
    styleText: 'Dr. Smith initially used casual, abbreviated documentation.',
    changeReason: 'AI-generated initial analysis',
    changedBy: SYSTEM_USER_ID,
  },
  {
    id: '74000000-0000-0000-0000-000000000010',
    tenantId: SEED_TENANT_ID,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_DOCTOR,
    versionNumber: 2,
    reportData: {
      formality: 'professional',
      sentenceLength: 'medium',
      medicalTermUsage: 'moderate',
      abbreviationStyle: 'standard',
    },
    styleText:
      'Dr. Smith prefers concise, professional documentation with moderate use of medical terminology. Sentences are typically medium length with standard clinical abbreviations. Documentation follows SOAP format with clear assessment and plan sections.',
    changeReason: 'Periodic update with more consultation data',
    changedBy: SYSTEM_USER_ID,
  },
  {
    id: '74000000-0000-0000-0000-000000000002',
    tenantId: SEED_TENANT_ID,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_DOCTOR2,
    versionNumber: 1,
    reportData: {
      formality: 'formal',
      sentenceLength: 'long',
      medicalTermUsage: 'extensive',
      abbreviationStyle: 'minimal',
    },
    styleText:
      'Dr. Doe uses formal, detailed documentation with extensive medical terminology. Prefers longer, descriptive sentences and minimal abbreviations, often spelling out terms in full. Cardiology-specific terminology is used consistently.',
    changeReason: 'AI-generated initial analysis',
    changedBy: SYSTEM_USER_ID,
  },
  {
    id: '74000000-0000-0000-0000-000000000003',
    tenantId: SEED_TENANT_ID,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_DOCTOR_OLD,
    versionNumber: 1,
    reportData: {
      formality: 'casual',
      sentenceLength: 'short',
      medicalTermUsage: 'low',
      abbreviationStyle: 'heavy',
    },
    styleText: 'Dr. Smith initially used casual, abbreviated documentation. This style was superseded by a more professional analysis.',
    changeReason: 'AI-generated initial analysis',
    changedBy: SYSTEM_USER_ID,
  },
  {
    id: '74000000-0000-0000-0000-000000000004',
    tenantId: SEED_TENANT_ID,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_DEPT_HEAD,
    versionNumber: 1,
    reportData: {
      formality: 'professional',
      sentenceLength: 'medium',
      medicalTermUsage: 'moderate',
      abbreviationStyle: 'standard',
    },
    styleText:
      'Department-level default writing style for General Practice. Professional tone, moderate medical terminology, SOAP-structured documentation with clear clinical reasoning.',
    changeReason: 'AI-generated department baseline',
    changedBy: SYSTEM_USER_ID,
  },
  {
    id: '74000000-0000-0000-0000-000000000005',
    tenantId: SEED_TENANT_ID,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_SURGERY,
    versionNumber: 1,
    reportData: {
      formality: 'formal',
      sentenceLength: 'short',
      medicalTermUsage: 'extensive',
      abbreviationStyle: 'heavy',
    },
    styleText:
      'Dr. Patel uses highly structured, formal surgical documentation. Prefers short, decisive sentences with heavy use of standard surgical abbreviations (RIF, McBurney, NPO, OT). Operative notes follow a strict template: Indication → Procedure → Findings → Post-op Plan.',
    changeReason: 'AI-generated initial analysis from 5 surgical consultations',
    changedBy: SYSTEM_USER_ID,
  },
  {
    id: '74000000-0000-0000-0000-000000000006',
    tenantId: SEED_TENANT_ID,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_NEURO,
    versionNumber: 1,
    reportData: {
      formality: 'formal',
      sentenceLength: 'long',
      medicalTermUsage: 'extensive',
      abbreviationStyle: 'minimal',
    },
    styleText:
      'Dr. Chen favours detailed, narrative-style neurological documentation. Uses extensive neurological terminology with minimal abbreviations, preferring to spell out clinical terms. Includes thorough differential diagnoses and reasoning chains in assessments. Descriptions of neurological examination findings are particularly granular.',
    changeReason: 'AI-generated initial analysis from 3 neurology consultations',
    changedBy: SYSTEM_USER_ID,
  },
  {
    id: '74000000-0000-0000-0000-000000000007',
    tenantId: SEED_TENANT_ID,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_BREN,
    versionNumber: 1,
    reportData: { formality: 'formal', sentenceLength: 'medium', medicalTermUsage: 'extensive', abbreviationStyle: 'moderate' },
    styleText: 'Dr. Sharma writes thorough, formal breast and endocrine documentation...',
    changeReason: 'AI-generated initial analysis from 4 breast & endocrine consultations',
    changedBy: SYSTEM_USER_ID,
  },
  {
    id: '74000000-0000-0000-0000-000000000008',
    tenantId: SEED_TENANT_ID,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_RHEUM,
    versionNumber: 1,
    reportData: { formality: 'formal', sentenceLength: 'medium', medicalTermUsage: 'extensive', abbreviationStyle: 'moderate' },
    styleText: 'Dr. Park uses structured rheumatology documentation...',
    changeReason: 'AI-generated initial analysis from 3 rheumatology consultations',
    changedBy: SYSTEM_USER_ID,
  },
];

export const DEFAULT_DNA_USAGE_RECORDS = [
  {
    id: '75000000-0000-0000-0000-000000000001',
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DOCTOR,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_DOCTOR,
    dnaVersionNumber: 1,
    consultationId: null,
    departmentId: SEED_DEPARTMENT_IDS.GEN,
  },
  {
    id: '75000000-0000-0000-0000-000000000002',
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DOCTOR2,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_DOCTOR2,
    dnaVersionNumber: 1,
    consultationId: null,
    departmentId: SEED_DEPARTMENT_IDS.CARD,
  },
  {
    id: '75000000-0000-0000-0000-000000000003',
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DOCTOR,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_DOCTOR,
    dnaVersionNumber: 2,
    consultationId: null,
    departmentId: SEED_DEPARTMENT_IDS.GEN,
  },
  {
    id: '75000000-0000-0000-0000-000000000004',
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DEPT_HEAD,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_DEPT_HEAD,
    dnaVersionNumber: 1,
    consultationId: null,
    departmentId: SEED_DEPARTMENT_IDS.GEN,
  },
  {
    id: '75000000-0000-0000-0000-000000000005',
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DOCTOR_SURGERY,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_SURGERY,
    dnaVersionNumber: 1,
    consultationId: null,
    departmentId: SEED_DEPARTMENT_IDS.SURG,
  },
  {
    id: '75000000-0000-0000-0000-000000000006',
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DOCTOR_NEURO,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_NEURO,
    dnaVersionNumber: 1,
    consultationId: null,
    departmentId: SEED_DEPARTMENT_IDS.NEUR,
  },
  {
    id: '75000000-0000-0000-0000-000000000007',
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DOCTOR_BREN,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_BREN,
    dnaVersionNumber: 1,
    consultationId: null,
    departmentId: SEED_DEPARTMENT_IDS.BREN,
  },
  {
    id: '75000000-0000-0000-0000-000000000008',
    tenantId: SEED_TENANT_ID,
    doctorId: SEED_USER_IDS.DOCTOR_RHEUM,
    dnaReportId: SEED_DNA_REPORT_IDS.REPORT_RHEUM,
    dnaVersionNumber: 1,
    consultationId: null,
    departmentId: SEED_DEPARTMENT_IDS.RHEUM,
  },
];

export const DEFAULT_PROMPT_USAGE_RECORDS = [
  {
    id: '76000000-0000-0000-0000-000000000001',
    tenantId: SEED_TENANT_ID,
    promptTemplateId: SEED_TEMPLATE_IDS.SYSTEM_DEFAULT,
    promptVersionNumber: 1,
    consultationId: null,
    doctorId: SEED_USER_IDS.DOCTOR,
    departmentId: SEED_DEPARTMENT_IDS.GEN,
  },
  {
    id: '76000000-0000-0000-0000-000000000002',
    tenantId: SEED_TENANT_ID,
    promptTemplateId: SEED_TEMPLATE_IDS.DNA_ANALYSIS,
    promptVersionNumber: 1,
    consultationId: null,
    doctorId: SEED_USER_IDS.DOCTOR2,
    departmentId: SEED_DEPARTMENT_IDS.CARD,
  },
];

// =============================================================================
// CUSTOMER-TENANT DNA
//
// The DNA reports/versions/usage above all belong to the Global customer
// tenant (SEED_TENANT_ID), so the admin cross-tenant switcher demoed empty DNA
// for ArcaAI. A DnaWritingStyleReport.doctorId is a hard FK to
// User AND the runtime membership/PHI guard requires that doctor to be a member
// of the tenant (role + department).
//
// Those clinicians ALREADY exist: 91-user.ts seeds one impersonatable DOCTOR
// per customer tenant (ARCAAI_DOCTOR), each
// with the DOCTOR role + that tenant's GEN department, satisfying the
// membership invariant. This seed therefore REUSES those canonical users by id
// and must NOT invent its own. An earlier revision created brand-new users with
// the SAME username (arcaai_doctor) under
// different ids, which violates `User.username @unique` and crashes a COLD seed:
// 91-user.ts runs first and takes the username, then this file's create
// collides. We now attach ONLY the DNA-specific child rows below.
//
// IDs follow the per-tenant 4th-UUID-group convention (0001 ArcaAI):
// reports 73…, versions 74…, usage 75…. DnaUsageRecord has no
// createdAt override so it defaults to now(), keeping the records inside the
// 30-day admin dashboard window.
// =============================================================================
export const CUSTOMER_DNA_CLINICIANS = [
  {
    userId: SEED_USER_IDS.ARCAAI_DOCTOR,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    departmentId: SEED_DEPARTMENT_IDS.GEN_ARCAAI,
    reportId: '73000000-0000-0000-0001-000000000001',
    versionId: '74000000-0000-0000-0001-000000000001',
    usageIds: ['75000000-0000-0000-0001-000000000001', '75000000-0000-0000-0001-000000000002'],
    reportData: { formality: 'professional', sentenceLength: 'medium', medicalTermUsage: 'moderate', abbreviationStyle: 'standard' },
    styleText:
      'Dr. Tan (ArcaAI, General Practice) writes concise, professional outpatient notes with moderate medical terminology and standard abbreviations. Documentation follows a clear SOAP structure with explicit assessment and plan sections.',
  },
  {
    userId: SEED_USER_IDS.ARCAAI_DOCTOR_SURG,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    departmentId: SEED_DEPARTMENT_IDS.SURG_ARCAAI,
    reportId: '73000000-0000-0000-0001-000000000002',
    versionId: '74000000-0000-0000-0001-000000000002',
    usageIds: ['75000000-0000-0000-0001-000000000003'],
    reportData: { formality: 'formal', sentenceLength: 'short', medicalTermUsage: 'extensive', abbreviationStyle: 'heavy' },
    styleText:
      'Dr. Ng (ArcaAI, Surgery) writes highly structured, formal operative documentation. Prefers short, decisive sentences with heavy use of standard surgical abbreviations (NPO, OT, RIF, POD). Notes follow a strict template: Indication → Procedure → Findings → Post-op Plan.',
  },
  {
    userId: SEED_USER_IDS.ARCAAI_DOCTOR_RHEUM,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    departmentId: SEED_DEPARTMENT_IDS.RHEUM_ARCAAI,
    reportId: '73000000-0000-0000-0001-000000000003',
    versionId: '74000000-0000-0000-0001-000000000003',
    usageIds: ['75000000-0000-0000-0001-000000000004'],
    reportData: { formality: 'formal', sentenceLength: 'medium', medicalTermUsage: 'extensive', abbreviationStyle: 'moderate' },
    styleText:
      'Dr. Nair (ArcaAI, Rheumatology) documents with emphasis on tender/swollen joint counts, inflammatory markers, and disease-activity scores. Uses moderate standard rheumatology shorthand (DAS28, ESR, CRP) and consistently presents serial lab values in tabular form.',
  },
  {
    userId: SEED_USER_IDS.ARCAAI_DOCTOR_NEUR,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    departmentId: SEED_DEPARTMENT_IDS.NEUR_ARCAAI,
    reportId: '73000000-0000-0000-0001-000000000004',
    versionId: '74000000-0000-0000-0001-000000000004',
    usageIds: ['75000000-0000-0000-0001-000000000005'],
    reportData: { formality: 'formal', sentenceLength: 'long', medicalTermUsage: 'extensive', abbreviationStyle: 'minimal' },
    styleText:
      'Dr. Wong (ArcaAI, Neurology) favours detailed, narrative-style documentation with extensive neurological terminology and minimal abbreviations, preferring to spell terms out in full. Neurological examination findings are described granularly, with thorough differentials and explicit reasoning chains.',
  },
  {
    userId: SEED_USER_IDS.ARCAAI_DOCTOR_ORTH,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    departmentId: SEED_DEPARTMENT_IDS.ORTH_ARCAAI,
    reportId: '73000000-0000-0000-0001-000000000005',
    versionId: '74000000-0000-0000-0001-000000000005',
    usageIds: ['75000000-0000-0000-0001-000000000006'],
    reportData: { formality: 'professional', sentenceLength: 'short', medicalTermUsage: 'moderate', abbreviationStyle: 'heavy' },
    styleText:
      'Dr. Goh (ArcaAI, Orthopedics) writes brisk, focused musculoskeletal notes centred on mechanism of injury, range-of-motion, and imaging correlation. Uses heavy standard orthopedic abbreviations (ROM, WBAT, ORIF, NWB) with clearly delineated management and follow-up plans.',
  },
  {
    userId: SEED_USER_IDS.ARCAAI_DOCTOR_HEME,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    departmentId: SEED_DEPARTMENT_IDS.HEME_ARCAAI,
    reportId: '73000000-0000-0000-0001-000000000006',
    versionId: '74000000-0000-0000-0001-000000000006',
    usageIds: ['75000000-0000-0000-0001-000000000007'],
    reportData: { formality: 'formal', sentenceLength: 'medium', medicalTermUsage: 'extensive', abbreviationStyle: 'moderate' },
    styleText:
      'Dr. Rao (ArcaAI, Hematology) writes precise, formal notes anchored to the full blood count, blood-film morphology, and coagulation profile. Uses moderate standard hematology shorthand (CBC, Hb, MCV, INR) and always lays out serial counts in tabular format with trend commentary.',
  },
  {
    userId: SEED_USER_IDS.ARCAAI_DOCTOR_BREN,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    departmentId: SEED_DEPARTMENT_IDS.BREN_ARCAAI,
    reportId: '73000000-0000-0000-0001-000000000007',
    versionId: '74000000-0000-0000-0001-000000000007',
    usageIds: ['75000000-0000-0000-0001-000000000008'],
    reportData: { formality: 'formal', sentenceLength: 'medium', medicalTermUsage: 'extensive', abbreviationStyle: 'moderate' },
    styleText:
      'Dr. Lee (ArcaAI, Breast & Endocrine) writes thorough, formal documentation covering reproductive and hormonal history alongside imaging and screening results. Uses moderate abbreviations, spelling out uncommon terms, and consistently emphasises risk-factor analysis and screening-protocol adherence.',
  },
];

export const CUSTOMER_DNA_REPORTS = CUSTOMER_DNA_CLINICIANS.map((c) => ({
  id: c.reportId,
  tenantId: c.tenantId,
  doctorId: c.userId,
  reportData: c.reportData,
  styleText: c.styleText,
  isLatest: true,
  currentVersionNumber: 1,
}));

export const CUSTOMER_DNA_VERSIONS = CUSTOMER_DNA_CLINICIANS.map((c) => ({
  id: c.versionId,
  tenantId: c.tenantId,
  dnaReportId: c.reportId,
  versionNumber: 1,
  reportData: c.reportData,
  styleText: c.styleText,
  changeReason: 'AI-generated initial analysis',
  changedBy: SYSTEM_USER_ID,
}));

export const CUSTOMER_DNA_USAGE_RECORDS = CUSTOMER_DNA_CLINICIANS.flatMap((c) =>
  c.usageIds.map((usageId) => ({
    id: usageId,
    tenantId: c.tenantId,
    doctorId: c.userId,
    dnaReportId: c.reportId,
    dnaVersionNumber: 1,
    consultationId: null,
    departmentId: c.departmentId,
  })),
);

// Usernames of users the DNA seed CREATES on its own — intentionally EMPTY: the
// DNA seed reuses the canonical 91-user.ts clinicians by id and never creates a
// user. The cold-seed unique-username guard (seed/__tests__) folds this into the
// global username set; a regression that re-introduces a standalone identity
// here would repopulate it and surface the duplicate-username collision.
export const CUSTOMER_DNA_SEED_USERNAMES: string[] = [];

export const DNA_REGEN_SETTINGS = [
  {
    id: '77000000-0000-0000-0000-000000000001',
    tenantId: SEED_TENANT_ID,
    name: 'DNA Regeneration Enabled',
    description: 'Master on/off switch for the scheduled DNA regeneration job',
    key: 'dna-regen.enabled',
    value: 'false',
    defaultValue: 'false',
    dataType: 'Boolean' as const,
    namespace: 'dna-regeneration',
  },
  {
    id: '77000000-0000-0000-0000-000000000002',
    tenantId: SEED_TENANT_ID,
    name: 'DNA Regeneration Cron',
    description: 'Cron expression for the DNA regeneration schedule (default: midnight on 1st of every month)',
    key: 'dna-regen.cron',
    value: '0 0 1 * *',
    defaultValue: '0 0 1 * *',
    dataType: 'String' as const,
    namespace: 'dna-regeneration',
  },
  {
    id: '77000000-0000-0000-0000-000000000003',
    tenantId: SEED_TENANT_ID,
    name: 'DNA Regeneration Max Samples',
    description: 'Maximum number of context items fetched per doctor for DNA analysis',
    key: 'dna-regen.max-samples',
    value: '50',
    defaultValue: '50',
    dataType: 'Integer' as const,
    namespace: 'dna-regeneration',
  },
  {
    id: '77000000-0000-0000-0000-000000000004',
    tenantId: SEED_TENANT_ID,
    name: 'DNA Regeneration Max Context Chars',
    description: 'Maximum total characters sent to TEXT v2 for DNA analysis',
    key: 'dna-regen.max-context-chars',
    value: '100000',
    defaultValue: '100000',
    dataType: 'Integer' as const,
    namespace: 'dna-regeneration',
  },
  {
    id: '77000000-0000-0000-0000-000000000005',
    tenantId: SEED_TENANT_ID,
    name: 'DNA Regeneration Job Delay',
    description: 'Delay in milliseconds between queued regeneration jobs for staggering',
    key: 'dna-regen.job-delay-ms',
    value: '5000',
    defaultValue: '5000',
    dataType: 'Integer' as const,
    namespace: 'dna-regeneration',
  },
];

export const seedDnaWritingStyle = async (client: CorePrismaClient) => {
  console.log('Seeding DNA regeneration scheduler settings...');
  for (const setting of DNA_REGEN_SETTINGS) {
    await client.globalSetting.upsert({
      where: {
        GlobalSetting_tenantId_name_key_unique: {
          tenantId: setting.tenantId,
          name: setting.name,
          key: setting.key,
        },
      },
      // `value` omitted deliberately — operator-owned.
      update: { description: setting.description },
      create: setting,
    });
  }
  console.log(`Seeded ${DNA_REGEN_SETTINGS.length} DNA regeneration settings`);

  console.log('Seeding DNA writing style reports...');
  for (const report of DEFAULT_DNA_REPORTS) {
    const data = await encryptSeedRow<Prisma.DnaWritingStyleReportUncheckedCreateInput>('DnaWritingStyleReport', report);
    await client.dnaWritingStyleReport.upsert({
      where: { id: report.id },
      update: data,
      create: data,
    });
  }
  console.log(`Seeded ${DEFAULT_DNA_REPORTS.length} DNA reports`);

  console.log('Seeding DNA writing style versions...');
  for (const version of DEFAULT_DNA_VERSIONS) {
    const data = await encryptSeedRow<Prisma.DnaWritingStyleVersionUncheckedCreateInput>('DnaWritingStyleVersion', version);
    await client.dnaWritingStyleVersion.upsert({
      where: { id: version.id },
      update: data,
      create: data,
    });
  }
  console.log(`Seeded ${DEFAULT_DNA_VERSIONS.length} DNA versions`);

  console.log('Seeding DNA usage records...');
  for (const record of DEFAULT_DNA_USAGE_RECORDS) {
    await client.dnaUsageRecord.upsert({
      where: { id: record.id },
      update: record,
      create: record,
    });
  }
  console.log(`Seeded ${DEFAULT_DNA_USAGE_RECORDS.length} DNA usage records`);

  console.log('Seeding prompt usage records...');
  for (const record of DEFAULT_PROMPT_USAGE_RECORDS) {
    await client.promptUsageRecord.upsert({
      where: { id: record.id },
      update: record,
      create: record,
    });
  }
  console.log(`Seeded ${DEFAULT_PROMPT_USAGE_RECORDS.length} prompt usage records`);

  // -------------------------------------------------------------------------
  // Customer-tenant DNA.
  //
  // The customer-tenant DOCTOR clinician (ARCAAI_DOCTOR) is seeded by
  // 91-user.ts (which runs first), with the
  // DOCTOR role + that tenant's GEN department. We attach the DNA child rows
  // to those EXISTING canonical users by id — we do NOT create users here, so
  // there is no duplicate-username collision on a cold seed.
  // -------------------------------------------------------------------------
  console.log('Seeding customer-tenant DNA reports...');
  for (const report of CUSTOMER_DNA_REPORTS) {
    const data = await encryptSeedRow<Prisma.DnaWritingStyleReportUncheckedCreateInput>('DnaWritingStyleReport', report);
    await client.dnaWritingStyleReport.upsert({
      where: { id: report.id },
      update: data,
      create: data,
    });
  }
  console.log(`Seeded ${CUSTOMER_DNA_REPORTS.length} customer-tenant DNA reports`);

  console.log('Seeding customer-tenant DNA versions...');
  for (const version of CUSTOMER_DNA_VERSIONS) {
    const data = await encryptSeedRow<Prisma.DnaWritingStyleVersionUncheckedCreateInput>('DnaWritingStyleVersion', version);
    await client.dnaWritingStyleVersion.upsert({
      where: { id: version.id },
      update: data,
      create: data,
    });
  }
  console.log(`Seeded ${CUSTOMER_DNA_VERSIONS.length} customer-tenant DNA versions`);

  console.log('Seeding customer-tenant DNA usage records...');
  for (const record of CUSTOMER_DNA_USAGE_RECORDS) {
    await client.dnaUsageRecord.upsert({
      where: { id: record.id },
      update: record,
      create: record,
    });
  }
  console.log(`Seeded ${CUSTOMER_DNA_USAGE_RECORDS.length} customer-tenant DNA usage records`);
};

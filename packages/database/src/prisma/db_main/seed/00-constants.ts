/**
 * Seed Constants — Single Source of Truth
 *
 * All hardcoded IDs used across seed files are defined here.
 * Every seed file imports from this module instead of declaring local constants.
 *
 * ID Prefix Convention:
 *   00000000-0000-0000-0000-000000000000  →  Reserved system tenant (platform-wide rows)
 *   00000000-0000-0000-0000-XXXXXXXXXXXX  →  Roles (RBAC)
 *   00000000-0000-0000-0001-XXXXXXXXXXXX  →  Policies (RBAC)
 *   50000000-xxxx  →  Customer Tenants (Global, ArcaAI)
 *   60000000-xxxx  →  API Keys + System User
 *   70000000-xxxx  →  Users (0001-0009 admin, 0010-0029 clinical, 0030+ service)
 *   70000000-xxxx  →  Departments (separate entity, same prefix range but dept block)
 *   71000000-xxxx  →  Prompt Templates
 *   71000000-…-0001-0000000000XX  →  ArcaAI-tenant prompt templates
 *                     (001-004 demo cross-tenant set; 010-024 = the first 15
 *                     ArcaAI clinical templates — TASK-592 Workstream D;
 *                     025-032 = the 8 added by TASK-634 Phase 8b, bringing the
 *                     set to 23 = 11 departments × 2 visit types + 1 shared
 *                     pre-summary)
 *   72000000-xxxx  →  Prompt Versions
 *   72000000-…-0001-0000000000XX  →  ArcaAI-tenant prompt versions (mirror of
 *                     the template slot above)
 *   73000000-xxxx  →  DNA Writing Style Reports
 *   74000000-xxxx  →  DNA Writing Style Versions
 *   75000000-xxxx  →  DNA Usage Records
 *   76000000-xxxx  →  Prompt Usage Records
 *   77000000-xxxx  →  DNA Regeneration Settings
 *   78000000-xxxx  →  Department Agents (0002 SYSTEM golden, 0000 Global-tenant
 *                     clones, 0001 ArcaAI clones — TASK-548 agent golden library)
 *   70000000-…-0002-…  →  SYSTEM golden departments (TASK-548)
 *   71000000-…-0002-…  →  SYSTEM golden prompt templates (TASK-548)
 *   72000000-…-0002-…  →  SYSTEM golden prompt versions (TASK-548)
 *   71000000-…-0004-…  →  SYSTEM platform-default prompt templates (TASK-635)
 *   72000000-…-0004-…  →  their v1 PromptVersion snapshots (mirror slot)
 *                     A fresh STATIC block, deliberately NOT the golden
 *                     `…-0002-…` generator (whose ids derive from
 *                     `uniqueSourceIds` insertion order in
 *                     07a-agent-golden-library.ts — appending there would
 *                     couple a platform-default id to fixture ordering).
 *   79000000-…-XXXX-…  →  Consultation Context Schemas (TASK-686 day-1 default;
 *                     tenant slot mirrors the 78000000 agent block — 0002
 *                     SYSTEM, 0000 Global, 0001 ArcaAI)
 *   89000000-…-XXXX-…  →  their published ConsultationContextSchemaVersion
 *                     snapshots (mirror slot)
 *   D0000000-xxxx  →  DepartmentAgentVersion rows. NOT a free-standing block:
 *                     each id is its agent's id with the `78000000` prefix
 *                     swapped for `D0000000` (`agentVersionIdFor`), so agent
 *                     and version stay 1:1 without a second numbering scheme.
 *   80000000-0001  →  AI Models (ASR)
 *   80000000-0002  →  AI Models (VAD)
 *   80000000-0003  →  AI Models (Noise Reduction)
 *   80000000-0004  →  AI Models (ONNX Community)
 *   80000000-0005  →  AI Models (LLM/Summarization — SMR v2)
 *   80000000-0006  →  AI Models (Local Browser STT)
 *   81000000-xxxx  →  ASR Pipelines
 *   82000000-xxxx  →  STT Global Settings
 *   83000000-xxxx  →  General User Settings
 *   84000000-xxxx  →  SDK User Preferences
 *   85000000-xxxx  →  Per-Tenant Global Settings (general, feature-flags, stt, smr)
 *   90000000-xxxx  →  Consultations
 *   91000000-xxxx  →  Context Items
 *   92000000-xxxx  →  Summary Metas
 *   93000000-xxxx  →  Audio Recordings
 *   94000000-xxxx  →  Context Item Versions
 *   95000000-xxxx  →  Named Entities
 *   96000000-xxxx  →  Media (dual-capture demo blobs; defined in 09-consultation)
 *   97000000-xxxx  →  User Voice Profiles (diarization enrollment)
 *   98000000-xxxx  →  Transcription Jobs (ASR job queue rows)
 *   A0000000-xxxx  →  Audit Log Entries
 *   B0000000-xxxx  →  Plan Entitlements
 *   C0000000-xxxx  →  Tenant Allowed Origins — bootstrap loopback rows ONLY.
 *                     Not used by any seed file: these ids are allocated by
 *                     `migrations/20260808160000_task_641_bootstrap_loopback_origins`,
 *                     which guarantees the six SYSTEM loopback rows exist in
 *                     environments that never run the seed (TASK-641 H-2).
 *                     Listed here so the block is not handed out twice.
 */

// =============================================================================
// SYSTEM
// =============================================================================

export const SYSTEM_USER_ID = '60000000-0000-0000-0000-000000000000';

// =============================================================================
// TENANTS
// =============================================================================

/**
 * Reserved system tenant — used as the `tenantId` owner for platform-wide rows
 * (system policies, RBAC roles, system AI models / pipelines, system-wide
 * settings) that are NOT customer data. Replaces the previous
 * `tenantId IS NULL` / sentinel-default semantics.
 *
 * DO NOT use this tenant for any customer-facing data.
 */
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Global customer tenant — pre-existing seed tenant. Kept for backward
 * compatibility with existing tests and per-tenant default settings.
 */
export const SEED_TENANT_ID = '50000000-0000-0000-0000-000000000000';

export const SEED_CUSTOMER_TENANT_IDS = {
  // ArcaAI is the single retained customer/demo tenant. It exists to back the
  // cross-tenant isolation E2E suite (a "second tenant" to prove 404/scoping
  // contracts). The former 4bits + Mumbai demo tenants were removed.
  ARCAAI: '50000000-0000-0000-0000-000000000001',
} as const;

// =============================================================================
// POLICIES
// =============================================================================

export const SEED_POLICY_IDS = {
  SYSTEM_FULL_ACCESS: '00000000-0000-0000-0001-000000000001',
  RBAC_SYSTEM_MANAGE: '00000000-0000-0000-0001-000000000010',
  TENANT_FULL_ACCESS: '00000000-0000-0000-0001-000000000002',
  RBAC_TENANT_MANAGE: '00000000-0000-0000-0001-000000000011',
  RBAC_DELEGATE: '00000000-0000-0000-0001-000000000012',
  CONSULTATION_OWN_MANAGE: '00000000-0000-0000-0001-000000000020',
  CONSULTATION_READ_ASSIGNED: '00000000-0000-0000-0001-000000000021',
  CONSULTATION_SHARED_PATIENT_READ: '00000000-0000-0000-0001-000000000023',
  CONSULTATION_DEPARTMENT_READ: '00000000-0000-0000-0001-000000000022',
  USER_PROFILE_OWN: '00000000-0000-0000-0001-000000000030',
  API_KEY_OWN_MANAGE: '00000000-0000-0000-0001-000000000031',
  SERVICE_INTEGRATION: '00000000-0000-0000-0001-000000000040',
  FEDERATED_LEARNING_ACCESS: '00000000-0000-0000-0001-000000000041',
  PROMPT_TEMPLATE_MANAGE: '00000000-0000-0000-0001-000000000050',
  GLOBAL_SETTINGS_MANAGE: '00000000-0000-0000-0001-000000000051',
  AUDIT_LOG_READ: '00000000-0000-0000-0001-000000000052',
  STORAGE_UPLOAD: '00000000-0000-0000-0001-000000000060',
} as const;

// =============================================================================
// ROLES
// =============================================================================

export const SEED_ROLE_IDS = {
  // 00000000-0000-0000-0000-000000000001 is the RETIRED SUPER_ADMIN role id:
  // consolidated into GLOBAL_ADMIN and soft-deleted by data
  // migration. Reserved forever — never reuse it for a new role.
  TENANT_ADMIN: '00000000-0000-0000-0000-000000000002',
  // Elevated platform-wide "global admin"; the single
  // elevated role recognized by tenant-guards.ELEVATED_ROLES.
  GLOBAL_ADMIN: '00000000-0000-0000-0000-000000000003',
  DOCTOR: '00000000-0000-0000-0000-000000000010',
  NURSE: '00000000-0000-0000-0000-000000000011',
  SERVICE_ACCOUNT: '00000000-0000-0000-0000-000000000012',
  DEPARTMENT_HEAD: '00000000-0000-0000-0000-000000000020',
  SENIOR_NURSE: '00000000-0000-0000-0000-000000000021',
} as const;

// =============================================================================
// USERS
// =============================================================================

export const SEED_USER_IDS = {
  SYSTEM: SYSTEM_USER_ID,
  // Key kept as SUPER_ADMIN for data identity: it is the seeded `super_admin`
  // USER (login identifier), which carries the GLOBAL_ADMIN role.
  SUPER_ADMIN: '70000000-0000-0000-0000-000000000001',
  TENANT_ADMIN: '70000000-0000-0000-0000-000000000002',
  ARCAAI_ADMIN: '70000000-0000-0000-0000-000000000003',
  // Platform-wide global admin. Lives on the SYSTEM tenant
  // (like the seeded super_admin user) so it is membership-exempt and
  // elevated cross-tenant.
  GLOBAL_ADMIN: '70000000-0000-0000-0000-000000000006',
  DOCTOR: '70000000-0000-0000-0000-000000000010',
  DOCTOR2: '70000000-0000-0000-0000-000000000011',
  DEPT_HEAD: '70000000-0000-0000-0000-000000000012',
  NURSE: '70000000-0000-0000-0000-000000000013',
  SENIOR_NURSE: '70000000-0000-0000-0000-000000000014',
  DOCTOR_SURGERY: '70000000-0000-0000-0000-000000000015',
  DOCTOR_NEURO: '70000000-0000-0000-0000-000000000016',
  DOCTOR_PEDS: '70000000-0000-0000-0000-000000000017',
  DOCTOR_ER: '70000000-0000-0000-0000-000000000018',
  DOCTOR_BREN: '70000000-0000-0000-0000-000000000019',
  DOCTOR_RHEUM: '70000000-0000-0000-0000-000000000020',
  DOCTOR_HEME: '70000000-0000-0000-0000-000000000021',
  DOCTOR_DERM: '70000000-0000-0000-0000-000000000022',
  DOCTOR_DIET: '70000000-0000-0000-0000-000000000023',
  DOCTOR_NEPH: '70000000-0000-0000-0000-000000000024',
  DOCTOR_SONC: '70000000-0000-0000-0000-000000000025',
  DOCTOR_MED: '70000000-0000-0000-0000-000000000026',
  NURSE_CARD: '70000000-0000-0000-0000-000000000027',
  NURSE_MED: '70000000-0000-0000-0000-000000000028',
  SERVICE_ACCOUNT: '70000000-0000-0000-0000-000000000030',
  // One impersonatable DOCTOR + NURSE for the ArcaAI
  // customer tenant. The ~17 clinical users above all live on the Global
  // tenant; tenant admins are confined to their own tenant, so
  // ArcaAI needs its own non-admin clinical users to impersonate.
  ARCAAI_DOCTOR: '70000000-0000-0000-0000-000000000040',
  ARCAAI_NURSE: '70000000-0000-0000-0000-000000000041',
  // One DOCTOR per ArcaAI clinical department (day-1 production coverage).
  // ARCAAI_DOCTOR (Olivia Tan, above) covers General Medicine (GEN); these six
  // cover the remaining ArcaAI departments so every ArcaAI department has a
  // resident clinician. Primary department resolves by (tenantId, code) via
  // PRIMARY_DEPARTMENT_CODE_BY_USERNAME in 91-user.ts.
  ARCAAI_DOCTOR_SURG: '70000000-0000-0000-0000-000000000042',
  ARCAAI_DOCTOR_RHEUM: '70000000-0000-0000-0000-000000000043',
  ARCAAI_DOCTOR_NEUR: '70000000-0000-0000-0000-000000000044',
  ARCAAI_DOCTOR_ORTH: '70000000-0000-0000-0000-000000000045',
  ARCAAI_DOCTOR_HEME: '70000000-0000-0000-0000-000000000046',
  ARCAAI_DOCTOR_BREN: '70000000-0000-0000-0000-000000000047',
} as const;

// =============================================================================
// DEPARTMENTS
// =============================================================================

export const SEED_DEPARTMENT_IDS = {
  GEN: '70000000-0000-0000-0000-000000000001',
  CARD: '70000000-0000-0000-0000-000000000002',
  RAD: '70000000-0000-0000-0000-000000000003',
  LAB: '70000000-0000-0000-0000-000000000004',
  NEUR: '70000000-0000-0000-0000-000000000005',
  ORTH: '70000000-0000-0000-0000-000000000006',
  DERM: '70000000-0000-0000-0000-000000000007',
  PSYCH: '70000000-0000-0000-0000-000000000008',
  PEDS: '70000000-0000-0000-0000-000000000009',
  ER: '70000000-0000-0000-0000-000000000010',
  SURG: '70000000-0000-0000-0000-000000000011',
  MED: '70000000-0000-0000-0000-000000000012',
  BREN: '70000000-0000-0000-0000-000000000013',
  RHEUM: '70000000-0000-0000-0000-000000000014',
  HEME: '70000000-0000-0000-0000-000000000015',
  DIET: '70000000-0000-0000-0000-000000000016',
  NEPH: '70000000-0000-0000-0000-000000000017',
  SONC: '70000000-0000-0000-0000-000000000018',
  // ArcaAI customer-tenant CLINICAL departments (TASK-592 Workstream D;
  // completed to v1 parity by TASK-634 Phase 8b).
  //
  // The ArcaAI tenant carries the ELEVEN v1 clinical departments — and exactly
  // eleven. v1 has no Department table; its department set is defined by what
  // its SMR recognises, and BOTH authoritative sources on the running v1 pod
  // agree on eleven: `DEPT_VISIT_SCHEMAS` (22 = 11 × {new_referral, followup})
  // and `select_prompt_template` (11 branches). The v1 keys map to the codes
  // below as: breast_endocrine→BREN, dermatology→DERM, dietetics→DIET,
  // hematology→HEME, medicine→GEN, nephrology→NEPH, neurology→NEUR,
  // orthopedics→ORTH, rheumatology→RHEUM, surgery→SURG,
  // surgical_oncology→SONC.
  //
  // Each is wired via the LEGACY Department prompt-id columns
  // (newPatientPromptId / revisitPromptId) to its own APPROVED, per-visit-type
  // `PromptTemplate`s (see 07b-arcaai-clinical-templates.ts).
  // `preSummaryPromptId` is deliberately NULL on every one of them: pre-summary
  // has no department axis (TASK-634).
  //
  // The first seven ALSO carry a per-visit-type default `DepartmentAgent`
  // (TASK-635 RF-3, ARCAAI_TENANT_AGENTS in 07a-agent-golden-library.ts),
  // binding the same ids. The four added by Phase 8b carry NO default agent —
  // the visit-type columns are the v1-faithful path and an agent tier adds
  // nothing here.
  //
  // GEN_ARCAAI is RETAINED (existing consultation / user / DNA / audit seed
  // references point at it) and REPURPOSED as General Medicine. The former
  // CARD_ARCAAI / ER_ARCAAI demo departments were retired.
  //
  // 4th UUID group 0001 = ArcaAI tenant; trailing slot 001 = General Medicine
  // (kept), 010-015 = the six specialty departments added by TASK-592,
  // 016-019 = the four added by TASK-634 Phase 8b.
  GEN_ARCAAI: '70000000-0000-0000-0001-000000000001',
  SURG_ARCAAI: '70000000-0000-0000-0001-000000000010',
  RHEUM_ARCAAI: '70000000-0000-0000-0001-000000000011',
  NEUR_ARCAAI: '70000000-0000-0000-0001-000000000012',
  ORTH_ARCAAI: '70000000-0000-0000-0001-000000000013',
  HEME_ARCAAI: '70000000-0000-0000-0001-000000000014',
  BREN_ARCAAI: '70000000-0000-0000-0001-000000000015',
  DERM_ARCAAI: '70000000-0000-0000-0001-000000000016',
  DIET_ARCAAI: '70000000-0000-0000-0001-000000000017',
  NEPH_ARCAAI: '70000000-0000-0000-0001-000000000018',
  SONC_ARCAAI: '70000000-0000-0000-0001-000000000019',
} as const;

// =============================================================================
// API KEYS
// =============================================================================

export const SEED_API_KEY_IDS = {
  SDK_DOCTOR: '60000000-0000-0000-0000-000000000001',
  SDK_DOCTOR2: '60000000-0000-0000-0000-000000000002',
  WEBHOOK_ADMIN: '60000000-0000-0000-0000-000000000003',
  SERVICE_ACCOUNT: '60000000-0000-0000-0000-000000000004',
  SDK_ARCAAI: '60000000-0000-0000-0000-000000000005',
  REVOKED_DOCTOR: '60000000-0000-0000-0000-000000000006',
  SDK_SURGERY: '60000000-0000-0000-0000-000000000007',
  INTEGRATION_ARCAAI: '60000000-0000-0000-0000-000000000008',
  EXPIRED_DOCTOR2: '60000000-0000-0000-0000-000000000009',
  SDK_COMPAT_ARCAAI: '60000000-0000-0000-0000-00000000000a',
} as const;

export const SEED_API_KEY_RAW = {
  SDK_DOCTOR: 'hope_sk_test_a5c5e56x54c4437fbd6ce7dee9_631238',
  SDK_DOCTOR2: 'hope_sk_test_b7d8f67y65d5548gce8df8eef0_742349',
  WEBHOOK_ADMIN: 'hope_wh_test_c8e9g78z76e6659hdf9eg9ffg1_853460',
  SERVICE_ACCOUNT: 'hope_sa_test_d9f0h89a87f7760ieg0fh0ggh2_964571',
  SDK_ARCAAI: 'hope_sk_test_e0g1i90b98g8871jfh1gi1hhi3_075682',
  REVOKED_DOCTOR: 'hope_sk_test_f1h2j01c09h9982kgi2hj2iij4_186793',
  SDK_SURGERY: 'hope_sk_test_g2i3k12d10i0093lhj3ik3jjk5_297804',
  INTEGRATION_ARCAAI: 'hope_ig_test_h3j4l23e21j1104mik4jl4kkl6_308915',
  EXPIRED_DOCTOR2: 'hope_sk_test_i4k5m34f32k2215njl5km5llm7_419026',
  SDK_COMPAT_ARCAAI:
    'hope_sk_7548d66e07c25f8d0d079fa4f22e20abad3a0d919a83bd24ce6b0da58074c19a_a619ea',
} as const;

// =============================================================================
// PROMPT TEMPLATES
// =============================================================================

export const SEED_TEMPLATE_IDS = {
  SYSTEM_DEFAULT: '71000000-0000-0000-0000-000000000001',
  SOAP_SUMMARY: '71000000-0000-0000-0000-000000000002',
  DNA_ANALYSIS: '71000000-0000-0000-0000-000000000003',
  CARD_CUSTOM: '71000000-0000-0000-0000-000000000004',
  SMR_SYSTEM_BASE: '71000000-0000-0000-0000-000000000005',
  SMR_SYSTEM_ER: '71000000-0000-0000-0000-000000000006',
  SMR_SYSTEM_PEDS: '71000000-0000-0000-0000-000000000007',
  SMR_SYSTEM_CARD: '71000000-0000-0000-0000-000000000008',
  SMR_SYSTEM_PSYCH: '71000000-0000-0000-0000-000000000009',
  SURGERY_NEW_REFERRAL: '71000000-0000-0000-0000-000000000010',
  SURGERY_REVISIT: '71000000-0000-0000-0000-000000000011',
  MEDICINE_NEW_REFERRAL: '71000000-0000-0000-0000-000000000012',
  MEDICINE_REVISIT: '71000000-0000-0000-0000-000000000013',
  BREN_NEW_REFERRAL: '71000000-0000-0000-0000-000000000014',
  BREN_REVISIT: '71000000-0000-0000-0000-000000000015',
  RHEUM_NEW_REFERRAL: '71000000-0000-0000-0000-000000000016',
  RHEUM_REVISIT: '71000000-0000-0000-0000-000000000017',
  ORTH_NEW_REFERRAL: '71000000-0000-0000-0000-000000000018',
  ORTH_REVISIT: '71000000-0000-0000-0000-000000000019',
  NEUR_NEW_REFERRAL: '71000000-0000-0000-0000-000000000020',
  NEUR_REVISIT: '71000000-0000-0000-0000-000000000021',
  HEME_NEW_REFERRAL: '71000000-0000-0000-0000-000000000022',
  HEME_REVISIT: '71000000-0000-0000-0000-000000000023',
  JSON_ENFORCEMENT: '71000000-0000-0000-0000-000000000024',
  CORRECTIVE_RETRY: '71000000-0000-0000-0000-000000000025',
  PRE_SUMMARY_SYSTEM: '71000000-0000-0000-0000-000000000026',
  PREVIOUS_VISIT_SYSTEM: '71000000-0000-0000-0000-000000000027',
  DERM_NEW_REFERRAL: '71000000-0000-0000-0000-000000000028',
  DERM_REVISIT: '71000000-0000-0000-0000-000000000029',
  DIET_NEW_REFERRAL: '71000000-0000-0000-0000-000000000030',
  DIET_REVISIT: '71000000-0000-0000-0000-000000000031',
  NEPH_NEW_REFERRAL: '71000000-0000-0000-0000-000000000032',
  NEPH_REVISIT: '71000000-0000-0000-0000-000000000033',
  SONC_NEW_REFERRAL: '71000000-0000-0000-0000-000000000034',
  SONC_REVISIT: '71000000-0000-0000-0000-000000000035',
  CATCHALL_SOAP: '71000000-0000-0000-0000-000000000036',
  PRE_SUMMARY_DEFAULT: '71000000-0000-0000-0000-000000000040',
} as const;

// =============================================================================
// SYSTEM PLATFORM-DEFAULT PROMPT TEMPLATES (TASK-635, `…-0004-…` block)
//
// Owned by the SYSTEM tenant and readable by EVERY tenant (PromptTemplate /
// PromptVersion joined `SYSTEM_SHARED_READ_MODELS` in the C2 B-12 fold-in), so
// a tenant with no configuration of its own still resolves a governed prompt.
// Distinct from the `…-0002-…` golden LIBRARY (which is a per-tenant CLONE
// source): these rows are resolved DIRECTLY, by explicit id, from
// `SYSTEM_DEFAULTS` in PromptResolutionService.
// =============================================================================

export const SYSTEM_LIVE_SOAP_TEMPLATE_ID = '71000000-0000-0000-0004-000000000001';
export const SYSTEM_LIVE_SOAP_VERSION_ID = '72000000-0000-0000-0004-000000000001';

/**
 * RESERVED for TASK-635 Lane D2 (OD-1b / RF-1): the department-free pre-summary
 * fork served to NATIVE callers. Declared here so the id is claimed and cannot
 * be reused; D2 seeds the row and flips the native call sites to
 * `preSummaryVariant: 'dept-free'`. Nothing resolves it before then.
 */
export const SYSTEM_DEPT_FREE_PRE_SUMMARY_TEMPLATE_ID = '71000000-0000-0000-0004-000000000002';
export const SYSTEM_DEPT_FREE_PRE_SUMMARY_VERSION_ID = '72000000-0000-0000-0004-000000000002';

// Version IDs are generated dynamically — one per template.
// Use helper: SEED_VERSION_ID(n) → '72000000-0000-0000-0000-' + n.toString().padStart(12, '0')
export const SEED_VERSION_ID = (n: number): string => `72000000-0000-0000-0000-${n.toString().padStart(12, '0')}`;

// =============================================================================
// DNA WRITING STYLE
// =============================================================================

export const SEED_DNA_REPORT_IDS = {
  REPORT_DOCTOR_OLD: '73000000-0000-0000-0000-000000000001',
  REPORT_DOCTOR: '73000000-0000-0000-0000-000000000002',
  REPORT_DOCTOR2: '73000000-0000-0000-0000-000000000003',
  REPORT_DEPT_HEAD: '73000000-0000-0000-0000-000000000004',
  REPORT_SURGERY: '73000000-0000-0000-0000-000000000005',
  REPORT_NEURO: '73000000-0000-0000-0000-000000000006',
  REPORT_BREN: '73000000-0000-0000-0000-000000000007',
  REPORT_RHEUM: '73000000-0000-0000-0000-000000000008',
} as const;

// =============================================================================
// CONSULTATIONS (for e2e testing)
//
// Seeded in 09-consultation.ts:
//   GEN_COMPLETED, GEN_REOPENED, CARD_NEW, SURG_NEW, SURG_FOLLOWUP,
//   NEUR_REFERRAL, PEDS_COMPLETED, ER_RECORDING, CARD_CROSS_DEPT
//   + customer-tenant: ARCAAI_GEN_{NEW,REVISIT} (doc-08 F1)
//
// Reserved (ID allocated, not yet seeded in 09-consultation.ts):
//   CARD_REVISIT, BREN_NEW, RHEUM_NEW, RHEUM_REVISIT, HEME_NEW,
//   DERM_NEW, DIET_NEW, NEPH_NEW, SONC_NEW
// =============================================================================

export const SEED_CONSULTATION_IDS = {
  // --- Seeded ---
  GEN_COMPLETED: '90000000-0000-0000-0000-000000000001',
  GEN_REOPENED: '90000000-0000-0000-0000-000000000002',
  CARD_NEW: '90000000-0000-0000-0000-000000000003',
  SURG_NEW: '90000000-0000-0000-0000-000000000005',
  SURG_FOLLOWUP: '90000000-0000-0000-0000-000000000006',
  NEUR_REFERRAL: '90000000-0000-0000-0000-000000000007',
  PEDS_COMPLETED: '90000000-0000-0000-0000-000000000016',
  ER_RECORDING: '90000000-0000-0000-0000-000000000017',
  CARD_CROSS_DEPT: '90000000-0000-0000-0000-000000000018',
  // --- Reserved (not yet seeded — used by audit-log and prompt-template seeds) ---
  CARD_REVISIT: '90000000-0000-0000-0000-000000000004',
  BREN_NEW: '90000000-0000-0000-0000-000000000008',
  RHEUM_NEW: '90000000-0000-0000-0000-000000000009',
  RHEUM_REVISIT: '90000000-0000-0000-0000-000000000010',
  HEME_NEW: '90000000-0000-0000-0000-000000000011',
  DERM_NEW: '90000000-0000-0000-0000-000000000012',
  DIET_NEW: '90000000-0000-0000-0000-000000000013',
  NEPH_NEW: '90000000-0000-0000-0000-000000000014',
  SONC_NEW: '90000000-0000-0000-0000-000000000015',
  // --- Customer-tenant consultations (seeded in 09-consultation.ts) ---
  // 4th UUID group encodes the customer tenant (0001 ArcaAI).
  ARCAAI_GEN_NEW: '90000000-0000-0000-0001-000000000001',
  ARCAAI_GEN_REVISIT: '90000000-0000-0000-0001-000000000002',
} as const;

// Context item IDs are generated with a helper for scalability.
// Format: 91000000-0000-0000-0000-XXXXXXXXXXXX
export const SEED_CTX_ID = (n: number): string => `91000000-0000-0000-0000-${n.toString().padStart(12, '0')}`;

export const SEED_CONTEXT_ITEM_IDS = {
  // --- Seeded in 09-consultation.ts ---
  GEN_TRANSCRIPT: SEED_CTX_ID(1),
  GEN_RAW_SUMMARY: SEED_CTX_ID(2),
  GEN_AUDIO: SEED_CTX_ID(3),
  GEN_MODIFIED_SUMMARY: SEED_CTX_ID(4),
  GEN_CASE_NOTE: SEED_CTX_ID(5),
  GEN_PRE_SUMMARY: SEED_CTX_ID(6),
  GEN_REOPENED_TRANSCRIPT: SEED_CTX_ID(7),
  GEN_REOPENED_WORKNOTE: SEED_CTX_ID(8),
  CARD_TRANSCRIPT: SEED_CTX_ID(10),
  CARD_WORKNOTE: SEED_CTX_ID(11),
  CARD_PRE_SUMMARY: SEED_CTX_ID(12),
  CARD_CROSS_TRANSCRIPT: SEED_CTX_ID(14),
  SURG_TRANSCRIPT: SEED_CTX_ID(20),
  SURG_AUDIO: SEED_CTX_ID(21),
  SURG_CASE_NOTE: SEED_CTX_ID(22),
  SURG_FOLLOWUP_TRANSCRIPT: SEED_CTX_ID(24),
  NEUR_TRANSCRIPT: SEED_CTX_ID(30),
  PEDS_TRANSCRIPT: SEED_CTX_ID(110),
  PEDS_RAW_SUMMARY: SEED_CTX_ID(111),
  PEDS_AUDIO: SEED_CTX_ID(112),
  ER_AUDIO: SEED_CTX_ID(120),
  // --- Reserved (ID allocated, not yet seeded in 09-consultation.ts) ---
  CARD_REVISIT_TRANSCRIPT: SEED_CTX_ID(13),
  SURG_RAW_SUMMARY: SEED_CTX_ID(23),
  BREN_TRANSCRIPT: SEED_CTX_ID(40),
  BREN_RAW_SUMMARY: SEED_CTX_ID(41),
  RHEUM_TRANSCRIPT: SEED_CTX_ID(50),
  RHEUM_RAW_SUMMARY: SEED_CTX_ID(51),
  RHEUM_REVISIT_TRANSCRIPT: SEED_CTX_ID(52),
  HEME_TRANSCRIPT: SEED_CTX_ID(60),
  DERM_TRANSCRIPT: SEED_CTX_ID(70),
  DIET_TRANSCRIPT: SEED_CTX_ID(80),
  NEPH_TRANSCRIPT: SEED_CTX_ID(90),
  SONC_TRANSCRIPT: SEED_CTX_ID(100),
  // Historical case notes for DNA testing (doctor Smith - GEN)
  DNA_CASE_NOTE_SMITH_1: SEED_CTX_ID(200),
  DNA_CASE_NOTE_SMITH_2: SEED_CTX_ID(201),
  DNA_CASE_NOTE_SMITH_3: SEED_CTX_ID(202),
  DNA_CASE_NOTE_SMITH_4: SEED_CTX_ID(203),
  DNA_CASE_NOTE_SMITH_5: SEED_CTX_ID(204),
  // Historical case notes for DNA testing (doctor Patel - SURG)
  DNA_CASE_NOTE_PATEL_1: SEED_CTX_ID(210),
  DNA_CASE_NOTE_PATEL_2: SEED_CTX_ID(211),
  DNA_CASE_NOTE_PATEL_3: SEED_CTX_ID(212),
  DNA_CASE_NOTE_PATEL_4: SEED_CTX_ID(213),
  DNA_CASE_NOTE_PATEL_5: SEED_CTX_ID(214),
  // Historical case notes for DNA testing (doctor Doe - CARD)
  DNA_CASE_NOTE_DOE_1: SEED_CTX_ID(220),
  DNA_CASE_NOTE_DOE_2: SEED_CTX_ID(221),
  DNA_CASE_NOTE_DOE_3: SEED_CTX_ID(222),
  DNA_CASE_NOTE_DOE_4: SEED_CTX_ID(223),
  DNA_CASE_NOTE_DOE_5: SEED_CTX_ID(224),
  // --- Customer-tenant transcripts (seeded in 09-consultation.ts) ---
  // 4th UUID group encodes the customer tenant (0001 ArcaAI).
  ARCAAI_GEN_NEW_TRANSCRIPT: '91000000-0000-0000-0001-000000000001',
  ARCAAI_GEN_REVISIT_TRANSCRIPT: '91000000-0000-0000-0001-000000000002',
} as const;

export const SEED_SUMMARY_META_IDS = {
  GEN_SUMMARY: '92000000-0000-0000-0000-000000000001',
  SURG_SUMMARY: '92000000-0000-0000-0000-000000000002',
  BREN_SUMMARY: '92000000-0000-0000-0000-000000000003',
  RHEUM_SUMMARY: '92000000-0000-0000-0000-000000000004',
  PEDS_SUMMARY: '92000000-0000-0000-0000-000000000005',
} as const;

export const SEED_AUDIO_RECORDING_IDS = {
  GEN_AUDIO: '93000000-0000-0000-0000-000000000001',
  SURG_AUDIO: '93000000-0000-0000-0000-000000000002',
  PEDS_AUDIO: '93000000-0000-0000-0000-000000000003',
  ER_AUDIO: '93000000-0000-0000-0000-000000000004',
} as const;

// =============================================================================
// USER VOICE PROFILES
//
// Deterministic voice-enrollment rows for the two primary seed doctors so the
// Voice Profile playground, the active-profile diarization seeding, and the
// `voiceProfileSeeded` indicator are demonstrable out-of-the-box. The embedding
// column is pgvector `vector(256)` (Unsupported by the Prisma client), so the
// rows are written with raw SQL in 91-user.ts. One ACTIVE + one inactive per
// doctor — the DB enforces at most one active per user via a partial unique
// index, so exactly one id per doctor carries `isActive: true`.
// =============================================================================

export const SEED_VOICE_PROFILE_IDS = {
  DOCTOR_ACTIVE: '97000000-0000-0000-0000-000000000001',
  DOCTOR_INACTIVE: '97000000-0000-0000-0000-000000000002',
  DOCTOR2_ACTIVE: '97000000-0000-0000-0000-000000000003',
  DOCTOR2_INACTIVE: '97000000-0000-0000-0000-000000000004',
  // One ACTIVE enrollment for the ArcaAI customer-tenant
  // doctor so voice-enrollment demos are populated for the customer tenant,
  // not just the Global-tenant doctors above.
  ARCAAI_DOCTOR_ACTIVE: '97000000-0000-0000-0001-000000000001',
} as const;

// =============================================================================
// TRANSCRIPTION JOBS
// =============================================================================
// ASR job-queue rows across the full status lifecycle so the admin "jobs"
// views and EU analytics are populated. The 4th UUID group encodes the owning
// tenant (0000=Global/SEED, 0001=ArcaAI); every row references a real seeded
// ASR pipeline (FK) and a real seeded consultation (soft ref) in the SAME
// tenant. Idempotent upsert-by-id.
// =============================================================================

export const SEED_TRANSCRIPTION_JOB_IDS = {
  // Global customer tenant (SEED_TENANT_ID) — full lifecycle coverage.
  GEN_COMPLETED: '98000000-0000-0000-0000-000000000001',
  NEUR_PROCESSING: '98000000-0000-0000-0000-000000000002',
  ER_QUEUED: '98000000-0000-0000-0000-000000000003',
  CARD_FAILED: '98000000-0000-0000-0000-000000000004',
  // ArcaAI customer tenant — at least one completed + one queued.
  ARCAAI_COMPLETED: '98000000-0000-0000-0001-000000000001',
  ARCAAI_QUEUED: '98000000-0000-0000-0001-000000000002',
} as const;

// =============================================================================
// CONTEXT ITEM VERSIONS (for summary edit history)
// =============================================================================

export const SEED_CONTEXT_VERSION_IDS = {
  // GEN_COMPLETED — raw summary edit history (v1 initial AI, v2 doctor correction)
  GEN_SUMMARY_V1: '94000000-0000-0000-0000-000000000001',
  GEN_SUMMARY_V2: '94000000-0000-0000-0000-000000000002',
  // GEN_COMPLETED — modified summary (v1 initial user edit)
  GEN_MODIFIED_SUMMARY_V1: '94000000-0000-0000-0000-000000000003',
  // GEN_COMPLETED — transcript (v1 initial)
  GEN_TRANSCRIPT_V1: '94000000-0000-0000-0000-000000000004',
  // GEN_COMPLETED — case note (v1 initial)
  GEN_CASE_NOTE_V1: '94000000-0000-0000-0000-000000000005',
  // GEN_COMPLETED — pre-summary (v1 initial)
  GEN_PRE_SUMMARY_V1: '94000000-0000-0000-0000-000000000006',
  // CARD_NEW — worknote edit history (v1 initial, v2 addendum)
  CARD_WORKNOTE_V1: '94000000-0000-0000-0000-000000000010',
  CARD_WORKNOTE_V2: '94000000-0000-0000-0000-000000000011',
  // CARD_NEW — transcript (v1 initial)
  CARD_TRANSCRIPT_V1: '94000000-0000-0000-0000-000000000012',
  // CARD_NEW — pre-summary (v1 initial)
  CARD_PRE_SUMMARY_V1: '94000000-0000-0000-0000-000000000013',
  // SURG_NEW — case note edit history (v1 initial, v2 post-op addendum)
  SURG_CASE_NOTE_V1: '94000000-0000-0000-0000-000000000020',
  SURG_CASE_NOTE_V2: '94000000-0000-0000-0000-000000000021',
  // SURG_NEW — transcript (v1 initial)
  SURG_TRANSCRIPT_V1: '94000000-0000-0000-0000-000000000022',
  // PEDS_COMPLETED — raw summary (v1 initial)
  PEDS_SUMMARY_V1: '94000000-0000-0000-0000-000000000030',
  // PEDS_COMPLETED — transcript (v1 initial)
  PEDS_TRANSCRIPT_V1: '94000000-0000-0000-0000-000000000031',
} as const;

// =============================================================================
// NAMED ENTITIES (NER results)
// =============================================================================

export const SEED_NAMED_ENTITY_IDS = {
  GEN_MED_AMOXICILLIN: '95000000-0000-0000-0000-000000000001',
  GEN_MED_PARACETAMOL: '95000000-0000-0000-0000-000000000002',
  GEN_COND_PNEUMONIA: '95000000-0000-0000-0000-000000000003',
  GEN_PROC_CHEST_XRAY: '95000000-0000-0000-0000-000000000004',
  GEN_ANAT_RIGHT_LOWER_LOBE: '95000000-0000-0000-0000-000000000005',
  PEDS_MED_AMOXICILLIN: '95000000-0000-0000-0000-000000000006',
  PEDS_COND_OTITIS_MEDIA: '95000000-0000-0000-0000-000000000007',
  PEDS_ANAT_TYMPANIC_MEMBRANE: '95000000-0000-0000-0000-000000000008',
} as const;

// =============================================================================
// GLOBAL SETTINGS (per-tenant general, feature-flags, stt)
// =============================================================================

export const SEED_GLOBAL_SETTING_IDS = {
  // ArcaAI — general
  ARCAAI_MAX_CONCURRENT_SESSIONS: '85000000-0000-0000-0001-000000000001',
  ARCAAI_DEFAULT_LANGUAGE: '85000000-0000-0000-0001-000000000002',
  ARCAAI_SESSION_TIMEOUT: '85000000-0000-0000-0001-000000000003',
  // ArcaAI — feature-flags
  ARCAAI_FF_TRANSCRIPTION: '85000000-0000-0000-0001-000000000010',
  ARCAAI_FF_DNA_STYLE: '85000000-0000-0000-0001-000000000011',
  ARCAAI_FF_CROSS_CHAIN: '85000000-0000-0000-0001-000000000012',
  ARCAAI_FF_NER: '85000000-0000-0000-0001-000000000013',
  ARCAAI_FF_CODE_SWITCHING: '85000000-0000-0000-0001-000000000014',
  // ArcaAI — stt
  ARCAAI_STT_MODEL: '85000000-0000-0000-0001-000000000020',
  ARCAAI_STT_VAD: '85000000-0000-0000-0001-000000000021',
  // ArcaAI — smr Azure deployment-name (non-secret)
  // ARCAAI_SMR_PROVIDER (…030) / ARCAAI_SMR_MODEL (…031) /
  // ARCAAI_GUARDRAIL_* (…033-035) / ARCAAI_UX_SMR_PROVIDER_MODELS (…043)
  // retired (rows swept to DELETED); ids stay reserved — never reuse them.
  ARCAAI_SMR_AZURE_DEPLOYMENT: '85000000-0000-0000-0001-000000000032',
  // ArcaAI — ux-constants
  ARCAAI_UX_LOCAL_ASR_MODELS: '85000000-0000-0000-0001-000000000040',
  ARCAAI_UX_LOCAL_VAD_MODELS: '85000000-0000-0000-0001-000000000041',
  ARCAAI_UX_LOCAL_NOISE_SUPPRESSION_MODELS: '85000000-0000-0000-0001-000000000042',
  ARCAAI_UX_GUARDRAIL_PROVIDER_MODELS: '85000000-0000-0000-0001-000000000044',

  // Global tenant — general
  GLOBAL_MAX_CONCURRENT_SESSIONS: '85000000-0000-0000-0000-000000000001',
  GLOBAL_DEFAULT_LANGUAGE: '85000000-0000-0000-0000-000000000002',
  GLOBAL_SESSION_TIMEOUT: '85000000-0000-0000-0000-000000000003',
  // Global tenant — feature-flags
  GLOBAL_FF_TRANSCRIPTION: '85000000-0000-0000-0000-000000000010',
  GLOBAL_FF_DNA_STYLE: '85000000-0000-0000-0000-000000000011',
  GLOBAL_FF_CROSS_CHAIN: '85000000-0000-0000-0000-000000000012',
  GLOBAL_FF_NER: '85000000-0000-0000-0000-000000000013',
  GLOBAL_FF_CODE_SWITCHING: '85000000-0000-0000-0000-000000000014',
  // Global tenant — stt
  GLOBAL_STT_MODEL: '85000000-0000-0000-0000-000000000020',
  GLOBAL_STT_VAD: '85000000-0000-0000-0000-000000000021',
  // Global tenant — smr Azure deployment-name (non-secret)
  // GLOBAL_SMR_PROVIDER (…030) / GLOBAL_SMR_MODEL (…031) /
  // GLOBAL_GUARDRAIL_* (…033-035) / GLOBAL_UX_SMR_PROVIDER_MODELS (…043)
  // retired (rows swept to DELETED); ids stay reserved — never reuse them.
  GLOBAL_SMR_AZURE_DEPLOYMENT: '85000000-0000-0000-0000-000000000032',
  // Global tenant — ux-constants (static model lists for UI dropdowns)
  GLOBAL_UX_LOCAL_ASR_MODELS: '85000000-0000-0000-0000-000000000040',
  GLOBAL_UX_LOCAL_VAD_MODELS: '85000000-0000-0000-0000-000000000041',
  GLOBAL_UX_LOCAL_NOISE_SUPPRESSION_MODELS: '85000000-0000-0000-0000-000000000042',
  GLOBAL_UX_GUARDRAIL_PROVIDER_MODELS: '85000000-0000-0000-0000-000000000044',
  GLOBAL_LOCKED_CONFIG_PATHS: '85000000-0000-0000-0000-000000000050',

  // Consultation sharing feature flag
  GLOBAL_FF_CONSULTATION_SHARING: '85000000-0000-0000-0000-000000000015',
  ARCAAI_FF_CONSULTATION_SHARING: '85000000-0000-0000-0001-000000000015',

  ARCAAI_LOCKED_CONFIG_PATHS: '85000000-0000-0000-0001-000000000050',

  // Per-tenant admin-console menu-order default
  // (namespace `arcaai-admin`, key `menuOrder`). Seeds the TENANT tier of the
  // resolver's USER → TENANT → DEFAULT precedence. Suffix `051` mirrors the
  // `050` locked-config-paths numbering; the 4th UUID group encodes the tenant.
  GLOBAL_ADMIN_MENU_ORDER: '85000000-0000-0000-0000-000000000051',
  ARCAAI_ADMIN_MENU_ORDER: '85000000-0000-0000-0001-000000000051',

  // Platform capability for local raw-stream dual-capture. A single
  // `locked` row owned by SYSTEM_TENANT_ID (the reserved platform tenant). The
  // 4th UUID group `0002` is a fresh system-tenant block (roles use `0000`,
  // policies `0001`). Read flat-by-key from the AppSettings boot cache.
  SYSTEM_FF_LOCAL_RAW_CAPTURE: '00000000-0000-0000-0002-000000000001',

  // Platform controls for the nightly SYSTEM-template resync sweep.
  // Same `0002` system-tenant block as the capability flag above; read flat
  // by key from the AppSettings boot cache.
  SYSTEM_PIPELINE_TEMPLATE_RESYNC_ENABLED: '00000000-0000-0000-0002-000000000002',
  SYSTEM_PIPELINE_TEMPLATE_RESYNC_CRON: '00000000-0000-0000-0002-000000000003',

  // Platform controls for the nightly SYSTEM agent-library resync sweep
  // (TASK-548). Same `0002` system-tenant block; read flat by key from the
  // AppSettings boot cache.
  SYSTEM_AGENT_TEMPLATE_RESYNC_ENABLED: '00000000-0000-0000-0002-000000000004',
  SYSTEM_AGENT_TEMPLATE_RESYNC_CRON: '00000000-0000-0000-0002-000000000005',

  // DB-backed rate-limit config (platform tenant only; gateway-wide).
  RATE_LIMIT_ENABLED: '85000000-0000-0000-0000-000000000300',
  RATE_LIMIT_TIER_DEFAULT_LIMIT: '85000000-0000-0000-0000-000000000301',
  RATE_LIMIT_TIER_DEFAULT_TTL: '85000000-0000-0000-0000-000000000302',
  RATE_LIMIT_TIER_STRICT_LIMIT: '85000000-0000-0000-0000-000000000303',
  RATE_LIMIT_TIER_STRICT_TTL: '85000000-0000-0000-0000-000000000304',
  RATE_LIMIT_TIER_HEAVY_LIMIT: '85000000-0000-0000-0000-000000000305',
  RATE_LIMIT_TIER_HEAVY_TTL: '85000000-0000-0000-0000-000000000306',
  RATE_LIMIT_TIER_RELAXED_LIMIT: '85000000-0000-0000-0000-000000000307',
  RATE_LIMIT_TIER_RELAXED_TTL: '85000000-0000-0000-0000-000000000308',

  // Entitlements enforcement kill-switch (platform tenant only).
  // Seeded OFF (Q9); flip per-env to turn quota/feature enforcement on.
  ENTITLEMENTS_ENABLED: '85000000-0000-0000-0000-000000000400',

  // TASK-615 WS-H — TenantUsageMeter reconcile-sweep kill-switch (platform
  // tenant only). Same `0400` block as ENTITLEMENTS_ENABLED; seeded OFF by
  // default, env-driven ON for a fresh DEV/STAGING database (OQ3) via
  // METERING_RECONCILE_ENABLED_DEFAULT — mirrors ENTITLEMENTS_ENABLED_DEFAULT.
  METERING_RECONCILE_ENABLED: '85000000-0000-0000-0000-000000000401',
} as const;

// =============================================================================
// PLAN ENTITLEMENTS (platform-wide per-plan default matrix)
// =============================================================================
// One row per TenantPlan (the `plan` column is @unique). NOT tenant-scoped —
// a platform reference table like Role/Permission. Values mirror
// packages/applications/src/services/entitlements/entitlements.constants.ts
// (PLAN_ENTITLEMENT_DEFAULTS) — kept in sync manually (the database package
// must not depend on @arcaai/applications).
// =============================================================================

export const SEED_PLAN_ENTITLEMENT_IDS = {
  STARTER: 'B0000000-0000-0000-0000-000000000001',
  TRIAL: 'B0000000-0000-0000-0000-000000000002',
  PRO: 'B0000000-0000-0000-0000-000000000003',
  ENTERPRISE: 'B0000000-0000-0000-0000-000000000004',
} as const;

// =============================================================================
// AUDIT LOG ENTRIES
// =============================================================================

export const SEED_AUDIT_LOG_IDS = {
  LOGIN_SUPER_ADMIN: 'A0000000-0000-0000-0000-000000000001',
  LOGIN_DOCTOR: 'A0000000-0000-0000-0000-000000000002',
  CREATE_USER_NURSE: 'A0000000-0000-0000-0000-000000000003',
  ASSIGN_ROLE_DOCTOR: 'A0000000-0000-0000-0000-000000000004',
  CREATE_APIKEY: 'A0000000-0000-0000-0000-000000000005',
  CREATE_CONSULTATION: 'A0000000-0000-0000-0000-000000000006',
  UPDATE_CONSULTATION_STATUS: 'A0000000-0000-0000-0000-000000000007',
  GENERATE_SUMMARY: 'A0000000-0000-0000-0000-000000000008',
  EDIT_SUMMARY: 'A0000000-0000-0000-0000-000000000009',
  REOPEN_CONSULTATION: 'A0000000-0000-0000-0000-000000000010',
  // Per-customer-tenant audit logs
  ARCAAI_LOGIN_ADMIN: 'A0000000-0000-0000-0001-000000000001',
  ARCAAI_CREATE_DEPT: 'A0000000-0000-0000-0001-000000000002',
  ARCAAI_CREATE_CONSULTATION: 'A0000000-0000-0000-0001-000000000003',
  ARCAAI_UPDATE_SETTINGS: 'A0000000-0000-0000-0001-000000000004',
  ARCAAI_ASSIGN_ROLE: 'A0000000-0000-0000-0001-000000000005',
} as const;

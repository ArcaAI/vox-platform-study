import * as bcryptjs from 'bcryptjs';
import type { CorePrismaClient } from '../../../client';
import { ValueType } from '../../../generated/core-prisma-client/client.js';
import {
  SYSTEM_USER_ID,
  SEED_TENANT_ID,
  SEED_CUSTOMER_TENANT_IDS,
  SEED_USER_IDS,
  SEED_DEPARTMENT_IDS,
  SYSTEM_TENANT_ID,
  SEED_VOICE_PROFILE_IDS,
} from './00-constants';

/**
 * User Seed Data
 *
 * Creates default users with role assignments for the HOPE platform.
 *
 * User Structure:
 * - username: Unique login identifier
 * - password: Hashed password (default: password123)
 * - roleNames: Array of role names to assign
 * - tenantId: Tenant scope (use SYSTEM_TENANT_ID for platform-wide users
 *             such as the System service account or the global admins; NULL
 *             is no longer accepted)
 * - profile: User profile information
 */

/**
 * Primary department (by code) for each non-exempt seeded user.
 *
 * A non-exempt user must belong to a tenant via both a role
 * AND a department, so every seeded user that is not exempt is given a primary
 * `UserDepartment` in its own tenant. Codes resolve to a `Department` row in the
 * user's `tenantId` (the Global tenant for clinical users; the per-customer GEN
 * departments for the tenant admins). Exempt users — service accounts and the
 * platform `super_admin` (system tenant) — are intentionally omitted.
 */
export const PRIMARY_DEPARTMENT_CODE_BY_USERNAME: Record<string, string> = {
  tenant_admin: 'GEN',
  doctor: 'GEN',
  doctor2: 'CARD',
  department_head: 'GEN',
  nurse: 'GEN',
  senior_nurse: 'GEN',
  nurse_card: 'CARD',
  nurse_med: 'MED',
  doctor_surgery: 'SURG',
  doctor_neuro: 'NEUR',
  doctor_peds: 'PEDS',
  doctor_er: 'ER',
  doctor_bren: 'BREN',
  doctor_rheum: 'RHEUM',
  doctor_heme: 'HEME',
  doctor_derm: 'DERM',
  doctor_diet: 'DIET',
  doctor_neph: 'NEPH',
  doctor_sonc: 'SONC',
  doctor_med: 'MED',
  arcaai_admin: 'GEN',
  // Per-customer-tenant impersonatable clinical users.
  arcaai_doctor: 'GEN',
  arcaai_nurse: 'GEN',
  // One resident DOCTOR per remaining ArcaAI clinical department (arcaai_doctor
  // covers GEN). Codes resolve to the ArcaAI-tenant department by (tenantId, code).
  arcaai_doctor_surg: 'SURG',
  arcaai_doctor_rheum: 'RHEUM',
  arcaai_doctor_neur: 'NEUR',
  arcaai_doctor_orth: 'ORTH',
  arcaai_doctor_heme: 'HEME',
  arcaai_doctor_bren: 'BREN',
};

// =========================================================================
// Define users with their roles
// =========================================================================
// This seed creates users for the current healthcare-focused RBAC system.
// Available roles (7 total):
// - SUPER_ADMIN: Full system access (GLOBAL scope)
// - TENANT_ADMIN: Full tenant management
// - DOCTOR: Clinical role, owns consultations
// - NURSE: Read-only clinical support
// - SERVICE_ACCOUNT: API/integration access
// - DEPARTMENT_HEAD: Extends DOCTOR with delegation
// - SENIOR_NURSE: Extends NURSE with broader access
//
// Exported at module level (was local to seedUser) so the
// impersonation seed invariant can be asserted in unit tests. `seedUser` still
// iterates this list. Passwords are seeded via the upsert's `?? defaultPassword`
// fallback below, so each entry carries `password: null`.
// =========================================================================
export const SEED_USERS = [
  // =================================================================
  // SYSTEM ACCOUNT
  // =================================================================
  {
    id: SYSTEM_USER_ID,
    username: '__system__',
    password: null,
    isServiceAccount: true,
    roleNames: ['SERVICE_ACCOUNT'],
    tenantId: SYSTEM_TENANT_ID,
    profile: {
      firstName: 'System',
      lastName: 'Account',
      email: 'system@arcaai.internal',
      phone: null,
    },
    tags: ['system', 'service'],
    lastLoginAt: null,
    lastActiveAt: null,
  },

  // =================================================================
  // SYSTEM ADMINISTRATORS
  // =================================================================
  {
    // The `super_admin` USERNAME is a stable login identifier
    // (dev logins + e2e helpers depend on it); its ROLE is SUPER_ADMIN
    // (renamed from GLOBAL_ADMIN by TASK-707, D8 — before that rename, the
    // legacy SUPER_ADMIN role had been consolidated away by TASK-417).
    id: SEED_USER_IDS.SUPER_ADMIN,
    username: 'super_admin',
    password: null,
    isServiceAccount: false,
    roleNames: ['SUPER_ADMIN'],
    tenantId: SYSTEM_TENANT_ID, // Platform-wide access (system tenant)
    profile: {
      firstName: 'Super',
      lastName: 'Admin',
      email: 'super.admin@example.com',
      phone: '+1234567890',
    },
    tags: ['admin', 'system'],
    lastLoginAt: new Date(),
    lastActiveAt: new Date(),
  },
  {
    // Elevated platform-wide "global admin"; carries the
    // canonical elevated role (tenant-guards.ELEVATED_ROLES, renamed
    // SUPER_ADMIN by TASK-707, D8). Lives
    // on the SYSTEM tenant so it is membership-exempt (no department
    // required) exactly like super_admin, and works cross-tenant. This
    // user's own key/username stay `GLOBAL_ADMIN`/`global_admin` — see the
    // note on `SEED_USER_IDS.GLOBAL_ADMIN` in 00-constants.ts for why.
    id: SEED_USER_IDS.GLOBAL_ADMIN,
    username: 'global_admin',
    password: null,
    isServiceAccount: false,
    roleNames: ['SUPER_ADMIN'],
    tenantId: SYSTEM_TENANT_ID,
    profile: {
      firstName: 'Global',
      lastName: 'Admin',
      email: 'global.admin@example.com',
      phone: '+1234567899',
    },
    tags: ['admin', 'system', 'global'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.TENANT_ADMIN,
    username: 'tenant_admin',
    password: null,
    isServiceAccount: false,
    roleNames: ['TENANT_ADMIN'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Tenant',
      lastName: 'Admin',
      email: 'tenant.admin@example.com',
      phone: '+1234567891',
    },
    tags: ['admin', 'tenant'],
    lastLoginAt: null,
    lastActiveAt: null,
  },

  // =================================================================
  // HEALTHCARE ROLES - Primary test users
  // =================================================================
  {
    id: SEED_USER_IDS.DOCTOR,
    username: 'doctor',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'John',
      lastName: 'Smith',
      email: 'doctor.smith@example.com',
      phone: '+1234567810',
    },
    tags: ['clinical', 'doctor'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.DOCTOR2,
    username: 'doctor2',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'doctor.doe@example.com',
      phone: '+1234567811',
    },
    tags: ['clinical', 'doctor'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.DEPT_HEAD,
    username: 'department_head',
    password: null,
    isServiceAccount: false,
    roleNames: ['DEPARTMENT_HEAD'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Michael',
      lastName: 'Johnson',
      email: 'dept.head@example.com',
      phone: '+1234567812',
    },
    tags: ['clinical', 'doctor', 'department-head'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.NURSE,
    username: 'nurse',
    password: null,
    isServiceAccount: false,
    roleNames: ['NURSE'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Sarah',
      lastName: 'Williams',
      email: 'nurse.williams@example.com',
      phone: '+1234567813',
    },
    tags: ['clinical', 'nurse'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.SENIOR_NURSE,
    username: 'senior_nurse',
    password: null,
    isServiceAccount: false,
    roleNames: ['SENIOR_NURSE'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Emily',
      lastName: 'Brown',
      email: 'senior.nurse@example.com',
      phone: '+1234567814',
    },
    tags: ['clinical', 'nurse', 'senior'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.NURSE_CARD,
    username: 'nurse_card',
    password: null,
    isServiceAccount: false,
    roleNames: ['NURSE'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Tom',
      lastName: 'Brown',
      email: 'nurse.brown@example.com',
      phone: '+1234567819',
    },
    tags: ['clinical', 'nurse', 'cardiology'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.NURSE_MED,
    username: 'nurse_med',
    password: null,
    isServiceAccount: false,
    roleNames: ['NURSE'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Amy',
      lastName: 'Lee',
      email: 'nurse.lee@example.com',
      phone: '+1234567820',
    },
    tags: ['clinical', 'nurse', 'medicine'],
    lastLoginAt: null,
    lastActiveAt: null,
  },

  // =================================================================
  // HEALTHCARE ROLES - Department-specific doctors
  // =================================================================
  {
    id: SEED_USER_IDS.DOCTOR_SURGERY,
    username: 'doctor_surgery',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Raj',
      lastName: 'Patel',
      email: 'doctor.patel@example.com',
      phone: '+1234567815',
    },
    tags: ['clinical', 'doctor', 'surgery'],
    lastLoginAt: new Date('2026-02-20T08:00:00Z'),
    lastActiveAt: new Date('2026-02-20T16:30:00Z'),
  },
  {
    id: SEED_USER_IDS.DOCTOR_NEURO,
    username: 'doctor_neuro',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Lisa',
      lastName: 'Chen',
      email: 'doctor.chen@example.com',
      phone: '+1234567816',
    },
    tags: ['clinical', 'doctor', 'neurology'],
    lastLoginAt: new Date('2026-02-21T09:00:00Z'),
    lastActiveAt: new Date('2026-02-21T17:00:00Z'),
  },
  {
    id: SEED_USER_IDS.DOCTOR_PEDS,
    username: 'doctor_peds',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Maria',
      lastName: 'Garcia',
      email: 'doctor.garcia@example.com',
      phone: '+1234567817',
    },
    tags: ['clinical', 'doctor', 'pediatrics'],
    lastLoginAt: new Date('2026-02-22T07:30:00Z'),
    lastActiveAt: new Date('2026-02-22T15:00:00Z'),
  },
  {
    id: SEED_USER_IDS.DOCTOR_ER,
    username: 'doctor_er',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'James',
      lastName: 'Wilson',
      email: 'doctor.wilson@example.com',
      phone: '+1234567818',
    },
    tags: ['clinical', 'doctor', 'emergency'],
    lastLoginAt: new Date('2026-02-23T22:00:00Z'),
    lastActiveAt: new Date('2026-02-24T06:00:00Z'),
  },
  {
    id: SEED_USER_IDS.DOCTOR_BREN,
    username: 'doctor_bren',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Priya',
      lastName: 'Sharma',
      email: 'doctor.sharma@example.com',
      phone: '+1234567821',
    },
    tags: ['clinical', 'doctor', 'breast-endocrine'],
    lastLoginAt: new Date('2026-02-24T08:00:00Z'),
    lastActiveAt: new Date('2026-02-24T16:00:00Z'),
  },
  {
    id: SEED_USER_IDS.DOCTOR_RHEUM,
    username: 'doctor_rheum',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'David',
      lastName: 'Park',
      email: 'doctor.park@example.com',
      phone: '+1234567822',
    },
    tags: ['clinical', 'doctor', 'rheumatology'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.DOCTOR_HEME,
    username: 'doctor_heme',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Aisha',
      lastName: 'Khan',
      email: 'doctor.khan@example.com',
      phone: '+1234567823',
    },
    tags: ['clinical', 'doctor', 'hematology'],
    lastLoginAt: new Date('2026-02-23T09:00:00Z'),
    lastActiveAt: new Date('2026-02-23T17:30:00Z'),
  },
  {
    id: SEED_USER_IDS.DOCTOR_DERM,
    username: 'doctor_derm',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Carlos',
      lastName: 'Rivera',
      email: 'doctor.rivera@example.com',
      phone: '+1234567824',
    },
    tags: ['clinical', 'doctor', 'dermatology'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.DOCTOR_DIET,
    username: 'doctor_diet',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Mei',
      lastName: 'Lin',
      email: 'doctor.lin@example.com',
      phone: '+1234567825',
    },
    tags: ['clinical', 'doctor', 'dietetics'],
    lastLoginAt: new Date('2026-02-22T10:00:00Z'),
    lastActiveAt: new Date('2026-02-22T18:00:00Z'),
  },
  {
    id: SEED_USER_IDS.DOCTOR_NEPH,
    username: 'doctor_neph',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Omar',
      lastName: 'Hassan',
      email: 'doctor.hassan@example.com',
      phone: '+1234567826',
    },
    tags: ['clinical', 'doctor', 'nephrology'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.DOCTOR_SONC,
    username: 'doctor_sonc',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Elena',
      lastName: 'Volkov',
      email: 'doctor.volkov@example.com',
      phone: '+1234567827',
    },
    tags: ['clinical', 'doctor', 'surgical-oncology'],
    lastLoginAt: new Date('2026-02-21T07:00:00Z'),
    lastActiveAt: new Date('2026-02-21T15:30:00Z'),
  },
  {
    id: SEED_USER_IDS.DOCTOR_MED,
    username: 'doctor_med',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Thomas',
      lastName: 'Wright',
      email: 'doctor.wright@example.com',
      phone: '+1234567828',
    },
    tags: ['clinical', 'doctor', 'medicine'],
    lastLoginAt: new Date('2026-02-24T08:30:00Z'),
    lastActiveAt: new Date('2026-02-24T17:00:00Z'),
  },

  // =================================================================
  // MULTI-TENANT ADMINS
  // =================================================================
  {
    id: SEED_USER_IDS.ARCAAI_ADMIN,
    username: 'arcaai_admin',
    password: null,
    isServiceAccount: false,
    roleNames: ['TENANT_ADMIN'],
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    profile: {
      firstName: 'ArcaAI',
      lastName: 'Administrator',
      email: 'admin@arcaai.com',
      phone: '+6591234567',
    },
    tags: ['admin', 'tenant', 'arcaai'],
    lastLoginAt: new Date('2026-02-24T10:00:00Z'),
    lastActiveAt: new Date('2026-02-24T10:00:00Z'),
  },

  // =================================================================
  // CUSTOMER-TENANT CLINICAL USERS
  // =================================================================
  // One impersonatable DOCTOR + NURSE per customer tenant so the tenant
  // admin (confined to its own tenant by the backend C-1 cross-tenant
  // block) has non-admin clinical users to impersonate. Each maps to its
  // tenant's GEN department via PRIMARY_DEPARTMENT_CODE_BY_USERNAME.
  // =================================================================
  {
    id: SEED_USER_IDS.ARCAAI_DOCTOR,
    username: 'arcaai_doctor',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    profile: {
      firstName: 'Olivia',
      lastName: 'Tan',
      email: 'doctor.tan@arcaai.com',
      phone: '+6591234601',
    },
    tags: ['clinical', 'doctor', 'arcaai'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.ARCAAI_NURSE,
    username: 'arcaai_nurse',
    password: null,
    isServiceAccount: false,
    roleNames: ['NURSE'],
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    profile: {
      firstName: 'Wei',
      lastName: 'Lim',
      email: 'nurse.lim@arcaai.com',
      phone: '+6591234602',
    },
    tags: ['clinical', 'nurse', 'arcaai'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  // -----------------------------------------------------------------
  // One resident DOCTOR per remaining ArcaAI clinical department, so
  // every ArcaAI department (Surgery, Rheumatology, Neurology,
  // Orthopedics, Hematology, Breast & Endocrine) has a clinician on
  // day-1. arcaai_doctor (Olivia Tan, above) covers General Medicine.
  // Primary department is resolved by (tenantId, code) through
  // PRIMARY_DEPARTMENT_CODE_BY_USERNAME.
  // -----------------------------------------------------------------
  {
    id: SEED_USER_IDS.ARCAAI_DOCTOR_SURG,
    username: 'arcaai_doctor_surg',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    profile: {
      firstName: 'Marcus',
      lastName: 'Ng',
      email: 'doctor.ng@arcaai.com',
      phone: '+6591234603',
    },
    tags: ['clinical', 'doctor', 'arcaai', 'surgery'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.ARCAAI_DOCTOR_RHEUM,
    username: 'arcaai_doctor_rheum',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    profile: {
      firstName: 'Priya',
      lastName: 'Nair',
      email: 'doctor.nair@arcaai.com',
      phone: '+6591234604',
    },
    tags: ['clinical', 'doctor', 'arcaai', 'rheumatology'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.ARCAAI_DOCTOR_NEUR,
    username: 'arcaai_doctor_neur',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    profile: {
      firstName: 'Daniel',
      lastName: 'Wong',
      email: 'doctor.wong@arcaai.com',
      phone: '+6591234605',
    },
    tags: ['clinical', 'doctor', 'arcaai', 'neurology'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.ARCAAI_DOCTOR_ORTH,
    username: 'arcaai_doctor_orth',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    profile: {
      firstName: 'Rachel',
      lastName: 'Goh',
      email: 'doctor.goh@arcaai.com',
      phone: '+6591234606',
    },
    tags: ['clinical', 'doctor', 'arcaai', 'orthopedics'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.ARCAAI_DOCTOR_HEME,
    username: 'arcaai_doctor_heme',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    profile: {
      firstName: 'Arjun',
      lastName: 'Rao',
      email: 'doctor.rao@arcaai.com',
      phone: '+6591234607',
    },
    tags: ['clinical', 'doctor', 'arcaai', 'hematology'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
  {
    id: SEED_USER_IDS.ARCAAI_DOCTOR_BREN,
    username: 'arcaai_doctor_bren',
    password: null,
    isServiceAccount: false,
    roleNames: ['DOCTOR'],
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    profile: {
      firstName: 'Sophia',
      lastName: 'Lee',
      email: 'doctor.lee@arcaai.com',
      phone: '+6591234608',
    },
    tags: ['clinical', 'doctor', 'arcaai', 'breast_endocrine'],
    lastLoginAt: null,
    lastActiveAt: null,
  },

  // =================================================================
  // SERVICE ACCOUNTS
  // =================================================================
  {
    id: SEED_USER_IDS.SERVICE_ACCOUNT,
    username: 'service_account',
    password: null,
    isServiceAccount: true,
    roleNames: ['SERVICE_ACCOUNT'],
    tenantId: SEED_TENANT_ID,
    profile: {
      firstName: 'Integration',
      lastName: 'Service',
      email: 'service@example.com',
      phone: null,
    },
    tags: ['service', 'integration'],
    lastLoginAt: null,
    lastActiveAt: null,
  },
];

// =========================================================================
// USER VOICE PROFILES
// =========================================================================
// Deterministic voice-enrollment rows for the two primary seed doctors so the
// Voice Profile playground, active-profile diarization seeding, and the
// `voiceProfileSeeded` indicator are demonstrable out-of-the-box.
//
// The `embedding` column is pgvector `vector(256)` — `Unsupported(...)` in the
// Prisma schema, so the Prisma client cannot write it. The upsert loop in
// `seedUser` therefore uses `$executeRawUnsafe` with a `[v1,…,v256]` vector
// literal (mirrors `UserVoiceProfileRepository.createWithEmbedding`).
// =========================================================================

/**
 * pgvector dimension of `core."UserVoiceProfile"."embedding"`. MUST match the
 * `vector(N)` in the migration and `EXPECTED_EMBEDDING_DIM` in the backend
 * `VoiceProfileService` (256-d wespeaker/WavLM speaker embedding).
 */
export const VOICE_EMBEDDING_DIM = 256;

/** Speaker-embedding model id used for the demo rows (matches the backend default). */
const VOICE_PROFILE_MODEL_ID = 'pyannote/wespeaker-voxceleb-resnet34-LM';

/**
 * Build a DETERMINISTIC placeholder speaker embedding of length
 * {@link VOICE_EMBEDDING_DIM}. A fixed trig pattern keyed by `seed` makes the
 * vector byte-stable across re-seeds; the result is L2-normalized to unit
 * length to mimic a real wespeaker/WavLM `*-sv` embedding. This is NOT a real
 * biometric — it only exists so the playground has data to render.
 */
function makeDeterministicEmbedding(seed: number): number[] {
  const raw: number[] = [];
  let mag = 0;
  for (let i = 0; i < VOICE_EMBEDDING_DIM; i++) {
    const x = Math.sin((i + 1) * 0.12345 + seed * 1.7) * Math.cos(seed + i * 0.031);
    raw.push(x);
    mag += x * x;
  }
  const norm = Math.sqrt(mag) || 1;
  return raw.map((x) => x / norm);
}

export interface SeedVoiceProfile {
  id: string;
  /** Enrollment tenant; voice-profile reads are tenant-scoped. */
  tenantId: string;
  userId: string;
  isActive: boolean;
  label: string;
  modelId: string;
  embedding: number[];
}

/**
 * One ACTIVE + one inactive profile per primary seed doctor. The DB enforces at
 * most one active profile per user (partial unique index), so exactly one row
 * per doctor carries `isActive: true`. Distinct embedding seeds keep each
 * profile's vector unique so cosine-similarity demos are meaningful.
 */
export const SEED_VOICE_PROFILES: SeedVoiceProfile[] = [
  {
    id: SEED_VOICE_PROFILE_IDS.DOCTOR_ACTIVE,
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.DOCTOR,
    isActive: true,
    label: 'Clinic mic (primary)',
    modelId: VOICE_PROFILE_MODEL_ID,
    embedding: makeDeterministicEmbedding(1),
  },
  {
    id: SEED_VOICE_PROFILE_IDS.DOCTOR_INACTIVE,
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.DOCTOR,
    isActive: false,
    label: 'Headset (backup)',
    modelId: VOICE_PROFILE_MODEL_ID,
    embedding: makeDeterministicEmbedding(2),
  },
  {
    id: SEED_VOICE_PROFILE_IDS.DOCTOR2_ACTIVE,
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.DOCTOR2,
    isActive: true,
    label: 'Clinic mic (primary)',
    modelId: VOICE_PROFILE_MODEL_ID,
    embedding: makeDeterministicEmbedding(3),
  },
  {
    id: SEED_VOICE_PROFILE_IDS.DOCTOR2_INACTIVE,
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.DOCTOR2,
    isActive: false,
    label: 'Old enrollment (2025)',
    modelId: VOICE_PROFILE_MODEL_ID,
    embedding: makeDeterministicEmbedding(4),
  },
  // One ACTIVE enrollment per customer-tenant doctor so the
  // voice-enrollment / diarization demos are populated for the ArcaAI
  // customer-tenant doctor, not just the Global-tenant doctors above. Distinct
  // embedding seeds keep each vector unique for cosine-similarity demos.
  {
    id: SEED_VOICE_PROFILE_IDS.ARCAAI_DOCTOR_ACTIVE,
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    userId: SEED_USER_IDS.ARCAAI_DOCTOR,
    isActive: true,
    label: 'Clinic mic (primary)',
    modelId: VOICE_PROFILE_MODEL_ID,
    embedding: makeDeterministicEmbedding(5),
  },
];

export const seedUser = async (client: CorePrismaClient) => {
  console.log('Seeding users...');

  const roles = await client.role.findMany();
  const roleMap = new Map<string, (typeof roles)[number]>(roles.map((r) => [r.name, r]));

  const hashPassword = async (password: string): Promise<string> => {
    const saltRounds = 10;
    return bcryptjs.hash(password, saltRounds);
  };

  // Default password for all seeded users
  const defaultPassword = await hashPassword('password123');

  // Create users and related records
  for (const userData of SEED_USERS) {
    try {
      // 1. Create User record
      const user = await client.user.upsert({
        where: { id: userData.id },
        update: {
          username: userData.username,
          password: userData.password ?? defaultPassword,
          isServiceAccount: userData.isServiceAccount,
          tags: userData.tags,
          lastLoginAt: userData.lastLoginAt,
          lastActiveAt: userData.lastActiveAt,
        },
        create: {
          id: userData.id,
          username: userData.username,
          password: userData.password ?? defaultPassword,
          isServiceAccount: userData.isServiceAccount,
          tags: userData.tags,
          lastLoginAt: userData.lastLoginAt,
          lastActiveAt: userData.lastActiveAt,
        },
      });

      // 2. Create UserProfile
      await client.userProfile.upsert({
        where: { userId: user.id },
        update: {
          firstName: userData.profile.firstName,
          lastName: userData.profile.lastName,
          email: userData.profile.email,
          phone: userData.profile.phone,
        },
        create: {
          userId: user.id,
          firstName: userData.profile.firstName,
          lastName: userData.profile.lastName,
          email: userData.profile.email,
          phone: userData.profile.phone,
        },
      });

      // 3. Assign Roles (new schema: 1:1 relationship with roleId)
      for (const roleName of userData.roleNames) {
        const role = roleMap.get(roleName);
        if (role) {
          const existingAssignment = await client.userRoleAssignment.findFirst({
            where: {
              userId: user.id,
              roleId: role.id,
              tenantId: userData.tenantId,
            },
          });

          if (!existingAssignment) {
            // Let Prisma auto-generate the ID to avoid conflicts
            await client.userRoleAssignment.create({
              data: {
                userId: user.id,
                roleId: role.id,
                tenantId: userData.tenantId,
              },
            });
            console.log(`  Assigned role "${roleName}" to user "${userData.username}"`);
          }
        } else {
          console.warn(`  Warning: Role "${roleName}" not found for user "${userData.username}"`);
        }
      }

      // 4. Assign a primary department (non-exempt users
      //    must belong to a tenant via both a role AND a department).
      //    Service accounts and platform/system-tenant users are exempt.
      const isMembershipExempt = userData.isServiceAccount || userData.tenantId === SYSTEM_TENANT_ID;
      const departmentCode = PRIMARY_DEPARTMENT_CODE_BY_USERNAME[userData.username];
      if (!isMembershipExempt && departmentCode) {
        const department = await client.department.findFirst({
          where: { tenantId: userData.tenantId, code: departmentCode },
        });
        if (department) {
          const existingDepartment = await client.userDepartment.findFirst({
            where: { userId: user.id, tenantId: userData.tenantId },
          });
          if (!existingDepartment) {
            await client.userDepartment.create({
              data: {
                userId: user.id,
                departmentId: department.id,
                tenantId: userData.tenantId,
                isPrimary: true,
              },
            });
            console.log(`  Assigned primary department "${departmentCode}" to user "${userData.username}"`);
          }
        } else {
          console.warn(`  Warning: Department "${departmentCode}" not found in tenant ${userData.tenantId} for user "${userData.username}"`);
        }
      }

      console.log(`Created user: ${userData.username}`);
    } catch (error) {
      console.error(`Error creating user ${userData.username}:`, error);
    }
  }

  // =========================================================================
  // User Voice Profiles
  // =========================================================================
  // `core."UserVoiceProfile"."embedding"` is pgvector `vector(256)`, declared
  // `Unsupported(...)` in the Prisma schema, so the Prisma client cannot write
  // it. We INSERT with raw SQL using a `[v1,…,v256]` vector literal (mirrors
  // `UserVoiceProfileRepository.createWithEmbedding`). `ON CONFLICT ("id") DO
  // UPDATE` keeps the seed idempotent — no destructive DELETE/TRUNCATE, and it
  // never introduces a second active row per user (partial unique index safe).
  console.log('Seeding user voice profiles...');
  const voiceProfileTimestamp = new Date('2026-02-20T08:00:00Z');
  for (const vp of SEED_VOICE_PROFILES) {
    if (!vp.embedding.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error(`Invalid embedding for voice profile ${vp.id}: all values must be finite numbers`);
    }
    const vectorStr = `[${vp.embedding.join(',')}]`;
    await client.$executeRawUnsafe(
      `INSERT INTO "core"."UserVoiceProfile"
                ("id", "tenantId", "userId", "embedding", "isActive", "label", "modelId",
                 "resourceStatus", "createdBy", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8::"core"."ResourceStatusType", $9, $10, $11)
             ON CONFLICT ("id") DO UPDATE SET
                "tenantId" = EXCLUDED."tenantId",
                "userId" = EXCLUDED."userId",
                "embedding" = EXCLUDED."embedding",
                "isActive" = EXCLUDED."isActive",
                "label" = EXCLUDED."label",
                "modelId" = EXCLUDED."modelId",
                "updatedAt" = EXCLUDED."updatedAt"`,
      vp.id,
      vp.tenantId,
      vp.userId,
      vectorStr,
      vp.isActive,
      vp.label,
      vp.modelId,
      'ENABLED',
      SYSTEM_USER_ID,
      voiceProfileTimestamp,
      voiceProfileTimestamp,
    );
  }
  console.log(`  Seeded ${SEED_VOICE_PROFILES.length} user voice profiles`);

  // =========================================================================
  // User Settings - General UI preferences
  // =========================================================================
  const generalUserSettings = [
    {
      id: '80000000-0000-0000-0000-000000000001',
      userId: SEED_USER_IDS.SUPER_ADMIN,
      name: 'Theme Preference',
      key: 'theme',
      value: 'dark',
      dataType: ValueType.String,
      namespace: 'ui',
    },
  ];

  for (const setting of generalUserSettings) {
    await client.userSettings.upsert({
      where: { id: setting.id },
      update: {
        // `value` omitted deliberately — a UserSettings value
        // is that user's own preference; a re-seed must not reset it.
        name: setting.name,
        key: setting.key,
        dataType: setting.dataType,
        namespace: setting.namespace,
      },
      create: {
        id: setting.id,
        userId: setting.userId,
        name: setting.name,
        key: setting.key,
        value: setting.value,
        dataType: setting.dataType,
        namespace: setting.namespace,
      },
    });
  }

  // =========================================================================
  // Tenant-wide Default Pipeline (GlobalSettings)
  // =========================================================================
  console.log('Seeding tenant-wide default pipeline setting...');

  // Point the Global tenant's `default-stt-pipeline` at the
  // Global tenant's OWN pipeline (06-stt GLOBAL_TENANT_ASR_PIPELINES) instead
  // of the SYSTEM-owned rows. SYSTEM pipelines are not shared-read into
  // customer tenants, so a SYSTEM value would be unreachable for Global
  // doctors; the Global-tenant pipeline lives in SEED_TENANT_ID and is both
  // listable and resolvable for them.
  //
  // Points the default at the Global tenant's resolvable
  // production-whisper-large-v3 pipeline (id …0401), rather than the CT2 int8
  // pipeline (…0403), whose model carries a non-resolving placeholder
  // sourceUri; the CT2 pipeline stays registered but must not be the default
  // until the artifact is published.
  // Since flipped to the ArcaAI ml-en GGUF fine-tune (…0417) — the generic
  // whisper-turbo GGUF (…0404) hallucinated on Malayalam when pinned to ml.
  await client.globalSetting.upsert({
    where: {
      GlobalSetting_tenantId_name_key_unique: {
        tenantId: SEED_TENANT_ID,
        name: 'stt-pipeline',
        key: 'default-stt-pipeline',
      },
    },
    update: {
      // `value` omitted deliberately. This setting selects the
      // live default ASR pipeline; writing it here force-repointed every
      // tenant's choice on each seed run. `defaultValue` still tracks the repo,
      // so the platform's recommendation moves without overriding a human's.
      defaultValue: '81000000-0000-0000-0001-000000000417',
      description: 'Default ASR pipeline for all doctors when using remote workflow mode',
    },
    create: {
      id: '82000000-0000-0000-0002-000000000100',
      tenantId: SEED_TENANT_ID,
      namespace: 'arcaai-sdk',
      name: 'stt-pipeline',
      key: 'default-stt-pipeline',
      value: '81000000-0000-0000-0001-000000000417',
      defaultValue: '81000000-0000-0000-0001-000000000417',
      dataType: ValueType.String,
      description: 'Default ASR pipeline for all doctors when using remote workflow mode',
    },
  });
  console.log('  Created tenant-wide default pipeline setting');

  // =========================================================================
  // SDK User Preferences - Workflow-Oriented Structure
  // Namespace: 'arcaai-sdk' (doctor-controlled preferences)
  // Namespace: 'arcaai-admin' (admin-controlled pipeline assignments)
  // =========================================================================
  console.log('Seeding SDK user preferences...');

  const sdkUserPreferences = [
    // =====================================================================
    // Doctor (John Smith) - Remote (backend) workflow — sane default.
    // localConfig below is retained so local STT is loadable if opted in.
    // =====================================================================
    {
      id: '81000000-0000-0000-0000-000000000001',
      userId: SEED_USER_IDS.DOCTOR,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000002',
      userId: SEED_USER_IDS.DOCTOR,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'en',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000003',
      userId: SEED_USER_IDS.DOCTOR,
      name: 'SDK Preference: dnaStyleId',
      key: 'dnaStyleId',
      value: 'clinical-concise-en',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000004',
      userId: SEED_USER_IDS.DOCTOR,
      name: 'SDK Preference: localConfig',
      key: 'localConfig',
      value: JSON.stringify({
        noiseCancellation: { modelId: 'rnnoise', level: 'high' },
        stt: { modelId: 'whisper-base' },
        vad: { modelId: 'silero-vad-v5', sensitivity: 0.6 },
        ner: { modelId: 'biomedical', autoExtract: true },
        diarization: { enabled: true, autoEnroll: true },
      }),
      dataType: ValueType.Json,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000005',
      userId: SEED_USER_IDS.DOCTOR,
      name: 'SDK Preference: custom',
      key: 'custom',
      value: JSON.stringify({
        autoSaveInterval: 30000,
        showWaveform: true,
        defaultTemplate: 'soap-note',
      }),
      dataType: ValueType.Json,
      namespace: 'arcaai-sdk',
    },

    // =====================================================================
    // Doctor2 (Jane Doe) - Remote workflow
    // Uses admin-assigned pipeline, Thai language
    // =====================================================================
    {
      id: '81000000-0000-0000-0000-000000000011',
      userId: SEED_USER_IDS.DOCTOR2,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000012',
      userId: SEED_USER_IDS.DOCTOR2,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'th',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000013',
      userId: SEED_USER_IDS.DOCTOR2,
      name: 'SDK Preference: dnaStyleId',
      key: 'dnaStyleId',
      value: 'clinical-detailed-th',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },

    // =====================================================================
    // Department Head (Michael Johnson) - Remote (backend) workflow, power user
    // All features enabled with custom shortcuts
    // =====================================================================
    {
      id: '81000000-0000-0000-0000-000000000021',
      userId: SEED_USER_IDS.DEPT_HEAD,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000022',
      userId: SEED_USER_IDS.DEPT_HEAD,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'en',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000023',
      userId: SEED_USER_IDS.DEPT_HEAD,
      name: 'SDK Preference: localConfig',
      key: 'localConfig',
      value: JSON.stringify({
        noiseCancellation: { modelId: 'rnnoise', level: 'high' },
        stt: { modelId: 'whisper-base' },
        vad: { modelId: 'silero-vad-v5', sensitivity: 0.7 },
        ner: { modelId: 'biomedical', autoExtract: true },
        diarization: { enabled: true, autoEnroll: true },
      }),
      dataType: ValueType.Json,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000024',
      userId: SEED_USER_IDS.DEPT_HEAD,
      name: 'SDK Preference: custom',
      key: 'custom',
      value: JSON.stringify({
        autoSaveInterval: 15000,
        showWaveform: true,
        showSpeakerLabels: true,
        defaultTemplate: 'comprehensive-note',
        enableShortcuts: true,
      }),
      dataType: ValueType.Json,
      namespace: 'arcaai-sdk',
    },

    // =====================================================================
    // Dr. Raj Patel (Surgery) - Remote workflow, English
    // =====================================================================
    {
      id: '81000000-0000-0000-0000-000000000041',
      userId: SEED_USER_IDS.DOCTOR_SURGERY,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000042',
      userId: SEED_USER_IDS.DOCTOR_SURGERY,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'en',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000043',
      userId: SEED_USER_IDS.DOCTOR_SURGERY,
      name: 'SDK Preference: primaryDepartmentId',
      key: 'primaryDepartmentId',
      value: SEED_DEPARTMENT_IDS.SURG,
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },

    // =====================================================================
    // Dr. Lisa Chen (Neurology) - Remote (backend) workflow, English
    // =====================================================================
    {
      id: '81000000-0000-0000-0000-000000000051',
      userId: SEED_USER_IDS.DOCTOR_NEURO,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000052',
      userId: SEED_USER_IDS.DOCTOR_NEURO,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'en',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000053',
      userId: SEED_USER_IDS.DOCTOR_NEURO,
      name: 'SDK Preference: primaryDepartmentId',
      key: 'primaryDepartmentId',
      value: SEED_DEPARTMENT_IDS.NEUR,
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },

    // =====================================================================
    // Dr. Maria Garcia (Pediatrics) - Remote (backend) workflow, Spanish
    // =====================================================================
    {
      id: '81000000-0000-0000-0000-000000000061',
      userId: SEED_USER_IDS.DOCTOR_PEDS,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000062',
      userId: SEED_USER_IDS.DOCTOR_PEDS,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'es',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000063',
      userId: SEED_USER_IDS.DOCTOR_PEDS,
      name: 'SDK Preference: primaryDepartmentId',
      key: 'primaryDepartmentId',
      value: SEED_DEPARTMENT_IDS.PEDS,
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },

    // =====================================================================
    // Dr. James Wilson (Emergency) - Remote workflow, English
    // =====================================================================
    {
      id: '81000000-0000-0000-0000-000000000071',
      userId: SEED_USER_IDS.DOCTOR_ER,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000072',
      userId: SEED_USER_IDS.DOCTOR_ER,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'en',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '81000000-0000-0000-0000-000000000073',
      userId: SEED_USER_IDS.DOCTOR_ER,
      name: 'SDK Preference: primaryDepartmentId',
      key: 'primaryDepartmentId',
      value: SEED_DEPARTMENT_IDS.ER,
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },

    // =====================================================================
    // Dr. Priya Sharma (Breast & Endocrine) - Remote (backend) workflow, English
    // =====================================================================
    {
      id: '84000000-0000-0000-0000-000000000001',
      userId: SEED_USER_IDS.DOCTOR_BREN,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000002',
      userId: SEED_USER_IDS.DOCTOR_BREN,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'en',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000003',
      userId: SEED_USER_IDS.DOCTOR_BREN,
      name: 'SDK Preference: primaryDepartmentId',
      key: 'primaryDepartmentId',
      value: SEED_DEPARTMENT_IDS.BREN,
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },

    // =====================================================================
    // Dr. David Park (Rheumatology) - Remote workflow, English
    // =====================================================================
    {
      id: '84000000-0000-0000-0000-000000000011',
      userId: SEED_USER_IDS.DOCTOR_RHEUM,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000012',
      userId: SEED_USER_IDS.DOCTOR_RHEUM,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'en',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000013',
      userId: SEED_USER_IDS.DOCTOR_RHEUM,
      name: 'SDK Preference: primaryDepartmentId',
      key: 'primaryDepartmentId',
      value: SEED_DEPARTMENT_IDS.RHEUM,
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },

    // =====================================================================
    // Dr. Aisha Khan (Hematology) - Remote (backend) workflow, English
    // =====================================================================
    {
      id: '84000000-0000-0000-0000-000000000021',
      userId: SEED_USER_IDS.DOCTOR_HEME,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000022',
      userId: SEED_USER_IDS.DOCTOR_HEME,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'en',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000023',
      userId: SEED_USER_IDS.DOCTOR_HEME,
      name: 'SDK Preference: primaryDepartmentId',
      key: 'primaryDepartmentId',
      value: SEED_DEPARTMENT_IDS.HEME,
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },

    // =====================================================================
    // Dr. Carlos Rivera (Dermatology) - Remote workflow, Spanish
    // =====================================================================
    {
      id: '84000000-0000-0000-0000-000000000031',
      userId: SEED_USER_IDS.DOCTOR_DERM,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000032',
      userId: SEED_USER_IDS.DOCTOR_DERM,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'es',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000033',
      userId: SEED_USER_IDS.DOCTOR_DERM,
      name: 'SDK Preference: primaryDepartmentId',
      key: 'primaryDepartmentId',
      value: SEED_DEPARTMENT_IDS.DERM,
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },

    // =====================================================================
    // Dr. Mei Lin (Dietetics) - Remote (backend) workflow, Chinese
    // =====================================================================
    {
      id: '84000000-0000-0000-0000-000000000041',
      userId: SEED_USER_IDS.DOCTOR_DIET,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000042',
      userId: SEED_USER_IDS.DOCTOR_DIET,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'zh',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000043',
      userId: SEED_USER_IDS.DOCTOR_DIET,
      name: 'SDK Preference: primaryDepartmentId',
      key: 'primaryDepartmentId',
      value: SEED_DEPARTMENT_IDS.DIET,
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },

    // =====================================================================
    // Dr. Omar Hassan (Nephrology) - Remote workflow, Arabic
    // =====================================================================
    {
      id: '84000000-0000-0000-0000-000000000051',
      userId: SEED_USER_IDS.DOCTOR_NEPH,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000052',
      userId: SEED_USER_IDS.DOCTOR_NEPH,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'ar',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000053',
      userId: SEED_USER_IDS.DOCTOR_NEPH,
      name: 'SDK Preference: primaryDepartmentId',
      key: 'primaryDepartmentId',
      value: SEED_DEPARTMENT_IDS.NEPH,
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },

    // =====================================================================
    // Dr. Elena Volkov (Surgical Oncology) - Remote (backend) workflow, Russian
    // =====================================================================
    {
      id: '84000000-0000-0000-0000-000000000061',
      userId: SEED_USER_IDS.DOCTOR_SONC,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000062',
      userId: SEED_USER_IDS.DOCTOR_SONC,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'ru',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000063',
      userId: SEED_USER_IDS.DOCTOR_SONC,
      name: 'SDK Preference: primaryDepartmentId',
      key: 'primaryDepartmentId',
      value: SEED_DEPARTMENT_IDS.SONC,
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },

    // =====================================================================
    // Dr. Thomas Wright (Medicine) - Remote (backend) workflow, English
    // =====================================================================
    {
      id: '84000000-0000-0000-0000-000000000071',
      userId: SEED_USER_IDS.DOCTOR_MED,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000072',
      userId: SEED_USER_IDS.DOCTOR_MED,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'en',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000073',
      userId: SEED_USER_IDS.DOCTOR_MED,
      name: 'SDK Preference: primaryDepartmentId',
      key: 'primaryDepartmentId',
      value: SEED_DEPARTMENT_IDS.MED,
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },

    // =====================================================================
    // Per-customer-tenant DOCTOR preferences.
    // Minimal, distinct-per-tenant prefs so impersonation surfaces real
    // values. workflowMode defaults to remote (backend) for all; language
    // stays distinct per tenant: ArcaAI = en.
    // =====================================================================
    {
      id: '84000000-0000-0000-0000-000000000081',
      userId: SEED_USER_IDS.ARCAAI_DOCTOR,
      name: 'SDK Preference: workflowMode',
      key: 'workflowMode',
      value: 'remote',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000082',
      userId: SEED_USER_IDS.ARCAAI_DOCTOR,
      name: 'SDK Preference: language',
      key: 'language',
      value: 'en',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    // Enrich ArcaAI doctor prefs (primary department + DNA
    // style) so impersonation surfaces a complete, realistic profile.
    {
      id: '84000000-0000-0000-0000-000000000083',
      userId: SEED_USER_IDS.ARCAAI_DOCTOR,
      name: 'SDK Preference: primaryDepartmentId',
      key: 'primaryDepartmentId',
      value: SEED_DEPARTMENT_IDS.GEN_ARCAAI,
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
    {
      id: '84000000-0000-0000-0000-000000000084',
      userId: SEED_USER_IDS.ARCAAI_DOCTOR,
      name: 'SDK Preference: dnaStyleId',
      key: 'dnaStyleId',
      value: 'clinical-concise-en',
      dataType: ValueType.String,
      namespace: 'arcaai-sdk',
    },
  ];

  for (const pref of sdkUserPreferences) {
    await client.userSettings.upsert({
      where: { id: pref.id },
      update: {
        // `value` omitted deliberately — a UserSettings value
        // is that user's own preference; a re-seed must not reset it.
        name: pref.name,
        key: pref.key,
        dataType: pref.dataType,
        namespace: pref.namespace,
      },
      create: {
        id: pref.id,
        userId: pref.userId,
        name: pref.name,
        key: pref.key,
        value: pref.value,
        dataType: pref.dataType,
        namespace: pref.namespace,
      },
    });
  }
  console.log(`  Created ${sdkUserPreferences.length} SDK user preferences`);

  // =========================================================================
  // Admin Pipeline Assignments (namespace: 'arcaai-admin')
  // Per-user pipeline overrides assigned by administrators
  // =========================================================================
  console.log('Seeding admin pipeline assignments...');

  const adminPipelineAssignments = [
    // Jane Doe gets assigned the Turbo pipeline by admin. Must reference a
    // pipeline OWNED BY HER TENANT (Global / SEED_TENANT_ID): admin overrides
    // resolve first in resolveRemoteConfig, and SYSTEM-tenant pipelines
    // (…0001-…0007) are not shared-read into customer tenants, so a SYSTEM id
    // here would 404 ("Pipeline … not found") on stream-session start. Use the
    // Global tenant's own Turbo pipeline (06-stt GLOBAL_TENANT_ASR_PIPELINES,
    // id …0402) instead of the SYSTEM Turbo (…0002).
    {
      id: '81000000-0000-0000-0000-000000000031',
      userId: SEED_USER_IDS.DOCTOR2,
      name: 'Admin: Assigned Pipeline',
      key: 'assigned-pipeline',
      value: '81000000-0000-0000-0001-000000000402', // Global tenant Turbo Pipeline
      dataType: ValueType.String,
      namespace: 'arcaai-admin',
    },
  ];

  for (const assignment of adminPipelineAssignments) {
    await client.userSettings.upsert({
      where: { id: assignment.id },
      update: {
        // `value` omitted deliberately — a UserSettings value
        // is that user's own preference; a re-seed must not reset it.
        name: assignment.name,
        key: assignment.key,
        dataType: assignment.dataType,
        namespace: assignment.namespace,
      },
      create: {
        id: assignment.id,
        userId: assignment.userId,
        name: assignment.name,
        key: assignment.key,
        value: assignment.value,
        dataType: assignment.dataType,
        namespace: assignment.namespace,
      },
    });
  }
  console.log(`  Created ${adminPipelineAssignments.length} admin pipeline assignments`);

  console.log('User seeding completed successfully');
  return { success: true, count: SEED_USERS.length };
};

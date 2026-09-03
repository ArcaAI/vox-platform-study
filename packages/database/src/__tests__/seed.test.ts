/**
 * Database Seed Script Tests
 *
 * Unit tests for seed script functions that populate the database
 * with initial data for the HOPE platform.
 *
 * These tests import and validate the ACTUAL seed data from the seed files,
 * not duplicated mock data. This ensures tests fail if seed data changes.
 *
 * Test Coverage:
 * - Seed data structure validation
 * - Seed data integrity (required fields, valid UUIDs)
 * - Dependency relationships (policies -> roles -> users)
 * - Idempotency verification
 * - Unified pre-summary template validation
 * - 3-group promptConfig structure
 * - Cross-reference integrity across all seed entities
 */

import { describe, it, expect, vi } from 'vitest';

import { DEFAULT_POLICIES, PolicyScope } from '../prisma/db_main/seed/01-policy';
import { SYSTEM_ROLES, TENANT_EXTENDABLE_ROLES, DEFAULT_ROLES } from '../prisma/db_main/seed/03-role';
import {
  DEFAULT_DEPARTMENTS,
  DEFAULT_TENANT_ID,
  ARCAAI_CLINICAL_DEPARTMENTS,
  ARCAAI_CLINICAL_DEPARTMENTS_WITHOUT_AGENT,
  ARCAAI_ALL_CLINICAL_DEPARTMENTS,
} from '../prisma/db_main/seed/04-department';
import {
  ARCAAI_CLINICAL_APPROVED_VERSION,
  ARCAAI_CLINICAL_TEMPLATES,
  ARCAAI_CLINICAL_VERSIONS,
  ARCAAI_CLINICAL_TEMPLATE_IDS,
} from '../prisma/db_main/seed/07b-arcaai-clinical-templates';
import { PRE_SUMMARY_CONTENT, SURGERY_NEW_REFERRAL_CONTENT } from '../prisma/db_main/seed/07b-arcaai-clinical-content';
import {
  DEFAULT_AI_MODELS,
  DEFAULT_ASR_PIPELINES,
  CUSTOMER_TENANT_ASR_PIPELINES,
  GLOBAL_TENANT_ASR_PIPELINES,
  DEFAULT_STT_SETTINGS,
  AiModelSource,
  AiModelFormat,
  ModelCategory,
  ModelTaskType,
  ModelType,
  backfillCustomerTenantAiModels,
  CUSTOMER_TENANT_IDS_FOR_AIMODEL_BACKFILL,
  ASR_TEMPLATE_SLUGS,
} from '../prisma/db_main/seed/06-stt';
import { ALL_SETTINGS, PLATFORM_SETTINGS } from '../prisma/db_main/seed/11-global-setting';
import { seedHarnessPolicy, SYSTEM_HARNESS_POLICY_TEXT_DEFAULTS } from '../prisma/db_main/seed/13-harness-policy';
import {
  seedPipelinePolicy,
  SYSTEM_PIPELINE_POLICY_DEFAULTS,
  DEMO_PIPELINE_POLICY_OVERRIDE,
  ARCAAI_PIPELINE_POLICY_OVERRIDE,
} from '../prisma/db_main/seed/14-pipeline-policy';
import { TENANT_FRONTEND_CONFIGS } from '../prisma/db_main/seed/05-tenant';
import { DEFAULT_PROMPT_TEMPLATES, DEFAULT_PROMPT_VERSIONS } from '../prisma/db_main/seed/07-prompt-template';
import {
  DEFAULT_DNA_REPORTS,
  DEFAULT_DNA_VERSIONS,
  DEFAULT_DNA_USAGE_RECORDS,
  DEFAULT_PROMPT_USAGE_RECORDS,
} from '../prisma/db_main/seed/08-dna-writing-style';
import {
  SEED_TEMPLATE_IDS,
  SEED_DEPARTMENT_IDS,
  SEED_USER_IDS,
  SEED_POLICY_IDS,
  SEED_ROLE_IDS,
  SEED_CUSTOMER_TENANT_IDS,
  SEED_TENANT_ID,
  SYSTEM_TENANT_ID,
  SYSTEM_USER_ID,
  SEED_VOICE_PROFILE_IDS,
} from '../prisma/db_main/seed/00-constants';
import { DEFAULT_AUDIO_RECORDINGS, DEFAULT_MEDIA, DEFAULT_SUMMARY_METAS, SEED_MEDIA_IDS } from '../prisma/db_main/seed/09-consultation';
import { SEED_VOICE_PROFILES, VOICE_EMBEDDING_DIM } from '../prisma/db_main/seed/91-user';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// =============================================================================
// CONSTANTS VALIDATION
// =============================================================================

describe('Seed Constants (00-constants)', () => {
  it('should define SYSTEM_USER_ID with correct prefix', () => {
    expect(SYSTEM_USER_ID).toBe('60000000-0000-0000-0000-000000000000');
    expect(SYSTEM_USER_ID).toMatch(UUID_REGEX);
  });

  it('should include SYSTEM user in SEED_USER_IDS', () => {
    expect(SEED_USER_IDS.SYSTEM).toBe(SYSTEM_USER_ID);
  });

  it('should define 19 department IDs (8 Global-tenant care settings + 11 ArcaAI clinical)', () => {
    expect(Object.keys(SEED_DEPARTMENT_IDS).length).toBe(19);
  });

  it('should define the 11 ArcaAI clinical department IDs — v1 parity', () => {
    expect(SEED_DEPARTMENT_IDS.GEN_ARCAAI).toBeDefined();
    expect(SEED_DEPARTMENT_IDS.SURG_ARCAAI).toBeDefined();
    expect(SEED_DEPARTMENT_IDS.RHEUM_ARCAAI).toBeDefined();
    expect(SEED_DEPARTMENT_IDS.NEUR_ARCAAI).toBeDefined();
    expect(SEED_DEPARTMENT_IDS.ORTH_ARCAAI).toBeDefined();
    expect(SEED_DEPARTMENT_IDS.HEME_ARCAAI).toBeDefined();
    expect(SEED_DEPARTMENT_IDS.BREN_ARCAAI).toBeDefined();
    expect(SEED_DEPARTMENT_IDS.DERM_ARCAAI).toBeDefined();
    expect(SEED_DEPARTMENT_IDS.DIET_ARCAAI).toBeDefined();
    expect(SEED_DEPARTMENT_IDS.NEPH_ARCAAI).toBeDefined();
    expect(SEED_DEPARTMENT_IDS.SONC_ARCAAI).toBeDefined();
    // All eleven live in the ArcaAI `…-0001-…` block, and the ids are unique.
    const arcaaiIds = Object.entries(SEED_DEPARTMENT_IDS)
      .filter(([key]) => key.endsWith('_ARCAAI'))
      .map(([, id]) => id);
    expect(arcaaiIds).toHaveLength(11);
    expect(new Set(arcaaiIds).size).toBe(11);
    arcaaiIds.forEach((id) => expect(id.startsWith('70000000-0000-0000-0001-')).toBe(true));
  });

  it('should have retired the ArcaAI CARD + ER demo department IDs', () => {
    expect((SEED_DEPARTMENT_IDS as Record<string, string>).CARD_ARCAAI).toBeUndefined();
    expect((SEED_DEPARTMENT_IDS as Record<string, string>).ER_ARCAAI).toBeUndefined();
  });

  it('should have retired the Global-tenant specialty department IDs (OD-8)', () => {
    // DIET / NEPH / SONC and the rest of the specialty roster are ArcaAI's, and
    // exist only under the *_ARCAAI keys now. Keeping Global copies is what made
    // the SYSTEM golden library ship one hospital's catalog to every tenant.
    const ids = SEED_DEPARTMENT_IDS as Record<string, string | undefined>;
    ['GEN', 'CARD', 'MED', 'SURG', 'NEUR', 'ORTH', 'DERM', 'PSYCH', 'BREN', 'RHEUM', 'HEME', 'DIET', 'NEPH', 'SONC'].forEach((code) => {
      expect(ids[code], `Global specialty department id ${code} should be retired`).toBeUndefined();
    });
  });

  it('should define the 8 Global care-setting department IDs on the 0003 block', () => {
    const globalIds = Object.entries(SEED_DEPARTMENT_IDS).filter(([key]) => !key.endsWith('_ARCAAI'));
    expect(globalIds).toHaveLength(8);
    globalIds.forEach(([, id]) => expect(id.startsWith('70000000-0000-0000-0003-')).toBe(true));
  });

  it('should define 17 policy IDs including new prompt/audit/settings policies', () => {
    expect(Object.keys(SEED_POLICY_IDS).length).toBe(17);
    expect(SEED_POLICY_IDS.PROMPT_TEMPLATE_MANAGE).toBeDefined();
    expect(SEED_POLICY_IDS.GLOBAL_SETTINGS_MANAGE).toBeDefined();
    expect(SEED_POLICY_IDS.AUDIT_LOG_READ).toBeDefined();
  });

  it('should define PRE_SUMMARY_DEFAULT template ID', () => {
    expect(SEED_TEMPLATE_IDS.PRE_SUMMARY_DEFAULT).toBe('71000000-0000-0000-0000-000000000040');
  });

  it('should NOT have deprecated department-specific pre-summary slug IDs', () => {
    const keys = Object.keys(SEED_TEMPLATE_IDS);
    const deprecatedPrefixes = keys.filter((k) => k.startsWith('PRE_SUMMARY_') && k !== 'PRE_SUMMARY_DEFAULT' && k !== 'PRE_SUMMARY_SYSTEM');
    expect(deprecatedPrefixes).toEqual([]);
  });

  it('should have all department IDs as valid UUIDs', () => {
    Object.values(SEED_DEPARTMENT_IDS).forEach((id) => {
      expect(id).toMatch(UUID_REGEX);
    });
  });

  it('should have all policy IDs as valid UUIDs', () => {
    Object.values(SEED_POLICY_IDS).forEach((id) => {
      expect(id).toMatch(UUID_REGEX);
    });
  });

  it('should have all template IDs as valid UUIDs', () => {
    Object.values(SEED_TEMPLATE_IDS).forEach((id) => {
      expect(id).toMatch(UUID_REGEX);
    });
  });

  it('should have unique values across all department IDs', () => {
    const values = Object.values(SEED_DEPARTMENT_IDS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('should have unique values across all template IDs', () => {
    const values = Object.values(SEED_TEMPLATE_IDS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('should have per-tenant admin user IDs', () => {
    expect(SEED_USER_IDS.ARCAAI_ADMIN).toBeDefined();
  });

  it('should have department-specific doctor user IDs', () => {
    expect(SEED_USER_IDS.DOCTOR_BREN).toBeDefined();
    expect(SEED_USER_IDS.DOCTOR_RHEUM).toBeDefined();
    expect(SEED_USER_IDS.DOCTOR_HEME).toBeDefined();
    expect(SEED_USER_IDS.DOCTOR_DERM).toBeDefined();
    expect(SEED_USER_IDS.DOCTOR_DIET).toBeDefined();
    expect(SEED_USER_IDS.DOCTOR_NEPH).toBeDefined();
    expect(SEED_USER_IDS.DOCTOR_SONC).toBeDefined();
    expect(SEED_USER_IDS.DOCTOR_MED).toBeDefined();
  });
});

// =============================================================================
// SEED EXECUTION ORDER
// =============================================================================

describe('Seed Execution Order', () => {
  it('should have policies defined before roles (dependency)', () => {
    const policyNames = DEFAULT_POLICIES.map((p) => p.name);
    DEFAULT_ROLES.forEach((role) => {
      role.policies.forEach((policyName) => {
        expect(policyNames).toContain(policyName);
      });
    });
  });

  it('should have parent roles defined before child roles', () => {
    const roleIds = DEFAULT_ROLES.map((r) => r.id);
    DEFAULT_ROLES.forEach((role) => {
      if (role.parentRoleId) {
        expect(roleIds).toContain(role.parentRoleId);
      }
    });
  });
});

// =============================================================================
// POLICY SEED DATA
// =============================================================================

describe('Policy Seed Data', () => {
  describe('Policy Structure', () => {
    it('should have required fields for each policy', () => {
      const requiredFields = ['id', 'name', 'description', 'scope', 'rules'];
      DEFAULT_POLICIES.forEach((policy) => {
        requiredFields.forEach((field) => {
          expect(policy).toHaveProperty(field);
        });
      });
    });

    it('should have valid UUID format for all policy IDs', () => {
      DEFAULT_POLICIES.forEach((policy) => {
        expect(policy.id).toMatch(UUID_REGEX);
      });
    });

    it('should have valid scope values', () => {
      const validScopes = [PolicyScope.GLOBAL, PolicyScope.TENANT];
      DEFAULT_POLICIES.forEach((policy) => {
        expect(validScopes).toContain(policy.scope);
      });
    });

    it('should have non-empty rules array for each policy', () => {
      DEFAULT_POLICIES.forEach((policy) => {
        expect(Array.isArray(policy.rules)).toBe(true);
        expect(policy.rules.length).toBeGreaterThan(0);
      });
    });

    it('should have valid rule structure with action and subject', () => {
      DEFAULT_POLICIES.forEach((policy) => {
        policy.rules.forEach((rule) => {
          expect(rule).toHaveProperty('action');
          expect(rule).toHaveProperty('subject');
        });
      });
    });
  });

  describe('Default Policies', () => {
    it('should define 22 policies', () => {
      // Includes the `prompt-template-read` policy, the clinical
      // documentation harness policies (`harness-platform-manage`,
      // `harness-tenant-manage`), the `prisma-studio-manage` policy, and
      // `api-documentation-read` (21 -> 22).
      expect(DEFAULT_POLICIES.length).toBe(22);
    });

    it('should include the api-documentation-read policy as a dedicated, delegable grant', () => {
      const apiDocs = DEFAULT_POLICIES.find((p) => p.name === 'api-documentation-read');

      expect(apiDocs).toBeDefined();
      // GLOBAL, like `prisma-studio-manage`: the API contract is a property of
      // the PLATFORM, not of a tenant's data, so there is no tenantId condition.
      expect(apiDocs?.scope).toBe(PolicyScope.GLOBAL);
      // A DEDICATED subject, so the developer portal can be delegated to tenant
      // developers without granting `manage:all`. `read` serves the business
      // projection; the administration projection needs `manage`, which in
      // practice only `system-full-access` grants.
      expect(apiDocs?.rules).toEqual([{ action: 'read', subject: 'ApiDocumentation' }]);
    });

    it('should include system-full-access policy', () => {
      const systemFullAccess = DEFAULT_POLICIES.find((p) => p.name === 'system-full-access');
      expect(systemFullAccess).toBeDefined();
      expect(systemFullAccess?.scope).toBe(PolicyScope.GLOBAL);
    });

    // The anti-lockout guard identifies the protected set by the
    // `isProtected` column (rename-proof), with the name match as fallback.
    // The seed MUST mark exactly the two system-critical GLOBAL policies.
    it('should mark exactly system-full-access and rbac-system-manage as isProtected', () => {
      const protectedNames = DEFAULT_POLICIES.filter((p) => (p as { isProtected?: boolean }).isProtected === true).map((p) => p.name);
      expect(protectedNames.sort()).toEqual(['rbac-system-manage', 'system-full-access']);
    });

    it('should include tenant-full-access policy', () => {
      const tenantFullAccess = DEFAULT_POLICIES.find((p) => p.name === 'tenant-full-access');
      expect(tenantFullAccess).toBeDefined();
      expect(tenantFullAccess?.scope).toBe(PolicyScope.TENANT);
    });

    // Tenant admins self-serve their own tenant's clone
    // of the SYSTEM AI model catalog (tenant-scoped `manage AiModel`).
    it('should grant tenant-scoped manage AiModel in tenant-full-access', () => {
      const tenantFullAccess = DEFAULT_POLICIES.find((p) => p.name === 'tenant-full-access');
      const rule = tenantFullAccess?.rules.find((r) => r.subject === 'AiModel');
      expect(rule).toBeDefined();
      const actions = Array.isArray(rule?.action) ? rule?.action : [rule?.action];
      expect(actions).toContain('manage');
      expect(JSON.stringify(rule?.conditions)).toContain('${context.tenantId}');
    });

    it('should include prompt-template-manage policy', () => {
      const promptPolicy = DEFAULT_POLICIES.find((p) => p.name === 'prompt-template-manage');
      expect(promptPolicy).toBeDefined();
      expect(promptPolicy?.scope).toBe(PolicyScope.TENANT);
    });

    // End-user (clinician) read-only template ability.
    it('should include prompt-template-read policy (read+list PromptTemplate, tenant-scoped)', () => {
      const readPolicy = DEFAULT_POLICIES.find((p) => p.name === 'prompt-template-read');
      expect(readPolicy).toBeDefined();
      expect(readPolicy?.scope).toBe(PolicyScope.TENANT);

      const rule = readPolicy?.rules.find((r) => r.subject === 'PromptTemplate');
      expect(rule).toBeDefined();
      // read-only — must NOT grant `manage` (that's the admin plane).
      const actions = Array.isArray(rule?.action) ? rule?.action : [rule?.action];
      expect(actions).toEqual(expect.arrayContaining(['read', 'list']));
      expect(actions).not.toContain('manage');
      // tenant-scoped to the caller's tenant.
      expect(JSON.stringify(rule?.conditions)).toContain('${context.tenantId}');
    });

    it('should include global-settings-manage policy', () => {
      const settingsPolicy = DEFAULT_POLICIES.find((p) => p.name === 'global-settings-manage');
      expect(settingsPolicy).toBeDefined();
      expect(settingsPolicy?.scope).toBe(PolicyScope.TENANT);
    });

    it('should include audit-log-read policy', () => {
      const auditPolicy = DEFAULT_POLICIES.find((p) => p.name === 'audit-log-read');
      expect(auditPolicy).toBeDefined();
      expect(auditPolicy?.scope).toBe(PolicyScope.TENANT);
    });

    // Clinical documentation harness RBAC policies.
    it('should include harness-platform-manage policy (GLOBAL)', () => {
      const policy = DEFAULT_POLICIES.find((p) => p.name === 'harness-platform-manage');
      expect(policy).toBeDefined();
      expect(policy?.scope).toBe(PolicyScope.GLOBAL);
    });

    it('should include harness-tenant-manage policy (TENANT)', () => {
      const policy = DEFAULT_POLICIES.find((p) => p.name === 'harness-tenant-manage');
      expect(policy).toBeDefined();
      expect(policy?.scope).toBe(PolicyScope.TENANT);
    });

    // Prisma Studio in production sits behind a DEDICATED
    // permission. The subject is `PrismaStudio` (not covered by any
    // tenant-scoped grant); GLOBAL scope, unconditional — the studio is a
    // privileged, untenanted raw-DB surface.
    it('should include prisma-studio-manage policy (GLOBAL, manage:PrismaStudio)', () => {
      const policy = DEFAULT_POLICIES.find((p) => p.name === 'prisma-studio-manage');
      expect(policy).toBeDefined();
      expect(policy?.scope).toBe(PolicyScope.GLOBAL);
      expect(policy?.rules).toEqual([{ action: 'manage', subject: 'PrismaStudio' }]);
    });

    // Golden-dataset curation (`POST /admin/harness/
    // golden-sets*`) is guarded by `manage:HarnessEval`. Datasets are
    // tenant-owned rows, so the harness policies carry `manage` (not just
    // `read`) on HarnessEval: unconditional at platform scope, pinned to
    // the caller's tenant at tenant scope. HarnessAudit stays read-only.
    it.each(['harness-platform-manage', 'harness-tenant-manage', 'tenant-full-access'])(
      'should grant manage HarnessEval in %s',
      (policyName) => {
        const policy = DEFAULT_POLICIES.find((p) => p.name === policyName);
        const rule = policy?.rules.find((r) => r.subject === 'HarnessEval');
        expect(rule).toBeDefined();
        const actions = Array.isArray(rule?.action) ? rule?.action : [rule?.action];
        expect(actions).toContain('manage');
        if (policy?.scope === PolicyScope.TENANT) {
          expect(JSON.stringify(rule?.conditions)).toContain('${context.tenantId}');
        } else {
          expect(rule?.conditions).toBeUndefined();
        }
      },
    );

    // The MCP registry and the agent-trajectory read plane no longer
    // borrow the `HarnessPolicy` subject. The seed grants below
    // are ADDITIVE grandfathering: every role that could reach those two
    // surfaces through `manage:HarnessPolicy` keeps exactly today's access
    // via an explicit grant on the new subject. (Custom, tenant-authored
    // policies are deliberately NOT auto-migrated; operators add the grant
    // themselves.)
    it.each([
      ['harness-platform-manage', 'McpServer', 'manage'],
      ['harness-platform-manage', 'AgentTrajectory', 'read'],
      ['harness-tenant-manage', 'McpServer', 'manage'],
      ['harness-tenant-manage', 'AgentTrajectory', 'read'],
      ['tenant-full-access', 'McpServer', 'manage'],
      ['tenant-full-access', 'AgentTrajectory', 'read'],
    ])('should grant %s → %s (%s) after the M-12 subject swap', (policyName, subject, action) => {
      const policy = DEFAULT_POLICIES.find((p) => p.name === policyName);
      const rule = policy?.rules.find((r) => r.subject === subject);
      expect(rule, `${policyName} is missing a ${subject} rule`).toBeDefined();
      const actions = Array.isArray(rule?.action) ? rule?.action : [rule?.action];
      expect(actions).toContain(action);
      // GLOBAL policies grant unconditionally; TENANT policies stay pinned.
      if (policy?.scope === PolicyScope.TENANT) {
        expect(JSON.stringify(rule?.conditions)).toContain('${context.tenantId}');
      } else {
        expect(rule?.conditions).toBeUndefined();
      }
    });

    // Realtime-pipeline cascade admin RBAC (a SEPARATE
    // PipelinePolicy subject from HarnessPolicy). Platform = unconditional;
    // tenant = pinned to the caller's tenant. `manage` implies `read`.
    it('should grant platform-wide manage PipelinePolicy in harness-platform-manage', () => {
      const policy = DEFAULT_POLICIES.find((p) => p.name === 'harness-platform-manage');
      const rule = policy?.rules.find((r) => r.subject === 'PipelinePolicy');
      expect(rule).toBeDefined();
      const actions = Array.isArray(rule?.action) ? rule?.action : [rule?.action];
      expect(actions).toContain('manage');
      // GLOBAL grant — no tenant condition.
      expect(rule?.conditions).toBeUndefined();
    });

    it('should grant tenant-scoped manage PipelinePolicy in harness-tenant-manage', () => {
      const policy = DEFAULT_POLICIES.find((p) => p.name === 'harness-tenant-manage');
      const rule = policy?.rules.find((r) => r.subject === 'PipelinePolicy');
      expect(rule).toBeDefined();
      const actions = Array.isArray(rule?.action) ? rule?.action : [rule?.action];
      expect(actions).toContain('manage');
      expect(JSON.stringify(rule?.conditions)).toContain('${context.tenantId}');
    });

    it('should grant tenant-scoped manage PipelinePolicy in tenant-full-access', () => {
      const policy = DEFAULT_POLICIES.find((p) => p.name === 'tenant-full-access');
      const rule = policy?.rules.find((r) => r.subject === 'PipelinePolicy');
      expect(rule).toBeDefined();
      const actions = Array.isArray(rule?.action) ? rule?.action : [rule?.action];
      expect(actions).toContain('manage');
      expect(JSON.stringify(rule?.conditions)).toContain('${context.tenantId}');
    });

    it('should have unique policy names', () => {
      const names = DEFAULT_POLICIES.map((p) => p.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('should have unique policy IDs', () => {
      const ids = DEFAULT_POLICIES.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('Policy Template Variables', () => {
    it('should use ${user.id} template variable in conditions', () => {
      const policiesWithUserCondition = DEFAULT_POLICIES.filter((p) => JSON.stringify(p.rules).includes('${user.id}'));
      expect(policiesWithUserCondition.length).toBeGreaterThan(0);
    });

    it('should use ${context.tenantId} template variable in conditions', () => {
      const policiesWithTenantCondition = DEFAULT_POLICIES.filter((p) => JSON.stringify(p.rules).includes('${context.tenantId}'));
      expect(policiesWithTenantCondition.length).toBeGreaterThan(0);
    });
  });
});

describe('PolicyScope Values', () => {
  it('should define GLOBAL scope', () => {
    expect(PolicyScope.GLOBAL).toBe('GLOBAL');
  });

  it('should define TENANT scope', () => {
    expect(PolicyScope.TENANT).toBe('TENANT');
  });

  it('should have exactly 2 scope values', () => {
    expect(Object.keys(PolicyScope)).toHaveLength(2);
  });
});

// =============================================================================
// ROLE SEED DATA
// =============================================================================

describe('Role Seed Data', () => {
  describe('System Roles', () => {
    it('should define 4 system roles', () => {
      expect(SYSTEM_ROLES.length).toBe(4);
    });

    it('should mark all system roles as isSystemRole: true', () => {
      SYSTEM_ROLES.forEach((role) => {
        expect(role.isSystemRole).toBe(true);
      });
    });

    // The elevated role is named SUPER_ADMIN. GLOBAL_ADMIN must never be seeded.
    it('should NOT seed a GLOBAL_ADMIN role anywhere', () => {
      expect(DEFAULT_ROLES.find((r) => r.name === 'GLOBAL_ADMIN')).toBeUndefined();
    });

    it('should include SUPER_ADMIN as the canonical elevated system role', () => {
      const superAdmin = DEFAULT_ROLES.find((r) => r.name === 'SUPER_ADMIN');
      expect(superAdmin).toBeDefined();
      expect(superAdmin?.isSystemRole).toBe(true);
      expect(superAdmin?.parentRoleId).toBeNull();
      expect(superAdmin?.externalName).toBe('Super Administrator');
    });

    it('should include TENANT_ADMIN role', () => {
      expect(SYSTEM_ROLES.find((r) => r.name === 'TENANT_ADMIN')).toBeDefined();
    });

    it('should include DOCTOR role', () => {
      expect(SYSTEM_ROLES.find((r) => r.name === 'DOCTOR')).toBeDefined();
    });

    it('should include NURSE role', () => {
      expect(SYSTEM_ROLES.find((r) => r.name === 'NURSE')).toBeDefined();
    });

    it('should include SERVICE_ACCOUNT role', () => {
      expect(SYSTEM_ROLES.find((r) => r.name === 'SERVICE_ACCOUNT')).toBeDefined();
    });

    it('should have valid UUID format for all system role IDs', () => {
      SYSTEM_ROLES.forEach((role) => {
        expect(role.id).toMatch(UUID_REGEX);
      });
    });
  });

  describe('Tenant Extendable Roles', () => {
    it('should define 2 tenant extendable roles', () => {
      expect(TENANT_EXTENDABLE_ROLES.length).toBe(2);
    });

    it('should mark extendable roles as isSystemRole: false', () => {
      TENANT_EXTENDABLE_ROLES.forEach((role) => {
        expect(role.isSystemRole).toBe(false);
      });
    });

    it('should have DEPARTMENT_HEAD inherit from DOCTOR', () => {
      const deptHead = TENANT_EXTENDABLE_ROLES.find((r) => r.name === 'DEPARTMENT_HEAD');
      const doctor = SYSTEM_ROLES.find((r) => r.name === 'DOCTOR');
      expect(deptHead?.parentRoleId).toBe(doctor?.id);
    });

    it('should have SENIOR_NURSE inherit from NURSE', () => {
      const seniorNurse = TENANT_EXTENDABLE_ROLES.find((r) => r.name === 'SENIOR_NURSE');
      const nurse = SYSTEM_ROLES.find((r) => r.name === 'NURSE');
      expect(seniorNurse?.parentRoleId).toBe(nurse?.id);
    });
  });

  describe('Role-Policy Assignments', () => {
    // SUPER_ADMIN carries the full elevated policy set.
    it('should assign the full elevated policy set to SUPER_ADMIN', () => {
      const superAdmin = DEFAULT_ROLES.find((r) => r.name === 'SUPER_ADMIN');
      expect(superAdmin?.policies).toContain('system-full-access');
      expect(superAdmin?.policies).toContain('rbac-system-manage');
      expect(superAdmin?.policies).toContain('global-settings-manage');
    });

    it('should assign tenant-full-access to TENANT_ADMIN', () => {
      const tenantAdmin = DEFAULT_ROLES.find((r) => r.name === 'TENANT_ADMIN');
      expect(tenantAdmin?.policies).toContain('tenant-full-access');
    });

    it('should assign consultation-own-manage to DOCTOR', () => {
      const doctor = DEFAULT_ROLES.find((r) => r.name === 'DOCTOR');
      expect(doctor?.policies).toContain('consultation-own-manage');
    });

    // DOCTOR gets read-only template access (for the
    // Pre-Summary / Summary selector) but NOT the admin `manage` plane.
    // DEPARTMENT_HEAD inherits DOCTOR's policies via parentRoleId.
    it('should assign prompt-template-read to DOCTOR (and NOT prompt-template-manage)', () => {
      const doctor = DEFAULT_ROLES.find((r) => r.name === 'DOCTOR');
      expect(doctor?.policies).toContain('prompt-template-read');
      expect(doctor?.policies).not.toContain('prompt-template-manage');
    });

    it('should assign consultation-read-assigned to NURSE', () => {
      const nurse = DEFAULT_ROLES.find((r) => r.name === 'NURSE');
      expect(nurse?.policies).toContain('consultation-read-assigned');
    });

    // The SUPER_ADMIN policy set carries the dedicated
    // Prisma Studio grant (manage:all would also pass the guard, but the
    // explicit policy makes the studio delegable without full access).
    it('should assign prisma-studio-manage to SUPER_ADMIN', () => {
      const superAdmin = DEFAULT_ROLES.find((r) => r.name === 'SUPER_ADMIN');
      expect(superAdmin?.policies).toContain('prisma-studio-manage');
    });

    it('should assign user-profile-own to all clinical roles', () => {
      const doctor = DEFAULT_ROLES.find((r) => r.name === 'DOCTOR');
      const nurse = DEFAULT_ROLES.find((r) => r.name === 'NURSE');
      const tenantAdmin = DEFAULT_ROLES.find((r) => r.name === 'TENANT_ADMIN');
      expect(doctor?.policies).toContain('user-profile-own');
      expect(nurse?.policies).toContain('user-profile-own');
      expect(tenantAdmin?.policies).toContain('user-profile-own');
    });

    it('should only reference existing policies', () => {
      const policyNames = DEFAULT_POLICIES.map((p) => p.name);
      DEFAULT_ROLES.forEach((role) => {
        role.policies.forEach((policyName) => {
          expect(policyNames).toContain(policyName);
        });
      });
    });
  });

  describe('Role Structure', () => {
    it('should have required fields for each role', () => {
      const requiredFields = ['id', 'name', 'description', 'externalName', 'isSystemRole', 'policies'];
      DEFAULT_ROLES.forEach((role) => {
        requiredFields.forEach((field) => {
          expect(role).toHaveProperty(field);
        });
      });
    });

    it('should have unique role names', () => {
      const names = DEFAULT_ROLES.map((r) => r.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('should have unique role IDs', () => {
      const ids = DEFAULT_ROLES.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});

// =============================================================================
// DEPARTMENT SEED DATA
// =============================================================================

describe('Department Seed Data', () => {
  it('should define 8 platform-generic care-setting departments', () => {
    expect(DEFAULT_DEPARTMENTS.length).toBe(8);
  });

  it('should have unique department codes', () => {
    const codes = DEFAULT_DEPARTMENTS.map((d) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('should have unique department IDs', () => {
    const ids = DEFAULT_DEPARTMENTS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should have valid UUID format for all department IDs', () => {
    DEFAULT_DEPARTMENTS.forEach((dept) => {
      expect(dept.id).toMatch(UUID_REGEX);
    });
  });

  it('should include all 8 expected care-setting departments', () => {
    const codes = DEFAULT_DEPARTMENTS.map((d) => d.code);
    const expectedCodes = ['OPD', 'IPD', 'ER', 'PERI', 'RAD', 'LAB', 'BEH', 'PEDS'];
    expectedCodes.forEach((code) => {
      expect(codes).toContain(code);
    });
    expect(codes).toHaveLength(expectedCodes.length);
  });

  it('should carry none of the ArcaAI/BCMCH specialty codes (OD-8)', () => {
    // The Global catalog IS the source of the SYSTEM golden library, so a
    // specialty code here becomes every new tenant's day-1 department.
    const codes = new Set(DEFAULT_DEPARTMENTS.map((d) => d.code));
    ['GEN', 'MED', 'SURG', 'NEUR', 'ORTH', 'DERM', 'BREN', 'RHEUM', 'HEME', 'DIET', 'NEPH', 'SONC'].forEach((code) => {
      expect(codes.has(code), `specialty code ${code} leaked back into the Global catalog`).toBe(false);
    });
  });

  it('should have default tenant ID for all departments', () => {
    DEFAULT_DEPARTMENTS.forEach((d) => {
      expect(d.tenantId).toBe(DEFAULT_TENANT_ID);
    });
  });

  it('should have required fields for each department', () => {
    const requiredFields = ['id', 'tenantId', 'code', 'name', 'description'];
    DEFAULT_DEPARTMENTS.forEach((dept) => {
      requiredFields.forEach((field) => {
        expect(dept).toHaveProperty(field);
      });
    });
  });
});

// =============================================================================
// ARCAAI CLINICAL DEPARTMENT CATALOG
// =============================================================================

describe('ArcaAI Clinical Department Seed Data', () => {
  const ARCAAI = SEED_CUSTOMER_TENANT_IDS.ARCAAI;

  // ---------------------------------------------------------------------------
  // HOPE v1's canonical department set — ELEVEN, and the owner's strict rule for
  // Is that the ArcaAI tenant carries EXACTLY these and no
  // others.
  //
  // Source of truth is the RUNNING v1 TEXT pod (rancher cluster c-9lwv8,
  // namespace apps, pod apps-text-…), re-verified 2026-08-08:
  //   `text.models.prompts_json.DEPT_VISIT_SCHEMAS` → 22 entries = 11 departments
  //   × {new_referral, followup}; `select_prompt_template` has 11 branches.
  // v1 has no Department table at all, so "v1's departments" IS this key set.
  // ---------------------------------------------------------------------------
  const V1_DEPARTMENT_KEY_TO_ARCAAI_CODE: Record<string, string> = {
    breast_endocrine: 'BREN',
    dermatology: 'DERM',
    dietetics: 'DIET',
    hematology: 'HEME',
    medicine: 'GEN',
    nephrology: 'NEPH',
    neurology: 'NEUR',
    orthopedics: 'ORTH',
    rheumatology: 'RHEUM',
    surgery: 'SURG',
    surgical_oncology: 'SONC',
  };

  it('should carry EXACTLY as many clinical departments as HOPE v1 — eleven (owner strict rule)', () => {
    expect(Object.keys(V1_DEPARTMENT_KEY_TO_ARCAAI_CODE)).toHaveLength(11);
    expect(ARCAAI_ALL_CLINICAL_DEPARTMENTS).toHaveLength(11);
  });

  it('should match v1 department-for-department — no extra, no missing (owner strict rule)', () => {
    const seeded = new Set(ARCAAI_ALL_CLINICAL_DEPARTMENTS.map((d) => d.code));
    const expected = new Set(Object.values(V1_DEPARTMENT_KEY_TO_ARCAAI_CODE));
    expect([...seeded].sort()).toEqual([...expected].sort());
    // Stated the other way round so a failure names the offending v1 key.
    Object.entries(V1_DEPARTMENT_KEY_TO_ARCAAI_CODE).forEach(([v1Key, code]) => {
      expect(seeded.has(code), `v1 department "${v1Key}" has no ArcaAI department (code ${code})`).toBe(true);
    });
  });

  it('should split the eleven into the 7 agent-bound + 4 agent-free rows without overlap', () => {
    expect(ARCAAI_CLINICAL_DEPARTMENTS.map((d) => d.code).sort()).toEqual(['BREN', 'GEN', 'HEME', 'NEUR', 'ORTH', 'RHEUM', 'SURG']);
    expect(ARCAAI_CLINICAL_DEPARTMENTS_WITHOUT_AGENT.map((d) => d.code).sort()).toEqual(['DERM', 'DIET', 'NEPH', 'SONC']);
    expect(ARCAAI_ALL_CLINICAL_DEPARTMENTS).toEqual([...ARCAAI_CLINICAL_DEPARTMENTS, ...ARCAAI_CLINICAL_DEPARTMENTS_WITHOUT_AGENT]);
  });

  // removed the case that asserted the four Phase-8b departments carry
  // no default `DepartmentAgent`. There are no agent rows at all now, so the
  // property it guarded is vacuous; the SPLIT it guarded — which departments
  // carry visit-type prompt columns — is asserted by the case above and by
  // `every department prompt column resolves` in `seed-fk-closure.test.ts`.

  it('should repurpose the retained GEN_ARCAAI id as General Medicine', () => {
    const gen = ARCAAI_ALL_CLINICAL_DEPARTMENTS.find((d) => d.id === SEED_DEPARTMENT_IDS.GEN_ARCAAI);
    expect(gen).toBeDefined();
    expect(gen?.code).toBe('GEN');
    expect(gen?.name).toBe('General Medicine');
  });

  it('should bind every ArcaAI clinical department to the ArcaAI tenant', () => {
    ARCAAI_ALL_CLINICAL_DEPARTMENTS.forEach((dept) => {
      expect(dept.tenantId).toBe(ARCAAI);
    });
  });

  it('should have unique, valid-UUID department IDs across all ArcaAI clinical rows', () => {
    const ids = ARCAAI_ALL_CLINICAL_DEPARTMENTS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(UUID_REGEX));
  });

  it('should wire both visit-type prompt-id columns on every ArcaAI clinical department', () => {
    ARCAAI_ALL_CLINICAL_DEPARTMENTS.forEach((dept) => {
      expect(dept.newPatientPromptId, `${dept.code} new-patient column`).not.toBeNull();
      expect(dept.revisitPromptId, `${dept.code} revisit column`).not.toBeNull();
      // new-referral and revisit MUST differ — the visit-type split is the
      // whole reason legacy columns are used instead of a single agent.
      expect(dept.newPatientPromptId).not.toBe(dept.revisitPromptId);
    });
  });

  it('should point every ArcaAI clinical department visit-type column at an APPROVED ArcaAI template', () => {
    // Mirrors the resolver tier-1 legacy contract: Department.{new,revisit}PromptId
    // must resolve to an APPROVED PromptTemplate owned by the ArcaAI tenant.
    const approvedById = new Map(ARCAAI_CLINICAL_TEMPLATES.filter((t) => t.status === 'APPROVED').map((t) => [t.id, t]));
    ARCAAI_ALL_CLINICAL_DEPARTMENTS.forEach((dept) => {
      [dept.newPatientPromptId, dept.revisitPromptId].forEach((promptId) => {
        const tpl = approvedById.get(promptId);
        expect(tpl, `${dept.code} → ${promptId} must be an APPROVED ArcaAI template`).toBeDefined();
        expect(tpl?.tenantId).toBe(ARCAAI);
      });
    });
  });

  it('should bind each visit-type template to its OWN department', () => {
    const templateById = new Map(ARCAAI_CLINICAL_TEMPLATES.map((t) => [t.id, t]));
    ARCAAI_ALL_CLINICAL_DEPARTMENTS.forEach((dept) => {
      [dept.newPatientPromptId, dept.revisitPromptId].forEach((promptId) => {
        expect(templateById.get(promptId)?.departmentId, `${dept.code} → ${promptId} must be scoped to ${dept.code}`).toBe(dept.id);
      });
    });
  });

  it('should NOT department-scope the pre-summary prompt on any ArcaAI clinical department', () => {
    // Pre-summary has no department axis and no visit-type axis: v1 has exactly
    // ONE pre-summary prompt per tenant, with department/visit type as variables
    // inside it. Setting `preSummaryPromptId` per department re-creates the
    // category error that let the department-agent tier hijack pre-summary.
    ARCAAI_ALL_CLINICAL_DEPARTMENTS.forEach((dept) => {
      expect(dept.preSummaryPromptId, `${dept.code} must not department-scope pre-summary`).toBeNull();
    });
  });

  it('should define the tenant-wide pre-summary template', () => {
    const preSummary = ARCAAI_CLINICAL_TEMPLATES.find((t) => t.id === ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY);
    expect(preSummary).toBeDefined();
    expect(preSummary?.tenantId).toBe(ARCAAI);
    expect(preSummary?.status).toBe('APPROVED');
    // Tenant-wide, not bound to any department.
    expect(preSummary?.scope).toBe('TENANT_DEFAULT');
    expect(preSummary?.departmentId).toBeNull();
  });
});

// =============================================================================
// ARCAAI CLINICAL PROMPT LIBRARY
// =============================================================================

describe('ArcaAI Clinical Prompt Library Seed Data', () => {
  const ARCAAI = SEED_CUSTOMER_TENANT_IDS.ARCAAI;

  it('should define 23 templates (11 departments × 2 visit types + 1 shared pre-summary)', () => {
    // 22 = v1's `DEPT_VISIT_SCHEMAS` cardinality, department-for-department.
    expect(ARCAAI_CLINICAL_TEMPLATES.length).toBe(23);
    expect(ARCAAI_CLINICAL_TEMPLATES.filter((t) => t.id !== ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY)).toHaveLength(22);
  });

  it('should own every template + version by the ArcaAI tenant', () => {
    ARCAAI_CLINICAL_TEMPLATES.forEach((t) => expect(t.tenantId).toBe(ARCAAI));
    ARCAAI_CLINICAL_VERSIONS.forEach((v) => expect(v.tenantId).toBe(ARCAAI));
  });

  it('should seed every template APPROVED, SUMMARY, and pinned at the approved version', () => {
    ARCAAI_CLINICAL_TEMPLATES.forEach((t) => {
      expect(t.status).toBe('APPROVED');
      expect(t.category).toBe('SUMMARY');
      expect(t.currentVersionNumber).toBe(ARCAAI_CLINICAL_APPROVED_VERSION);
      expect(t.approvedVersionNumber).toBe(ARCAAI_CLINICAL_APPROVED_VERSION);
    });
  });

  it('should scope the 22 department templates DEPARTMENT_DEFAULT and the pre-summary TENANT_DEFAULT', () => {
    const preSummary = ARCAAI_CLINICAL_TEMPLATES.find((t) => t.id === ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY);
    expect(preSummary?.scope).toBe('TENANT_DEFAULT');
    expect(preSummary?.departmentId).toBeNull();
    ARCAAI_CLINICAL_TEMPLATES.filter((t) => t.id !== ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY).forEach((t) => {
      expect(t.scope).toBe('DEPARTMENT_DEFAULT');
      expect(t.departmentId).not.toBeNull();
    });
  });

  it('should carry non-empty verbatim content on every template', () => {
    ARCAAI_CLINICAL_TEMPLATES.forEach((t) => {
      expect(typeof t.content).toBe('string');
      expect(t.content.length).toBeGreaterThan(0);
    });
  });

  it('should have unique template ids, all in the ArcaAI 71…-0001- block', () => {
    const ids = ARCAAI_CLINICAL_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => {
      expect(id).toMatch(UUID_REGEX);
      expect(id.startsWith('71000000-0000-0000-0001-')).toBe(true);
    });
  });

  it('should keep every version per template — v1 and v2 retained, v3 approved', () => {
    // Older versions are not replaced by newer ones; they stay seeded so the
    // approved pin is a one-field rollback with no content to restore.
    const SEEDED_VERSIONS = [1, 2, 3];
    expect(ARCAAI_CLINICAL_APPROVED_VERSION).toBe(3);
    expect(ARCAAI_CLINICAL_VERSIONS.length).toBe(ARCAAI_CLINICAL_TEMPLATES.length * SEEDED_VERSIONS.length);

    const byTemplate = new Map<string, number[]>();
    ARCAAI_CLINICAL_VERSIONS.forEach((v) => byTemplate.set(v.promptTemplateId, [...(byTemplate.get(v.promptTemplateId) ?? []), v.versionNumber]));
    expect(byTemplate.size).toBe(ARCAAI_CLINICAL_TEMPLATES.length);
    byTemplate.forEach((versions) => expect([...versions].sort()).toEqual(SEEDED_VERSIONS));

    // Version ids are unique, and carry the version number in the third UUID
    // group (v1 keeps its original `…-0000-0001-…` mirror slot).
    const ids = ARCAAI_CLINICAL_VERSIONS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    ARCAAI_CLINICAL_VERSIONS.forEach((v) => {
      const group = v.versionNumber === 1 ? '0000' : String(v.versionNumber).padStart(4, '0');
      expect(v.id.startsWith(`72000000-0000-${group}-0001-`)).toBe(true);
      expect(v.content.length).toBeGreaterThan(0);
    });

    // v1 differs from every later version for every template.
    byTemplate.forEach((_versions, templateId) => {
      const [v1, ...later] = [1, 2, 3].map((n) => ARCAAI_CLINICAL_VERSIONS.find((v) => v.promptTemplateId === templateId && v.versionNumber === n)!.content);
      later.forEach((body, i) => expect(body, `v${i + 2} of ${templateId} is byte-identical to v1`).not.toBe(v1));
    });

    // v3 vs v2 is DELIBERATELY asymmetric, and this asserts it rather than
    // letting it drift unnoticed: the v3 release changed ONLY the pre-summary.
    // The 22 department bodies are byte-identical to v2 — v3's own version
    // history credits itself with the RULE 6 ASR-repair rewrite, but that text
    // was already present in the v2 corpus, so there is nothing new to seed for
    // them. They are still versioned to 3 because the corpus ships as a matched
    // set: the department prompts depend on the v3 pre-summary's `(recorded …)`
    // stamp to tell history from what was said today, so a single uniform pin
    // keeps the pair from being rolled back independently.
    const differsFromV2 = ARCAAI_CLINICAL_TEMPLATES.filter((t) => {
      const [v2, v3] = [2, 3].map((n) => ARCAAI_CLINICAL_VERSIONS.find((v) => v.promptTemplateId === t.id && v.versionNumber === n)!.content);
      return v2 !== v3;
    }).map((t) => t.id);
    expect(differsFromV2).toEqual([ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY]);

    // The template's mutable `content` column mirrors the APPROVED version.
    const approvedById = new Map(ARCAAI_CLINICAL_VERSIONS.filter((v) => v.versionNumber === ARCAAI_CLINICAL_APPROVED_VERSION).map((v) => [v.promptTemplateId, v.content]));
    ARCAAI_CLINICAL_TEMPLATES.forEach((t) => expect(t.content).toBe(approvedById.get(t.id)));

    // ...and v1 still holds the v1 body, byte-for-byte.
    const v1ById = new Map(ARCAAI_CLINICAL_VERSIONS.filter((v) => v.versionNumber === 1).map((v) => [v.promptTemplateId, v.content]));
    expect(v1ById.get(ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY)).toBe(PRE_SUMMARY_CONTENT);
    expect(v1ById.get(ARCAAI_CLINICAL_TEMPLATE_IDS.SURGERY_NEW_REFERRAL)).toBe(SURGERY_NEW_REFERRAL_CONTENT);
  });

  it.each([2, 3])('should carry the source-of-truth protocol on every v%i department prompt', (versionNumber) => {
    // The defect v2 introduced Block A to close, and v3 keeps: prior case-note
    // content restyled as today's findings. It must be present and identical in
    // all 22 department prompts of the version.
    const blockA = new Set<string>();
    const prompts = ARCAAI_CLINICAL_VERSIONS.filter((v) => v.versionNumber === versionNumber && v.promptTemplateId !== ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY);
    expect(prompts).toHaveLength(22);
    prompts.forEach((v) => {
      const match = /=== SOURCE-OF-TRUTH PROTOCOL[\s\S]*?=== END SOURCE-OF-TRUTH PROTOCOL ===/.exec(v.content);
      expect(match, `no SOURCE-OF-TRUTH PROTOCOL block in ${v.promptTemplateId}`).not.toBeNull();
      blockA.add(match![0]);
      expect(v.content).toContain('SOURCE:');
    });
    expect(blockA.size, 'Block A must be byte-identical across all 22 department prompts').toBe(1);
  });

  it.each([2, 3])('should keep the v%i pre-summary literal and its parsing contracts intact', (versionNumber) => {
    const preSummary = ARCAAI_CLINICAL_VERSIONS.find((v) => v.versionNumber === versionNumber && v.promptTemplateId === ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY);
    expect(preSummary).toBeDefined();

    // The five FORMAT titles are title-matched by PRE_SUMMARY_DISPLAY_TITLES;
    // renaming one returns an EMPTY structured_data.sections.
    [
      'Confirmed & Provisional Diagnoses:',
      'Investigations (Latest Dept Note):',
      'Diagnostics & Trends:',
      'Plan of Care (Latest Dept Note):',
      'Medications Prescribed (Latest Dept Note):',
    ].forEach((title) => expect(preSummary!.content).toContain(`- ${title}`));

    // The nine single-brace placeholders survive (markdown escaped them in the
    // source; extraction unescapes). A lost placeholder ships a literal brace.
    // v3 makes the pre-summary English-only but RETAINS {language_name}, so the
    // contract with renderPreSummaryTemplate is unchanged across versions.
    ['current_department', 'visit_type', 'safe_age', 'safe_dob', 'safe_gender', 'safe_vitals', 'formatted_test_results', 'formatted_previous_visits', 'language_name'].forEach((name) =>
      expect(preSummary!.content).toContain(`{${name}}`),
    );

    // The pre-summary reads typed EMR text, not ASR output — the RULE 6
    // terminology-repair licence must NOT leak into it.
    expect(preSummary!.content).not.toContain('=== SOURCE-OF-TRUTH PROTOCOL');
  });

  it('should require annotated ASR name repair on every v3 department prompt', () => {
    // v3 RULE 6 requires repairing mangled names ("shell cal" → Shelcal), and
    // the `(transcribed as "…")` annotation is the entire safety argument for
    // permitting repair at all — it must not be dropped from any prompt.
    ARCAAI_CLINICAL_VERSIONS.filter((v) => v.versionNumber === 3 && v.promptTemplateId !== ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY).forEach((v) => {
      expect(v.content, `no ASR repair annotation form in ${v.promptTemplateId}`).toContain('transcribed as');
    });
  });

  it('should split provenance from event dating in the v3 pre-summary', () => {
    // The v3 pre-summary defect: one date parenthesis meant both "filed on" and
    // "measured on", so an old result inside a recent note read as new.
    const v3 = ARCAAI_CLINICAL_VERSIONS.find((v) => v.versionNumber === 3 && v.promptTemplateId === ARCAAI_CLINICAL_TEMPLATE_IDS.PRE_SUMMARY);
    expect(v3).toBeDefined();
    ['Provenance date', 'Event date', '(recorded '].forEach((marker) => expect(v3!.content).toContain(marker));
  });

  it('should not seed author FILE METADATA comments into any ArcaAI prompt body', () => {
    // PRE_SUMMARY_PROMPT_v3.md prefixes the source file with an HTML comment
    // titled "FILE METADATA — DO NOT PASTE INTO HOPE". That annotation is for
    // authors/generators, not the model. Extraction must strip it. Department
    // bodies are fence-extracted and never contained it; this still scans every
    // seeded version so a later corpus cannot leak it unnoticed.
    [...ARCAAI_CLINICAL_VERSIONS, ...ARCAAI_CLINICAL_TEMPLATES].forEach((row) => {
      expect(row.content, `FILE METADATA leaked into ${'promptTemplateId' in row ? row.promptTemplateId : row.id}`).not.toContain(
        'FILE METADATA',
      );
      expect(row.content).not.toContain('DO NOT PASTE INTO HOPE');
    });
  });
});

// =============================================================================
// DEPARTMENT PROMPT CONFIGURATION
// =============================================================================

describe('Department Prompt Configuration', () => {
  const VALID_SUMMARY_TEMPLATES = ['SOAP', 'Progress-Note', 'ED-Encounter', 'Periop-Assessment', 'Imaging-Report', 'Lab-Report', 'Behavioral-Assessment', 'Pediatric-SOAP'];

  const VALID_ABBREVIATION_DENSITIES = ['low', 'medium', 'high'];

  describe('Schema Field Presence', () => {
    it('should have defaultSummaryTemplate on every department', () => {
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        expect(dept).toHaveProperty('defaultSummaryTemplate');
      });
    });

    it('should have newPatientPromptId on every department', () => {
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        expect(dept).toHaveProperty('newPatientPromptId');
      });
    });

    it('should have revisitPromptId on every department', () => {
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        expect(dept).toHaveProperty('revisitPromptId');
      });
    });

    it('should have promptConfig on every department', () => {
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        expect(dept).toHaveProperty('promptConfig');
      });
    });

    it('should have preSummaryPromptId on every department', () => {
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        expect(dept).toHaveProperty('preSummaryPromptId');
      });
    });
  });

  describe('Unified Pre-Summary Template', () => {
    // Pre-summary has NO department axis and NO visit-type axis — v1
    // has exactly ONE pre-summary prompt per tenant, with department and visit
    // type as VARIABLES inside it. Pointing every department at the unified
    // template was harmless-looking but re-created the category error that let
    // the department-agent tier hijack pre-summary (D-01/D-03), and left 18
    // inert overrides the resolver no longer reads. The tenant-wide template is
    // reached through the resolver's tenant tier, not through a per-department
    // column, so this column must stay NULL — otherwise a re-seed silently
    // restores the overrides after they are cleared.
    it('should NOT department-scope the pre-summary prompt on any default department', () => {
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        expect(dept.preSummaryPromptId, `${dept.code} must not department-scope pre-summary`).toBeNull();
      });
    });

    it('still seeds the unified PRE_SUMMARY_DEFAULT template itself (reached via the resolver tenant tier)', () => {
      const preSummary = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.PRE_SUMMARY_DEFAULT);
      expect(preSummary).toBeDefined();
    });
  });

  describe('Summary Templates', () => {
    it('should have a non-empty template for every department', () => {
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        expect(dept.defaultSummaryTemplate).toBeTruthy();
        expect(typeof dept.defaultSummaryTemplate).toBe('string');
        expect(dept.defaultSummaryTemplate!.length).toBeGreaterThan(0);
      });
    });

    it('should only use known template values', () => {
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        expect(VALID_SUMMARY_TEMPLATES).toContain(dept.defaultSummaryTemplate);
      });
    });

    it('should map each care setting to its documentation format', () => {
      const EXPECTED: Record<string, string> = {
        OPD: 'SOAP',
        IPD: 'Progress-Note',
        ER: 'ED-Encounter',
        PERI: 'Periop-Assessment',
        RAD: 'Imaging-Report',
        LAB: 'Lab-Report',
        BEH: 'Behavioral-Assessment',
        PEDS: 'Pediatric-SOAP',
      };
      Object.entries(EXPECTED).forEach(([code, template]) => {
        const dept = DEFAULT_DEPARTMENTS.find((d) => d.code === code);
        expect(dept, `department ${code} missing`).toBeDefined();
        expect(dept?.defaultSummaryTemplate).toBe(template);
      });
    });
  });

  describe('Prompt IDs', () => {
    // Every care setting has a NEW-encounter body. Only the settings with a
    // genuine longitudinal follow-up have a revisit body; a single-episode
    // setting (ER) and the two report-producing services (RAD, LAB) do not.
    const DEPTS_WITH_REVISIT = ['OPD', 'IPD', 'PERI', 'BEH', 'PEDS'];
    const DEPTS_WITHOUT_REVISIT = ['ER', 'RAD', 'LAB'];

    it('should have a non-null newPatientPromptId on every care setting', () => {
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        expect(dept.newPatientPromptId, `${dept.code} has no new-encounter prompt`).not.toBeNull();
      });
    });

    it('should have a revisit prompt for longitudinal care settings', () => {
      DEPTS_WITH_REVISIT.forEach((code) => {
        const dept = DEFAULT_DEPARTMENTS.find((d) => d.code === code);
        expect(dept).toBeDefined();
        expect(dept?.revisitPromptId, `${code} should have a revisit prompt`).not.toBeNull();
      });
    });

    it('should have no revisit prompt for single-episode / report-producing settings', () => {
      DEPTS_WITHOUT_REVISIT.forEach((code) => {
        const dept = DEFAULT_DEPARTMENTS.find((d) => d.code === code);
        expect(dept).toBeDefined();
        expect(dept?.revisitPromptId, `${code} should not have a revisit prompt`).toBeNull();
      });
    });
  });

  describe('Prompt Config Structure', () => {
    it('should have an object for promptConfig on every department', () => {
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        expect(dept.promptConfig).toBeDefined();
        expect(typeof dept.promptConfig).toBe('object');
        expect(dept.promptConfig).not.toBeNull();
      });
    });

    it('should have contextVariables array in every promptConfig', () => {
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        expect(Array.isArray(dept.promptConfig!.contextVariables)).toBe(true);
        expect(dept.promptConfig!.contextVariables.length).toBeGreaterThan(0);
      });
    });

    it('should have preferredSections array in every promptConfig', () => {
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        expect(Array.isArray(dept.promptConfig!.preferredSections)).toBe(true);
        expect(dept.promptConfig!.preferredSections.length).toBeGreaterThan(0);
      });
    });

    it('should have valid abbreviationDensity in every promptConfig', () => {
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        expect(VALID_ABBREVIATION_DENSITIES).toContain(dept.promptConfig!.abbreviationDensity);
      });
    });

    it('should include "Recent Vitals" in context variables for clinical departments', () => {
      const clinicalDepts = ['OPD', 'IPD', 'PERI', 'PEDS', 'ER'];
      clinicalDepts.forEach((code) => {
        const dept = DEFAULT_DEPARTMENTS.find((d) => d.code === code);
        expect(dept?.promptConfig!.contextVariables).toContain('Recent Vitals');
      });
    });

    it('should include "PREVIOUS CASE NOTES SUMMARY" for consultation-based departments', () => {
      const consultDepts = ['OPD', 'IPD', 'PERI', 'BEH', 'PEDS'];
      consultDepts.forEach((code) => {
        const dept = DEFAULT_DEPARTMENTS.find((d) => d.code === code);
        expect(dept?.promptConfig!.contextVariables).toContain('PREVIOUS CASE NOTES SUMMARY');
      });
    });

    it('should have setting-specific context variables', () => {
      const rad = DEFAULT_DEPARTMENTS.find((d) => d.code === 'RAD');
      expect(rad?.promptConfig!.contextVariables).toContain('Prior Imaging');

      const peds = DEFAULT_DEPARTMENTS.find((d) => d.code === 'PEDS');
      expect(peds?.promptConfig!.contextVariables).toContain('Growth Chart');
      expect(peds?.promptConfig!.contextVariables).toContain('Immunization History');

      const beh = DEFAULT_DEPARTMENTS.find((d) => d.code === 'BEH');
      expect(beh?.promptConfig!.contextVariables).toContain('Risk Assessment');
    });
  });

  describe('Abbreviation Density Alignment', () => {
    it('should have high abbreviation density for technical departments', () => {
      const highAbbrevDepts = ['RAD', 'LAB', 'ER'];
      highAbbrevDepts.forEach((code) => {
        const dept = DEFAULT_DEPARTMENTS.find((d) => d.code === code);
        expect(dept?.promptConfig!.abbreviationDensity).toBe('high');
      });
    });

    it('should have low abbreviation density for narrative-heavy departments', () => {
      const lowAbbrevDepts = ['OPD', 'BEH', 'PEDS'];
      lowAbbrevDepts.forEach((code) => {
        const dept = DEFAULT_DEPARTMENTS.find((d) => d.code === code);
        expect(dept?.promptConfig!.abbreviationDensity).toBe('low');
      });
    });

    it('should have medium abbreviation density for mixed departments', () => {
      const mediumAbbrevDepts = ['IPD', 'PERI'];
      mediumAbbrevDepts.forEach((code) => {
        const dept = DEFAULT_DEPARTMENTS.find((d) => d.code === code);
        expect(dept?.promptConfig!.abbreviationDensity).toBe('medium');
      });
    });
  });

  describe('Integration with Existing Fields', () => {
    it('should preserve all required fields alongside prompt fields', () => {
      const allRequiredFields = [
        'id',
        'tenantId',
        'code',
        'name',
        'description',
        'defaultSummaryTemplate',
        'preSummaryPromptId',
        'newPatientPromptId',
        'revisitPromptId',
        'promptConfig',
      ];
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        allRequiredFields.forEach((field) => {
          expect(dept).toHaveProperty(field);
        });
      });
    });

    it('should have 8 departments after prompt config addition', () => {
      expect(DEFAULT_DEPARTMENTS.length).toBe(8);
    });

    it('should have default tenant ID for all departments', () => {
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        expect(dept.tenantId).toBe(DEFAULT_TENANT_ID);
      });
    });
  });
});

// =============================================================================
// STT SEED DATA TESTS
// =============================================================================

describe('STT Seed Data', () => {
  describe('AI Models Seed Data', () => {
    describe('Structure', () => {
      it('should have required fields for each AI model', () => {
        const requiredFields = [
          'id',
          'tenantId',
          'name',
          'slug',
          'description',
          'category',
          'taskType',
          'modelType',
          'source',
          'sourceUri',
          'format',
          'tags',
        ];
        DEFAULT_AI_MODELS.forEach((model) => {
          requiredFields.forEach((field) => {
            expect(model).toHaveProperty(field);
          });
        });
      });

      it('should have valid UUID format for all model IDs', () => {
        DEFAULT_AI_MODELS.forEach((model) => {
          expect(model.id).toMatch(UUID_REGEX);
        });
      });

      it('should have unique model IDs', () => {
        const ids = DEFAULT_AI_MODELS.map((m) => m.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('should have unique model slugs within tenant', () => {
        const slugsByTenant = new Map<string, Set<string>>();
        DEFAULT_AI_MODELS.forEach((model) => {
          const tenantId = model.tenantId;
          if (!slugsByTenant.has(tenantId)) {
            slugsByTenant.set(tenantId, new Set());
          }
          const slugs = slugsByTenant.get(tenantId)!;
          expect(slugs.has(model.slug)).toBe(false);
          slugs.add(model.slug);
        });
      });

      it('should use system tenant ID for all platform-wide AI models', () => {
        // System AI models are platform-wide seeds owned by the
        // reserved system tenant (`00000000-…`).
        DEFAULT_AI_MODELS.forEach((model) => {
          expect(model.tenantId).toBe(SYSTEM_TENANT_ID);
        });
      });
    });

    describe('Model Categories', () => {
      it('should have valid category for all models (AUDIO, NLP or VISION)', () => {
        // VISION added vision-language model catalog rows.
        const validCategories = [ModelCategory.AUDIO, ModelCategory.NLP, ModelCategory.VISION];
        DEFAULT_AI_MODELS.forEach((model) => {
          expect(validCategories).toContain(model.category);
        });
      });

      it('should have valid task types', () => {
        const validTaskTypes = Object.values(ModelTaskType);
        DEFAULT_AI_MODELS.forEach((model) => {
          expect(validTaskTypes).toContain(model.taskType);
        });
      });

      it('should have valid model types', () => {
        const validModelTypes = Object.values(ModelType);
        DEFAULT_AI_MODELS.forEach((model) => {
          expect(validModelTypes).toContain(model.modelType);
        });
      });
    });

    describe('Model Sources', () => {
      it('should have valid model sources', () => {
        const validSources = Object.values(AiModelSource);
        DEFAULT_AI_MODELS.forEach((model) => {
          expect(validSources).toContain(model.source);
        });
      });

      it('should have valid model formats', () => {
        const validFormats = Object.values(AiModelFormat);
        DEFAULT_AI_MODELS.forEach((model) => {
          expect(validFormats).toContain(model.format);
        });
      });

      it('should have non-empty sourceUri', () => {
        DEFAULT_AI_MODELS.forEach((model) => {
          expect(model.sourceUri.length).toBeGreaterThan(0);
        });
      });
    });

    describe('ASR Models (consolidated keepers)', () => {
      it('should include Whisper Large V3 Turbo model', () => {
        const whisperTurbo = DEFAULT_AI_MODELS.find((m) => m.slug === 'whisper-large-v3-turbo');
        expect(whisperTurbo).toBeDefined();
        expect(whisperTurbo?.taskType).toBe(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION);
        expect(whisperTurbo?.source).toBe(AiModelSource.HUGGINGFACE);
        expect(whisperTurbo?.modelType).toBe(ModelType.QUANTIZED_MODEL);
      });

      it('should include Whisper Small model (lightweight pipeline)', () => {
        const whisperSmall = DEFAULT_AI_MODELS.find((m) => m.slug === 'whisper-small');
        expect(whisperSmall).toBeDefined();
        expect(whisperSmall?.taskType).toBe(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION);
      });

      it('should include the faster-whisper CT2 int8 model', () => {
        const ct2 = DEFAULT_AI_MODELS.find((m) => m.slug === 'faster-whisper-large-v3-turbo-int8');
        expect(ct2).toBeDefined();
        expect(ct2?.format).toBe(AiModelFormat.FASTER_WHISPER);
      });

      it('should include the Azure Speech + MAI-Transcribe cloud engines', () => {
        const azure = DEFAULT_AI_MODELS.find((m) => m.slug === 'azure-speech-stt');
        const mai = DEFAULT_AI_MODELS.find((m) => m.slug === 'mai-transcribe-1.5');
        expect(azure?.format).toBe(AiModelFormat.AZURE_SPEECH);
        expect(mai?.format).toBe(AiModelFormat.AZURE_FOUNDRY);
      });

      it('should include the parakeet.cpp Nemotron streaming model', () => {
        const nemotron = DEFAULT_AI_MODELS.find((m) => m.slug === 'nemotron-3.5-asr-streaming-0.6b');
        expect(nemotron).toBeDefined();
        expect(nemotron?.format).toBe(AiModelFormat.PARAKEET_CPP);
      });

      // The legacy ASR rows are RETIRED (soft-DELETED by
      // retireLegacyAiModels), no longer part of the seeded catalog.
      it.each(['whisper-large-v3', 'whisper-medium', 'faster-whisper-large-v3', 'parakeet-ctc-1.1b'])(
        'should NOT seed retired ASR model %s',
        (slug) => {
          expect(DEFAULT_AI_MODELS.find((m) => m.slug === slug)).toBeUndefined();
        },
      );
    });

    describe('Guardrail Models (Phase 1)', () => {
      it('exposes the GUARDRAIL task type + GGUF/MLX formats in the seed enum mirrors', () => {
        expect(ModelTaskType.GUARDRAIL).toBe('GUARDRAIL');
        expect(AiModelFormat.GGUF).toBe('GGUF');
        expect(AiModelFormat.MLX).toBe('MLX');
      });

      it('registers granite-guardian-4.1-8b under the SYSTEM tenant as a GUARDRAIL/GGUF model', () => {
        const granite = DEFAULT_AI_MODELS.find((m) => m.slug === 'granite-guardian-4.1-8b');
        expect(granite).toBeDefined();
        expect(granite?.tenantId).toBe(SYSTEM_TENANT_ID);
        expect(granite?.taskType).toBe(ModelTaskType.GUARDRAIL);
        expect(granite?.format).toBe(AiModelFormat.GGUF);
        expect(granite?.category).toBe(ModelCategory.NLP);
      });
    });

    describe('VAD Models', () => {
      it('should include the Silero VAD model (only remaining VAD; renamed v6→silero-vad to match the v5 runtime)', () => {
        const silero = DEFAULT_AI_MODELS.find((m) => m.slug === 'silero-vad');
        expect(silero).toBeDefined();
        expect(silero?.taskType).toBe(ModelTaskType.VOICE_ACTIVITY_DETECTION);
        // identity reconciled with the stt runtime loader.
        expect(silero?.sourceUri).toBe('onnx-community/silero-vad');
        // The old mislabelled slug is gone; v4/v5/pyannote stay retired.
        expect(DEFAULT_AI_MODELS.find((m) => m.slug === 'silero-vad-v6')).toBeUndefined();
        expect(DEFAULT_AI_MODELS.find((m) => m.slug === 'silero-vad-v4')).toBeUndefined();
        expect(DEFAULT_AI_MODELS.find((m) => m.slug === 'silero-vad-v5')).toBeUndefined();
        expect(DEFAULT_AI_MODELS.find((m) => m.slug === 'pyannote-vad')).toBeUndefined();
      });

      it('should have VAD models with low memory requirements', () => {
        const vadModels = DEFAULT_AI_MODELS.filter((m) => m.taskType === ModelTaskType.VOICE_ACTIVITY_DETECTION);
        expect(vadModels.length).toBeGreaterThanOrEqual(1);
        vadModels.forEach((model) => {
          expect(model.memorySizeMb).toBeLessThan(500);
        });
      });
    });

    describe('Noise Reduction Models', () => {
      it('should include the RNNoise model (only remaining denoiser)', () => {
        const rnnoise = DEFAULT_AI_MODELS.find((m) => m.slug === 'rnnoise');
        expect(rnnoise).toBeDefined();
        expect(rnnoise?.taskType).toBe(ModelTaskType.AUDIO_TO_AUDIO);
        expect(DEFAULT_AI_MODELS.find((m) => m.slug === 'deepfilternet-v3')).toBeUndefined();
        expect(DEFAULT_AI_MODELS.find((m) => m.slug === 'nvidia-cleanunet')).toBeUndefined();
      });
    });
  });

  describe('ASR Pipelines Seed Data', () => {
    describe('Structure', () => {
      it('should have required fields for each pipeline', () => {
        const requiredFields = ['id', 'tenantId', 'name', 'slug', 'description', 'configYaml', 'tags'];
        DEFAULT_ASR_PIPELINES.forEach((pipeline) => {
          requiredFields.forEach((field) => {
            expect(pipeline).toHaveProperty(field);
          });
        });
      });

      it('should have valid UUID format for all pipeline IDs', () => {
        DEFAULT_ASR_PIPELINES.forEach((pipeline) => {
          expect(pipeline.id).toMatch(UUID_REGEX);
        });
      });

      it('should have unique pipeline IDs', () => {
        const ids = DEFAULT_ASR_PIPELINES.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('should have unique pipeline slugs within tenant', () => {
        const slugsByTenant = new Map<string, Set<string>>();
        DEFAULT_ASR_PIPELINES.forEach((pipeline) => {
          const tenantId = pipeline.tenantId;
          if (!slugsByTenant.has(tenantId)) {
            slugsByTenant.set(tenantId, new Set());
          }
          const slugs = slugsByTenant.get(tenantId)!;
          expect(slugs.has(pipeline.slug)).toBe(false);
          slugs.add(pipeline.slug);
        });
      });
    });

    describe('Pipeline Configuration', () => {
      it('should have non-empty configYaml', () => {
        DEFAULT_ASR_PIPELINES.forEach((pipeline) => {
          expect(pipeline.configYaml.length).toBeGreaterThan(100);
        });
      });

      it('should have valid YAML structure with version', () => {
        DEFAULT_ASR_PIPELINES.forEach((pipeline) => {
          expect(pipeline.configYaml).toContain('version:');
        });
      });

      it('should have models section in configYaml', () => {
        DEFAULT_ASR_PIPELINES.forEach((pipeline) => {
          expect(pipeline.configYaml).toContain('models:');
          expect(pipeline.configYaml).toContain('asr:');
        });
      });

      it('should have preprocessing section in configYaml', () => {
        DEFAULT_ASR_PIPELINES.forEach((pipeline) => {
          expect(pipeline.configYaml).toContain('preprocessing:');
        });
      });

      it('should have inference section in configYaml', () => {
        DEFAULT_ASR_PIPELINES.forEach((pipeline) => {
          expect(pipeline.configYaml).toContain('inference:');
        });
      });

      it('should reference valid model slugs in configYaml', () => {
        const modelSlugs = DEFAULT_AI_MODELS.map((m) => m.slug);
        DEFAULT_ASR_PIPELINES.forEach((pipeline) => {
          const asrMatch = pipeline.configYaml.match(/asr:\s*"([^"]+)"/);
          if (asrMatch) {
            expect(modelSlugs).toContain(asrMatch[1]);
          }
          const vadMatch = pipeline.configYaml.match(/vad:\s*"([^"]+)"/);
          if (vadMatch) {
            expect(modelSlugs).toContain(vadMatch[1]);
          }
          const denoiseMatch = pipeline.configYaml.match(/denoise:\s*"([^"]+)"/);
          if (denoiseMatch) {
            expect(modelSlugs).toContain(denoiseMatch[1]);
          }
        });
      });

      // The realtime/streaming pipelines activate the
      // LocalAgreement-2 commit policy so partials carry `stable_chars`
      // and the already-built (but previously dormant) tentative-tail
      // render lights up. Asserted across every tenant variant that shares
      // the realtime/turbo configYaml (system + ArcaAI customer + Global).
      it('should activate LocalAgreement-2 commit policy on the realtime + turbo streaming pipelines', () => {
        // best-practice-realtime retired; the matrix
        // streaming pipelines carry LA-2.
        const streamingSlugs = ['turbo-whisper-large-v3', 'whisper-turbo-no-postprocessing', 'whisper-turbo-no-preprocessing'];
        const allPipelines = [...DEFAULT_ASR_PIPELINES, ...CUSTOMER_TENANT_ASR_PIPELINES, ...GLOBAL_TENANT_ASR_PIPELINES];
        const realtimeRows = allPipelines.filter((p) => streamingSlugs.includes(p.slug));

        // system #3 + #4 + system/ArcaAI/Global turbo => >= 5 rows.
        expect(realtimeRows.length).toBeGreaterThanOrEqual(5);
        realtimeRows.forEach((pipeline) => {
          // A top-level `streaming:` mapping whose commit_policy activates
          // LocalAgreement-2 (YAML comments between the keys are ignored
          // by the parser, so match the block non-adjacently).
          expect(pipeline.configYaml).toContain('streaming:');
          expect(pipeline.configYaml).toMatch(/streaming:[\s\S]*?commit_policy:\s*local_agreement_2/);
        });
      });
    });

    describe('Default Pipelines', () => {
      it('should include production pipeline', () => {
        const production = DEFAULT_ASR_PIPELINES.find((p) => p.slug === 'production-whisper-large-v3');
        expect(production).toBeDefined();
        expect(production?.tags).toContain('high-quality');
      });

      // arcaai-whisper-large-ml-en-gguf is the platform default: the generic
      // whisper-turbo GGUF pinned to ml hallucinated on Malayalam, so the
      // in-house ml-en code-switch fine-tune is the default and carries the
      // 'production'/'recommended' tags.
      it('should make the ArcaAI ml-en GGUF fine-tune the default', () => {
        const arcaaiDefault = DEFAULT_ASR_PIPELINES.find((p) => p.slug === 'arcaai-whisper-large-ml-en-gguf');
        expect(arcaaiDefault).toBeDefined();
        expect(arcaaiDefault?.isDefault).toBe(true);
        expect(arcaaiDefault?.tags).toContain('production');
        expect(arcaaiDefault?.tags).toContain('recommended');
        // The generic whisper-turbo GGUF is registered but no longer default.
        const genericGguf = DEFAULT_ASR_PIPELINES.find((p) => p.slug === 'production-whisper-large-v3-turbo-gguf');
        expect(genericGguf?.isDefault).toBe(false);
      });

      // The DEFAULT (isDefault) pipeline must also carry the
      // LocalAgreement-2 streaming block (parity with best-practice-realtime /
      // turbo), so the tentative-tail render is active on the default
      // clinician streaming path, not only when an explicit realtime pipeline is
      // selected. Streaming-only; batch use is unaffected.
      it('should activate LocalAgreement-2 on the default (production) streaming pipeline', () => {
        const production = DEFAULT_ASR_PIPELINES.find((p) => p.slug === 'production-whisper-large-v3');
        expect(production).toBeDefined();
        expect(production?.configYaml).toContain('streaming:');
        expect(production?.configYaml).toMatch(/streaming:[\s\S]*?commit_policy:\s*local_agreement_2/);
      });

      it('should include turbo pipeline for streaming', () => {
        const turbo = DEFAULT_ASR_PIPELINES.find((p) => p.slug === 'turbo-whisper-large-v3');
        expect(turbo).toBeDefined();
        expect(turbo?.tags).toContain('streaming');
        expect(turbo?.tags).toContain('fast');
      });

      it('SYSTEM catalog has exactly 14 base pipelines with one isDefault', () => {
        // 9 pipelines + 2 cloud BYOK
        // fallback candidates (sarvam-transcription, openai-transcription)
        // + 3 ArcaAI ML-EN code-switch (GGUF f16 + GGUF q8_0 + transformer).
        expect(DEFAULT_ASR_PIPELINES).toHaveLength(14);
        const defaults = DEFAULT_ASR_PIPELINES.filter((p) => p.isDefault === true);
        expect(defaults).toHaveLength(1);
        expect(defaults[0]?.slug).toBe('arcaai-whisper-large-ml-en-gguf');
        // Retired from the product matrix.
        const slugs = DEFAULT_ASR_PIPELINES.map((p) => p.slug);
        expect(slugs).not.toContain('lightweight-whisper-small');
        expect(slugs).not.toContain('code-switching-en-vi-template');
        expect(slugs).not.toContain('asr-en-template');
        expect(slugs).not.toContain('asr-ml-template');
      });

      // =================================================================
      // Template lineage. The 9 SYSTEM rows ARE the
      // templates; every tenant row seeded from them is a locked copy.
      // =================================================================

      it('ASR_TEMPLATE_SLUGS set-equals the SYSTEM catalog slugs', () => {
        expect([...ASR_TEMPLATE_SLUGS].sort()).toEqual(DEFAULT_ASR_PIPELINES.map((p) => p.slug).sort());
      });

      it('SYSTEM template rows are never locked and carry no lineage', () => {
        DEFAULT_ASR_PIPELINES.forEach((pipeline) => {
          expect(pipeline.templateLocked ?? false).toBe(false);
          expect(pipeline.sourceTemplateSlug ?? null).toBeNull();
        });
      });

      it('every seeded tenant pipeline is a locked copy with template lineage', () => {
        // Tenant-only pipelines backfilled from live admin-console creations
        // (ARCAAI_MANUAL_ASR_PIPELINES / GLOBAL_MANUAL_ASR_PIPELINES in
        // 06-stt.ts) are experiments/clones observed as UNLOCKED in the
        // cluster, not SYSTEM-template copies — excluded from this
        // invariant on purpose (see the full-parity exception list above).
        const MANUAL_TENANT_ONLY_SLUGS = new Set([
          'experiment-arcaai-whisper-large-ml-en-ct2',
          'arcaai-whisper-large-ml-en-gguf-copy',
          'whisper-large-en-medical-260726-merged-gguf',
          'whisper-large-en-medical-260726-merged-ct2',
        ]);
        const tenantRows = [...CUSTOMER_TENANT_ASR_PIPELINES, ...GLOBAL_TENANT_ASR_PIPELINES].filter(
          (p) => !MANUAL_TENANT_ONLY_SLUGS.has(p.slug),
        );
        expect(tenantRows.length).toBeGreaterThan(0);

        tenantRows.forEach((pipeline) => {
          expect(pipeline.templateLocked).toBe(true);
          expect(ASR_TEMPLATE_SLUGS).toContain(pipeline.sourceTemplateSlug);
          // Lineage points at the template the row was cloned from,
          // which is the row's own slug for seed-provisioned copies.
          expect(pipeline.sourceTemplateSlug).toBe(pipeline.slug);
        });
      });

      it('should include the matrix pipelines', () => {
        const slugs = DEFAULT_ASR_PIPELINES.map((p) => p.slug);
        [
          'whisper-turbo-no-postprocessing',
          'whisper-turbo-no-preprocessing',
          'azure-speech-transcription',
          'azure-foundry-mai-transcribe',
          'parakeet-nemotron-streaming',
        ].forEach((slug) => expect(slugs).toContain(slug));
      });
    });
  });

  describe('STT Global Settings Seed Data', () => {
    describe('Structure', () => {
      it('should have required fields for each setting', () => {
        const requiredFields = ['id', 'tenantId', 'namespace', 'name', 'key', 'value', 'dataType', 'description'];
        DEFAULT_STT_SETTINGS.forEach((setting) => {
          requiredFields.forEach((field) => {
            expect(setting).toHaveProperty(field);
          });
        });
      });

      it('should have valid UUID format for all setting IDs', () => {
        DEFAULT_STT_SETTINGS.forEach((setting) => {
          expect(setting.id).toMatch(UUID_REGEX);
        });
      });

      it('should have unique setting IDs', () => {
        const ids = DEFAULT_STT_SETTINGS.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('should use stt.config or platform namespace for all settings', () => {
        const validNamespaces = ['stt.config', 'platform'];
        DEFAULT_STT_SETTINGS.forEach((setting) => {
          expect(validNamespaces).toContain(setting.namespace);
        });
      });
    });

    describe('Setting Categories', () => {
      // The `model_cache` and `workers` GlobalSetting rows were
      // removed: they had no reader (stt's `GlobalSettingRead` mapping,
      // deleted) and are superseded by the registered settings keys
      // `stt.modelCache.*` / `stt.workers.concurrency`, served over the
      // internal effective-config route. These assertions now lock the
      // REMOVAL, so re-adding a dormant second config lane fails the suite.
      it('should NOT carry model cache settings (superseded by stt.modelCache.* registry keys)', () => {
        expect(DEFAULT_STT_SETTINGS.filter((s) => s.name === 'model_cache')).toHaveLength(0);
      });

      it('should NOT carry worker settings (superseded by stt.workers.concurrency)', () => {
        expect(DEFAULT_STT_SETTINGS.filter((s) => s.name === 'workers')).toHaveLength(0);
      });

      it('should include storage settings', () => {
        const storageSettings = DEFAULT_STT_SETTINGS.filter((s) => s.name === 'storage');
        expect(storageSettings.length).toBeGreaterThanOrEqual(2);
        const keys = storageSettings.map((s) => s.key);
        expect(keys).toContain('audio_bucket');
      });

      it('should include API gateway settings', () => {
        const gatewaySettings = DEFAULT_STT_SETTINGS.filter((s) => s.name === 'api_gateway');
        expect(gatewaySettings.length).toBeGreaterThanOrEqual(1);
        const keys = gatewaySettings.map((s) => s.key);
        expect(keys).toContain('base_url');
      });

      it('should include default pipeline settings', () => {
        const defaultSettings = DEFAULT_STT_SETTINGS.filter((s) => s.name === 'defaults');
        expect(defaultSettings.length).toBeGreaterThanOrEqual(2);
        const keys = defaultSettings.map((s) => s.key);
        expect(keys).toContain('batch_pipeline_slug');
        expect(keys).toContain('streaming_pipeline_slug');
      });
    });

    describe('Default Values', () => {
      it('should have matching value and defaultValue for non-env settings', () => {
        const envDrivenKeys = ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'];
        DEFAULT_STT_SETTINGS.filter((s) => !envDrivenKeys.includes(s.key)).forEach((setting) => {
          expect(setting.value).toBe(setting.defaultValue);
        });
      });

      it('should reference valid pipeline slugs in default settings', () => {
        const pipelineSlugs = DEFAULT_ASR_PIPELINES.map((p) => p.slug);
        const batchDefault = DEFAULT_STT_SETTINGS.find((s) => s.key === 'batch_pipeline_slug');
        const streamingDefault = DEFAULT_STT_SETTINGS.find((s) => s.key === 'streaming_pipeline_slug');
        expect(batchDefault).toBeDefined();
        expect(streamingDefault).toBeDefined();
        expect(pipelineSlugs).toContain(batchDefault!.value);
        expect(pipelineSlugs).toContain(streamingDefault!.value);
      });
    });
  });

  describe('STT Seed Data Dependencies', () => {
    it('should have AI Models defined before Pipelines (dependency)', () => {
      const modelSlugs = DEFAULT_AI_MODELS.map((m) => m.slug);
      DEFAULT_ASR_PIPELINES.forEach((pipeline) => {
        const asrMatch = pipeline.configYaml.match(/asr:\s*"([^"]+)"/);
        const vadMatch = pipeline.configYaml.match(/vad:\s*"([^"]+)"/);
        const denoiseMatch = pipeline.configYaml.match(/denoise:\s*"([^"]+)"/);
        if (asrMatch) expect(modelSlugs).toContain(asrMatch[1]);
        if (vadMatch) expect(modelSlugs).toContain(vadMatch[1]);
        if (denoiseMatch) expect(modelSlugs).toContain(denoiseMatch[1]);
      });
    });

    it('should have Pipelines defined before Settings reference them (dependency)', () => {
      const pipelineSlugs = DEFAULT_ASR_PIPELINES.map((p) => p.slug);
      const defaultSettings = DEFAULT_STT_SETTINGS.filter((s) => s.name === 'defaults');
      defaultSettings.forEach((setting) => {
        if (setting.key.includes('pipeline_slug')) {
          expect(pipelineSlugs).toContain(setting.value);
        }
      });
    });
  });
});

// =============================================================================
// FULL-PARITY PIPELINE POLICY
//   Every customer-facing tenant (Global + ArcaAI) mirrors the FULL SYSTEM ASR
//   pipeline catalog — the same slug set as DEFAULT_ASR_PIPELINES — so a tenant
//   is never seeded a curated subset. Exactly one default per tenant preserved.
// =============================================================================

describe('Full-parity ASR pipeline catalog per customer tenant (policy)', () => {
  const systemSlugs = [...new Set(DEFAULT_ASR_PIPELINES.map((p) => p.slug))].sort();

  // Tenant-only pipelines backfilled from live admin-console creations
  // (formalized into ARCAAI_MANUAL_ASR_PIPELINES / GLOBAL_MANUAL_ASR_PIPELINES
  // in 06-stt.ts) are a deliberate, documented exception to full parity —
  // they are tenant-specific experiments/clones, not part of the SYSTEM
  // template catalog, so they never get mirrored to other tenants.
  const GLOBAL_TENANT_ONLY_SLUGS = ['experiment-arcaai-whisper-large-ml-en-ct2'];
  const ARCAAI_TENANT_ONLY_SLUGS = [
    'arcaai-whisper-large-ml-en-gguf-copy',
    'whisper-large-en-medical-260726-merged-gguf',
    'whisper-large-en-medical-260726-merged-ct2',
  ];

  it('gives the Global customer tenant the SAME slug set as SYSTEM (plus its documented tenant-only exceptions)', () => {
    const globalSlugs = [...new Set(GLOBAL_TENANT_ASR_PIPELINES.filter((p) => p.tenantId === SEED_TENANT_ID).map((p) => p.slug))].sort();
    expect(globalSlugs).toEqual([...systemSlugs, ...GLOBAL_TENANT_ONLY_SLUGS].sort());
  });

  it('gives the ArcaAI customer tenant the SAME slug set as SYSTEM (plus its documented tenant-only exceptions)', () => {
    const arcaaiSlugs = [
      ...new Set(CUSTOMER_TENANT_ASR_PIPELINES.filter((p) => p.tenantId === SEED_CUSTOMER_TENANT_IDS.ARCAAI).map((p) => p.slug)),
    ].sort();
    expect(arcaaiSlugs).toEqual([...systemSlugs, ...ARCAAI_TENANT_ONLY_SLUGS].sort());
  });

  it('keeps globally-unique IDs once every tenant carries the full catalog', () => {
    const ids = [...DEFAULT_ASR_PIPELINES, ...GLOBAL_TENANT_ASR_PIPELINES, ...CUSTOMER_TENANT_ASR_PIPELINES].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// =============================================================================
// PER-TENANT ASR PIPELINES + isDefault
// =============================================================================

describe('Per-Tenant ASR Pipelines', () => {
  const customerTenantIds = [SEED_CUSTOMER_TENANT_IDS.ARCAAI];

  it('should seed at least one ASR pipeline for each customer tenant (ArcaAI)', () => {
    customerTenantIds.forEach((tenantId) => {
      const count = CUSTOMER_TENANT_ASR_PIPELINES.filter((p) => p.tenantId === tenantId).length;
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });

  it('should bind every customer-tenant pipeline to a known customer tenant id', () => {
    CUSTOMER_TENANT_ASR_PIPELINES.forEach((p) => {
      expect(customerTenantIds).toContain(p.tenantId);
    });
  });

  it('should NOT own any customer-tenant pipeline by the system tenant', () => {
    CUSTOMER_TENANT_ASR_PIPELINES.forEach((p) => {
      expect(p.tenantId).not.toBe(SYSTEM_TENANT_ID);
    });
  });

  it('should have required fields + valid UUID for each customer-tenant pipeline', () => {
    const requiredFields = ['id', 'tenantId', 'name', 'slug', 'description', 'configYaml', 'tags'];
    CUSTOMER_TENANT_ASR_PIPELINES.forEach((p) => {
      requiredFields.forEach((field) => {
        expect(p).toHaveProperty(field);
      });
      expect(p.id).toMatch(UUID_REGEX);
      expect(p.configYaml.length).toBeGreaterThan(100);
    });
  });

  it('should keep pipeline IDs globally unique across system + customer pipelines', () => {
    const ids = [...DEFAULT_ASR_PIPELINES, ...CUSTOMER_TENANT_ASR_PIPELINES].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should keep slugs unique within each tenant (system + customer combined)', () => {
    const slugsByTenant = new Map<string, Set<string>>();
    [...DEFAULT_ASR_PIPELINES, ...CUSTOMER_TENANT_ASR_PIPELINES].forEach((pipeline) => {
      if (!slugsByTenant.has(pipeline.tenantId)) {
        slugsByTenant.set(pipeline.tenantId, new Set());
      }
      const slugs = slugsByTenant.get(pipeline.tenantId)!;
      expect(slugs.has(pipeline.slug)).toBe(false);
      slugs.add(pipeline.slug);
    });
  });
});

describe('ASR Pipeline isDefault invariant', () => {
  const allPipelines = [...DEFAULT_ASR_PIPELINES, ...CUSTOMER_TENANT_ASR_PIPELINES];
  const customerTenantIds = [SEED_CUSTOMER_TENANT_IDS.ARCAAI];

  it('should mark exactly ONE pipeline as isDefault:true per owning tenant', () => {
    const defaultsByTenant = new Map<string, number>();
    allPipelines.forEach((p) => {
      if (p.isDefault === true) {
        defaultsByTenant.set(p.tenantId, (defaultsByTenant.get(p.tenantId) ?? 0) + 1);
      }
    });

    const tenantsThatOwnPipelines = new Set(allPipelines.map((p) => p.tenantId));
    tenantsThatOwnPipelines.forEach((tenantId) => {
      expect(defaultsByTenant.get(tenantId)).toBe(1);
    });
  });

  it('should make the ArcaAI ml-en GGUF fine-tune the system isDefault one', () => {
    // The SYSTEM default is arcaai-whisper-large-ml-en-gguf (id …0018); the
    // generic whisper-turbo GGUF (id …0014, the former default) is registered
    // but no longer the seeded default.
    const systemDefault = DEFAULT_ASR_PIPELINES.find((p) => p.id === '81000000-0000-0000-0001-000000000018');
    expect(systemDefault).toBeDefined();
    expect(systemDefault?.slug).toBe('arcaai-whisper-large-ml-en-gguf');
    expect(systemDefault?.isDefault).toBe(true);

    // The former GGUF default is not a seeded default anymore, so there is exactly one.
    const oldDefault = DEFAULT_ASR_PIPELINES.find((p) => p.id === '81000000-0000-0000-0001-000000000014');
    expect(oldDefault?.slug).toBe('production-whisper-large-v3-turbo-gguf');
    expect(oldDefault?.isDefault).toBe(false);
  });

  it('should give each customer tenant exactly one isDefault pipeline', () => {
    customerTenantIds.forEach((tenantId) => {
      const defaults = CUSTOMER_TENANT_ASR_PIPELINES.filter((p) => p.tenantId === tenantId && p.isDefault === true);
      expect(defaults.length).toBe(1);
    });
  });

  it('should keep idempotency intent: never define two defaults for one tenant in the seed data', () => {
    // A re-run upserts by (tenantId, slug); the source data must therefore
    // never declare two isDefault rows for the same tenant, or a re-seed
    // could create two defaults.
    const defaultsByTenant = new Map<string, number>();
    allPipelines
      .filter((p) => p.isDefault === true)
      .forEach((p) => {
        defaultsByTenant.set(p.tenantId, (defaultsByTenant.get(p.tenantId) ?? 0) + 1);
      });
    defaultsByTenant.forEach((count) => {
      expect(count).toBeLessThanOrEqual(1);
    });
  });
});

// =============================================================================
// DEFAULT MODEL WIRING
//   (a) TEXT → gemma-4-e2b-it-qat via HarnessPolicy (GlobalSetting keys RETIRED)
//   (b) Guardrail → granite-guardian-4.1-8b via AiTaskDefault (keys RETIRED)
//   (c) STT → unchanged (CT2 registered; whisper-large-v3-turbo default)
// =============================================================================

// =============================================================================
// The nightly SYSTEM-template resync sweep is turned ON by
// a platform VALUE, not by flipping the registry default.
//
// The descriptor is a kill-switch, and the settings registry refuses at
// assembly to register a kill-switch that defaults ON (fail-safe governance).
// So the fail-safe default stays `false` and the deployment enables the sweep
// with a locked platform row — exactly the `enable-local-raw-capture` pattern:
// `value` is the live setting, `defaultValue` keeps the OFF fallback so a reset
// reverts to fail-safe, and `locked` restricts the flip to SUPER_ADMIN.
// =============================================================================

describe('nightly pipeline template resync is enabled by a platform setting', () => {
  const enabled = () => PLATFORM_SETTINGS.find((s) => s.key === 'pipeline.templateResync.enabled');
  const cron = () => PLATFORM_SETTINGS.find((s) => s.key === 'pipeline.templateResync.cron');

  it('seeds the sweep ON while keeping the fail-safe default OFF', () => {
    const row = enabled();
    expect(row).toBeDefined();
    expect(row?.value).toBe('true');
    // A reset must revert to the fail-safe, never to the live value.
    expect(row?.defaultValue).toBe('false');
    expect(row?.dataType).toBe('Boolean');
  });

  it('locks the sweep toggle to SUPER_ADMIN and owns it at the platform tenant', () => {
    expect(enabled()?.locked).toBe(true);
    expect(enabled()?.tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('seeds the schedule matching the service default (03:00 daily)', () => {
    expect(cron()?.value).toBe('0 3 * * *');
    expect(cron()?.tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('keys are unique across the platform rows (flat-by-key AppSettings cache)', () => {
    const keys = PLATFORM_SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('TEXT default moved off GlobalSetting (HarnessPolicy is authoritative)', () => {
  it('no longer seeds the default-text-provider / default-text-model GlobalSetting keys', () => {
    expect(ALL_SETTINGS.filter((s) => s.key === 'default-text-model')).toEqual([]);
    expect(ALL_SETTINGS.filter((s) => s.key === 'default-text-provider')).toEqual([]);
    expect(ALL_SETTINGS.filter((s) => s.key === 'text-provider-models')).toEqual([]);
  });

  it('keeps the non-secret text-azure-deployment key for every tenant', () => {
    const rows = ALL_SETTINGS.filter((s) => s.key === 'text-azure-deployment');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    rows.forEach((s) => expect(s.namespace).toBe('text'));
  });

  it('keeps the platform TEXT default model registered in the catalog (lms-gemma-4-e2b-it-qat)', () => {
    const row = DEFAULT_AI_MODELS.find((m) => m.slug === 'lms-gemma-4-e2b-it-qat');
    expect(row).toBeDefined();
    expect(row?.sourceUri).toBe('gemma-4-e2b-it-qat');
    expect(row?.tags).toContain('default');
    expect(row?.tags).toContain('summarization');
  });
});

describe('Guardrail default moved off GlobalSetting (AiTaskDefault is authoritative)', () => {
  it('no longer seeds the guardrail namespace GlobalSetting keys', () => {
    expect(ALL_SETTINGS.filter((s) => s.namespace === 'guardrail')).toEqual([]);
  });

  it('keeps the granite-guardian catalog row registered under SYSTEM (GUARDRAIL / GGUF / lm-studio)', () => {
    const granite = DEFAULT_AI_MODELS.find((m) => m.slug === 'granite-guardian-4.1-8b');
    expect(granite).toBeDefined();
    expect(granite?.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(granite?.taskType).toBe(ModelTaskType.GUARDRAIL);
    expect(granite?.format).toBe(AiModelFormat.GGUF);
    expect((granite as { provider?: string } | undefined)?.provider).toBe('lm-studio');
  });
});

describe('Phase 2 — STT default (CT2 registered; whisper.cpp GGUF effective default)', () => {
  const CT2_MODEL_SLUG = 'faster-whisper-large-v3-turbo-int8';
  const CT2_PIPELINE_SLUG = 'production-faster-whisper-turbo-int8';
  const DEFAULT_PIPELINE_SLUG = 'arcaai-whisper-large-ml-en-gguf';

  it('mirrors the CTRANSLATE2 format in the seed enum mirror', () => {
    expect(AiModelFormat.CTRANSLATE2).toBe('CTRANSLATE2');
  });

  it('registers the CT2 turbo AiModel under SYSTEM with the resolvable deepdml sourceUri', () => {
    const ct2 = DEFAULT_AI_MODELS.find((m) => m.slug === CT2_MODEL_SLUG);
    expect(ct2).toBeDefined();
    expect(ct2?.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(ct2?.category).toBe(ModelCategory.AUDIO);
    expect(ct2?.taskType).toBe(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION);
    expect(ct2?.modelType).toBe(ModelType.QUANTIZED_MODEL);
    expect(ct2?.format).toBe(AiModelFormat.FASTER_WHISPER);
    // Precision bumped int8 → float16 (CTranslate2's spelling;
    // NOT the ggml-style "f16" abbreviation — see resolve_ct2_compute_type).
    expect(ct2?.computeType).toBe('float16');
    // The CT2 artifact points at the real
    // deepdml conversion — resolvable at
    // runtime via FasterWhisperLoader.
    expect(ct2?.sourceUri).toBe('deepdml/faster-whisper-large-v3-turbo-ct2');
  });

  it('registers the CT2 pipeline as NOT default and keeps the whisper.cpp GGUF pipeline as the SYSTEM default', () => {
    const ct2 = DEFAULT_ASR_PIPELINES.find((p) => p.slug === CT2_PIPELINE_SLUG);
    expect(ct2).toBeDefined();
    expect(ct2?.isDefault).toBe(false);
    const production = DEFAULT_ASR_PIPELINES.find((p) => p.slug === DEFAULT_PIPELINE_SLUG);
    expect(production?.isDefault).toBe(true);
  });

  it('makes the whisper.cpp GGUF pipeline the isDefault one for SYSTEM, Global, and every customer tenant', () => {
    const groups = [DEFAULT_ASR_PIPELINES, GLOBAL_TENANT_ASR_PIPELINES, CUSTOMER_TENANT_ASR_PIPELINES];
    groups.forEach((group) => {
      const tenantIds = new Set(group.map((p) => p.tenantId));
      tenantIds.forEach((tenantId) => {
        const defaults = group.filter((p) => p.tenantId === tenantId && p.isDefault === true);
        expect(defaults.length).toBe(1);
        expect(defaults[0].slug).toBe(DEFAULT_PIPELINE_SLUG);
      });
    });
  });

  it('keeps exactly one isDefault pipeline per tenant across all pipeline groups', () => {
    const all = [...DEFAULT_ASR_PIPELINES, ...GLOBAL_TENANT_ASR_PIPELINES, ...CUSTOMER_TENANT_ASR_PIPELINES];
    const defaultsByTenant = new Map<string, number>();
    all.forEach((p) => {
      if (p.isDefault === true) {
        defaultsByTenant.set(p.tenantId, (defaultsByTenant.get(p.tenantId) ?? 0) + 1);
      }
    });
    new Set(all.map((p) => p.tenantId)).forEach((tenantId) => {
      expect(defaultsByTenant.get(tenantId)).toBe(1);
    });
  });

  it('points BOTH batch + streaming default pipeline slugs at production-whisper-large-v3', () => {
    const batch = DEFAULT_STT_SETTINGS.find((s) => s.key === 'batch_pipeline_slug');
    const streaming = DEFAULT_STT_SETTINGS.find((s) => s.key === 'streaming_pipeline_slug');
    expect(batch?.value).toBe(DEFAULT_PIPELINE_SLUG);
    expect(streaming?.value).toBe(DEFAULT_PIPELINE_SLUG);
    // The referenced slug must exist in the seeded pipeline catalog.
    expect(DEFAULT_ASR_PIPELINES.map((p) => p.slug)).toContain(DEFAULT_PIPELINE_SLUG);
  });

  it('is the bare matrix #7 pipeline referencing the CT2 model by slug', () => {
    const ct2 = DEFAULT_ASR_PIPELINES.find((p) => p.slug === CT2_PIPELINE_SLUG);
    expect(ct2).toBeDefined();
    // D6 — registry-authoritative: the CT2 artifact is referenced by its
    // catalog slug; format/compute live on the AiModel row.
    expect(ct2!.configYaml).toContain('asr: "faster-whisper-large-v3-turbo-int8"');
    // Matrix #7 is bare: no pre/diarization/post stages.
    expect(ct2!.configYaml).not.toContain('diarization:');
  });
});

describe('STT default resolves to a loadable artifact (no placeholder default)', () => {
  const PLACEHOLDER = 'MODEL_REPO_PLACEHOLDER';
  const CT2_MODEL_SLUG = 'faster-whisper-large-v3-turbo-int8';
  const CT2_PIPELINE_SLUG = 'production-faster-whisper-turbo-int8';
  const allPipelines = [...DEFAULT_ASR_PIPELINES, ...GLOBAL_TENANT_ASR_PIPELINES, ...CUSTOMER_TENANT_ASR_PIPELINES];

  it('never marks a pipeline whose config references a placeholder artifact as isDefault', () => {
    // The live default STT pipeline must resolve to a real
    // artifact (the last placeholder deepdml URI was removed), so
    // this is a guard against placeholders ever reappearing as defaults.
    const placeholderDefaults = allPipelines.filter((p) => p.isDefault === true && p.configYaml.includes(PLACEHOLDER));
    expect(placeholderDefaults).toEqual([]);
  });

  it('points the seeded batch + streaming default slugs at a resolvable (non-placeholder) pipeline', () => {
    const bySlug = (slug?: string) => DEFAULT_ASR_PIPELINES.find((p) => p.slug === slug);
    const batch = DEFAULT_STT_SETTINGS.find((s) => s.key === 'batch_pipeline_slug');
    const streaming = DEFAULT_STT_SETTINGS.find((s) => s.key === 'streaming_pipeline_slug');
    expect(bySlug(batch?.value)).toBeDefined();
    expect(bySlug(batch?.value)?.configYaml).not.toContain(PLACEHOLDER);
    expect(bySlug(streaming?.value)).toBeDefined();
    expect(bySlug(streaming?.value)?.configYaml).not.toContain(PLACEHOLDER);
  });

  it('keeps the CT2 AiModel registered but NOT tagged production/recommended', () => {
    const ct2 = DEFAULT_AI_MODELS.find((m) => m.slug === CT2_MODEL_SLUG);
    expect(ct2).toBeDefined(); // still in the catalog so admins can see it
    // Real deepdml artifact, no placeholder left.
    expect(ct2?.sourceUri).not.toContain(PLACEHOLDER);
    expect(ct2?.tags).not.toContain('production');
    expect(ct2?.tags).not.toContain('recommended');
  });

  it('does not tag the CT2 pipeline as production/recommended', () => {
    const ct2Pipelines = allPipelines.filter((p) => p.slug === CT2_PIPELINE_SLUG);
    expect(ct2Pipelines.length).toBeGreaterThan(0);
    ct2Pipelines.forEach((p) => {
      expect(p.tags).not.toContain('production');
      expect(p.tags).not.toContain('recommended');
    });
  });
});

// =============================================================================
// TENANT FRONTEND CONFIG SEED
// =============================================================================

describe('Tenant Frontend Config Seed', () => {
  const expectedTenantIds = [SEED_TENANT_ID, SEED_CUSTOMER_TENANT_IDS.ARCAAI];

  it('should seed one frontend config per customer tenant + the Global/SEED tenant', () => {
    expectedTenantIds.forEach((tenantId) => {
      const rows = TENANT_FRONTEND_CONFIGS.filter((c) => c.tenantId === tenantId);
      expect(rows.length).toBe(1);
    });
  });

  it('should have a unique tenantId across all frontend configs (idempotent upsert key)', () => {
    const tenantIds = TENANT_FRONTEND_CONFIGS.map((c) => c.tenantId);
    expect(new Set(tenantIds).size).toBe(tenantIds.length);
  });

  it('should use reasonable boolean frontend defaults on every row', () => {
    TENANT_FRONTEND_CONFIGS.forEach((cfg) => {
      expect(typeof cfg.noiseCancel).toBe('boolean');
      expect(typeof cfg.vad).toBe('boolean');
      expect(typeof cfg.voiceEnrollment).toBe('boolean');
      expect(typeof cfg.diarization).toBe('boolean');
      expect(cfg).toHaveProperty('asrModel');
      expect(cfg).toHaveProperty('configJson');
    });
  });
});

// =============================================================================
// PROMPT TEMPLATE SEED DATA TESTS
// =============================================================================

const VALID_PROMPT_CATEGORIES = ['SYSTEM', 'SUMMARY', 'DNA_ANALYSIS', 'CUSTOM'];

describe('Prompt Template Seed Data', () => {
  describe('Prompt Template Structure', () => {
    it('should have required fields for each prompt template', () => {
      const requiredFields = ['id', 'tenantId', 'name', 'content', 'category', 'currentVersionNumber', 'tags'];
      DEFAULT_PROMPT_TEMPLATES.forEach((template) => {
        requiredFields.forEach((field) => {
          expect(template).toHaveProperty(field);
        });
      });
    });

    it('should have non-empty string IDs for all templates', () => {
      DEFAULT_PROMPT_TEMPLATES.forEach((template) => {
        expect(typeof template.id).toBe('string');
        expect(template.id.length).toBeGreaterThan(0);
      });
    });

    it('should have valid UUID format for all template IDs', () => {
      DEFAULT_PROMPT_TEMPLATES.forEach((template) => {
        expect(template.id).toMatch(UUID_REGEX);
      });
    });

    it('should have unique template IDs', () => {
      const ids = DEFAULT_PROMPT_TEMPLATES.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have valid category values', () => {
      DEFAULT_PROMPT_TEMPLATES.forEach((template) => {
        expect(VALID_PROMPT_CATEGORIES).toContain(template.category);
      });
    });

    it('should have non-empty content for each template', () => {
      DEFAULT_PROMPT_TEMPLATES.forEach((template) => {
        expect(template.content).toBeDefined();
        expect(typeof template.content).toBe('string');
        expect(template.content.length).toBeGreaterThan(0);
      });
    });

    it('should have variables as object when present', () => {
      DEFAULT_PROMPT_TEMPLATES.forEach((template) => {
        if (template.variables != null) {
          expect(typeof template.variables).toBe('object');
          expect(template.variables).not.toBeNull();
        }
      });
    });
  });

  describe('Unified Pre-Summary Template', () => {
    it('should include PRE_SUMMARY_DEFAULT template', () => {
      const preSummary = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.PRE_SUMMARY_DEFAULT);
      expect(preSummary).toBeDefined();
      expect(preSummary?.category).toBe('SYSTEM');
    });

    it('should have PRE_SUMMARY_DEFAULT with required template variables', () => {
      const preSummary = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.PRE_SUMMARY_DEFAULT);
      expect(preSummary).toBeDefined();
      const content = preSummary!.content;
      const requiredVars = ['{current_department}', '{visit_type}', '{safe_age}'];
      requiredVars.forEach((v) => {
        expect(content).toContain(v);
      });
    });

    it('should have PRE_SUMMARY_DEFAULT with 5 output sections', () => {
      const preSummary = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.PRE_SUMMARY_DEFAULT);
      expect(preSummary).toBeDefined();
      const content = preSummary!.content;
      const outputSections = [
        'Confirmed & Provisional Diagnoses',
        'Investigations',
        'Diagnostics & Trends',
        'Plan of Care',
        'Medications Prescribed',
      ];
      outputSections.forEach((section) => {
        expect(content).toContain(section);
      });
    });
  });

  describe('Prompt Template Defaults', () => {
    it('should include SYSTEM template', () => {
      const system = DEFAULT_PROMPT_TEMPLATES.find((t) => t.category === 'SYSTEM' && t.id === SEED_TEMPLATE_IDS.SYSTEM_DEFAULT);
      expect(system).toBeDefined();
      expect(system?.departmentId).toBeNull();
    });

    it('should include SUMMARY template', () => {
      const summary = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.SOAP_SUMMARY);
      expect(summary).toBeDefined();
    });

    it('should include DNA_ANALYSIS template', () => {
      const dna = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.DNA_ANALYSIS);
      expect(dna).toBeDefined();
    });

    it('should include the CUSTOM template, no longer department-bound', () => {
      // Cardiology left the Global catalog with the specialty roster
      // The template is retained but re-homed to
      // departmentId: null rather than left pointing at a deleted department —
      // `PromptTemplate.departmentId` is a real FK, so a dangling id is a failed
      // migration, not a stale reference.
      const custom = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.CARD_CUSTOM);
      expect(custom).toBeDefined();
      expect(custom?.departmentId).toBeNull();
    });
  });

  describe('Care-Setting Templates', () => {
    // Replaces the per-specialty DERM/DIET/NEPH/SONC pairs. Those bodies were
    // BCMCH's and now live only on the ArcaAI tenant
    // (07b-arcaai-clinical-templates.ts); the Global catalog carries generic
    // care-setting bodies instead.
    it('binds every Global department prompt column to a template that exists', () => {
      const byId = new Map(DEFAULT_PROMPT_TEMPLATES.map((t) => [t.id, t]));
      DEFAULT_DEPARTMENTS.forEach((dept) => {
        for (const [column, id] of [
          ['newPatientPromptId', dept.newPatientPromptId],
          ['revisitPromptId', dept.revisitPromptId],
        ] as const) {
          if (id === null) continue;
          expect(byId.has(id), `${dept.code}.${column} -> ${id} has no seeded template`).toBe(true);
        }
      });
    });

    it('anchors every department-bound template to a department that exists', () => {
      // `PromptTemplate.departmentId` is a real Postgres FK, so a dangling id
      // fails the seed rather than degrading quietly.
      const deptIds = new Set(DEFAULT_DEPARTMENTS.map((d) => d.id));
      DEFAULT_PROMPT_TEMPLATES.forEach((tpl) => {
        if (!tpl.departmentId) return;
        expect(deptIds.has(tpl.departmentId), `template ${tpl.name} -> departmentId ${tpl.departmentId} does not exist`).toBe(true);
      });
    });

    it('seeds the generic templates as APPROVED v1 so a fresh tenant can generate on day 1', () => {
      const generic = DEFAULT_PROMPT_TEMPLATES.filter((t) => t.id.startsWith('71000000-0000-0000-0003-'));
      expect(generic.length).toBe(13);
      generic.forEach((tpl) => {
        expect(tpl.status, `${tpl.name} must be APPROVED`).toBe('APPROVED');
        expect(tpl.currentVersionNumber).toBe(1);
      });
    });
  });
});

describe('Prompt Version Seed Data', () => {
  describe('Prompt Version Structure', () => {
    it('should have required fields for each prompt version', () => {
      const requiredFields = ['id', 'tenantId', 'promptTemplateId', 'versionNumber', 'content', 'changeReason', 'changedBy'];
      DEFAULT_PROMPT_VERSIONS.forEach((version) => {
        requiredFields.forEach((field) => {
          expect(version).toHaveProperty(field);
        });
      });
    });

    it('should have valid UUID format for all version IDs', () => {
      DEFAULT_PROMPT_VERSIONS.forEach((version) => {
        expect(version.id).toMatch(UUID_REGEX);
      });
    });

    it('should have unique version IDs', () => {
      const ids = DEFAULT_PROMPT_VERSIONS.map((v) => v.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should define one version per template', () => {
      expect(DEFAULT_PROMPT_VERSIONS.length).toBe(DEFAULT_PROMPT_TEMPLATES.length);
    });

    it('should have versionNumber 1 for all seed versions', () => {
      DEFAULT_PROMPT_VERSIONS.forEach((version) => {
        expect(version.versionNumber).toBe(1);
      });
    });

    it('should have content matching parent template', () => {
      const templateMap = new Map(DEFAULT_PROMPT_TEMPLATES.map((t) => [t.id, t]));
      DEFAULT_PROMPT_VERSIONS.forEach((version) => {
        const template = templateMap.get(version.promptTemplateId);
        expect(template).toBeDefined();
        expect(version.content).toBe(template!.content);
      });
    });

    it('should reference valid prompt template IDs', () => {
      const templateIds = new Set(DEFAULT_PROMPT_TEMPLATES.map((t) => t.id));
      DEFAULT_PROMPT_VERSIONS.forEach((version) => {
        expect(templateIds.has(version.promptTemplateId)).toBe(true);
      });
    });

    it('should have changedBy set to system user ID', () => {
      DEFAULT_PROMPT_VERSIONS.forEach((version) => {
        expect(version.changedBy).toBe(SYSTEM_USER_ID);
      });
    });
  });
});

// =============================================================================
// DNA WRITING STYLE SEED DATA TESTS
// =============================================================================

describe('DNA Writing Style Seed Data', () => {
  describe('DNA Report Structure', () => {
    it('should have required fields for each DNA report', () => {
      const requiredFields = ['id', 'tenantId', 'doctorId', 'reportData', 'styleText', 'isLatest', 'currentVersionNumber'];
      DEFAULT_DNA_REPORTS.forEach((report) => {
        requiredFields.forEach((field) => {
          expect(report).toHaveProperty(field);
        });
      });
    });

    it('should have valid UUID format for all report IDs', () => {
      DEFAULT_DNA_REPORTS.forEach((report) => {
        expect(report.id).toMatch(UUID_REGEX);
      });
    });

    it('should have unique report IDs', () => {
      const ids = DEFAULT_DNA_REPORTS.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have at least one report with isLatest true', () => {
      const latestReports = DEFAULT_DNA_REPORTS.filter((r) => r.isLatest === true);
      expect(latestReports.length).toBeGreaterThan(0);
    });

    it('should have reportData with expected structure', () => {
      DEFAULT_DNA_REPORTS.forEach((report) => {
        const data = report.reportData as Record<string, unknown>;
        expect(data).toBeDefined();
        expect(data).toHaveProperty('formality');
        expect(data).toHaveProperty('sentenceLength');
        expect(data).toHaveProperty('medicalTermUsage');
        expect(data).toHaveProperty('abbreviationStyle');
      });
    });
  });

  describe('DNA Version Structure', () => {
    it('should have required fields for each DNA version', () => {
      const requiredFields = ['id', 'tenantId', 'dnaReportId', 'versionNumber', 'changeReason', 'changedBy'];
      DEFAULT_DNA_VERSIONS.forEach((version) => {
        requiredFields.forEach((field) => {
          expect(version).toHaveProperty(field);
        });
      });
    });

    it('should have valid UUID format for all DNA version IDs', () => {
      DEFAULT_DNA_VERSIONS.forEach((version) => {
        expect(version.id).toMatch(UUID_REGEX);
      });
    });

    it('should reference valid DNA report IDs', () => {
      const reportIds = new Set(DEFAULT_DNA_REPORTS.map((r) => r.id));
      DEFAULT_DNA_VERSIONS.forEach((version) => {
        expect(reportIds.has(version.dnaReportId)).toBe(true);
      });
    });
  });
});

describe('Usage Record Seed Data', () => {
  describe('DnaUsageRecord Structure', () => {
    it('should have required fields for each DNA usage record', () => {
      const requiredFields = ['id', 'tenantId', 'doctorId', 'dnaReportId', 'departmentId'];
      DEFAULT_DNA_USAGE_RECORDS.forEach((record) => {
        requiredFields.forEach((field) => {
          expect(record).toHaveProperty(field);
        });
      });
    });

    it('should have valid UUID format for all DNA usage record IDs', () => {
      DEFAULT_DNA_USAGE_RECORDS.forEach((record) => {
        expect(record.id).toMatch(UUID_REGEX);
      });
    });

    it('should have non-null doctorId, dnaReportId, departmentId', () => {
      DEFAULT_DNA_USAGE_RECORDS.forEach((record) => {
        expect(record.doctorId).toBeTruthy();
        expect(record.dnaReportId).toBeTruthy();
        expect(record.departmentId).toBeTruthy();
      });
    });
  });

  describe('PromptUsageRecord Structure', () => {
    it('should have required fields for each prompt usage record', () => {
      const requiredFields = ['id', 'tenantId', 'promptTemplateId', 'doctorId', 'departmentId'];
      DEFAULT_PROMPT_USAGE_RECORDS.forEach((record) => {
        requiredFields.forEach((field) => {
          expect(record).toHaveProperty(field);
        });
      });
    });

    it('should have valid UUID format for all prompt usage record IDs', () => {
      DEFAULT_PROMPT_USAGE_RECORDS.forEach((record) => {
        expect(record.id).toMatch(UUID_REGEX);
      });
    });

    it('should have non-null promptTemplateId', () => {
      DEFAULT_PROMPT_USAGE_RECORDS.forEach((record) => {
        expect(record.promptTemplateId).toBeTruthy();
      });
    });
  });

  describe('Usage Record Cross-References', () => {
    const TEMPLATE_IDS = DEFAULT_PROMPT_TEMPLATES.map((t) => t.id);
    const REPORT_IDS = DEFAULT_DNA_REPORTS.map((r) => r.id);

    it('should have promptTemplateId matching known seed template IDs', () => {
      DEFAULT_PROMPT_USAGE_RECORDS.forEach((record) => {
        expect(TEMPLATE_IDS).toContain(record.promptTemplateId);
      });
    });

    it('should have dnaReportId matching known seed report IDs', () => {
      DEFAULT_DNA_USAGE_RECORDS.forEach((record) => {
        expect(REPORT_IDS).toContain(record.dnaReportId);
      });
    });

    it('should have departmentId matching known department IDs', () => {
      const deptIds = DEFAULT_DEPARTMENTS.map((d) => d.id);
      [...DEFAULT_DNA_USAGE_RECORDS, ...DEFAULT_PROMPT_USAGE_RECORDS].forEach((record) => {
        expect(deptIds).toContain(record.departmentId);
      });
    });
  });
});

// =============================================================================
// TEXT LLM MODELS SEED DATA TESTS
// =============================================================================

describe('LLM Models Seed Data (consolidated matrix)', () => {
  const llmModels = DEFAULT_AI_MODELS.filter((m) => m.taskType === ModelTaskType.SUMMARIZATION || m.taskType === ModelTaskType.TEXT_GENERATION);

  describe('Provider Coverage', () => {
    it('should include no Ollama models (Ollama removed entirely)', () => {
      const ollamaModels = llmModels.filter((m) => m.tags.includes('ollama') || (m as { provider?: string }).provider === 'ollama');
      expect(ollamaModels.length).toBe(0);
    });

    it('should include exactly 6 LM Studio models', () => {
      const lmsModels = llmModels.filter((m) => m.tags.includes('lm-studio'));
      expect(lmsModels.length).toBe(6);
    });

    it('should include exactly 1 Bedrock model', () => {
      const bedrockModels = llmModels.filter((m) => m.tags.includes('bedrock'));
      expect(bedrockModels.length).toBe(1);
    });

    it('should include exactly 1 Azure cloud model', () => {
      const azureModels = llmModels.filter((m) => m.tags.includes('azure'));
      expect(azureModels.length).toBe(1);
    });

    it('should include exactly 1 vLLM model', () => {
      const vllmModels = llmModels.filter((m) => m.tags.includes('vllm'));
      expect(vllmModels.length).toBe(1);
    });

    it('should include exactly 1 llama.cpp model', () => {
      const llamaCppModels = llmModels.filter((m) => m.tags.includes('llama-cpp'));
      expect(llamaCppModels.length).toBe(1);
    });

    it('should be exactly 10 LLM rows (6 owner-approved matrix, Ollama retired by + 2 self-host + 2 bedrock/judge)', () => {
      expect(llmModels.length).toBe(10);
    });
  });

  describe('Model Structure', () => {
    it('should have NLP category for all LLM models', () => {
      llmModels.forEach((model) => {
        expect(model.category).toBe(ModelCategory.NLP);
      });
    });

    it('should use TEXT_GENERATION for every LLM row', () => {
      llmModels.forEach((model) => {
        expect(model.taskType).toBe(ModelTaskType.TEXT_GENERATION);
      });
    });

    it('should have unique slugs for all LLM models', () => {
      const slugs = llmModels.map((m) => m.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
    });

    it('should have the llm tag + a canonical provider on all LLM models', () => {
      llmModels.forEach((model) => {
        expect(model.tags).toContain('llm');
        expect(['lm-studio', 'azure', 'vllm', 'llama-cpp', 'bedrock']).toContain((model as { provider?: string }).provider);
      });
    });

    it('should have IDs in the fresh 80000000-0000-0000-0007 block', () => {
      llmModels.forEach((model) => {
        expect(model.id).toMatch(/^80000000-0000-0000-0007-/);
      });
    });
  });

  describe('LM Studio Models', () => {
    const EXPECTED_LMS = [
      ['lms-gemma-4-e2b-it-qat', 'gemma-4-e2b-it-qat'],
      ['lms-gemma-4-e4b-it-qat', 'gemma-4-e4b-it-qat'],
      ['lms-gemma-4-medical-icd10', 'gemma-4-medical-icd10'],
      ['lms-gemma-4-12b-qat', 'google/gemma-4-12b-qat'],
      ['lms-medgemma-1.5-4b-it', 'medgemma-1.5-4b-it'],
    ] as const;

    it.each(EXPECTED_LMS)('should include LM Studio model %s (sourceUri %s)', (slug, sourceUri) => {
      const model = llmModels.find((m) => m.slug === slug);
      expect(model).toBeDefined();
      expect(model?.tags).toContain('lm-studio');
      expect(model?.sourceUri).toBe(sourceUri);
    });

    it('should mark ONLY lms-gemma-4-e2b-it-qat as the platform default (tags default+summarization)', () => {
      const defaults = llmModels.filter((m) => m.tags.includes('default'));
      expect(defaults.map((m) => m.slug)).toEqual(['lms-gemma-4-e2b-it-qat']);
      expect(defaults[0].tags).toContain('summarization');
    });
  });

  describe('Azure Cloud Model', () => {
    it('should include azure-gpt-5.4-mini as CLOUD_API with an empty deployment placeholder', () => {
      const gpt = llmModels.find((m) => m.slug === 'azure-gpt-5.4-mini');
      expect(gpt).toBeDefined();
      expect(gpt?.format).toBe(AiModelFormat.CLOUD_API);
      expect(gpt?.sourceUri).toBe('gpt-5.4-mini');
      expect((gpt as { metaData?: { azureDeployment?: string } } | undefined)?.metaData?.azureDeployment).toBe('');
    });
  });

  describe('Model Size Metadata', () => {
    it('should have memorySizeMb > 0 for local models', () => {
      const localModels = llmModels.filter((m) => m.tags.includes('lm-studio'));
      localModels.forEach((model) => {
        expect(model.memorySizeMb).toBeGreaterThan(0);
      });
    });

    it('should have memorySizeMb = 0 for cloud models', () => {
      const cloudModels = llmModels.filter((m) => m.tags.includes('cloud'));
      cloudModels.forEach((model) => {
        expect(model.memorySizeMb).toBe(0);
      });
    });
  });

  describe('Retired LLM catalog', () => {
    it('should no longer seed any of the legacy TEXT provider rows', () => {
      const legacy = DEFAULT_AI_MODELS.filter((m) => m.tags.includes('text'));
      expect(legacy).toEqual([]);
      [
        'gpt-4',
        'gpt-4o',
        'gpt-4o-mini',
        'claude-3-haiku',
        'claude-3.5-sonnet',
        'local-model-openai-compat',
        'ollama-granite4-latest',
        'lms-qwen3.5-0.8b',
        'lms-gemma-4-e2b-it-sft-rlvr-medical',
        // Ollama removed entirely (owner directive 2026-08-16).
        'ollama-gemma4-12b-mlx',
        'ollama-gemma4-e2b-it-qat',
        'ollama-qwen3.5-2b',
      ].forEach((slug) => {
        expect(DEFAULT_AI_MODELS.find((m) => m.slug === slug)).toBeUndefined();
      });
    });
  });
});

// =============================================================================
// STT LOCAL PROCESSING (BROWSER) MODELS — RETIRED
// =============================================================================
// The 7 browser-local whisper rows were retired: the SDK's model lists are
// hardcoded (`constants.task210.test.ts` locks the removed /ai-models fetch)
// and `TenantFrontendConfig.asrModel` is free-text, so no runtime path reads
// these catalog rows. `retireLegacyAiModels` soft-deletes existing copies.

describe('STT Local Processing Models retired', () => {
  it('should seed NO local-processing rows in the consolidated catalog', () => {
    const localModels = DEFAULT_AI_MODELS.filter((m) => m.tags.includes('local-processing'));
    expect(localModels).toEqual([]);
  });
});

// =============================================================================
// CUSTOMER-TENANT AI MODEL CATALOG BACKFILL
// =============================================================================

describe('Customer-tenant AI model catalog backfill', () => {
  const makeMockClient = (findFirstImpl: () => unknown) => {
    const created: Array<{ data: Record<string, unknown> }> = [];
    const updated: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const client = {
      aiModel: {
        findFirst: vi.fn(async () => findFirstImpl()),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args);
          return args.data;
        }),
        update: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          updated.push(args);
          return args.data;
        }),
      },
    };
    return { client, created, updated };
  };

  it('targets the global + the ArcaAI customer tenant (not the SYSTEM tenant)', () => {
    expect(CUSTOMER_TENANT_IDS_FOR_AIMODEL_BACKFILL).toHaveLength(2);
    expect(CUSTOMER_TENANT_IDS_FOR_AIMODEL_BACKFILL).not.toContain(SYSTEM_TENANT_ID);
  });

  it('clones every SYSTEM model into each customer tenant with a fresh id (no SYSTEM id/tenant leak)', async () => {
    const { client, created } = makeMockClient(() => null); // nothing exists yet
    const result = await backfillCustomerTenantAiModels(client as never);

    const expectedCount = DEFAULT_AI_MODELS.length * CUSTOMER_TENANT_IDS_FOR_AIMODEL_BACKFILL.length;
    expect(result.count).toBe(expectedCount);
    expect(client.aiModel.create).toHaveBeenCalledTimes(expectedCount);

    created.forEach(({ data }) => {
      // Fresh id (uuid(7) default) — never carries the SYSTEM row id.
      expect(data).not.toHaveProperty('id');
      // Bound to a customer tenant, never the SYSTEM tenant.
      expect(data.tenantId).not.toBe(SYSTEM_TENANT_ID);
      expect(CUSTOMER_TENANT_IDS_FOR_AIMODEL_BACKFILL).toContain(data.tenantId);
    });
  });

  it('is idempotent — skips slugs the tenant already owns (provider already set)', async () => {
    const { client } = makeMockClient(() => ({ id: 'already-exists', provider: 'lm-studio' }));
    const result = await backfillCustomerTenantAiModels(client as never);

    expect(result.count).toBe(0);
    expect(result.synced).toBe(0);
    expect(client.aiModel.create).not.toHaveBeenCalled();
    expect(client.aiModel.update).not.toHaveBeenCalled();
  });

  it('column-syncs pre-506 clones — fills provider/architecture (+metaData) ONLY while provider is NULL', async () => {
    // Pre-506 clones exist (create-only backfill) but predate the new
    // columns; the guardrail/NLP/TTS resolvers prefer the same-tenant
    // model row, so a NULL-provider clone would shadow the SYSTEM value.
    const { client, updated } = makeMockClient(() => ({ id: 'pre-506-clone', provider: null }));
    const result = await backfillCustomerTenantAiModels(client as never);

    const expectedSynced = DEFAULT_AI_MODELS.length * CUSTOMER_TENANT_IDS_FOR_AIMODEL_BACKFILL.length;
    expect(result.count).toBe(0);
    expect(result.synced).toBe(expectedSynced);
    expect(client.aiModel.create).not.toHaveBeenCalled();
    updated.forEach(({ where, data }) => {
      expect(where).toEqual({ id: 'pre-506-clone' });
      expect(data.provider).toBeTruthy();
      expect(data.version).toEqual({ increment: 1 });
      // Never touches tenant-customizable presentation fields.
      expect(data).not.toHaveProperty('name');
      expect(data).not.toHaveProperty('tags');
      expect(data).not.toHaveProperty('resourceStatus');
    });
  });
});

// =============================================================================
// SYSTEM HarnessPolicy TEXT default + WORM audit
// =============================================================================

describe('Phase 2 — seedHarnessPolicy (TEXT default + WORM)', () => {
  const makeMockClient = (existing: Record<string, unknown> | null) => {
    const created: Array<{ data: Record<string, unknown> }> = [];
    const updated: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const changes: Array<{ data: Record<string, unknown> }> = [];
    const client = {
      harnessPolicy: {
        findFirst: vi.fn(async () => existing),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args);
          // Real Prisma returns the full row incl. column defaults.
          return { id: 'new-policy-id', version: 1, ...args.data };
        }),
        update: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          updated.push(args);
          return { id: 'existing-id', version: 2, ...existing, ...args.data };
        }),
      },
      harnessPolicyChange: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          changes.push(args);
          return args.data;
        }),
      },
    };
    return { client, created, updated, changes };
  };

  it('exposes the agreed TEXT defaults (lm-studio + gemma-4-e2b-it-qat)', () => {
    expect(SYSTEM_HARNESS_POLICY_TEXT_DEFAULTS.textProvider).toBe('lm-studio');
    expect(SYSTEM_HARNESS_POLICY_TEXT_DEFAULTS.textModel).toBe('gemma-4-e2b-it-qat');
  });

  it('creates the SYSTEM policy row with the TEXT defaults and writes a WORM change (beforeJson=null)', async () => {
    const { client, created, changes } = makeMockClient(null);
    const result = await seedHarnessPolicy(client as never);

    expect(result.action).toBe('created');
    expect(result.changeWritten).toBe(true);

    expect(client.harnessPolicy.create).toHaveBeenCalledTimes(1);
    expect(created[0].data.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(created[0].data.textProvider).toBe('lm-studio');
    expect(created[0].data.textModel).toBe('gemma-4-e2b-it-qat');

    // WORM audit entry (HarnessPolicyChange) recorded for the default-set.
    expect(client.harnessPolicyChange.create).toHaveBeenCalledTimes(1);
    const change = changes[0].data;
    expect(change.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(change.beforeJson).toBeNull();
    expect((change.afterJson as Record<string, unknown>).textProvider).toBe('lm-studio');
    expect((change.afterJson as Record<string, unknown>).textModel).toBe('gemma-4-e2b-it-qat');
    expect(change.changedBy).toBe(SYSTEM_USER_ID);
  });

  it('is idempotent — no write/WORM when the SYSTEM policy already has the TEXT defaults', async () => {
    const { client } = makeMockClient({
      id: 'existing-id',
      tenantId: SYSTEM_TENANT_ID,
      version: 3,
      textProvider: 'lm-studio',
      textModel: 'gemma-4-e2b-it-qat',
    });
    const result = await seedHarnessPolicy(client as never);

    expect(result.action).toBe('noop');
    expect(result.changeWritten).toBe(false);
    expect(client.harnessPolicy.create).not.toHaveBeenCalled();
    expect(client.harnessPolicy.update).not.toHaveBeenCalled();
    expect(client.harnessPolicyChange.create).not.toHaveBeenCalled();
  });

  it('updates ONLY the two TEXT columns on an existing NULL-TEXT row and writes a before/after WORM change', async () => {
    const { client, updated, changes } = makeMockClient({
      id: 'existing-id',
      tenantId: SYSTEM_TENANT_ID,
      version: 1,
      textProvider: null,
      textModel: null,
      maxRegen: 5,
    });
    const result = await seedHarnessPolicy(client as never);

    expect(result.action).toBe('updated');
    expect(result.changeWritten).toBe(true);

    expect(client.harnessPolicy.update).toHaveBeenCalledTimes(1);
    // Writes ONLY the two TEXT columns (does not clobber other admin knobs).
    expect(Object.keys(updated[0].data).sort()).toEqual(['textModel', 'textProvider']);
    expect(updated[0].data.textProvider).toBe('lm-studio');
    expect(updated[0].data.textModel).toBe('gemma-4-e2b-it-qat');

    const change = changes[0].data;
    expect((change.beforeJson as Record<string, unknown>).textModel).toBeNull();
    expect((change.afterJson as Record<string, unknown>).textModel).toBe('gemma-4-e2b-it-qat');
    // The audit snapshot preserves untouched knobs (the regen budget).
    expect((change.afterJson as Record<string, unknown>).maxRegen).toBe(5);
  });
});

// =============================================================================
// SYSTEM + demo PipelinePolicy cascade defaults + WORM audit
// =============================================================================

describe('Phase 5 — seedPipelinePolicy (cascade defaults + WORM)', () => {
  // The seed ensures two TENANT-scope rows idempotently (find-then-create, never
  // upsert — the (tenantId, scope, scopeId) unique index treats null scopeId as
  // DISTINCT, so a blind create would duplicate). Each create also appends a WORM
  // PipelinePolicyChange (beforeJson=null). The mock keys existing rows by tenant.
  const makeMockClient = (existingByTenant: Record<string, Record<string, unknown> | null>) => {
    const created: Array<{ data: Record<string, unknown> }> = [];
    const changes: Array<{ data: Record<string, unknown> }> = [];
    const client = {
      pipelinePolicy: {
        findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
          const tenantId = args.where.tenantId as string;
          return existingByTenant[tenantId] ?? null;
        }),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args);
          return { id: `pp-${created.length}`, version: 1, ...args.data };
        }),
      },
      pipelinePolicyChange: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          changes.push(args);
          return args.data;
        }),
      },
    };
    return { client, created, changes };
  };

  it('exposes the SYSTEM defaults (auto on, harness ON since)', () => {
    expect(SYSTEM_PIPELINE_POLICY_DEFAULTS.autoSummaryEnabled).toBe(true);
    expect(SYSTEM_PIPELINE_POLICY_DEFAULTS.autoNerEnabled).toBe(true);
    // (Phase 2 exit criterion): the legacy signable generator this
    // toggle used to fall back to when false was deleted, so the SYSTEM
    // default flipped to true.
    expect(SYSTEM_PIPELINE_POLICY_DEFAULTS.harnessEnabled).toBe(true);
  });

  it('exposes the demo-tenant override that preserves the clinical-workspace harness', () => {
    expect(DEMO_PIPELINE_POLICY_OVERRIDE.harnessEnabled).toBe(true);
  });

  it('exposes the ArcaAI-tenant override that routes ArcaAI through the harness', () => {
    expect(ARCAAI_PIPELINE_POLICY_OVERRIDE.harnessEnabled).toBe(true);
  });

  it('creates the SYSTEM default + demo override + ArcaAI override rows (each with a beforeJson=null WORM change)', async () => {
    const { client, created, changes } = makeMockClient({
      [SYSTEM_TENANT_ID]: null,
      [SEED_TENANT_ID]: null,
      [SEED_CUSTOMER_TENANT_IDS.ARCAAI]: null,
    });
    const result = await seedPipelinePolicy(client as never);

    expect(result.success).toBe(true);
    expect(result.system).toBe('created');
    expect(result.demo).toBe('created');
    expect(result.arcaai).toBe('created');

    expect(client.pipelinePolicy.create).toHaveBeenCalledTimes(3);
    const systemRow = created.find((c) => c.data.tenantId === SYSTEM_TENANT_ID)!.data;
    expect(systemRow.scope).toBe('TENANT');
    expect(systemRow.scopeId ?? null).toBeNull();
    expect(systemRow.harnessEnabled).toBe(true);
    expect(systemRow.autoSummaryEnabled).toBe(true);

    const demoRow = created.find((c) => c.data.tenantId === SEED_TENANT_ID)!.data;
    expect(demoRow.scope).toBe('TENANT');
    expect(demoRow.harnessEnabled).toBe(true);

    const arcaaiRow = created.find((c) => c.data.tenantId === SEED_CUSTOMER_TENANT_IDS.ARCAAI)!.data;
    expect(arcaaiRow.scope).toBe('TENANT');
    expect(arcaaiRow.scopeId ?? null).toBeNull();
    expect(arcaaiRow.harnessEnabled).toBe(true);

    // One WORM change per created row, before=null (creation), changedBy=SYSTEM.
    expect(client.pipelinePolicyChange.create).toHaveBeenCalledTimes(3);
    for (const change of changes) {
      expect(change.data.beforeJson).toBeNull();
      expect(change.data.changedBy).toBe(SYSTEM_USER_ID);
    }
    const demoChange = changes.find((c) => c.data.tenantId === SEED_TENANT_ID)!.data;
    expect((demoChange.afterJson as Record<string, unknown>).harnessEnabled).toBe(true);
    const arcaaiChange = changes.find((c) => c.data.tenantId === SEED_CUSTOMER_TENANT_IDS.ARCAAI)!.data;
    expect((arcaaiChange.afterJson as Record<string, unknown>).harnessEnabled).toBe(true);
  });

  it('is idempotent — no write/WORM when all rows already exist', async () => {
    const { client } = makeMockClient({
      [SYSTEM_TENANT_ID]: { id: 'sys', tenantId: SYSTEM_TENANT_ID, scope: 'TENANT', harnessEnabled: false },
      [SEED_TENANT_ID]: { id: 'demo', tenantId: SEED_TENANT_ID, scope: 'TENANT', harnessEnabled: true },
      [SEED_CUSTOMER_TENANT_IDS.ARCAAI]: { id: 'arcaai', tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI, scope: 'TENANT', harnessEnabled: true },
    });
    const result = await seedPipelinePolicy(client as never);

    expect(result.system).toBe('noop');
    expect(result.demo).toBe('noop');
    expect(result.arcaai).toBe('noop');
    expect(client.pipelinePolicy.create).not.toHaveBeenCalled();
    expect(client.pipelinePolicyChange.create).not.toHaveBeenCalled();
  });

  it('creates ONLY the missing row when the others already exist (demo + ArcaAI present, SYSTEM absent)', async () => {
    const { client, created } = makeMockClient({
      [SYSTEM_TENANT_ID]: null,
      [SEED_TENANT_ID]: { id: 'demo', tenantId: SEED_TENANT_ID, scope: 'TENANT', harnessEnabled: true },
      [SEED_CUSTOMER_TENANT_IDS.ARCAAI]: { id: 'arcaai', tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI, scope: 'TENANT', harnessEnabled: true },
    });
    const result = await seedPipelinePolicy(client as never);

    expect(result.system).toBe('created');
    expect(result.demo).toBe('noop');
    expect(result.arcaai).toBe('noop');
    expect(client.pipelinePolicy.create).toHaveBeenCalledTimes(1);
    expect(created[0].data.tenantId).toBe(SYSTEM_TENANT_ID);
  });
});

// =============================================================================
// SEED DATA VALIDATION
// =============================================================================

describe('Seed Data Validation', () => {
  describe('UUID Format', () => {
    it('should use valid UUID format for all IDs', () => {
      DEFAULT_POLICIES.forEach((p) => expect(p.id).toMatch(UUID_REGEX));
      DEFAULT_ROLES.forEach((r) => expect(r.id).toMatch(UUID_REGEX));
      DEFAULT_DEPARTMENTS.forEach((d) => expect(d.id).toMatch(UUID_REGEX));
    });
  });

  describe('Default Values', () => {
    it('should use correct default tenant ID', () => {
      expect(DEFAULT_TENANT_ID).toBe('50000000-0000-0000-0000-000000000000');
    });

    it('should use default tenant ID in departments', () => {
      DEFAULT_DEPARTMENTS.forEach((d) => {
        expect(d.tenantId).toBe(DEFAULT_TENANT_ID);
      });
    });
  });

  describe('Data Integrity', () => {
    it('should have no circular role inheritance', () => {
      const roleMap = new Map(DEFAULT_ROLES.map((r) => [r.id, r]));
      DEFAULT_ROLES.forEach((role) => {
        if (role.parentRoleId) {
          const visited = new Set<string>();
          let currentId: string | null = role.parentRoleId;
          while (currentId) {
            expect(visited.has(currentId)).toBe(false);
            visited.add(currentId);
            const parent = roleMap.get(currentId);
            currentId = parent?.parentRoleId || null;
          }
        }
      });
    });

    it('should have all role policies reference valid policies', () => {
      const policyNames = new Set(DEFAULT_POLICIES.map((p) => p.name));
      DEFAULT_ROLES.forEach((role) => {
        role.policies.forEach((policyName) => {
          expect(policyNames.has(policyName)).toBe(true);
        });
      });
    });
  });
});

// =============================================================================
// CROSS-REFERENCE INTEGRITY
// =============================================================================

describe('Seed Data Cross-Reference Integrity', () => {
  it('should have prompt version variables matching parent template variables', () => {
    const templateMap = new Map(DEFAULT_PROMPT_TEMPLATES.map((t) => [t.id, t]));
    DEFAULT_PROMPT_VERSIONS.forEach((v) => {
      const template = templateMap.get(v.promptTemplateId);
      expect(template).toBeDefined();
      expect(JSON.stringify(v.variables)).toBe(JSON.stringify(template!.variables));
    });
  });

  it('should have prompt version content matching parent template content', () => {
    const templateMap = new Map(DEFAULT_PROMPT_TEMPLATES.map((t) => [t.id, t]));
    DEFAULT_PROMPT_VERSIONS.forEach((v) => {
      const template = templateMap.get(v.promptTemplateId);
      expect(template).toBeDefined();
      expect(v.content).toBe(template!.content);
    });
  });

  it('should have departments with prompt IDs referencing valid prompt template IDs', () => {
    const templateIds = new Set(DEFAULT_PROMPT_TEMPLATES.map((t) => t.id));
    DEFAULT_DEPARTMENTS.forEach((dept) => {
      if (dept.newPatientPromptId) {
        expect(templateIds.has(dept.newPatientPromptId)).toBe(true);
      }
      if (dept.revisitPromptId) {
        expect(templateIds.has(dept.revisitPromptId)).toBe(true);
      }
      if (dept.preSummaryPromptId) {
        expect(templateIds.has(dept.preSummaryPromptId)).toBe(true);
      }
    });
  });

  it('should have unique IDs for all DNA usage records', () => {
    const ids = DEFAULT_DNA_USAGE_RECORDS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should have unique IDs for all prompt usage records', () => {
    const ids = DEFAULT_PROMPT_USAGE_RECORDS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// =============================================================================
// DUAL CAPTURE — PIPELINE CONFIG + DEMO RECORDING
// =============================================================================

/**
 * Walks a key path (e.g. ['preprocessing', 'dual_capture']) through a 2-space
 * indented YAML blob and returns the indented child lines of the final key, or
 * null when the path is absent. Lets the seed tests assert nested structure of
 * the pipeline configYaml without adding a YAML-parser dependency.
 */
function getYamlBlock(yaml: string, keyPath: string[]): string | null {
  let scope = yaml.split('\n');
  let parentIndent = -2; // first level expects indent 0
  for (const key of keyPath) {
    const expectIndent = parentIndent + 2;
    const headerRe = new RegExp(`^ {${expectIndent}}${key}:\\s*(#.*)?$`);
    const startIdx = scope.findIndex((line) => headerRe.test(line));
    if (startIdx === -1) return null;
    const body: string[] = [];
    for (let i = startIdx + 1; i < scope.length; i++) {
      const line = scope[i];
      if (line.trim() === '') {
        body.push(line);
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= expectIndent) break;
      body.push(line);
    }
    scope = body;
    parentIndent = expectIndent;
  }
  return scope.join('\n');
}

describe('Dual Capture Pipeline Config', () => {
  // dual_capture lives on the "Full Features" pipeline
  // (production-whisper-large-v3, matrix #1), which carries the full
  // pre/post-processing stages; it is no longer the tenant default (the new
  // default, matrix #2, is a no-pre/no-post pipeline with nothing to dual-
  // capture), so this suite targets it by slug rather than by isDefault.
  const defaultPipeline = DEFAULT_ASR_PIPELINES.find((p) => p.slug === 'production-whisper-large-v3');

  it('should expose the full-features pipeline (production-whisper-large-v3) whose config drives dual capture', () => {
    expect(defaultPipeline).toBeDefined();
    expect(defaultPipeline?.slug).toBe('production-whisper-large-v3');
  });

  it('should add a dual_capture block under preprocessing on the default pipeline (raw capture before filters)', () => {
    const block = getYamlBlock(defaultPipeline!.configYaml, ['preprocessing', 'dual_capture']);
    expect(block).not.toBeNull();
    expect(block).toMatch(/enabled:\s*true/);
    expect(block).toMatch(/capture_raw:\s*true/);
  });

  it('should add a dual_capture block under postprocessing on the default pipeline (processed capture after filters)', () => {
    const block = getYamlBlock(defaultPipeline!.configYaml, ['postprocessing', 'dual_capture']);
    expect(block).not.toBeNull();
    expect(block).toMatch(/enabled:\s*true/);
    expect(block).toMatch(/capture_processed:\s*true/);
  });
});

describe('Dual-Capture Demo AudioRecording', () => {
  it('should seed at least one AudioRecording carrying both rawMediaId and processedMediaId', () => {
    const dualCapture = DEFAULT_AUDIO_RECORDINGS.filter((r) => r.rawMediaId != null && r.processedMediaId != null);
    expect(dualCapture.length).toBeGreaterThanOrEqual(1);
  });

  it('should resolve the dual-capture recording primary/raw/processed ids to seeded Media rows', () => {
    const mediaIds = new Set(DEFAULT_MEDIA.map((m) => m.id));
    const dualCapture = DEFAULT_AUDIO_RECORDINGS.find((r) => r.rawMediaId != null && r.processedMediaId != null);
    expect(dualCapture).toBeDefined();
    expect(mediaIds.has(dualCapture!.mediaId)).toBe(true);
    expect(mediaIds.has(dualCapture!.rawMediaId!)).toBe(true);
    expect(mediaIds.has(dualCapture!.processedMediaId!)).toBe(true);
  });

  it('should use three distinct media ids (primary != raw != processed) on the demo recording', () => {
    const dualCapture = DEFAULT_AUDIO_RECORDINGS.find((r) => r.rawMediaId != null && r.processedMediaId != null);
    expect(dualCapture).toBeDefined();
    const ids = [dualCapture!.mediaId, dualCapture!.rawMediaId!, dualCapture!.processedMediaId!];
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([SEED_MEDIA_IDS.GEN_AUDIO_PRIMARY, SEED_MEDIA_IDS.GEN_AUDIO_RAW, SEED_MEDIA_IDS.GEN_AUDIO_PROCESSED]);
  });

  it('should keep the dual-capture recording referencing a real (non-placeholder) primary mediaId', () => {
    const dualCapture = DEFAULT_AUDIO_RECORDINGS.find((r) => r.rawMediaId != null && r.processedMediaId != null);
    expect(dualCapture).toBeDefined();
    expect(dualCapture!.mediaId).not.toMatch(/placeholder/);
    expect(dualCapture!.mediaId).toMatch(UUID_REGEX);
  });
});

describe('Dual-Capture Demo Media', () => {
  it('should seed exactly three Media rows (primary + raw + processed)', () => {
    expect(DEFAULT_MEDIA.length).toBe(3);
  });

  it('should have required fields for each Media row', () => {
    const requiredFields = ['id', 'tenantId', 'name', 'uri', 'extension', 'mimeType', 'size', 'hash'];
    DEFAULT_MEDIA.forEach((media) => {
      requiredFields.forEach((field) => {
        expect(media).toHaveProperty(field);
      });
      expect(media.name.length).toBeGreaterThan(0);
      expect(media.uri.length).toBeGreaterThan(0);
      expect(media.size).toBeGreaterThan(0);
    });
  });

  it('should have valid UUID format and unique Media ids', () => {
    DEFAULT_MEDIA.forEach((media) => {
      expect(media.id).toMatch(UUID_REGEX);
    });
    const ids = DEFAULT_MEDIA.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should own all demo Media rows under the Global seed tenant', () => {
    DEFAULT_MEDIA.forEach((media) => {
      expect(media.tenantId).toBe(SEED_TENANT_ID);
    });
  });

  it('should expose every SEED_MEDIA_IDS value as a seeded Media row', () => {
    const ids = new Set(DEFAULT_MEDIA.map((m) => m.id));
    Object.values(SEED_MEDIA_IDS).forEach((id) => {
      expect(ids.has(id)).toBe(true);
    });
  });
});

// =============================================================================
// SUMMARY-META QUALITY SEED — cacheHit + qualityScore
// =============================================================================

describe('SummaryMeta Quality Seed', () => {
  it('should seed at least the two demo SummaryMeta rows', () => {
    expect(DEFAULT_SUMMARY_METAS.length).toBeGreaterThanOrEqual(2);
  });

  it('should set cacheHit (boolean) on every SummaryMeta seed row', () => {
    DEFAULT_SUMMARY_METAS.forEach((meta) => {
      expect(typeof meta.cacheHit).toBe('boolean');
    });
  });

  it('should set a realistic qualityScore in [0,1] on every SummaryMeta seed row', () => {
    DEFAULT_SUMMARY_METAS.forEach((meta) => {
      expect(typeof meta.qualityScore).toBe('number');
      expect(meta.qualityScore).toBeGreaterThan(0);
      expect(meta.qualityScore).toBeLessThanOrEqual(1);
    });
  });

  it('should mix cacheHit true + false across the rows so the QualityBadge demos both states', () => {
    const hits = DEFAULT_SUMMARY_METAS.map((m) => m.cacheHit);
    expect(hits).toContain(true);
    expect(hits).toContain(false);
  });
});

// =============================================================================
// USER VOICE PROFILE SEED
// =============================================================================

describe('UserVoiceProfile Seed', () => {
  it('should seed voice profiles for both seed doctors (DOCTOR + DOCTOR2)', () => {
    const userIds = new Set(SEED_VOICE_PROFILES.map((p) => p.userId));
    expect(userIds.has(SEED_USER_IDS.DOCTOR)).toBe(true);
    expect(userIds.has(SEED_USER_IDS.DOCTOR2)).toBe(true);
  });

  it('should include at least one active AND one inactive voice profile', () => {
    expect(SEED_VOICE_PROFILES.some((p) => p.isActive === true)).toBe(true);
    expect(SEED_VOICE_PROFILES.some((p) => p.isActive === false)).toBe(true);
  });

  it('should give each seed doctor exactly one active profile (drives voiceProfileSeeded + diarization)', () => {
    [SEED_USER_IDS.DOCTOR, SEED_USER_IDS.DOCTOR2].forEach((userId) => {
      const active = SEED_VOICE_PROFILES.filter((p) => p.userId === userId && p.isActive);
      expect(active.length).toBe(1);
    });
  });

  it('should never declare two active profiles for one user (partial-unique-index invariant)', () => {
    const activeByUser = new Map<string, number>();
    SEED_VOICE_PROFILES.filter((p) => p.isActive).forEach((p) => {
      activeByUser.set(p.userId, (activeByUser.get(p.userId) ?? 0) + 1);
    });
    activeByUser.forEach((count) => expect(count).toBeLessThanOrEqual(1));
  });

  it('should carry a valid 256-d finite-number embedding on every voice profile', () => {
    expect(VOICE_EMBEDDING_DIM).toBe(256);
    SEED_VOICE_PROFILES.forEach((p) => {
      expect(Array.isArray(p.embedding)).toBe(true);
      expect(p.embedding.length).toBe(VOICE_EMBEDDING_DIM);
      expect(p.embedding.every((n) => typeof n === 'number' && Number.isFinite(n))).toBe(true);
    });
  });

  it('should have valid UUID + unique ids for every voice profile', () => {
    SEED_VOICE_PROFILES.forEach((p) => expect(p.id).toMatch(UUID_REGEX));
    const ids = SEED_VOICE_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should expose every SEED_VOICE_PROFILE_IDS value as a seeded profile', () => {
    const ids = new Set(SEED_VOICE_PROFILES.map((p) => p.id));
    Object.values(SEED_VOICE_PROFILE_IDS).forEach((id) => expect(ids.has(id)).toBe(true));
  });
});

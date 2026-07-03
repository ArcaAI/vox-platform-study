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
    CUSTOMER_TENANT_GEN_DEPARTMENTS,
    CUSTOMER_TENANT_SPECIALTY_DEPARTMENTS,
} from '../prisma/db_main/seed/04-department';
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
    switchDefaultSttPipeline,
    STT_DEFAULT_PIPELINE_BACKFILL_TENANTS,
    STT_DEFAULT_PIPELINE_SLUG,
    STT_PLACEHOLDER_PIPELINE_SLUG,
} from '../prisma/db_main/seed/06-stt';
import { ALL_SETTINGS, SMR_PROVIDER_MODELS } from '../prisma/db_main/seed/11-global-setting';
import {
    seedHarnessPolicy,
    SYSTEM_HARNESS_POLICY_SMR_DEFAULTS,
} from '../prisma/db_main/seed/13-harness-policy';
import {
    seedPipelinePolicy,
    SYSTEM_PIPELINE_POLICY_DEFAULTS,
    DEMO_PIPELINE_POLICY_OVERRIDE,
} from '../prisma/db_main/seed/14-pipeline-policy';
import { TENANT_FRONTEND_CONFIGS } from '../prisma/db_main/seed/05-tenant';
import {
    DEFAULT_PROMPT_TEMPLATES,
    DEFAULT_PROMPT_VERSIONS,
} from '../prisma/db_main/seed/07-prompt-template';
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
import {
    DEFAULT_AUDIO_RECORDINGS,
    DEFAULT_MEDIA,
    DEFAULT_SUMMARY_METAS,
    SEED_MEDIA_IDS,
} from '../prisma/db_main/seed/09-consultation';
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

    it('should define 21 department IDs (18 Global-tenant + 1 ArcaAI GEN + 2 ArcaAI specialty, TASK-305 Phase F / TASK-331 r2605 #6 / TASK-365)', () => {
        expect(Object.keys(SEED_DEPARTMENT_IDS).length).toBe(21);
    });

    it('should define a per-customer-tenant GEN department ID for the ArcaAI tenant (TASK-305 Phase F)', () => {
        expect(SEED_DEPARTMENT_IDS.GEN_ARCAAI).toBeDefined();
    });

    it('should define CARD + ER specialty department IDs for the ArcaAI tenant (TASK-331 r2605 #6)', () => {
        expect(SEED_DEPARTMENT_IDS.CARD_ARCAAI).toBeDefined();
        expect(SEED_DEPARTMENT_IDS.ER_ARCAAI).toBeDefined();
    });

    it('should include DIET, NEPH, SONC department IDs', () => {
        expect(SEED_DEPARTMENT_IDS.DIET).toBeDefined();
        expect(SEED_DEPARTMENT_IDS.NEPH).toBeDefined();
        expect(SEED_DEPARTMENT_IDS.SONC).toBeDefined();
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
        const deprecatedPrefixes = keys.filter(
            (k) => k.startsWith('PRE_SUMMARY_') && k !== 'PRE_SUMMARY_DEFAULT' && k !== 'PRE_SUMMARY_SYSTEM'
        );
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
        it('should define 20 policies', () => {
            // TASK-331 doc-09 — +1 for the `prompt-template-read` policy.
            // TASK-330 Phase 6 — +2 for the clinical documentation harness
            // policies (`harness-platform-manage`, `harness-tenant-manage`).
            expect(DEFAULT_POLICIES.length).toBe(20);
        });

        it('should include system-full-access policy', () => {
            const systemFullAccess = DEFAULT_POLICIES.find((p) => p.name === 'system-full-access');
            expect(systemFullAccess).toBeDefined();
            expect(systemFullAccess?.scope).toBe(PolicyScope.GLOBAL);
        });

        // TASK-409 — the anti-lockout guard identifies the protected set by the
        // `isProtected` column (rename-proof), with the name match as fallback.
        // The seed MUST mark exactly the two system-critical GLOBAL policies.
        it('should mark exactly system-full-access and rbac-system-manage as isProtected (TASK-409)', () => {
            const protectedNames = DEFAULT_POLICIES.filter((p) => (p as { isProtected?: boolean }).isProtected === true).map((p) => p.name);
            expect(protectedNames.sort()).toEqual(['rbac-system-manage', 'system-full-access']);
        });

        it('should include tenant-full-access policy', () => {
            const tenantFullAccess = DEFAULT_POLICIES.find((p) => p.name === 'tenant-full-access');
            expect(tenantFullAccess).toBeDefined();
            expect(tenantFullAccess?.scope).toBe(PolicyScope.TENANT);
        });

        // TASK-356 Phase 1 — tenant admins self-serve their own tenant's clone
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

        // TASK-331 doc-09 — end-user (clinician) read-only template ability.
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

        // TASK-330 Phase 6 — clinical documentation harness RBAC policies.
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

        // TASK-356 Phase 5 — realtime-pipeline cascade admin RBAC (a SEPARATE
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
            const policiesWithUserCondition = DEFAULT_POLICIES.filter((p) =>
                JSON.stringify(p.rules).includes('${user.id}')
            );
            expect(policiesWithUserCondition.length).toBeGreaterThan(0);
        });

        it('should use ${context.tenantId} template variable in conditions', () => {
            const policiesWithTenantCondition = DEFAULT_POLICIES.filter((p) =>
                JSON.stringify(p.rules).includes('${context.tenantId}')
            );
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
        it('should define 5 system roles', () => {
            expect(SYSTEM_ROLES.length).toBe(5);
        });

        it('should mark all system roles as isSystemRole: true', () => {
            SYSTEM_ROLES.forEach((role) => {
                expect(role.isSystemRole).toBe(true);
            });
        });

        it('should include SUPER_ADMIN role', () => {
            const superAdmin = SYSTEM_ROLES.find((r) => r.name === 'SUPER_ADMIN');
            expect(superAdmin).toBeDefined();
            expect(superAdmin?.isSystemRole).toBe(true);
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
        it('should assign system-full-access to SUPER_ADMIN', () => {
            const superAdmin = DEFAULT_ROLES.find((r) => r.name === 'SUPER_ADMIN');
            expect(superAdmin?.policies).toContain('system-full-access');
        });

        it('should assign tenant-full-access to TENANT_ADMIN', () => {
            const tenantAdmin = DEFAULT_ROLES.find((r) => r.name === 'TENANT_ADMIN');
            expect(tenantAdmin?.policies).toContain('tenant-full-access');
        });

        it('should assign consultation-own-manage to DOCTOR', () => {
            const doctor = DEFAULT_ROLES.find((r) => r.name === 'DOCTOR');
            expect(doctor?.policies).toContain('consultation-own-manage');
        });

        // TASK-331 doc-09 — DOCTOR gets read-only template access (for the
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
    it('should define 18 medical departments', () => {
        expect(DEFAULT_DEPARTMENTS.length).toBe(18);
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

    it('should include all 18 expected departments', () => {
        const codes = DEFAULT_DEPARTMENTS.map((d) => d.code);
        const expectedCodes = [
            'GEN', 'CARD', 'RAD', 'LAB', 'NEUR', 'ORTH', 'DERM', 'PSYCH',
            'PEDS', 'ER', 'SURG', 'MED', 'BREN', 'RHEUM', 'HEME', 'DIET', 'NEPH', 'SONC',
        ];
        expectedCodes.forEach((code) => {
            expect(codes).toContain(code);
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
// CUSTOMER-TENANT DEPARTMENT CATALOG (TASK-331 r2605 #6)
// =============================================================================

describe('Customer-Tenant Department Seed Data (TASK-331 r2605 #6)', () => {
    const customerTenantIds = [
        SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    ];

    it('should define 2 specialty rows (CARD + ER for the ArcaAI customer tenant)', () => {
        expect(CUSTOMER_TENANT_SPECIALTY_DEPARTMENTS.length).toBe(2);
    });

    it('should add CARD and ER to every customer tenant alongside the existing GEN', () => {
        customerTenantIds.forEach((tenantId) => {
            const codes = CUSTOMER_TENANT_SPECIALTY_DEPARTMENTS.filter((d) => d.tenantId === tenantId).map((d) => d.code);
            expect(codes).toEqual(expect.arrayContaining(['CARD', 'ER']));
        });
    });

    it('should keep prompt IDs null on customer-tenant departments (they reference Global templates)', () => {
        [...CUSTOMER_TENANT_GEN_DEPARTMENTS, ...CUSTOMER_TENANT_SPECIALTY_DEPARTMENTS].forEach((dept) => {
            expect(dept.preSummaryPromptId).toBeNull();
            expect(dept.newPatientPromptId).toBeNull();
            expect(dept.revisitPromptId).toBeNull();
        });
    });

    it('should have unique department IDs across all customer-tenant rows', () => {
        const ids = [...CUSTOMER_TENANT_GEN_DEPARTMENTS, ...CUSTOMER_TENANT_SPECIALTY_DEPARTMENTS].map((d) => d.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have valid UUID format for all customer-tenant department IDs', () => {
        [...CUSTOMER_TENANT_GEN_DEPARTMENTS, ...CUSTOMER_TENANT_SPECIALTY_DEPARTMENTS].forEach((dept) => {
            expect(dept.id).toMatch(UUID_REGEX);
        });
    });

    it('should bind every customer-tenant department to a known customer tenant id', () => {
        [...CUSTOMER_TENANT_GEN_DEPARTMENTS, ...CUSTOMER_TENANT_SPECIALTY_DEPARTMENTS].forEach((dept) => {
            expect(customerTenantIds).toContain(dept.tenantId);
        });
    });
});

// =============================================================================
// DEPARTMENT PROMPT CONFIGURATION
// =============================================================================

describe('Department Prompt Configuration', () => {
    const VALID_SUMMARY_TEMPLATES = [
        'SOAP',
        'Radiology-Report',
        'Lab-Report',
        'Psychiatric-Assessment',
        'ER-Triage',
        'Neurology-Structured',
        'Orthopedics-Structured',
        'Surgery-Structured',
        'Medicine-Structured',
        'BreastEndocrine-Structured',
        'Rheumatology-Structured',
        'Hematology-Structured',
        'Dermatology-Structured',
        'Dietetics-Structured',
        'Nephrology-Structured',
        'SurgicalOncology-Structured',
    ];

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
        it('should have all departments pointing to the unified PRE_SUMMARY_DEFAULT template', () => {
            DEFAULT_DEPARTMENTS.forEach((dept) => {
                expect(dept.preSummaryPromptId).toBe(SEED_TEMPLATE_IDS.PRE_SUMMARY_DEFAULT);
            });
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

        it('should use SOAP for general clinical departments', () => {
            const soapDepts = ['GEN', 'CARD', 'PEDS'];
            soapDepts.forEach((code) => {
                const dept = DEFAULT_DEPARTMENTS.find((d) => d.code === code);
                expect(dept).toBeDefined();
                expect(dept?.defaultSummaryTemplate).toBe('SOAP');
            });
        });

        it('should use Radiology-Report for RAD department', () => {
            const rad = DEFAULT_DEPARTMENTS.find((d) => d.code === 'RAD');
            expect(rad?.defaultSummaryTemplate).toBe('Radiology-Report');
        });

        it('should use Lab-Report for LAB department', () => {
            const lab = DEFAULT_DEPARTMENTS.find((d) => d.code === 'LAB');
            expect(lab?.defaultSummaryTemplate).toBe('Lab-Report');
        });

        it('should use Psychiatric-Assessment for PSYCH department', () => {
            const psych = DEFAULT_DEPARTMENTS.find((d) => d.code === 'PSYCH');
            expect(psych?.defaultSummaryTemplate).toBe('Psychiatric-Assessment');
        });

        it('should use ER-Triage for ER department', () => {
            const er = DEFAULT_DEPARTMENTS.find((d) => d.code === 'ER');
            expect(er?.defaultSummaryTemplate).toBe('ER-Triage');
        });
    });

    describe('Prompt IDs', () => {
        const DEPTS_WITH_PROMPTS = [
            'GEN', 'CARD', 'NEUR', 'ORTH', 'SURG', 'MED', 'BREN', 'RHEUM', 'HEME',
            'DERM', 'DIET', 'NEPH', 'SONC',
        ];
        const DEPTS_WITHOUT_PROMPTS = ['RAD', 'LAB', 'PSYCH', 'PEDS', 'ER'];

        it('should have non-null prompt IDs for departments with prompt registry', () => {
            DEPTS_WITH_PROMPTS.forEach((code) => {
                const dept = DEFAULT_DEPARTMENTS.find((d) => d.code === code);
                expect(dept).toBeDefined();
                expect(dept?.newPatientPromptId).not.toBeNull();
                expect(dept?.revisitPromptId).not.toBeNull();
            });
        });

        it('should have null prompt IDs for departments without prompt registry', () => {
            DEPTS_WITHOUT_PROMPTS.forEach((code) => {
                const dept = DEFAULT_DEPARTMENTS.find((d) => d.code === code);
                expect(dept).toBeDefined();
                expect(dept?.newPatientPromptId).toBeNull();
                expect(dept?.revisitPromptId).toBeNull();
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
            const clinicalDepts = ['GEN', 'CARD', 'NEUR', 'ORTH', 'PEDS', 'ER'];
            clinicalDepts.forEach((code) => {
                const dept = DEFAULT_DEPARTMENTS.find((d) => d.code === code);
                expect(dept?.promptConfig!.contextVariables).toContain('Recent Vitals');
            });
        });

        it('should include "PREVIOUS CASE NOTES SUMMARY" for consultation-based departments', () => {
            const consultDepts = ['GEN', 'CARD', 'NEUR', 'ORTH', 'DERM', 'PSYCH', 'PEDS'];
            consultDepts.forEach((code) => {
                const dept = DEFAULT_DEPARTMENTS.find((d) => d.code === code);
                expect(dept?.promptConfig!.contextVariables).toContain('PREVIOUS CASE NOTES SUMMARY');
            });
        });

        it('should have department-specific context variables for specialties', () => {
            const card = DEFAULT_DEPARTMENTS.find((d) => d.code === 'CARD');
            expect(card?.promptConfig!.contextVariables).toContain('ECG Results');

            const rad = DEFAULT_DEPARTMENTS.find((d) => d.code === 'RAD');
            expect(rad?.promptConfig!.contextVariables).toContain('Prior Imaging');

            const peds = DEFAULT_DEPARTMENTS.find((d) => d.code === 'PEDS');
            expect(peds?.promptConfig!.contextVariables).toContain('Growth Chart');
            expect(peds?.promptConfig!.contextVariables).toContain('Immunization History');

            const psych = DEFAULT_DEPARTMENTS.find((d) => d.code === 'PSYCH');
            expect(psych?.promptConfig!.contextVariables).toContain('Risk Assessment');
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
            const lowAbbrevDepts = ['GEN', 'DERM', 'PSYCH', 'PEDS', 'MED'];
            lowAbbrevDepts.forEach((code) => {
                const dept = DEFAULT_DEPARTMENTS.find((d) => d.code === code);
                expect(dept?.promptConfig!.abbreviationDensity).toBe('low');
            });
        });

        it('should have medium abbreviation density for mixed departments', () => {
            const mediumAbbrevDepts = ['CARD', 'NEUR', 'ORTH', 'SURG', 'BREN', 'RHEUM', 'HEME'];
            mediumAbbrevDepts.forEach((code) => {
                const dept = DEFAULT_DEPARTMENTS.find((d) => d.code === code);
                expect(dept?.promptConfig!.abbreviationDensity).toBe('medium');
            });
        });
    });

    describe('Integration with Existing Fields', () => {
        it('should preserve all required fields alongside prompt fields', () => {
            const allRequiredFields = [
                'id', 'tenantId', 'code', 'name', 'description',
                'defaultSummaryTemplate', 'preSummaryPromptId',
                'newPatientPromptId', 'revisitPromptId', 'promptConfig',
            ];
            DEFAULT_DEPARTMENTS.forEach((dept) => {
                allRequiredFields.forEach((field) => {
                    expect(dept).toHaveProperty(field);
                });
            });
        });

        it('should have 18 departments after prompt config addition', () => {
            expect(DEFAULT_DEPARTMENTS.length).toBe(18);
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
                    'id', 'tenantId', 'name', 'slug', 'description',
                    'category', 'taskType', 'modelType', 'source', 'sourceUri', 'format', 'tags',
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
                // reserved system tenant (`00000000-…`), per TASK-305 Phase A.
                DEFAULT_AI_MODELS.forEach((model) => {
                    expect(model.tenantId).toBe(SYSTEM_TENANT_ID);
                });
            });
        });

        describe('Model Categories', () => {
            it('should have valid category for all models (AUDIO or NLP)', () => {
                const validCategories = [ModelCategory.AUDIO, ModelCategory.NLP];
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

        describe('ASR Models', () => {
            it('should include Whisper Large V3 model', () => {
                const whisperLarge = DEFAULT_AI_MODELS.find((m) => m.slug === 'whisper-large-v3');
                expect(whisperLarge).toBeDefined();
                expect(whisperLarge?.taskType).toBe(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION);
                expect(whisperLarge?.source).toBe(AiModelSource.HUGGINGFACE);
            });

            it('should include Whisper Large V3 Turbo model', () => {
                const whisperTurbo = DEFAULT_AI_MODELS.find((m) => m.slug === 'whisper-large-v3-turbo');
                expect(whisperTurbo).toBeDefined();
                expect(whisperTurbo?.modelType).toBe(ModelType.QUANTIZED_MODEL);
            });

            it('should include Faster Whisper ONNX model', () => {
                const fasterWhisper = DEFAULT_AI_MODELS.find((m) => m.slug === 'faster-whisper-large-v3');
                expect(fasterWhisper).toBeDefined();
                expect(fasterWhisper?.format).toBe(AiModelFormat.ONNX);
            });

            it('should include NeMo Parakeet model', () => {
                const parakeet = DEFAULT_AI_MODELS.find((m) => m.slug === 'parakeet-ctc-1.1b');
                expect(parakeet).toBeDefined();
                expect(parakeet?.format).toBe(AiModelFormat.NEMO);
            });
        });

        describe('Guardrail Models (TASK-356 Phase 1)', () => {
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
            it('should include Silero VAD models', () => {
                const sileroVadV4 = DEFAULT_AI_MODELS.find((m) => m.slug === 'silero-vad-v4');
                const sileroVadV5 = DEFAULT_AI_MODELS.find((m) => m.slug === 'silero-vad-v5');
                expect(sileroVadV4).toBeDefined();
                expect(sileroVadV5).toBeDefined();
                expect(sileroVadV4?.taskType).toBe(ModelTaskType.VOICE_ACTIVITY_DETECTION);
                expect(sileroVadV5?.taskType).toBe(ModelTaskType.VOICE_ACTIVITY_DETECTION);
            });

            it('should have VAD models with low memory requirements', () => {
                const vadModels = DEFAULT_AI_MODELS.filter(
                    (m) => m.taskType === ModelTaskType.VOICE_ACTIVITY_DETECTION
                );
                vadModels.forEach((model) => {
                    expect(model.memorySizeMb).toBeLessThan(500);
                });
            });
        });

        describe('Noise Reduction Models', () => {
            it('should include DeepFilterNet model', () => {
                const deepfilter = DEFAULT_AI_MODELS.find((m) => m.slug === 'deepfilternet-v3');
                expect(deepfilter).toBeDefined();
                expect(deepfilter?.taskType).toBe(ModelTaskType.AUDIO_TO_AUDIO);
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
        });

        describe('Default Pipelines', () => {
            it('should include production pipeline', () => {
                const production = DEFAULT_ASR_PIPELINES.find((p) => p.slug === 'production-whisper-large-v3');
                expect(production).toBeDefined();
                expect(production?.tags).toContain('production');
                expect(production?.tags).toContain('recommended');
            });

            it('should include turbo pipeline for streaming', () => {
                const turbo = DEFAULT_ASR_PIPELINES.find((p) => p.slug === 'turbo-whisper-large-v3');
                expect(turbo).toBeDefined();
                expect(turbo?.tags).toContain('streaming');
                expect(turbo?.tags).toContain('fast');
            });

            it('should include lightweight CPU pipeline', () => {
                const lightweight = DEFAULT_ASR_PIPELINES.find((p) => p.slug === 'lightweight-whisper-small');
                expect(lightweight).toBeDefined();
                expect(lightweight?.tags).toContain('cpu');
                expect(lightweight?.tags).toContain('lightweight');
            });

            it('should include optimized ONNX pipeline', () => {
                const optimized = DEFAULT_ASR_PIPELINES.find((p) => p.slug === 'optimized-faster-whisper');
                expect(optimized).toBeDefined();
                expect(optimized?.tags).toContain('optimized');
                expect(optimized?.tags).toContain('onnx');
            });

            it('should include NeMo English pipeline', () => {
                const nemo = DEFAULT_ASR_PIPELINES.find((p) => p.slug === 'nemo-parakeet-english');
                expect(nemo).toBeDefined();
                expect(nemo?.tags).toContain('nemo');
                expect(nemo?.tags).toContain('english');
            });
        });
    });

    describe('STT Global Settings Seed Data', () => {
        describe('Structure', () => {
            it('should have required fields for each setting', () => {
                const requiredFields = [
                    'id', 'tenantId', 'namespace', 'name', 'key', 'value', 'dataType', 'description',
                ];
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
            it('should include model cache settings', () => {
                const cacheSettings = DEFAULT_STT_SETTINGS.filter((s) => s.name === 'model_cache');
                expect(cacheSettings.length).toBeGreaterThanOrEqual(3);
                const keys = cacheSettings.map((s) => s.key);
                expect(keys).toContain('max_models');
                expect(keys).toContain('ttl_seconds');
                expect(keys).toContain('max_memory_mb');
            });

            it('should include worker settings', () => {
                const workerSettings = DEFAULT_STT_SETTINGS.filter((s) => s.name === 'workers');
                expect(workerSettings.length).toBeGreaterThanOrEqual(2);
                const keys = workerSettings.map((s) => s.key);
                expect(keys).toContain('concurrency');
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
                DEFAULT_STT_SETTINGS
                    .filter((s) => !envDrivenKeys.includes(s.key))
                    .forEach((setting) => {
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
// PER-TENANT ASR PIPELINES + isDefault (TASK-331 doc-03 F3 / Q2)
// =============================================================================

describe('Per-Tenant ASR Pipelines (TASK-331 doc-03 F3)', () => {
    const customerTenantIds = [
        SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    ];

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

describe('ASR Pipeline isDefault invariant (TASK-331 doc-03 Q2)', () => {
    const allPipelines = [...DEFAULT_ASR_PIPELINES, ...CUSTOMER_TENANT_ASR_PIPELINES];
    const customerTenantIds = [
        SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    ];

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

    it('should make the resolvable production-whisper-large-v3 pipeline (TASK-361) the system isDefault one', () => {
        // TASK-361 — the SYSTEM default is the resolvable production-whisper-large-v3
        // pipeline (id …0001); the CT2 int8 pipeline (id …0008) is registered but
        // NOT default until the D-4 artifact replaces MODEL_REPO_PLACEHOLDER.
        const systemDefault = DEFAULT_ASR_PIPELINES.find(
            (p) => p.id === '81000000-0000-0000-0001-000000000001'
        );
        expect(systemDefault).toBeDefined();
        expect(systemDefault?.slug).toBe('production-whisper-large-v3');
        expect(systemDefault?.isDefault).toBe(true);

        // The CT2 placeholder pipeline must NOT be a default so there is exactly one.
        const ct2 = DEFAULT_ASR_PIPELINES.find(
            (p) => p.id === '81000000-0000-0000-0001-000000000008'
        );
        expect(ct2?.slug).toBe('production-faster-whisper-turbo-int8');
        expect(ct2?.isDefault).toBe(false);
    });

    it('should give each customer tenant exactly one isDefault pipeline', () => {
        customerTenantIds.forEach((tenantId) => {
            const defaults = CUSTOMER_TENANT_ASR_PIPELINES.filter(
                (p) => p.tenantId === tenantId && p.isDefault === true
            );
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
// TASK-356 Phase 2 — DEFAULT MODEL WIRING
//   (a) SMR  → gemma-4-e2b-it-sft-rlvr-medical (lm-studio)
//   (b) Guardrail → granite-guardian-4.1-8b (regression guard; no flip)
//   (c) STT  → faster-whisper whisper-large-v3-turbo CTranslate2 int8
// =============================================================================

describe('TASK-356 Phase 2 — SMR default (gemma-4-e2b-it-sft-rlvr-medical)', () => {
    it('points the default-smr-model GlobalSetting at gemma-4-e2b-it-sft-rlvr-medical for every tenant', () => {
        const smrModelSettings = ALL_SETTINGS.filter((s) => s.key === 'default-smr-model');
        expect(smrModelSettings.length).toBeGreaterThanOrEqual(1);
        smrModelSettings.forEach((s) => {
            expect(s.value).toBe('gemma-4-e2b-it-sft-rlvr-medical');
            expect(s.defaultValue).toBe('gemma-4-e2b-it-sft-rlvr-medical');
        });
    });

    it('keeps gemma-4-e2b-it-sft-rlvr-medical a member of the lm-studio SMR provider catalog (resolver validity)', () => {
        const lmStudio = SMR_PROVIDER_MODELS.find((p) => p.provider === 'lm-studio');
        expect(lmStudio).toBeDefined();
        const names = lmStudio!.models.map((m) => m.name);
        expect(names).toContain('gemma-4-e2b-it-sft-rlvr-medical');
    });
});

describe('TASK-356 Phase 2 — Guardrail default (granite) regression guard', () => {
    it('keeps default-guardrail-model = granite-guardian-4.1-8b for every tenant', () => {
        const guardrailModelSettings = ALL_SETTINGS.filter((s) => s.key === 'default-guardrail-model');
        expect(guardrailModelSettings.length).toBeGreaterThanOrEqual(1);
        guardrailModelSettings.forEach((s) => {
            expect(s.value).toBe('granite-guardian-4.1-8b');
            expect(s.defaultValue).toBe('granite-guardian-4.1-8b');
        });
    });

    it('keeps default-guardrail-provider = lm-studio for every tenant', () => {
        const guardrailProviderSettings = ALL_SETTINGS.filter((s) => s.key === 'default-guardrail-provider');
        expect(guardrailProviderSettings.length).toBeGreaterThanOrEqual(1);
        guardrailProviderSettings.forEach((s) => {
            expect(s.value).toBe('lm-studio');
        });
    });

    it('keeps the granite-guardian catalog row registered under SYSTEM (GUARDRAIL / GGUF)', () => {
        const granite = DEFAULT_AI_MODELS.find((m) => m.slug === 'granite-guardian-4.1-8b');
        expect(granite).toBeDefined();
        expect(granite?.tenantId).toBe(SYSTEM_TENANT_ID);
        expect(granite?.taskType).toBe(ModelTaskType.GUARDRAIL);
        expect(granite?.format).toBe(AiModelFormat.GGUF);
    });
});

describe('TASK-356 Phase 2 / TASK-361 — STT default (CT2 registered; whisper-large-v3 effective default)', () => {
    const CT2_MODEL_SLUG = 'faster-whisper-large-v3-turbo-int8';
    const CT2_PIPELINE_SLUG = 'production-faster-whisper-turbo-int8';
    const DEFAULT_PIPELINE_SLUG = 'production-whisper-large-v3';

    it('mirrors the CTRANSLATE2 format in the seed enum mirror', () => {
        expect(AiModelFormat.CTRANSLATE2).toBe('CTRANSLATE2');
    });

    it('registers the CT2 int8 turbo AiModel under SYSTEM with a clearly-marked placeholder sourceUri', () => {
        const ct2 = DEFAULT_AI_MODELS.find((m) => m.slug === CT2_MODEL_SLUG);
        expect(ct2).toBeDefined();
        expect(ct2?.tenantId).toBe(SYSTEM_TENANT_ID);
        expect(ct2?.category).toBe(ModelCategory.AUDIO);
        expect(ct2?.taskType).toBe(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION);
        expect(ct2?.modelType).toBe(ModelType.QUANTIZED_MODEL);
        expect(ct2?.format).toBe(AiModelFormat.CTRANSLATE2);
        expect(ct2?.computeType).toBe('int8');
        // D-4: engineers publish the real CT2 artifact before the prod flip; the
        // placeholder intentionally won't resolve at runtime yet.
        expect(ct2?.sourceUri).toContain('MODEL_REPO_PLACEHOLDER');
    });

    it('registers the CT2 pipeline as NOT default and keeps production-whisper-large-v3 as the SYSTEM default', () => {
        const ct2 = DEFAULT_ASR_PIPELINES.find((p) => p.slug === CT2_PIPELINE_SLUG);
        expect(ct2).toBeDefined();
        expect(ct2?.isDefault).toBe(false);
        const production = DEFAULT_ASR_PIPELINES.find((p) => p.slug === DEFAULT_PIPELINE_SLUG);
        expect(production?.isDefault).toBe(true);
    });

    it('makes production-whisper-large-v3 the isDefault one for SYSTEM, Global, and every customer tenant', () => {
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
        const all = [
            ...DEFAULT_ASR_PIPELINES,
            ...GLOBAL_TENANT_ASR_PIPELINES,
            ...CUSTOMER_TENANT_ASR_PIPELINES,
        ];
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

    it('carries diarization + dual_capture into the CT2 pipeline config', () => {
        const ct2 = DEFAULT_ASR_PIPELINES.find((p) => p.slug === CT2_PIPELINE_SLUG);
        expect(ct2).toBeDefined();
        expect(ct2!.configYaml).toContain('engine: "faster_whisper"');
        expect(ct2!.configYaml).toMatch(/compute_type:\s*int8/);
        expect(ct2!.configYaml).toContain('diarization:');
        expect(ct2!.configYaml).toContain('dual_capture:');
    });
});

describe('TASK-361 — STT default resolves to a loadable artifact (no placeholder default)', () => {
    const PLACEHOLDER = 'MODEL_REPO_PLACEHOLDER';
    const CT2_MODEL_SLUG = 'faster-whisper-large-v3-turbo-int8';
    const CT2_PIPELINE_SLUG = 'production-faster-whisper-turbo-int8';
    const allPipelines = [
        ...DEFAULT_ASR_PIPELINES,
        ...GLOBAL_TENANT_ASR_PIPELINES,
        ...CUSTOMER_TENANT_ASR_PIPELINES,
    ];

    it('never marks a pipeline whose config references the placeholder artifact as isDefault', () => {
        // AC-1/AC-2: the live default STT pipeline must resolve to a real artifact.
        // The CT2 int8 pipeline carries the non-resolving MODEL_REPO_PLACEHOLDER
        // (pending the D-4 publish), so it must NOT be any tenant's isDefault.
        const placeholderDefaults = allPipelines.filter(
            (p) => p.isDefault === true && p.configYaml.includes(PLACEHOLDER)
        );
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

    it('keeps the placeholder CT2 AiModel registered but NOT tagged production/recommended (AC-3)', () => {
        const ct2 = DEFAULT_AI_MODELS.find((m) => m.slug === CT2_MODEL_SLUG);
        expect(ct2).toBeDefined(); // still in the catalog so admins can see it
        expect(ct2?.sourceUri).toContain(PLACEHOLDER); // still the placeholder until D-4
        expect(ct2?.tags).not.toContain('production');
        expect(ct2?.tags).not.toContain('recommended');
    });

    it('does not tag the placeholder CT2 pipeline as production/recommended (AC-3)', () => {
        const ct2Pipelines = allPipelines.filter((p) => p.slug === CT2_PIPELINE_SLUG);
        expect(ct2Pipelines.length).toBeGreaterThan(0);
        ct2Pipelines.forEach((p) => {
            expect(p.tags).not.toContain('production');
            expect(p.tags).not.toContain('recommended');
        });
    });
});

// =============================================================================
// TENANT FRONTEND CONFIG SEED (TASK-331 doc-03 F3)
// =============================================================================

describe('Tenant Frontend Config Seed (TASK-331 doc-03 F3)', () => {
    const expectedTenantIds = [
        SEED_TENANT_ID,
        SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    ];

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
            const requiredFields = [
                'id', 'tenantId', 'name', 'content', 'category', 'currentVersionNumber', 'tags',
            ];
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
            const preSummary = DEFAULT_PROMPT_TEMPLATES.find(
                (t) => t.id === SEED_TEMPLATE_IDS.PRE_SUMMARY_DEFAULT
            );
            expect(preSummary).toBeDefined();
            expect(preSummary?.category).toBe('SYSTEM');
        });

        it('should have PRE_SUMMARY_DEFAULT with required template variables', () => {
            const preSummary = DEFAULT_PROMPT_TEMPLATES.find(
                (t) => t.id === SEED_TEMPLATE_IDS.PRE_SUMMARY_DEFAULT
            );
            expect(preSummary).toBeDefined();
            const content = preSummary!.content;
            const requiredVars = [
                '{current_department}',
                '{visit_type}',
                '{safe_age}',
            ];
            requiredVars.forEach((v) => {
                expect(content).toContain(v);
            });
        });

        it('should have PRE_SUMMARY_DEFAULT with 5 output sections', () => {
            const preSummary = DEFAULT_PROMPT_TEMPLATES.find(
                (t) => t.id === SEED_TEMPLATE_IDS.PRE_SUMMARY_DEFAULT
            );
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

        it('should include CUSTOM template with Cardiology departmentId', () => {
            const custom = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.CARD_CUSTOM);
            expect(custom).toBeDefined();
            expect(custom?.departmentId).toBe(SEED_DEPARTMENT_IDS.CARD);
        });
    });

    describe('Department-Specific Templates', () => {
        it('should have new-referral and revisit templates for DERM', () => {
            const dermNew = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.DERM_NEW_REFERRAL);
            const dermRevisit = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.DERM_REVISIT);
            expect(dermNew).toBeDefined();
            expect(dermRevisit).toBeDefined();
        });

        it('should have new-referral and revisit templates for DIET', () => {
            const dietNew = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.DIET_NEW_REFERRAL);
            const dietRevisit = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.DIET_REVISIT);
            expect(dietNew).toBeDefined();
            expect(dietRevisit).toBeDefined();
        });

        it('should have new-referral and revisit templates for NEPH', () => {
            const nephNew = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.NEPH_NEW_REFERRAL);
            const nephRevisit = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.NEPH_REVISIT);
            expect(nephNew).toBeDefined();
            expect(nephRevisit).toBeDefined();
        });

        it('should have new-referral and revisit templates for SONC', () => {
            const soncNew = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.SONC_NEW_REFERRAL);
            const soncRevisit = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === SEED_TEMPLATE_IDS.SONC_REVISIT);
            expect(soncNew).toBeDefined();
            expect(soncRevisit).toBeDefined();
        });
    });
});

describe('Prompt Version Seed Data', () => {
    describe('Prompt Version Structure', () => {
        it('should have required fields for each prompt version', () => {
            const requiredFields = [
                'id', 'tenantId', 'promptTemplateId', 'versionNumber', 'content', 'changeReason', 'changedBy',
            ];
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
            const requiredFields = [
                'id', 'tenantId', 'doctorId', 'reportData', 'styleText', 'isLatest', 'currentVersionNumber',
            ];
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
            const requiredFields = [
                'id', 'tenantId', 'dnaReportId', 'versionNumber', 'changeReason', 'changedBy',
            ];
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
// SMR V2 LLM MODELS SEED DATA TESTS
// =============================================================================

describe('SMR v2 LLM Models Seed Data', () => {
    const smrModels = DEFAULT_AI_MODELS.filter(
        (m) => m.taskType === ModelTaskType.SUMMARIZATION || m.taskType === ModelTaskType.TEXT_GENERATION
    );

    describe('Provider Coverage', () => {
        it('should include 11 Ollama models', () => {
            const ollamaModels = smrModels.filter((m) => m.tags.includes('ollama'));
            expect(ollamaModels.length).toBe(11);
        });

        it('should include at least one Azure OpenAI model', () => {
            const azureModels = smrModels.filter((m) => m.tags.includes('azure-openai'));
            expect(azureModels.length).toBeGreaterThanOrEqual(1);
        });

        it('should include at least one Bedrock model', () => {
            const bedrockModels = smrModels.filter((m) => m.tags.includes('bedrock'));
            expect(bedrockModels.length).toBeGreaterThanOrEqual(1);
        });

        it('should include 13 LM Studio models', () => {
            const lmsModels = smrModels.filter((m) => m.tags.includes('lm-studio'));
            expect(lmsModels.length).toBe(13);
        });

        it('should include at least one OpenAI-compatible model', () => {
            const compatModels = smrModels.filter((m) =>
                m.tags.includes('openai-compat') || m.tags.includes('lm-studio')
            );
            expect(compatModels.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('Model Structure', () => {
        it('should have NLP category for all LLM models', () => {
            smrModels.forEach((model) => {
                expect(model.category).toBe(ModelCategory.NLP);
            });
        });

        it('should have valid task types (SUMMARIZATION or TEXT_GENERATION)', () => {
            smrModels.forEach((model) => {
                expect([ModelTaskType.SUMMARIZATION, ModelTaskType.TEXT_GENERATION]).toContain(model.taskType);
            });
        });

        it('should have unique slugs for all SMR models', () => {
            const slugs = smrModels.map((m) => m.slug);
            expect(new Set(slugs).size).toBe(slugs.length);
        });

        it('should have smr tag on all SMR models', () => {
            smrModels.forEach((model) => {
                expect(model.tags).toContain('smr');
            });
        });

        it('should have IDs in the 80000000-0000-0000-0005 range', () => {
            smrModels.forEach((model) => {
                expect(model.id).toMatch(/^80000000-0000-0000-0005-/);
            });
        });
    });

    describe('Ollama Models', () => {
        const EXPECTED_OLLAMA_SLUGS = [
            'ollama-qwen3.5-27b',
            'ollama-qwen3.5-latest',
            'ollama-translategemma-12b',
            'ollama-translategemma-latest',
            'ollama-medgemma-27b-text-q4km',
            'ollama-gemma3-latest',
            'ollama-gemma3n-e2b',
            'ollama-gpt-oss-latest',
            'ollama-gemma3n-latest',
            'ollama-granite4-tiny-h',
            'ollama-granite4-latest',
        ];

        it.each(EXPECTED_OLLAMA_SLUGS)('should include Ollama model %s', (slug) => {
            const model = smrModels.find((m) => m.slug === slug);
            expect(model).toBeDefined();
            expect(model?.tags).toContain('ollama');
            expect(model?.tags).toContain('smr');
        });

        it('should store the original Ollama model name in description or sourceUri', () => {
            const granite = smrModels.find((m) => m.slug === 'ollama-granite4-latest');
            expect(granite).toBeDefined();
            expect(granite?.sourceUri).toContain('granite4');
        });
    });

    describe('LM Studio Models', () => {
        const EXPECTED_LMS_SLUGS = [
            'lms-qwen3.5-4b',
            'lms-qwen3.5-0.8b',
            'lms-qwen3.5-9b',
            'lms-qwen3.5-35b-a3b',
            'lms-lfm2-24b-a2b',
            'lms-glm-4.6v-flash',
            'lms-lfm2.5-1.2b-instruct',
            'lms-lfm2.5-1.2b-thinking',
            'lms-lfm2.5-vl-1.6b',
            'lms-translategemma-27b-it',
            'lms-gemma-4-e2b-it-sft-rlvr-medical',
            'lms-medgemma-1.5-4b-unsloth',
            'lms-gpt-oss-20b',
        ];

        it.each(EXPECTED_LMS_SLUGS)('should include LM Studio model %s', (slug) => {
            const model = smrModels.find((m) => m.slug === slug);
            expect(model).toBeDefined();
            expect(model?.tags).toContain('lm-studio');
            expect(model?.tags).toContain('smr');
        });

        it('should have openai-compat tag on all LM Studio models', () => {
            const lmsModels = smrModels.filter((m) => m.tags.includes('lm-studio'));
            lmsModels.forEach((model) => {
                expect(model.tags).toContain('openai-compat');
            });
        });

        it('should mark lms-gemma-4-e2b-it-sft-rlvr-medical as a SAFETENSOR-format model', () => {
            const gemmaMedical = smrModels.find((m) => m.slug === 'lms-gemma-4-e2b-it-sft-rlvr-medical');
            expect(gemmaMedical).toBeDefined();
            expect(gemmaMedical?.format).toBe(AiModelFormat.SAFETENSOR);
        });
    });

    describe('Azure OpenAI Models', () => {
        it('should include gpt-4o-mini model', () => {
            const gpt4oMini = smrModels.find((m) => m.slug === 'gpt-4o-mini');
            expect(gpt4oMini).toBeDefined();
            expect(gpt4oMini?.tags).toContain('azure-openai');
        });
    });

    describe('Default Provider Models', () => {
        it('should include gpt-4 model (default Azure OpenAI model)', () => {
            const gpt4 = smrModels.find((m) => m.slug === 'gpt-4');
            expect(gpt4).toBeDefined();
            expect(gpt4?.tags).toContain('azure-openai');
        });

        it('should include claude-3-haiku model (default Bedrock model)', () => {
            const claude = smrModels.find((m) => m.slug === 'claude-3-haiku');
            expect(claude).toBeDefined();
            expect(claude?.tags).toContain('bedrock');
        });

        it('should have granite4-latest as a small default-capable Ollama model', () => {
            const granite = smrModels.find((m) => m.slug === 'ollama-granite4-latest');
            expect(granite).toBeDefined();
            expect(granite?.memorySizeMb).toBeLessThanOrEqual(2200);
        });
    });

    describe('Model Size Metadata', () => {
        it('should have memorySizeMb > 0 for local models', () => {
            const localModels = smrModels.filter(
                (m) => m.tags.includes('ollama') || m.tags.includes('lm-studio')
            );
            localModels.forEach((model) => {
                expect(model.memorySizeMb).toBeGreaterThan(0);
            });
        });

        it('should have memorySizeMb = 0 for cloud models', () => {
            const cloudModels = smrModels.filter(
                (m) => m.tags.includes('azure-openai') || m.tags.includes('bedrock')
            );
            cloudModels.forEach((model) => {
                expect(model.memorySizeMb).toBe(0);
            });
        });
    });
});

// =============================================================================
// STT LOCAL PROCESSING (BROWSER) MODELS SEED DATA TESTS
// =============================================================================

describe('STT Local Processing Models Seed Data', () => {
    const localModels = DEFAULT_AI_MODELS.filter(
        (m) => m.tags.includes('local-processing') && m.taskType === ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION
    );

    describe('Browser Whisper Model Coverage', () => {
        it('should include whisper-tiny for local processing', () => {
            const tiny = localModels.find((m) => m.slug === 'whisper-tiny');
            expect(tiny).toBeDefined();
            expect(tiny?.tags).toContain('local-processing');
        });

        it('should include whisper-base for local processing', () => {
            const base = localModels.find((m) => m.slug === 'whisper-base');
            expect(base).toBeDefined();
            expect(base?.tags).toContain('local-processing');
        });

        it('should include whisper-small for local processing', () => {
            const small = localModels.find((m) => m.slug === 'whisper-small-local');
            expect(small).toBeDefined();
            expect(small?.tags).toContain('local-processing');
        });

        it('should include whisper-medium for local processing', () => {
            const medium = localModels.find((m) => m.slug === 'whisper-medium-local');
            expect(medium).toBeDefined();
            expect(medium?.tags).toContain('local-processing');
        });
    });

    describe('Local Model Properties', () => {
        it('should use ONNX format for all local models (browser compatibility)', () => {
            localModels.forEach((model) => {
                expect(model.format).toBe(AiModelFormat.ONNX);
            });
        });

        it('should have onnx-community source URIs for local models', () => {
            localModels.forEach((model) => {
                expect(model.sourceUri).toMatch(/^onnx-community\//);
            });
        });

        it('should have AUDIO category for all local models', () => {
            localModels.forEach((model) => {
                expect(model.category).toBe(ModelCategory.AUDIO);
            });
        });

        it('should have reasonable memory sizes for browser use', () => {
            localModels.forEach((model) => {
                expect(model.memorySizeMb).toBeLessThanOrEqual(1024);
            });
        });

        it('should have at least 4 local processing models', () => {
            expect(localModels.length).toBeGreaterThanOrEqual(4);
        });
    });
});

// =============================================================================
// CUSTOMER-TENANT AI MODEL CATALOG BACKFILL (TASK-356 Phase 1, D-5)
// =============================================================================

describe('Customer-tenant AI model catalog backfill', () => {
    const makeMockClient = (findFirstImpl: () => unknown) => {
        const created: Array<{ data: Record<string, unknown> }> = [];
        const client = {
            aiModel: {
                findFirst: vi.fn(async () => findFirstImpl()),
                create: vi.fn(async (args: { data: Record<string, unknown> }) => {
                    created.push(args);
                    return args.data;
                }),
            },
        };
        return { client, created };
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

    it('is idempotent — skips slugs the tenant already owns', async () => {
        const { client } = makeMockClient(() => ({ id: 'already-exists' }));
        const result = await backfillCustomerTenantAiModels(client as never);

        expect(result.count).toBe(0);
        expect(client.aiModel.create).not.toHaveBeenCalled();
    });
});

// =============================================================================
// TASK-356 Phase 2 — SYSTEM HarnessPolicy SMR default + WORM audit
// =============================================================================

describe('TASK-356 Phase 2 — seedHarnessPolicy (SMR default + WORM)', () => {
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

    it('exposes the agreed SMR defaults (lm-studio + gemma-4-e2b-it-sft-rlvr-medical)', () => {
        expect(SYSTEM_HARNESS_POLICY_SMR_DEFAULTS.smrProvider).toBe('lm-studio');
        expect(SYSTEM_HARNESS_POLICY_SMR_DEFAULTS.smrModel).toBe('gemma-4-e2b-it-sft-rlvr-medical');
    });

    it('creates the SYSTEM policy row with the SMR defaults and writes a WORM change (beforeJson=null)', async () => {
        const { client, created, changes } = makeMockClient(null);
        const result = await seedHarnessPolicy(client as never);

        expect(result.action).toBe('created');
        expect(result.changeWritten).toBe(true);

        expect(client.harnessPolicy.create).toHaveBeenCalledTimes(1);
        expect(created[0].data.tenantId).toBe(SYSTEM_TENANT_ID);
        expect(created[0].data.smrProvider).toBe('lm-studio');
        expect(created[0].data.smrModel).toBe('gemma-4-e2b-it-sft-rlvr-medical');

        // WORM audit entry (HarnessPolicyChange) recorded for the default-set.
        expect(client.harnessPolicyChange.create).toHaveBeenCalledTimes(1);
        const change = changes[0].data;
        expect(change.tenantId).toBe(SYSTEM_TENANT_ID);
        expect(change.beforeJson).toBeNull();
        expect((change.afterJson as Record<string, unknown>).smrProvider).toBe('lm-studio');
        expect((change.afterJson as Record<string, unknown>).smrModel).toBe(
            'gemma-4-e2b-it-sft-rlvr-medical'
        );
        expect(change.changedBy).toBe(SYSTEM_USER_ID);
    });

    it('is idempotent — no write/WORM when the SYSTEM policy already has the SMR defaults', async () => {
        const { client } = makeMockClient({
            id: 'existing-id',
            tenantId: SYSTEM_TENANT_ID,
            version: 3,
            smrProvider: 'lm-studio',
            smrModel: 'gemma-4-e2b-it-sft-rlvr-medical',
        });
        const result = await seedHarnessPolicy(client as never);

        expect(result.action).toBe('noop');
        expect(result.changeWritten).toBe(false);
        expect(client.harnessPolicy.create).not.toHaveBeenCalled();
        expect(client.harnessPolicy.update).not.toHaveBeenCalled();
        expect(client.harnessPolicyChange.create).not.toHaveBeenCalled();
    });

    it('updates ONLY the two SMR columns on an existing NULL-SMR row and writes a before/after WORM change', async () => {
        const { client, updated, changes } = makeMockClient({
            id: 'existing-id',
            tenantId: SYSTEM_TENANT_ID,
            version: 1,
            smrProvider: null,
            smrModel: null,
            safetyModel: 'granite-guardian-4.1-8b',
        });
        const result = await seedHarnessPolicy(client as never);

        expect(result.action).toBe('updated');
        expect(result.changeWritten).toBe(true);

        expect(client.harnessPolicy.update).toHaveBeenCalledTimes(1);
        // Writes ONLY the two SMR columns (does not clobber other admin knobs).
        expect(Object.keys(updated[0].data).sort()).toEqual(['smrModel', 'smrProvider']);
        expect(updated[0].data.smrProvider).toBe('lm-studio');
        expect(updated[0].data.smrModel).toBe('gemma-4-e2b-it-sft-rlvr-medical');

        const change = changes[0].data;
        expect((change.beforeJson as Record<string, unknown>).smrModel).toBeNull();
        expect((change.afterJson as Record<string, unknown>).smrModel).toBe(
            'gemma-4-e2b-it-sft-rlvr-medical'
        );
        // The audit snapshot preserves untouched knobs (granite safety model).
        expect((change.afterJson as Record<string, unknown>).safetyModel).toBe('granite-guardian-4.1-8b');
    });
});

// =============================================================================
// TASK-356 Phase 5 — SYSTEM + demo PipelinePolicy cascade defaults + WORM audit
// =============================================================================

describe('TASK-356 Phase 5 — seedPipelinePolicy (cascade defaults + WORM)', () => {
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

    it('exposes the platform-legacy SYSTEM defaults (auto on, harness OFF)', () => {
        expect(SYSTEM_PIPELINE_POLICY_DEFAULTS.autoSummaryEnabled).toBe(true);
        expect(SYSTEM_PIPELINE_POLICY_DEFAULTS.autoNerEnabled).toBe(true);
        // Back-compat: today only the clinical-workspace demo opted into the harness.
        expect(SYSTEM_PIPELINE_POLICY_DEFAULTS.harnessEnabled).toBe(false);
    });

    it('exposes the demo-tenant override that preserves the clinical-workspace harness', () => {
        expect(DEMO_PIPELINE_POLICY_OVERRIDE.harnessEnabled).toBe(true);
    });

    it('creates BOTH the SYSTEM default + demo override rows (each with a beforeJson=null WORM change)', async () => {
        const { client, created, changes } = makeMockClient({ [SYSTEM_TENANT_ID]: null, [SEED_TENANT_ID]: null });
        const result = await seedPipelinePolicy(client as never);

        expect(result.success).toBe(true);
        expect(result.system).toBe('created');
        expect(result.demo).toBe('created');

        expect(client.pipelinePolicy.create).toHaveBeenCalledTimes(2);
        const systemRow = created.find((c) => c.data.tenantId === SYSTEM_TENANT_ID)!.data;
        expect(systemRow.scope).toBe('TENANT');
        expect(systemRow.scopeId ?? null).toBeNull();
        expect(systemRow.harnessEnabled).toBe(false);
        expect(systemRow.autoSummaryEnabled).toBe(true);

        const demoRow = created.find((c) => c.data.tenantId === SEED_TENANT_ID)!.data;
        expect(demoRow.scope).toBe('TENANT');
        expect(demoRow.harnessEnabled).toBe(true);

        // One WORM change per created row, before=null (creation), changedBy=SYSTEM.
        expect(client.pipelinePolicyChange.create).toHaveBeenCalledTimes(2);
        for (const change of changes) {
            expect(change.data.beforeJson).toBeNull();
            expect(change.data.changedBy).toBe(SYSTEM_USER_ID);
        }
        const demoChange = changes.find((c) => c.data.tenantId === SEED_TENANT_ID)!.data;
        expect((demoChange.afterJson as Record<string, unknown>).harnessEnabled).toBe(true);
    });

    it('is idempotent — no write/WORM when both rows already exist', async () => {
        const { client } = makeMockClient({
            [SYSTEM_TENANT_ID]: { id: 'sys', tenantId: SYSTEM_TENANT_ID, scope: 'TENANT', harnessEnabled: false },
            [SEED_TENANT_ID]: { id: 'demo', tenantId: SEED_TENANT_ID, scope: 'TENANT', harnessEnabled: true },
        });
        const result = await seedPipelinePolicy(client as never);

        expect(result.system).toBe('noop');
        expect(result.demo).toBe('noop');
        expect(client.pipelinePolicy.create).not.toHaveBeenCalled();
        expect(client.pipelinePolicyChange.create).not.toHaveBeenCalled();
    });

    it('creates ONLY the missing row when the other already exists (demo present, SYSTEM absent)', async () => {
        const { client, created } = makeMockClient({
            [SYSTEM_TENANT_ID]: null,
            [SEED_TENANT_ID]: { id: 'demo', tenantId: SEED_TENANT_ID, scope: 'TENANT', harnessEnabled: true },
        });
        const result = await seedPipelinePolicy(client as never);

        expect(result.system).toBe('created');
        expect(result.demo).toBe('noop');
        expect(client.pipelinePolicy.create).toHaveBeenCalledTimes(1);
        expect(created[0].data.tenantId).toBe(SYSTEM_TENANT_ID);
    });
});

// =============================================================================
// TASK-356 Phase 2 — switchDefaultSttPipeline backfill (no double-default)
// =============================================================================

describe('TASK-361 — switchDefaultSttPipeline backfill (reconcile back to resolvable default)', () => {
    type Row = { id: string; tenantId: string; slug: string; isDefault: boolean };

    const makeMockClient = (rows: Row[]) => {
        const matches = (row: Row, where: Record<string, unknown>) =>
            Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
        const client = {
            asrPipeline: {
                findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
                    rows.find((r) => matches(r, where)) ?? null
                ),
                findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
                    rows.filter((r) => matches(r, where))
                ),
                update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                    const row = rows.find((r) => r.id === where.id);
                    if (row) Object.assign(row, data);
                    return row;
                }),
            },
        };
        return { client, rows };
    };

    // Use a tenant that switchDefaultSttPipeline actually iterates over.
    const T = SYSTEM_TENANT_ID;
    const whisperRow = (isDefault: boolean): Row => ({ id: 'whisper', tenantId: T, slug: STT_DEFAULT_PIPELINE_SLUG, isDefault });
    const ct2Row = (isDefault: boolean): Row => ({ id: 'ct2', tenantId: T, slug: STT_PLACEHOLDER_PIPELINE_SLUG, isDefault });
    const turboRow = (isDefault: boolean): Row => ({ id: 'turbo', tenantId: T, slug: 'turbo-whisper-large-v3', isDefault });

    const tenantDefaults = (rows: Row[]) => rows.filter((r) => r.tenantId === T && r.isDefault);

    it('targets every pipeline-owning tenant (SYSTEM + Global + customers)', () => {
        expect(STT_DEFAULT_PIPELINE_BACKFILL_TENANTS).toContain(SYSTEM_TENANT_ID);
        expect(STT_DEFAULT_PIPELINE_BACKFILL_TENANTS.length).toBeGreaterThanOrEqual(3);
    });

    it('demotes the placeholder CT2 default and promotes resolvable whisper-large-v3 (migrates a Phase-2 DB back)', async () => {
        // A DB that TASK-356 Phase 2 switched to CT2: CT2 is the current default.
        const { client, rows } = makeMockClient([whisperRow(false), ct2Row(true)]);
        const result = await switchDefaultSttPipeline(client as never);

        const defaults = tenantDefaults(rows);
        expect(defaults).toHaveLength(1);
        expect(defaults[0].slug).toBe(STT_DEFAULT_PIPELINE_SLUG);
        expect(result.switched).toBeGreaterThanOrEqual(1);
    });

    it('respects an admin-chosen resolvable default (turbo) and demotes only the placeholder CT2', async () => {
        const { client, rows } = makeMockClient([whisperRow(false), turboRow(true), ct2Row(true)]);
        await switchDefaultSttPipeline(client as never);

        const defaults = tenantDefaults(rows);
        expect(defaults).toHaveLength(1);
        expect(defaults[0].slug).toBe('turbo-whisper-large-v3');
    });

    it('is a no-op when whisper-large-v3 is already the sole default (fresh DB) and is idempotent on re-run', async () => {
        const { client, rows } = makeMockClient([whisperRow(true), ct2Row(false)]);
        const first = await switchDefaultSttPipeline(client as never);
        expect(client.asrPipeline.update).not.toHaveBeenCalled();
        expect(first.switched).toBe(0);

        // Re-run converges to the same single-default state.
        await switchDefaultSttPipeline(client as never);
        const defaults = tenantDefaults(rows);
        expect(defaults).toHaveLength(1);
        expect(defaults[0].slug).toBe(STT_DEFAULT_PIPELINE_SLUG);
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
// DUAL CAPTURE — PIPELINE CONFIG + DEMO RECORDING (TASK-331 doc-06 F2)
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

describe('Dual Capture Pipeline Config (TASK-331 doc-06 F2)', () => {
    const defaultPipeline = DEFAULT_ASR_PIPELINES.find((p) => p.isDefault === true);

    it('should expose a default pipeline (production-whisper-large-v3, TASK-361) whose config drives dual capture', () => {
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

describe('Dual-Capture Demo AudioRecording (TASK-331 doc-06 F2)', () => {
    it('should seed at least one AudioRecording carrying both rawMediaId and processedMediaId', () => {
        const dualCapture = DEFAULT_AUDIO_RECORDINGS.filter(
            (r) => r.rawMediaId != null && r.processedMediaId != null
        );
        expect(dualCapture.length).toBeGreaterThanOrEqual(1);
    });

    it('should resolve the dual-capture recording primary/raw/processed ids to seeded Media rows', () => {
        const mediaIds = new Set(DEFAULT_MEDIA.map((m) => m.id));
        const dualCapture = DEFAULT_AUDIO_RECORDINGS.find(
            (r) => r.rawMediaId != null && r.processedMediaId != null
        );
        expect(dualCapture).toBeDefined();
        expect(mediaIds.has(dualCapture!.mediaId)).toBe(true);
        expect(mediaIds.has(dualCapture!.rawMediaId!)).toBe(true);
        expect(mediaIds.has(dualCapture!.processedMediaId!)).toBe(true);
    });

    it('should use three distinct media ids (primary != raw != processed) on the demo recording', () => {
        const dualCapture = DEFAULT_AUDIO_RECORDINGS.find(
            (r) => r.rawMediaId != null && r.processedMediaId != null
        );
        expect(dualCapture).toBeDefined();
        const ids = [dualCapture!.mediaId, dualCapture!.rawMediaId!, dualCapture!.processedMediaId!];
        expect(new Set(ids).size).toBe(3);
        expect(ids).toEqual([
            SEED_MEDIA_IDS.GEN_AUDIO_PRIMARY,
            SEED_MEDIA_IDS.GEN_AUDIO_RAW,
            SEED_MEDIA_IDS.GEN_AUDIO_PROCESSED,
        ]);
    });

    it('should keep the dual-capture recording referencing a real (non-placeholder) primary mediaId', () => {
        const dualCapture = DEFAULT_AUDIO_RECORDINGS.find(
            (r) => r.rawMediaId != null && r.processedMediaId != null
        );
        expect(dualCapture).toBeDefined();
        expect(dualCapture!.mediaId).not.toMatch(/placeholder/);
        expect(dualCapture!.mediaId).toMatch(UUID_REGEX);
    });
});

describe('Dual-Capture Demo Media (TASK-331 doc-06 F2)', () => {
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
// SUMMARY-META QUALITY SEED — cacheHit + qualityScore (TASK-331 doc-07 F4)
// =============================================================================

describe('SummaryMeta Quality Seed (TASK-331 doc-07 F4)', () => {
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
// USER VOICE PROFILE SEED (TASK-331 doc-07 F3)
// =============================================================================

describe('UserVoiceProfile Seed (TASK-331 doc-07 F3)', () => {
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

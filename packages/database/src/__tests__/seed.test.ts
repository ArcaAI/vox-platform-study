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

import { describe, it, expect } from 'vitest';

import { DEFAULT_POLICIES, PolicyScope } from '../prisma/db_main/seed/01-policy';
import { SYSTEM_ROLES, TENANT_EXTENDABLE_ROLES, DEFAULT_ROLES } from '../prisma/db_main/seed/03-role';
import { DEFAULT_DEPARTMENTS, DEFAULT_TENANT_ID } from '../prisma/db_main/seed/04-department';
import {
    DEFAULT_AI_MODELS,
    DEFAULT_ASR_PIPELINES,
    DEFAULT_STT_SETTINGS,
    AiModelSource,
    AiModelFormat,
    ModelCategory,
    ModelTaskType,
    ModelType,
} from '../prisma/db_main/seed/06-stt';
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
    SYSTEM_USER_ID,
} from '../prisma/db_main/seed/00-constants';

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

    it('should define 18 department IDs', () => {
        expect(Object.keys(SEED_DEPARTMENT_IDS).length).toBe(18);
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
        expect(SEED_USER_IDS.FOURBITS_ADMIN).toBeDefined();
        expect(SEED_USER_IDS.MUMBAI_ADMIN).toBeDefined();
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
        it('should define 17 policies', () => {
            expect(DEFAULT_POLICIES.length).toBe(17);
        });

        it('should include system-full-access policy', () => {
            const systemFullAccess = DEFAULT_POLICIES.find((p) => p.name === 'system-full-access');
            expect(systemFullAccess).toBeDefined();
            expect(systemFullAccess?.scope).toBe(PolicyScope.GLOBAL);
        });

        it('should include tenant-full-access policy', () => {
            const tenantFullAccess = DEFAULT_POLICIES.find((p) => p.name === 'tenant-full-access');
            expect(tenantFullAccess).toBeDefined();
            expect(tenantFullAccess?.scope).toBe(PolicyScope.TENANT);
        });

        it('should include prompt-template-manage policy', () => {
            const promptPolicy = DEFAULT_POLICIES.find((p) => p.name === 'prompt-template-manage');
            expect(promptPolicy).toBeDefined();
            expect(promptPolicy?.scope).toBe(PolicyScope.TENANT);
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

            it('should use default tenant ID for all models', () => {
                DEFAULT_AI_MODELS.forEach((model) => {
                    expect(model.tenantId).toBe(DEFAULT_TENANT_ID);
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
            'lms-medgemma-1.5-4b-mlx',
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

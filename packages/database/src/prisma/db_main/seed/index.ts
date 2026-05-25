// Environment is loaded by the parent module or dotenv-cli
// No need to import dotenv/config here as it would override test env vars
import { getPrismaClient } from '../../../client';
import { seedPolicy } from './01-policy';
import { seedApiKey } from './02-apikey';
import { seedRole } from './03-role';
import { seedDepartment } from './04-department';
import { seedTenant } from './05-tenant';
import { seedTenantBucket } from './05a-tenant-bucket';
import { seedStt } from './06-stt';
import { seedPromptTemplate } from './07-prompt-template';
import { seedDnaWritingStyle } from './08-dna-writing-style';
import { seedConsultation } from './09-consultation';
import { seedAuditLog } from './10-audit-log';
import { seedGlobalSetting } from './11-global-setting';
import { seedUser } from './91-user';

/**
 * Database Seed Script
 *
 * Seeds the database with initial data for the HOPE platform.
 * Execution order respects foreign key dependencies.
 *
 * FK dependency analysis:
 *   - PromptTemplate.departmentId → Department (hard FK)
 *   - Department.preSummaryPromptId / newPatientPromptId / revisitPromptId → plain String (no FK)
 *   - RolePolicy → Role + Policy
 *   - UserRoleAssignment → User + Role + Tenant
 *   - ApiKey → User + Tenant
 *   - Consultation → User + Department + Tenant
 *   - DnaWritingStyleReport → User + Tenant
 *   - AuditLog → everything
 *
 * Phase 1 — Independent entities (no FK deps):
 *   1. Policies
 *   2. Tenants
 *
 * Phase 2 — Depends on Phase 1:
 *   3. Roles (needs policies)
 *   4. Departments (needs tenants; prompt ID columns are plain strings, no FK)
 *   5. STT (no FK deps)
 *
 * Phase 3 — Depends on Phase 2:
 *   6. Prompt Templates (needs departments via departmentId FK)
 *
 * Phase 4 — Depends on Phase 3:
 *   7. Users (needs roles, tenants, departments)
 *   8. API Keys (needs users)
 *   9. Global Settings (needs tenants)
 *
 * Phase 5 — Depends on Phase 4:
 *  10. DNA Writing Style (needs users, departments, prompts)
 *  11. Consultations (needs users, departments)
 *
 * Phase 6 — Depends on everything:
 *  12. Audit Log
 */
export const seed = async () => {
    const client = getPrismaClient();

    try {
        console.log('Starting database seeding...\n');

        // Phase 1: Independent entities
        await seedPolicy(client);
        console.log('');
        await seedTenant(client);
        console.log('');
        await seedTenantBucket(client);
        console.log('');

        // Phase 2: Depends on Phase 1
        await seedRole(client);
        console.log('');
        await seedDepartment(client);
        console.log('');
        await seedStt(client);
        console.log('');

        // Phase 3: Depends on Phase 2 (PromptTemplate.departmentId → Department)
        await seedPromptTemplate(client);
        console.log('');

        // Phase 4: Depends on Phase 3
        await seedUser(client);
        console.log('');
        await seedApiKey(client);
        console.log('');
        await seedGlobalSetting(client);
        console.log('');

        // Phase 5: Depends on Phase 4
        await seedDnaWritingStyle(client);
        console.log('');
        await seedConsultation(client);
        console.log('');

        // Phase 6: Depends on everything
        await seedAuditLog(client);
        console.log('');

        console.log('Database seeding completed successfully!');
    } catch (error) {
        console.error('Error during database seeding:', error);
        throw error;
    } finally {
        await client.$disconnect();
    }
};

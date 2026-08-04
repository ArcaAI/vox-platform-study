// Environment is loaded by the parent module or dotenv-cli
// No need to import dotenv/config here as it would override test env vars
// eslint-disable-next-line no-restricted-imports -- allow-list: seed scripts legitimately bypass tenant-scope
import { getPlatformAdminPrismaClient_Unscoped } from '../../../client';
import { getNodeEnv } from '../../../env';
import { seedPolicy } from './01-policy';
import { seedApiKey, shouldSeedApiKeys } from './02-apikey';
import { seedRole } from './03-role';
import { seedDepartment } from './04-department';
import { seedTenant, seedTenantFrontendConfig } from './05-tenant';
import { seedTenantBucket } from './05a-tenant-bucket';
import { provisionTenantBuckets } from './05b-tenant-bucket-provision';
import { seedPlatformStorageConfig } from './05c-platform-storage-config';
import { seedStt } from './06-stt';
import { seedPromptTemplate } from './07-prompt-template';
import { seedArcaaiClinicalTemplates } from './07b-arcaai-clinical-templates';
import { seedAgentGoldenLibrary } from './07a-agent-golden-library';
import { seedDnaWritingStyle } from './08-dna-writing-style';
import { seedConsultation } from './09-consultation';
import { seedAuditLog } from './10-audit-log';
import { seedGlobalSetting } from './11-global-setting';
import { seedPlatformKnobSettings } from './11a-platform-knob-settings';
import { seedTenantAllowedOrigins } from './11b-tenant-allowed-origins';
import { seedRateLimitSettings } from './12-rate-limit-settings';
import { seedHarnessPolicy } from './13-harness-policy';
import { seedPipelinePolicy } from './14-pipeline-policy';
import { seedEntitlements } from './15-entitlements';
import { seedAiTaskDefault } from './16-ai-task-default';
import { seedAiProviderConnection } from './17-ai-provider-connection';
import { seedAiRuntimeProfile } from './18-ai-runtime-profile';
import { seedTenantTtsConfig } from './19-tenant-tts-config';
import { seedAiPriceBook } from './20-ai-price-book';
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
  const client = getPlatformAdminPrismaClient_Unscoped();

  // Single gate for demo/sensitive fixtures. Demo API
  // keys embed raw secrets + ACTIVE, broadly-scoped keys, so they must never
  // be seeded outside local dev/test. `shouldSeedApiKeys` (02-apikey) is the
  // single source of truth, reused here and by that step's own guard.
  const seedEnv = getNodeEnv();
  const SEED_DEMO_DATA = shouldSeedApiKeys(seedEnv);

  try {
    console.log('Starting database seeding...\n');

    // Phase 1: Independent entities
    await seedPolicy(client);
    console.log('');
    await seedTenant(client);
    console.log('');
    // Per-tenant frontend pipeline defaults (needs tenants).
    await seedTenantFrontendConfig(client);
    console.log('');
    await seedTenantBucket(client);
    console.log('');
    await provisionTenantBuckets(client);
    console.log('');
    // The SYSTEM-tenant platform storage default (TASK-558 lane E) — the third
    // tier of `bucket row → tenant default → SYSTEM default → env`. Depends
    // only on the reserved SYSTEM tenant (seedTenant, above); CREATE-ONLY, so a
    // re-seed never reverts a global admin's edit.
    await seedPlatformStorageConfig(client);
    console.log('');

    // Phase 2: Depends on Phase 1
    await seedRole(client);
    console.log('');
    await seedDepartment(client);
    console.log('');
    await seedStt(client);
    console.log('');
    // SYSTEM HarnessPolicy SMR default (+ WORM audit).
    // Depends only on the reserved SYSTEM tenant (Phase 1).
    await seedHarnessPolicy(client);
    console.log('');
    // SYSTEM + demo PipelinePolicy cascade defaults (+ WORM).
    // Needs the reserved SYSTEM tenant + the Global demo tenant (both Phase 1).
    await seedPipelinePolicy(client);
    console.log('');
    // SYSTEM AiTaskDefault platform defaults (guardrail/NLP task
    // models). CREATE-ONLY; needs the AiModel catalog (seedStt above).
    await seedAiTaskDefault(client);
    console.log('');
    // SYSTEM config-plane rows. Seed-authoritative Day-1 (TASK-578, OD-1):
    // the built-in-local llm connections (ollama/lm-studio/built-in/vllm/
    // llama-cpp) seed ENABLED, so `resolveConnection('llm', …)` returns the
    // SYSTEM row and env is a pure fallback; cloud-BYO rows stay inert until a
    // tenant brings a key. AiRuntimeProfile still seeds EMPTY (absence = no
    // opinion → the injection cascade falls through to the service default).
    // No FK on either model; ordered after AiTaskDefault for readability.
    await seedAiProviderConnection(client);
    console.log('');
    await seedAiRuntimeProfile(client);
    console.log('');
    // SYSTEM TenantTtsConfig platform default (TASK-577 / F1): built-in-first
    // TTS routing (kokoro / indic_parler) so an unconfigured tenant defaults to
    // a LOCAL engine, never a cloud vendor. CREATE-ONLY; needs the TTS AiModel
    // catalog (seedStt above) and the reserved SYSTEM tenant (Phase 1).
    await seedTenantTtsConfig(client);
    console.log('');

    // Phase 3: Depends on Phase 2 (PromptTemplate.departmentId → Department)
    await seedPromptTemplate(client);
    console.log('');
    // ArcaAI clinical prompt library (TASK-592 Workstream D): the 7 ArcaAI
    // clinical departments' per-visit-type summary templates + a shared
    // pre-summary, all APPROVED and owned by the ArcaAI tenant. The ArcaAI
    // departments (04-department) reference these via their legacy prompt-id
    // columns and carry NO default DepartmentAgent (07a seeds none for ArcaAI),
    // so the resolver uses the visit-type-faithful tier-1 legacy path.
    await seedArcaaiClinicalTemplates(client);
    console.log('');
    // Agent Golden Library (TASK-548): SYSTEM golden departments +
    // APPROVED prompt templates + one default agent per department, plus the
    // two fixture tenants expressed as locked clones. FKs:
    // DepartmentAgent → Department (golden, above) + PromptTemplate (golden,
    // created here). Idempotent upsert-by-id.
    await seedAgentGoldenLibrary(client);
    console.log('');

    // Phase 4: Depends on Phase 3
    await seedUser(client);
    console.log('');
    // API-key fixtures embed raw demo secrets; only seed in dev/test.
    if (SEED_DEMO_DATA) {
      await seedApiKey(client);
    } else {
      console.warn(
        `⚠️  Skipping API-key seeding: NODE_ENV="${seedEnv}" is not development/test. ` +
          'Demo API-key fixtures contain raw secrets and are never seeded outside local dev/test.',
      );
    }
    console.log('');
    await seedGlobalSetting(client);
    console.log('');
    // Platform-knob rows for the env keys TASK-558 lane I moved into the
    // `global-kv` tier, seeded at today's env values so behaviour is identical.
    await seedPlatformKnobSettings(client);
    console.log('');
    // Day-1 browser origins permitted to call the gateway, owned by the SYSTEM
    // tenant. Must be seeded BEFORE the production catch-all is closed
    // (TASK-610 §4.8) — an empty registry plus a closed catch-all locks every
    // browser app out.
    await seedTenantAllowedOrigins(client);
    console.log('');
    // Platform-wide rate-limit config (single-tenant rows).
    await seedRateLimitSettings(client);
    console.log('');
    // Plan entitlement matrix + enforcement kill-switch (OFF).
    await seedEntitlements(client);
    console.log('');
    // AI rate card, both planes (TASK-615). SYSTEM-tenant rows only, all
    // prices PLACEHOLDER. Ordered after the entitlement matrix because the SELL
    // PLAN_FEE rows are keyed by the same `TenantPlan` values that matrix
    // defines, and CREATE-ONLY like it.
    await seedAiPriceBook(client);
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

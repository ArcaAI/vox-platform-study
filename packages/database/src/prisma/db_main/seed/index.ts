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
import { seedLiveAgentDefaults } from './07c-live-agent-defaults';
import { seedDeptFreePreSummaryDefault } from './07d-dept-free-pre-summary-default';
import { seedConsultationLoopDefaults } from './07e-consultation-loop-defaults';
import { seedArcaaiDepartmentContextSchemas } from './07f-arcaai-department-context-schemas';
import { seedDnaWritingStyle } from './08-dna-writing-style';
import { seedConsultation } from './09-consultation';
import { seedAuditLog } from './10-audit-log';
import { seedGlobalSetting } from './11-global-setting';
import { seedPlatformKnobSettings } from './11a-platform-knob-settings';
import { seedTenantAllowedOrigins } from './11b-tenant-allowed-origins';
import { seedConsultationGateSettings } from './11c-consultation-gate-settings';
import { seedTtsEngineFlagSettings } from './11d-tts-engine-flags';
import { seedRateLimitSettings } from './12-rate-limit-settings';
import { seedHarnessPolicy } from './13-harness-policy';
import { seedPipelinePolicy } from './14-pipeline-policy';
import { seedEntitlements } from './15-entitlements';
import { seedAiTaskDefault } from './16-ai-task-default';
import { seedAiProviderConnection } from './17-ai-provider-connection';
import { seedAiRuntimeProfile } from './18-ai-runtime-profile';
import { seedTenantTtsConfig } from './19-tenant-tts-config';
import { seedAiPriceBook } from './20-ai-price-book';
import { seedWorkflowDefinition } from './21-workflow-definition';
import { seedArcaaiWorkflowAuthoring } from './23-arcaai-workflow-authoring';
import { seedConsentGrant } from './22-consent-grant';
import { seedUser } from './91-user';
import { seedBootstrapAdmin } from './92-bootstrap-admin';
import { seedBootstrapTenantAdmin } from './93-bootstrap-tenant-admin';
import { seedServiceAccount } from './94-service-account';
import { resolveSeedMode, isPhaseEnabled } from './seed-mode';

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
  // Seeding is OPT-IN via RUN_SEED and defaults to "none". This
  // resolves BEFORE a client is created, so `RUN_SEED` unset means the seed
  // opens no connection and writes nothing. `resolveSeedMode` throws rather
  // than guessing — see `seed-mode.ts` for why permission is never inferred
  // from an absent NODE_ENV.
  const mode = resolveSeedMode();

  if (mode === 'none') {
    console.log(
      'Skipping database seeding: RUN_SEED is unset or "none". ' +
        'Set RUN_SEED="safe" for platform configuration, or RUN_SEED="all" in development/test.',
    );
    return;
  }

  const client = getPlatformAdminPrismaClient_Unscoped();

  // Demo API keys embed raw secrets + ACTIVE, broadly-scoped keys. In `safe`
  // mode the phase is skipped outright; `shouldSeedApiKeys` (02-apikey) remains
  // the second, independent guard inside that step.
  const seedEnv = getNodeEnv();
  const SEED_DEMO_DATA = isPhaseEnabled('02-apikey', mode) && shouldSeedApiKeys(seedEnv);

  try {
    console.log(`Seed mode: ${mode}\n`);
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
    // The SYSTEM-tenant platform storage default — the third
    // tier of `bucket row → tenant default → SYSTEM default → env`. Depends
    // only on the reserved SYSTEM tenant (seedTenant, above); CREATE-ONLY, so a
    // re-seed never reverts a super admin's edit.
    await seedPlatformStorageConfig(client);
    console.log('');

    // Phase 2: Depends on Phase 1
    await seedRole(client);
    console.log('');
    await seedDepartment(client);
    console.log('');
    await seedStt(client);
    console.log('');
    // SYSTEM HarnessPolicy TEXT default (+ WORM audit).
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
    // SYSTEM config-plane rows. Seed-authoritative Day-1 (OD-1):
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
    // SYSTEM TenantTtsConfig platform default (/ F1): built-in-first
    // TTS routing (kokoro / indic_parler) so an unconfigured tenant defaults to
    // a LOCAL engine, never a cloud vendor. CREATE-ONLY; needs the TTS AiModel
    // catalog (seedStt above) and the reserved SYSTEM tenant (Phase 1).
    await seedTenantTtsConfig(client);
    console.log('');

    // Phase 3: Depends on Phase 2 (PromptTemplate.departmentId → Department)
    await seedPromptTemplate(client);
    console.log('');
    // ArcaAI clinical prompt library: the 7 ArcaAI
    // clinical departments' per-visit-type summary templates + a shared
    // pre-summary, all APPROVED and owned by the ArcaAI tenant. The ArcaAI
    // departments (04-department) reference these via their legacy prompt-id
    // columns AND (since / RF-3) by per-visit-type DepartmentAgent
    // bindings that point at exactly the same 14 templates — behaviour-identical
    // by construction, proven by arcaai-agent-column-equality.test.ts.
    await seedArcaaiClinicalTemplates(client);
    console.log('');
    // SYSTEM live-summarization default: one SYSTEM-tenant
    // PromptTemplate + v1 version whose content is byte-identical to the live
    // loop's in-code constants, so the live chain's SYSTEM-default tier and its
    // code-default fail-open tier serve the same bytes. Readable from every
    // tenant's CLS because PromptTemplate/PromptVersion joined
    // SYSTEM_SHARED_READ_MODELS in the same change (B-12 fold-in).
    await seedLiveAgentDefaults(client);
    console.log('');
    // SYSTEM department-free pre-summary default (/ OD-1b / RF-1):
    // one SYSTEM-tenant PromptTemplate + v1 version, native-only fork of the
    // v1-parity pre-summary body with no {current_department}/{visit_type}
    // placeholder. Resolved directly by SYSTEM_DEFAULTS.deptFreePreSummaryPromptId
    // when a native caller passes preSummaryVariant: 'dept-free'; the v1-compat
    // surface never requests this variant (RF-1 wire contract).
    await seedDeptFreePreSummaryDefault(client);
    console.log('');
    // Agent Golden Library: SYSTEM golden departments +
    // APPROVED prompt templates + one default agent per department, plus the
    // two fixture tenants expressed as locked clones. FKs:
    // DepartmentAgent → Department (golden, above) + PromptTemplate (golden,
    // created here). Idempotent upsert-by-id.
    await seedAgentGoldenLibrary(client);
    console.log('');
    // Day-1 consultation context schema: one servable TENANT-scoped
    // default per seeded tenant. Together with the loop configuration
    // seedAgentGoldenLibrary just wrote onto the default agents, this is what
    // makes `LoopConfigService` resolve `enabled: true` — turned the
    // SIGNALLING gate on, but the workflow's own gate is DERIVED from these two
    // rows and neither existed on a fresh install. CREATE-ONLY.
    await seedConsultationLoopDefaults(client);
    console.log('');
    // Department-scoped consultation vocabularies for the two ArcaAI clinical
    // departments. Runs AFTER 07e so the tenant-wide default already exists —
    // these SHADOW it per department rather than replacing it. CREATE-ONLY.
    if (isPhaseEnabled('07f-arcaai-department-context-schemas', mode)) {
      await seedArcaaiDepartmentContextSchemas(client);
      console.log('');
    }

    // Phase 4: Depends on Phase 3
    // Demo accounts (*@example.com) with a documented default password. In
    //  mode NO users are seeded — a production bootstrap must provision
    // its own first admin rather than inherit a known credential.
    if (isPhaseEnabled('91-user', mode)) {
      await seedUser(client);
      console.log('');
    }
    // TASK-763 — the env-driven first SUPER_ADMIN. Runs in EVERY seeding mode
    // (deliberately NOT on the `safe` deny-list): `91-user` is skipped in
    // `safe`, which left a production bootstrap with zero users and therefore
    // no way to log in. No-op unless BOOTSTRAP_SUPER_ADMIN_EMAIL +
    // _PASSWORD are set; CREATE-ONLY, so a re-seed never resets a rotated
    // credential. Ordered after seedUser so a `username` collision with a demo
    // account is detected rather than raced.
    await seedBootstrapAdmin(client);
    console.log('');
    // TASK-766 — the env-driven first TENANT_ADMIN, for the same reason and in
    // every seeding mode: `91-user` is skipped in `safe`, which left the fully
    // configured ArcaAI tenant with nobody able to administer it. No-op unless
    // BOOTSTRAP_TENANT_ADMIN_EMAIL + _PASSWORD are set; CREATE-ONLY. Ordered
    // after `seedBootstrapAdmin` so a username collision between the two
    // bootstrap accounts is detected in a deterministic order.
    await seedBootstrapTenantAdmin(client);
    console.log('');
    // TASK-766 — the ArcaAI tenant's machine identity (TASK-762 credential
    // class). Runs in EVERY seeding mode: outside development/test the row is
    // seeded INERT (a verifier with no preimage) and becomes usable through
    // `POST /admin/service-accounts/:id/rotate`, so no secret ever reaches a
    // production seed path. Needs tenants (Phase 1); no user FK — a service
    // account is not a delegation of a person.
    await seedServiceAccount(client);
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
    // Platform-knob rows for the env keys moved into the
    // `global-kv` tier, seeded at today's env values so behaviour is identical.
    await seedPlatformKnobSettings(client);
    console.log('');
    // The two consultation-pipeline kill-switches, turned ON for day 1
    // . Descriptor defaults stay OFF — the registry refuses to
    // assemble a kill-switch that defaults ON — so the seeded ROW is what
    // enables them, and `defaultValue` stays at the fail-safe.
    await seedConsultationGateSettings(client);
    console.log('');
    // The five tts provider/engine enable flags. `tts.kokoro.enabled` seeds ON
    // — the SYSTEM voice catalog routes `en` to kokoro, so without it a keyless
    // deployment registers no provider and answers 503 on /health/ready. The
    // descriptor defaults stay OFF (they must equal the Python fields), so the
    // ROW is what turns kokoro on and `defaultValue` stays at the code value.
    await seedTtsEngineFlagSettings(client);
    console.log('');
    // Day-1 browser origins permitted to call the gateway, owned by the SYSTEM
    // tenant. Must be seeded BEFORE the production catch-all is closed
    // an empty registry plus a closed catch-all locks every
    // browser app out.
    await seedTenantAllowedOrigins(client);
    console.log('');
    // Platform-wide rate-limit config (single-tenant rows).
    await seedRateLimitSettings(client);
    console.log('');
    // Plan entitlement matrix + enforcement kill-switch (OFF).
    await seedEntitlements(client);
    console.log('');
    // AI rate card, both planes. SYSTEM-tenant rows only, all
    // prices PLACEHOLDER. Ordered after the entitlement matrix because the SELL
    // PLAN_FEE rows are keyed by the same `TenantPlan` values that matrix
    // defines, and CREATE-ONLY like it.
    await seedAiPriceBook(client);
    console.log('');
    // Platform-default Summarization WorkflowDefinition — the row the dispatcher falls
    // back to when a tenant has authored none (TASK-720). SYSTEM-tenant, CREATE-ONLY.
    await seedWorkflowDefinition(client);
    console.log('');
    // The tenant-authored consultation workflows (TASK-798) — ArcaAI-owned,
    // PUBLISHED, on the real `consultation` palette. Runs after 21 so the
    // platform default exists first. Its WorkflowAssignment rows are GATED on
    // the Substrate-A exclusivity mechanism and print a loud warning when they
    // are skipped; see `substrate-exclusivity-guard.ts`.
    if (isPhaseEnabled('23-arcaai-workflow-authoring', mode)) {
      await seedArcaaiWorkflowAuthoring(client);
      console.log('');
    }

    // Phase 5: Depends on Phase 4 — synthetic clinician writing samples and
    // synthetic, Vault-encrypted PHI. Never outside development/test.
    if (isPhaseEnabled('08-dna-writing-style', mode)) {
      await seedDnaWritingStyle(client);
      console.log('');
    }
    if (isPhaseEnabled('09-consultation', mode)) {
      await seedConsultation(client);
      console.log('');
      // TASK-712 (consent-abac Phase 6): EXTERNAL_TOOL_LOOKUP/STYLE_LEARNING/
      // QUALITY_REVIEW grants for the demo patients above. Gated on the SAME
      // phase (not its own) — these rows exist only to make the just-seeded
      // synthetic patients usable, so they carry the same "never outside
      // development/test" posture as seedConsultation itself.
      await seedConsentGrant(client);
      console.log('');
    }

    // Phase 6: Depends on everything. Fabricated rows in the HIPAA audit trail,
    // written with a real `update:` payload — every run overwrote them.
    if (isPhaseEnabled('10-audit-log', mode)) {
      await seedAuditLog(client);
      console.log('');
    }

    console.log('Database seeding completed successfully!');
  } catch (error) {
    console.error('Error during database seeding:', error);
    throw error;
  } finally {
    await client.$disconnect();
  }
};

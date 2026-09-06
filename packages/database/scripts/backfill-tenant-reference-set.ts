/**
 * TASK-890 §3.4 step i — the ONE-SHOT BACKFILL: provision every EXISTING tenant with the
 * platform reference set.
 *
 * ## Why
 *
 * L13 step v removes `Agent`, `AgentAssignment`, `PromptTemplate` and `PromptVersion` from
 * `SYSTEM_SHARED_READ_MODELS`. From that commit on, a tenant resolves its OWN content and
 * nothing else: no assignment ⇒ `AGENT_NOT_ASSIGNED`, no `SYSTEM_DEFAULTS.*` clone ⇒
 * `PROMPT_DEFAULT_NOT_PROVISIONED`, no bridge schema ⇒ `LEGACY_CONTEXT_SCHEMA_MISSING`. Tenants
 * created FROM NOW ON are provisioned by `TenantService.create`; tenants that already exist have
 * to be caught up, and this is what catches them up.
 *
 * **Proof #9 (§4.4) is what the flip is gated on, and this script is what makes it pass.** Run
 * it on dev; on the test database `pnpm test:db:reset` re-seeds instead, and the seed's own
 * phase (`seed/26-tenant-reference-set.ts`) does the same work.
 *
 * ## What it touches
 *
 * WRITES, and only creates: context schemas + their pinned version, prompt templates + version
 * 1, agents + their fallback links, and TENANT-scope agent assignments — each stamped with the
 * provenance the re-sync route reads. It NEVER updates or deletes, so a tenant that has edited
 * its copy keeps the edit, and a second run is a no-op (clone ids are derived from
 * `(tenant, source)`).
 *
 * It writes NO `AiModel` and NO `GlobalSetting` row: the catalogue and the platform settings are
 * CONFIG (OD-O / OD-P), resolved tenant → SYSTEM at read time.
 *
 * ## Usage
 *
 *   npx dotenv -e .env.dev  -- tsx packages/database/scripts/backfill-tenant-reference-set.ts
 *   npx dotenv -e .env.dev  -- tsx packages/database/scripts/backfill-tenant-reference-set.ts --dry-run
 *   npx dotenv -e .env.test -- tsx packages/database/scripts/backfill-tenant-reference-set.ts
 *
 * `--dry-run` reports what each tenant is MISSING without writing anything, which is the same
 * question proof #9 asks.
 */
/* eslint-disable no-console */
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client';
import { provisionTenantReferenceSet } from '../src/prisma/db_main/seed/26-tenant-reference-set';
import { SYSTEM_TENANT_ID } from '../src/prisma/db_main/seed/00-constants';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const client = getPlatformAdminPrismaClient_Unscoped();

  try {
    const tenants = await client.tenant.findMany({
      where: { id: { not: SYSTEM_TENANT_ID }, resourceStatus: 'ENABLED' },
      select: { id: true, key: true, name: true },
      orderBy: { key: 'asc' },
    });

    console.log(`TASK-890 reference-set backfill — ${tenants.length} tenant(s)${dryRun ? ' (DRY RUN)' : ''}\n`);

    let totalWritten = 0;
    for (const tenant of tenants) {
      if (dryRun) {
        const [schemas, prompts, agents, assignments] = await Promise.all([
          client.consultationContextSchema.count({ where: { tenantId: tenant.id, sourceTemplateSlug: { not: null }, resourceStatus: 'ENABLED' } }),
          client.promptTemplate.count({ where: { tenantId: tenant.id, sourceTemplateId: { not: null }, resourceStatus: 'ENABLED' } }),
          client.agent.count({ where: { tenantId: tenant.id, sourceTenantId: SYSTEM_TENANT_ID, resourceStatus: 'ENABLED' } }),
          client.agentAssignment.count({ where: { tenantId: tenant.id, scope: 'TENANT', resourceStatus: 'ENABLED' } }),
        ]);
        const gap = schemas === 0 || prompts === 0 || agents === 0 || assignments === 0;
        console.log(
          `  ${gap ? 'GAP ' : 'ok  '} ${tenant.key} (${tenant.id}): schemas=${schemas} prompts=${prompts} agents=${agents} assignments=${assignments}`,
        );
        continue;
      }

      const summary = await provisionTenantReferenceSet(client, tenant.id);
      const written = summary.contextSchemas + summary.promptTemplates + summary.agents + summary.agentAssignments;
      totalWritten += written;
      console.log(
        `  ${tenant.key} (${tenant.id}): +${summary.contextSchemas} schema(s), +${summary.promptTemplates} prompt(s), ` +
          `+${summary.agents} agent(s), +${summary.agentAssignments} assignment(s)`,
      );
    }

    if (!dryRun) {
      console.log(`\nDone. ${totalWritten} row group(s) written. Re-run to confirm it reports zero — the backfill is idempotent.`);
      console.log('Now run proof #9 (§4.4) before merging L13 step v.');
    }
  } finally {
    await client.$disconnect();
  }
}

main().catch((error) => {
  console.error('Backfill failed:', error);
  process.exitCode = 1;
});

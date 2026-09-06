/**
 * TASK-890 §3.11 (OD-O) — retire the per-tenant `AiModel` CLONES.
 *
 * ## Why
 *
 * `TenantService.provisionTenantModelCatalog` used to copy every SYSTEM `AiModel` row into each
 * new tenant. OD-O reversed that: the catalogue is CONFIG, `AiModel` stays in
 * `SYSTEM_SHARED_READ_MODELS`, and a tenant READS the platform's rows. The clone was worse than
 * redundant — it was a snapshot that stopped tracking the platform the moment it was taken, and
 * a by-slug resolver prefers the tenant's row, so a stale clone silently SHADOWED the live
 * platform value for that tenant.
 *
 * ## What it deletes, and what it must not
 *
 * ONLY non-SYSTEM `AiModel` rows with `sourceConnectionId IS NULL` — the clone signature. A row
 * with a `sourceConnectionId` is a BYO model the tenant declared through its own provider
 * connection (§3.7a): tenant-owned by design, and the whole point of OD-A. Deleting one would
 * take a customer's own model registration with it.
 *
 * Deletion is a SOFT delete (`resourceStatus = 'DELETED'`), never a DROP: `Agent.modelId` is a
 * real FK, so an agent still bound to a clone must be RE-BOUND first — this script re-points it
 * at the SYSTEM row of the same slug, which is the row the clone was a copy of. An agent whose
 * clone has no SYSTEM counterpart is REPORTED and its clone is left alone: silently unbinding a
 * published agent is not a cleanup.
 *
 * Proof #3 (§4.4) measured ZERO clone rows on dev, so this is expected to be a no-op there. It
 * exists because "expected" is not "guaranteed" — another environment may have them, and the
 * retirement has to be executable rather than assumed.
 *
 * ## Usage
 *
 *   npx dotenv -e .env.dev -- tsx packages/database/scripts/backfill-retire-model-clones.ts --dry-run
 *   npx dotenv -e .env.dev -- tsx packages/database/scripts/backfill-retire-model-clones.ts
 */
/* eslint-disable no-console */
import { getPlatformAdminPrismaClient_Unscoped } from '../src/client';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from '../src/prisma/db_main/seed/00-constants';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const client = getPlatformAdminPrismaClient_Unscoped();

  try {
    const clones = await client.aiModel.findMany({
      where: { tenantId: { not: SYSTEM_TENANT_ID }, sourceConnectionId: null, resourceStatus: { not: 'DELETED' } },
      select: { id: true, tenantId: true, slug: true },
      orderBy: [{ tenantId: 'asc' }, { slug: 'asc' }],
    });

    console.log(`TASK-890 model-clone retirement — ${clones.length} clone row(s)${dryRun ? ' (DRY RUN)' : ''}\n`);
    if (clones.length === 0) {
      console.log('  Nothing to retire (proof #3 measured zero on dev — this is the expected result).');
      return;
    }

    let retired = 0;
    let blocked = 0;
    for (const clone of clones) {
      const platform = await client.aiModel.findFirst({
        where: { tenantId: SYSTEM_TENANT_ID, slug: clone.slug, resourceStatus: 'ENABLED' },
        select: { id: true },
      });
      const boundAgents = await client.agent.count({ where: { modelId: clone.id } });
      const boundFallbacks = await client.agentModelFallback.count({ where: { modelId: clone.id } });

      if (!platform && boundAgents + boundFallbacks > 0) {
        console.log(
          `  BLOCKED ${clone.tenantId}/${clone.slug}: bound by ${boundAgents} agent(s) + ${boundFallbacks} fallback(s) and SYSTEM has no row of that slug. Left in place.`,
        );
        blocked += 1;
        continue;
      }

      if (dryRun) {
        console.log(`  would retire ${clone.tenantId}/${clone.slug} (re-binding ${boundAgents} agent(s), ${boundFallbacks} fallback(s))`);
        retired += 1;
        continue;
      }

      if (platform) {
        await client.agent.updateMany({ where: { modelId: clone.id }, data: { modelId: platform.id } });
        await client.agentModelFallback.updateMany({ where: { modelId: clone.id }, data: { modelId: platform.id } });
      }
      await client.aiModel.update({
        where: { id: clone.id },
        data: {
          resourceStatus: 'DELETED',
          resourceStatusUpdatedAt: new Date(),
          resourceStatusUpdatedBy: SYSTEM_USER_ID,
          version: { increment: 1 },
        },
      });
      console.log(`  retired ${clone.tenantId}/${clone.slug}`);
      retired += 1;
    }

    console.log(`\nDone. ${retired} retired, ${blocked} left in place for a human.`);
  } finally {
    await client.$disconnect();
  }
}

main().catch((error) => {
  console.error('Retirement failed:', error);
  process.exitCode = 1;
});

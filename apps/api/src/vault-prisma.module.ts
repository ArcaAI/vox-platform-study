/**
 * TASK-302 Phase 5 Task 5.6 (Stream B) — VaultPrismaFactoryModule.
 *
 * Wires the `VAULT_PRISMA_FACTORY` DI token in `@arcaai/domains` to a
 * real Vault-backed PrismaClient when BOTH:
 *
 *   SECRETS_PROVIDER === 'vault'
 *   PG_DYNAMIC_CREDS  === 'true'
 *
 * Otherwise the token is bound to `null`, which the `@Optional()`
 * inject in `CoreDatabaseService` treats as "absent" — keeping the
 * env-mode singleton path unchanged.
 *
 * Why `null` (not "no provider"): NestJS resolves @Optional() against
 * a missing PROVIDER, but if a provider exists and returns `null` the
 * Optional inject delivers `null` to the constructor. The Service's
 * `typeof vaultFactory === 'function'` guard handles both cases.
 *
 * The module is `@Global` so the token is visible to CoreDatabaseModule
 * wherever it is imported in the feature-module graph without each
 * importer having to wire it explicitly.
 */

import { SecretsService, VaultLeaseRenewer } from '@arcaai/applications';
import { VAULT_PRISMA_FACTORY, type VaultPrismaFactory, type VaultPrismaFactoryResult } from '@arcaai/domains';
import { Global, Logger, Module } from '@nestjs/common';
import {
  applySoftDeleteExtension,
  applyTenantScopeExtension,
  resolveTenantContext,
  VaultPrismaClient,
  type VaultDbSecretsLike,
} from '@arcaai/database';

const logger = new Logger('VaultPrismaFactoryModule');

// BUG-006 — conservative fallback ONLY: the real hope-app-role max_ttl now
// differs per environment (dev 168h/7d, prod 720h/30d — see
// docs/operations/vault/README.md "Dynamic DB credentials") and MUST be set
// explicitly via PG_VAULT_MAX_TTL_SEC in each env file. This constant only
// applies if that var is missing; being smaller than any real max_ttl just
// means swapping somewhat more often than strictly necessary, never a
// missed swap. Vault's max_ttl clock starts at lease ISSUE time and does
// NOT reset on renewal, so elapsed time is measured from the credential's
// acquire()/swap() time, not from the last successful renew.
const DEFAULT_MAX_TTL_SEC = 24 * 60 * 60;
// Stop renewing and rebuild the pool this many seconds (or this fraction of
// max_ttl, whichever is smaller) before max_ttl — renewal beyond max_ttl is
// rejected by Vault outright, so the swap must land with room to spare.
const SWAP_SAFETY_MARGIN_CAP_SEC = 300;
const SWAP_SAFETY_MARGIN_FRACTION = 0.25;

function resolveMaxTtlSec(): number {
  const raw = process.env.PG_VAULT_MAX_TTL_SEC;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TTL_SEC;
}

function swapSafetyMarginSec(maxTtlSec: number): number {
  return Math.min(SWAP_SAFETY_MARGIN_CAP_SEC, maxTtlSec * SWAP_SAFETY_MARGIN_FRACTION);
}

/** Structural surface for registering renewer health with SecretsService, without forcing every VaultDbSecretsLike caller to implement it. */
interface LeaseRenewerRegistrar {
  setLeaseRenewer?(renewer: { readonly degraded: boolean; readonly failureCount: number }): void;
  clearLeaseRenewer?(): void;
}

/**
 * Pure builder that returns a Vault prisma factory OR null, based on
 * the env toggles. Exported for unit testing so the module bootstrap
 * doesn't need a full Nest DI container to verify the env-driven
 * branch selection (mirrors VaultRotationWorkerService's test pattern).
 *
 * The parameter is typed as the structural `VaultDbSecretsLike`
 * (instead of the concrete `SecretsService`) so this file does not
 * depend on @arcaai/applications' built d.ts containing the
 * Phase-5-introduced `requestDbCredential` method. NestJS DI still
 * injects the real SecretsService at runtime.
 */
export function buildVaultPrismaFactory(secrets: VaultDbSecretsLike): VaultPrismaFactory | null {
  const provider = process.env.SECRETS_PROVIDER;
  const enabled = process.env.PG_DYNAMIC_CREDS;
  if (provider !== 'vault' || enabled !== 'true') {
    logger.log(`VAULT_PRISMA_FACTORY not enabled (SECRETS_PROVIDER=${provider ?? 'unset'}, PG_DYNAMIC_CREDS=${enabled ?? 'unset'})`);
    return null;
  }
  const role = process.env.PG_VAULT_ROLE ?? 'hope-app-role';
  logger.log(`VAULT_PRISMA_FACTORY enabled; will mint short-lived PG credentials via Vault role '${role}'`);

  return async (): Promise<VaultPrismaFactoryResult> => {
    const wrapper = await VaultPrismaClient.create(secrets, role);
    const baseClient = wrapper.client;
    // Compose soft-delete THEN tenant-scope, mirroring env-mode
    // createExtendedPrismaClient (packages/database/src/client.ts). Order
    // matters: tenant-scope is applied LAST so its handlers run FIRST,
    // merging `tenantId` into `args.where` before soft-delete adds its
    // `resourceStatus` filter. TASK-444 regression: applying only
    // soft-delete here left the Vault-mode client UNSCOPED, so reads that
    // rely on the $extends (e.g. UserRoleAssignmentService.fetchAllByRoleId)
    // leaked other tenants' rows.
    const softDeleted = applySoftDeleteExtension(baseClient);
    const extendedClient = applyTenantScopeExtension(softDeleted as unknown as Parameters<typeof applyTenantScopeExtension>[0], {
      getTenantId: () => resolveTenantContext().tenantId,
      isSuperAdmin: () => resolveTenantContext().isSuperAdmin,
    });

    // BUG-006 — without this, the credential fetched above is baked into
    // the pool for its whole lifetime: Vault revokes the underlying PG user
    // at lease expiry and every subsequent query 401s (P1000) until a
    // manual restart. Renew at 50% TTL while under max_ttl; once renewal
    // is no longer possible (or a renewal call fails) rebuild the pool via
    // wrapper.swap(), which mints a brand-new credential.
    const maxTtlSec = resolveMaxTtlSec();
    let acquiredAtMs = Date.now();
    const renewer = new VaultLeaseRenewer({
      leaseId: wrapper.leaseId,
      ttlSec: wrapper.ttlSec,
      renew: async () => {
        const elapsedSec = (Date.now() - acquiredAtMs) / 1000;
        const canRenew = typeof secrets.renewDbLease === 'function' && elapsedSec < maxTtlSec - swapSafetyMarginSec(maxTtlSec);
        if (canRenew) {
          try {
            return await secrets.renewDbLease!(wrapper.leaseId, wrapper.ttlSec);
          } catch (err: unknown) {
            logger.warn(`Vault DB lease renew failed for role '${role}'; falling back to pool swap: ${(err as Error).message}`);
          }
        }
        await wrapper.swap();
        acquiredAtMs = Date.now();
        logger.log(`Vault DB lease pool swapped for role '${role}' (renew window exhausted or failed)`);
        return { ttlSec: wrapper.ttlSec };
      },
      onDegraded: (failureCount) => {
        logger.error(`Vault DB lease renewer degraded for role '${role}' after ${failureCount} consecutive failures`);
      },
    });
    renewer.start();
    (secrets as unknown as LeaseRenewerRegistrar).setLeaseRenewer?.(renewer);

    return {
      // The PrismaClient surface from @arcaai/database is the one
      // CoreDatabaseService consumes; the structural cast keeps the
      // wrapper free of the workspace's generated-types path.
      client: baseClient as unknown as VaultPrismaFactoryResult['client'],
      extendedClient: extendedClient as unknown as VaultPrismaFactoryResult['extendedClient'],
      disconnect: async () => {
        await renewer.stop();
        (secrets as unknown as LeaseRenewerRegistrar).clearLeaseRenewer?.();
        await wrapper.disconnect();
      },
    };
  };
}

/**
 * Concrete useFactory shim: accepts the real SecretsService instance
 * from Nest DI, casts down to the structural shape, and delegates to
 * buildVaultPrismaFactory. Separated so the structural builder above
 * remains independent of @arcaai/applications' built d.ts.
 */
function nestProviderFactory(secrets: SecretsService): VaultPrismaFactory | null {
  return buildVaultPrismaFactory(secrets as unknown as VaultDbSecretsLike);
}

@Global()
@Module({
  imports: [],
  providers: [
    {
      provide: VAULT_PRISMA_FACTORY,
      useFactory: nestProviderFactory,
      inject: [SecretsService],
    },
  ],
  exports: [VAULT_PRISMA_FACTORY],
})
export class VaultPrismaFactoryModule {}

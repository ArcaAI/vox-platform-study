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

import { SecretsService } from '@arcaai/applications';
import { VAULT_PRISMA_FACTORY, type VaultPrismaFactory, type VaultPrismaFactoryResult } from '@arcaai/domains';
import { Global, Logger, Module } from '@nestjs/common';
import { applySoftDeleteExtension, VaultPrismaClient, type VaultDbSecretsLike } from '@arcaai/database';

const logger = new Logger('VaultPrismaFactoryModule');

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
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const provider = process.env.SECRETS_PROVIDER;
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const enabled = process.env.PG_DYNAMIC_CREDS;
  if (provider !== 'vault' || enabled !== 'true') {
    logger.log(`VAULT_PRISMA_FACTORY not enabled (SECRETS_PROVIDER=${provider ?? 'unset'}, PG_DYNAMIC_CREDS=${enabled ?? 'unset'})`);
    return null;
  }
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const role = process.env.PG_VAULT_ROLE ?? 'hope-app-role';
  logger.log(`VAULT_PRISMA_FACTORY enabled; will mint short-lived PG credentials via Vault role '${role}'`);

  return async (): Promise<VaultPrismaFactoryResult> => {
    const wrapper = await VaultPrismaClient.create(secrets, role);
    const baseClient = wrapper.client;
    const extendedClient = applySoftDeleteExtension(baseClient);
    return {
      // The PrismaClient surface from @arcaai/database is the one
      // CoreDatabaseService consumes; the structural cast keeps the
      // wrapper free of the workspace's generated-types path.
      client: baseClient as unknown as VaultPrismaFactoryResult['client'],
      extendedClient: extendedClient as unknown as VaultPrismaFactoryResult['extendedClient'],
      disconnect: () => wrapper.disconnect(),
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

/**
 * Tenant Allowed Origin Seed (TASK-610 lane W1-D)
 *
 * Creates the platform-scope `TenantAllowedOrigin` rows for the day-1
 * CORS allow-list: local development SDK playground, BCMCH production/staging
 * environment origins, and pre-production endpoint with non-default port.
 *
 * All four rows are owned by the reserved platform tenant (`SYSTEM_TENANT_ID`,
 * `00000000-…`) so they apply to every customer tenant at the application layer.
 * Tenant-specific origins (customer-controlled CORS) are NOT seeded; their
 * absence means "inherit the platform allow-list", which is the correct
 * starting state for every tenant.
 *
 * IDEMPOTENT, and CREATE-ONLY for the `origin` and `tenantId` columns: a
 * re-seed refreshes metadata (`label`, `description`) but never clobbers an
 * operator-managed row. That property is what makes it safe to run
 * `pnpm db:seed` against a live database.
 *
 * Origins are stored in normalized form (lowercase, no path, no trailing slash,
 * non-default port preserved). The OriginNormalizer in packages/applications
 * enforces this contract on write; this seed contains the normalized output.
 */
import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID, SEED_USER_IDS } from './00-constants';

const CREATED_BY = SEED_USER_IDS.SYSTEM;

interface OriginSeed {
  /** Normalized `scheme://host[:port]` — lowercase, no path, no trailing slash. */
  origin: string;
  /** Human-readable name shown in the admin origin list. */
  label: string;
  /** Optional operator note. */
  description: string;
}

const ORIGINS: OriginSeed[] = [
  {
    origin: 'http://localhost:5173',
    label: 'Local development (SDK / playground)',
    description: 'SDK playground, Vite dev server for local testing and demos.',
  },
  {
    origin: 'https://arcaai-u2204.bcmch.org',
    label: 'BCMCH production',
    description: 'Production deployment for BCMCH healthcare organization.',
  },
  {
    origin: 'https://arcaai-staging.bcmch.org',
    label: 'BCMCH staging',
    description: 'Staging environment for pre-production testing and QA at BCMCH.',
  },
  {
    origin: 'https://mi-preproduction.bcmch.org:4433',
    label: 'BCMCH pre-production',
    description: 'Pre-production endpoint with non-default port 4433 for BCMCH validation.',
  },
];

export const seedTenantAllowedOrigins = async (client: CorePrismaClient): Promise<void> => {
  console.log(
    `Seeding Tenant Allowed Origins (${ORIGINS.length} platform rows, tenantId='${SYSTEM_TENANT_ID}')...`,
  );

  for (const originRow of ORIGINS) {
    await client.tenantAllowedOrigin.upsert({
      // Addressable because `origin` carries a FIELD-level `@unique(map:)`.
      // It briefly did not: a named single-field `@@unique` made Prisma demand
      // a discriminator key it never generated, so the constraint could not be
      // addressed at all and this upsert failed at RUNTIME while `tsc` and the
      // entire unit suite stayed green. See tenant-allowed-origin.prisma.
      where: {
        origin: originRow.origin,
      },
      // Idempotent: refresh metadata but NEVER clobber an operator-modified row
      // on re-seed — operators expect their live CORS config to survive `db:seed`.
      update: {
        label: originRow.label,
        description: originRow.description,
      },
      create: {
        tenantId: SYSTEM_TENANT_ID,
        origin: originRow.origin,
        label: originRow.label,
        description: originRow.description,
        createdBy: CREATED_BY,
      },
    });
    console.log(`  ${originRow.origin} (${originRow.label})`);
  }

  console.log(`Seeded ${ORIGINS.length} Tenant Allowed Origins`);
};

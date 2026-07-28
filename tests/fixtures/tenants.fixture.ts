/**
 * Tenant Test Fixtures
 *
 * Factory functions for creating test tenants in the database.
 */

import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../helpers/db.helper';
import { SYSTEM_USER_ID } from './users.fixture';

/**
 * Options for creating a test tenant
 */
export interface CreateTenantOptions {
  id?: string;
  name?: string;
  slug?: string;
  description?: string;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Created tenant result
 */
export interface CreatedTenant {
  id: string;
  name: string;
  slug: string;
}

// Well-known test tenant IDs
export const TEST_TENANT_IDS = {
  DEFAULT: '50000000-0000-0000-0000-000000000000',
  TENANT_A: '50000000-0000-0000-0000-000000000001',
  TENANT_B: '50000000-0000-0000-0000-000000000002',
  TENANT_C: '50000000-0000-0000-0000-000000000003',
};

/**
 * Generate a unique ID for tests
 */
function generateTestId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a test tenant in the database
 */
export async function createTenantFixture(options: CreateTenantOptions = {}, prisma?: PrismaClient): Promise<CreatedTenant> {
  const client = prisma || getPrismaClient();
  const id = options.id || generateTestId();
  const name = options.name || `Test Tenant ${id}`;
  const slug = options.slug || `test-tenant-${id}`;

  await client.tenant.create({
    data: {
      id,
      name,
      slug,
      description: options.description || `Test tenant: ${name}`,
      resourceStatus: options.isActive !== false ? 'ENABLED' : 'DISABLED',
      metaData: options.metadata || null,
      createdBy: SYSTEM_USER_ID,
    },
  });

  return {
    id,
    name,
    slug,
  };
}

/**
 * Create multiple test tenants
 */
export async function createTenantsFixture(count: number, options: CreateTenantOptions = {}, prisma?: PrismaClient): Promise<CreatedTenant[]> {
  const tenants: CreatedTenant[] = [];

  for (let i = 0; i < count; i++) {
    const tenant = await createTenantFixture(
      {
        ...options,
        name: options.name ? `${options.name} ${i + 1}` : undefined,
        slug: options.slug ? `${options.slug}-${i + 1}` : undefined,
      },
      prisma,
    );
    tenants.push(tenant);
  }

  return tenants;
}

/**
 * Delete a test tenant from the database
 */
export async function deleteTenantFixture(tenantId: string, prisma?: PrismaClient): Promise<void> {
  const client = prisma || getPrismaClient();

  try {
    await client.tenant.delete({
      where: { id: tenantId },
    });
  } catch (error) {
    console.warn(`Could not delete tenant ${tenantId}:`, error);
  }
}

/**
 * Find a tenant by slug
 */
export async function findTenantBySlug(slug: string, prisma?: PrismaClient): Promise<CreatedTenant | null> {
  const client = prisma || getPrismaClient();

  const tenant = await client.tenant.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
    },
  });

  return tenant;
}

/**
 * Ensure the default test tenant exists
 */
export async function ensureDefaultTenant(prisma?: PrismaClient): Promise<CreatedTenant> {
  const client = prisma || getPrismaClient();

  const existing = await client.tenant.findUnique({
    where: { id: TEST_TENANT_IDS.DEFAULT },
    select: {
      id: true,
      name: true,
      slug: true,
    },
  });

  if (existing) {
    return existing;
  }

  return createTenantFixture(
    {
      id: TEST_TENANT_IDS.DEFAULT,
      name: 'Default Test Tenant',
      slug: 'default-test',
    },
    prisma,
  );
}

/**
 * Create isolated tenants for multi-tenant testing
 */
export async function createIsolatedTenants(prisma?: PrismaClient): Promise<{ tenantA: CreatedTenant; tenantB: CreatedTenant }> {
  const tenantA = await createTenantFixture(
    {
      id: TEST_TENANT_IDS.TENANT_A,
      name: 'Test Tenant A',
      slug: 'tenant-a',
    },
    prisma,
  );

  const tenantB = await createTenantFixture(
    {
      id: TEST_TENANT_IDS.TENANT_B,
      name: 'Test Tenant B',
      slug: 'tenant-b',
    },
    prisma,
  );

  return { tenantA, tenantB };
}

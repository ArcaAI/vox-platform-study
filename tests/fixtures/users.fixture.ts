/**
 * User Test Fixtures
 *
 * Factory functions for creating test users in the database.
 */

import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { getPrismaClient } from '../helpers/db.helper';

/**
 * Options for creating a test user
 */
export interface CreateUserOptions {
  id?: string;
  email?: string;
  name?: string;
  password?: string;
  tenantId?: string;
  isActive?: boolean;
  emailVerified?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Created user result
 */
export interface CreatedUser {
  id: string;
  email: string;
  name: string;
  password: string; // Plain text password for testing
  tenantId: string;
}

// Default tenant ID used in tests
export const DEFAULT_TEST_TENANT_ID = '50000000-0000-0000-0000-000000000000';

// Default system user ID
export const SYSTEM_USER_ID = '60000000-0000-0000-0000-000000000000';

/**
 * Generate a unique ID for tests
 */
function generateTestId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a single test user in the database
 */
export async function createUserFixture(options: CreateUserOptions = {}, prisma?: PrismaClient): Promise<CreatedUser> {
  const client = prisma || getPrismaClient();
  const id = options.id || generateTestId();
  const email = options.email || `test-${id}@example.com`;
  const name = options.name || 'Test User';
  const plainPassword = options.password || 'TestPassword123!';
  const hashedPassword = await hash(plainPassword, 10);
  const tenantId = options.tenantId || DEFAULT_TEST_TENANT_ID;

  await client.user.create({
    data: {
      id,
      email,
      name,
      password: hashedPassword,
      tenantId,
      resourceStatus: options.isActive !== false ? 'ENABLED' : 'DISABLED',
      emailVerified: options.emailVerified ?? true,
      metaData: options.metadata || null,
      createdBy: SYSTEM_USER_ID,
    },
  });

  return {
    id,
    email,
    name,
    password: plainPassword,
    tenantId,
  };
}

/**
 * Create multiple test users in the database
 */
export async function createUsersFixture(count: number, options: CreateUserOptions = {}, prisma?: PrismaClient): Promise<CreatedUser[]> {
  const users: CreatedUser[] = [];

  for (let i = 0; i < count; i++) {
    const user = await createUserFixture(
      {
        ...options,
        email: options.email ? `${i}-${options.email}` : undefined,
        name: options.name ? `${options.name} ${i + 1}` : `Test User ${i + 1}`,
      },
      prisma,
    );
    users.push(user);
  }

  return users;
}

/**
 * Create an admin user with admin role assigned
 */
export async function createAdminUserFixture(options: CreateUserOptions = {}, prisma?: PrismaClient): Promise<CreatedUser> {
  const user = await createUserFixture(
    {
      ...options,
      name: options.name || 'Admin User',
    },
    prisma,
  );

  // Note: Role assignment should be done separately using roles.fixture.ts
  return user;
}

/**
 * Delete a test user from the database
 */
export async function deleteUserFixture(userId: string, prisma?: PrismaClient): Promise<void> {
  const client = prisma || getPrismaClient();

  try {
    await client.user.delete({
      where: { id: userId },
    });
  } catch (error) {
    // Ignore if user doesn't exist
    console.warn(`Could not delete user ${userId}:`, error);
  }
}

/**
 * Delete multiple test users from the database
 */
export async function deleteUsersFixture(userIds: string[], prisma?: PrismaClient): Promise<void> {
  for (const userId of userIds) {
    await deleteUserFixture(userId, prisma);
  }
}

/**
 * Find a user by email
 */
export async function findUserByEmail(email: string, prisma?: PrismaClient): Promise<{ id: string; email: string; name: string } | null> {
  const client = prisma || getPrismaClient();

  return client.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
    },
  });
}

/**
 * Update a test user
 */
export async function updateUserFixture(userId: string, data: Partial<CreateUserOptions>, prisma?: PrismaClient): Promise<void> {
  const client = prisma || getPrismaClient();

  const updateData: Record<string, unknown> = {};

  if (data.email) updateData.email = data.email;
  if (data.name) updateData.name = data.name;
  if (data.password) updateData.password = await hash(data.password, 10);
  if (data.isActive !== undefined) {
    updateData.resourceStatus = data.isActive ? 'ENABLED' : 'DISABLED';
  }

  await client.user.update({
    where: { id: userId },
    data: updateData,
  });
}

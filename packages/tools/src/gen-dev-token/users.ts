/**
 * Development User Data
 *
 * This file contains user data for development token generation.
 * Keep in sync with packages/database/src/prisma/db_main/seed/91-user.ts
 *
 * @see packages/database/src/prisma/db_main/seed/91-user.ts
 */

export interface DevUser {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  tenantId: string | null;
  isServiceAccount: boolean;
  roles: string[];
}

/**
 * Development users matching the seed data
 * These users are created by the database seed script
 */
export const DEV_USERS: DevUser[] = [
  {
    id: '70000000-0000-0000-0000-000000000001',
    username: 'super_admin',
    email: 'super.admin@example.com',
    firstName: 'Super',
    lastName: 'Admin',
    tenantId: null,
    isServiceAccount: false,
    roles: ['SUPER_ADMIN'],
  },
  {
    id: '70000000-0000-0000-0000-000000000002',
    username: 'admin',
    email: 'admin@example.com',
    firstName: 'Admin',
    lastName: 'User',
    tenantId: null,
    isServiceAccount: false,
    roles: ['ADMIN'],
  },
  {
    id: '70000000-0000-0000-0000-000000000003',
    username: 'user',
    email: 'user@example.com',
    firstName: 'Regular',
    lastName: 'User',
    tenantId: null,
    isServiceAccount: false,
    roles: ['USER'],
  },
];

/**
 * Get a development user by username
 */
export function getDevUser(username: string): DevUser | undefined {
  return DEV_USERS.find((u) => u.username === username);
}

/**
 * Get all available usernames
 */
export function getAvailableUsernames(): string[] {
  return DEV_USERS.map((u) => u.username);
}

/**
 * Get default user (super_admin)
 */
export function getDefaultUser(): DevUser {
  return DEV_USERS[0];
}

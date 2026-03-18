/**
 * Test Fixtures Index
 *
 * Re-export all test fixtures for easy importing.
 */

// User fixtures
export {
  type CreateUserOptions,
  type CreatedUser,
  DEFAULT_TEST_TENANT_ID,
  SYSTEM_USER_ID,
  createUserFixture,
  createUsersFixture,
  createAdminUserFixture,
  deleteUserFixture,
  deleteUsersFixture,
  findUserByEmail,
  updateUserFixture,
} from './users.fixture';

// Role and Policy fixtures
export {
  type CaslRule,
  type CreateRoleOptions,
  type CreatePolicyOptions,
  type CreatedRole,
  type CreatedPolicy,
  createRoleFixture,
  createPolicyFixture,
  linkPolicyToRole,
  assignRoleToUser,
  removeRoleFromUser,
  createRoleWithPolicies,
  deleteRoleFixture,
  deletePolicyFixture,
  // Pre-defined templates
  createReadOnlyRole,
  createAdminRole,
  createUserManagerRole,
  createTenantScopedRole,
  createSelfOnlyRole,
} from './roles.fixture';

// Tenant fixtures
export {
  type CreateTenantOptions,
  type CreatedTenant,
  TEST_TENANT_IDS,
  createTenantFixture,
  createTenantsFixture,
  deleteTenantFixture,
  findTenantBySlug,
  ensureDefaultTenant,
  createIsolatedTenants,
} from './tenants.fixture';

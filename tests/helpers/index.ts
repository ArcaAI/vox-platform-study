/**
 * Test Helpers Index
 *
 * Re-export all test helpers for easy importing.
 */

// Auth helpers
export {
  type TestUser,
  type TokenPayload,
  generateTestToken,
  generateExpiredToken,
  generateInvalidToken,
  verifyToken,
  createTestUser,
  createAdminUser,
  createSuperAdminUser,
  createUserWithPermissions,
  createAuthHeader,
  extractUserFromHeader,
} from './auth.helper';

// Database helpers
export {
  type TestServiceConfig,
  getPrismaClient,
  resetDatabase,
  seedTestDatabase,
  runMigrations,
  disconnectDatabase,
  isDatabaseHealthy,
  waitForDatabase,
  executeRawQuery,
  getTableCount,
  withTransaction,
  pushSchema,
  setupTestDatabase,
  startTestService,
  startApiServer,
  waitForService,
  waitForApi,
  waitForMicroservice,
  isServiceHealthy,
  getServiceConfig,
} from './db.helper';

// API helpers
export {
  type ApiClient,
  type TypedApiResponse,
  createApiClient,
  createUnauthenticatedClient,
  createApiKeyClient,
  parseResponse,
  expectSuccess,
  expectStatus,
  expectError,
  expectUnauthorized,
  expectForbidden,
  expectNotFound,
  expectBadRequest,
  expectValidationError,
  get,
  post,
  put,
  patch,
  del,
  disposeClient,
} from './api.helper';

// E2E test helpers
export {
  type TestDataRegistry,
  type TestUserCredentials,
  type SeededUsers,
  DEFAULT_TENANT_KEY,
  SEEDED_USERS,
  SEEDED_API_KEY,
  SEEDED_API_KEY_DOCTOR2,
  createTestDataRegistry,
  loginUser,
  loginSeededUsers,
  generateUniqueUsername,
  createTestUser as createTestUserE2E,
  deleteTestUser,
  createTestRole,
  deleteTestRole,
  createTestPolicy,
  deleteTestPolicy,
  cleanupTestData,
  checkApiHealth,
  verifySeededData,
} from './e2e.helper';

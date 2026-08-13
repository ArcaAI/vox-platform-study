// Typed, fail-fast environment for the API gateway.
//
// `apps/api/src/main.ts` calls `apiEnv()` at the schema seam — right after
// `loadEnv()` and before `NestFactory.create()` — so an invalid environment
// fails the boot with the complete list of problems.
export { API_PLATFORM_ENV_SETTINGS } from './env.descriptors';
export { API_ENV_DESCRIPTORS, apiEnv, parseApiEnv, resetApiEnvCache, type ApiEnv } from './env.schema';

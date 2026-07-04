// Shared Vitest setup. Server modules derive the session key from
// ADMIN_SESSION_SECRET at call time; give tests a deterministic value.
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET ?? 'vitest-admin-session-secret-0123456789abcdef';
process.env.API_URL = process.env.API_URL ?? 'http://gateway.test:8868';

/**
 * Environment gating for the admin-console E2E suite: specs assert against a
 * RUNNING stack and must skip — with an actionable message — when it is not
 * there. Availability is probed once per worker and cached.
 */

export const APP_URL = process.env.ADMIN_CONSOLE_URL ?? 'http://localhost:5176';
export const API_URL = process.env.API_URL ?? 'http://localhost:8868';

/** Seeded super admin from packages/database seed 91-user.ts (dev + test DBs). */
export const ADMIN_CREDENTIALS = {
  username: process.env.E2E_ADMIN_USERNAME ?? 'super_admin',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'password123',
};

export const APP_DOWN_MESSAGE = `admin console is not running at ${APP_URL} — start it with \`pnpm dev:admin\` (or set ADMIN_CONSOLE_URL)`;
export const API_DOWN_MESSAGE = `API gateway is not healthy at ${API_URL} — start it with \`pnpm dev:api\` against a seeded database (or set API_URL)`;

async function probe(url: string, requireOk: boolean): Promise<boolean> {
  try {
    // 10s: a cold `next dev` compile of /login can exceed 3s, which made
    // every spec in the run skip spuriously.
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    // Any HTTP answer proves the server is up; health additionally
    // requires 2xx so a degraded gateway skips instead of failing logins.
    return requireOk ? response.ok : true;
  } catch {
    return false;
  }
}

let appUp: Promise<boolean> | undefined;
let apiUp: Promise<boolean> | undefined;

export function appAvailable(): Promise<boolean> {
  appUp ??= probe(`${APP_URL}/login`, false);
  return appUp;
}

export function apiAvailable(): Promise<boolean> {
  apiUp ??= probe(`${API_URL}/api/v1/health`, true);
  return apiUp;
}

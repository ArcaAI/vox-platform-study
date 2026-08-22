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

/**
 * Downstream service URLs. The gateway PROXIES these — it answers 200 on its own
 * health while a proxied service is down, so `apiAvailable()` cannot stand in for
 * them. A spec that drives a harness workflow or a transcription job needs the
 * service itself, and must SKIP with an actionable message rather than fail on a
 * locator that was never going to resolve. That is this module's stated contract;
 * it just did not extend past the gateway.
 */
export const SERVICE_URLS: Record<string, string> = {
  stt: process.env.STT_URL ?? 'http://localhost:8861',
  text: process.env.TEXT_URL ?? 'http://localhost:8862',
  guardrail: process.env.GUARDRAIL_URL ?? 'http://localhost:8863',
  nlp: process.env.NLP_URL ?? 'http://localhost:8864',
  harness: process.env.HARNESS_URL ?? 'http://localhost:8866',
};

export const serviceDownMessage = (name: string) =>
  `${name} service is not healthy at ${SERVICE_URLS[name]} — start the full stack with \`pnpm stack:dev\` (or set ${name.toUpperCase()}_URL)`;

const serviceUp: Record<string, Promise<boolean> | undefined> = {};

/** Probed once per worker, like the app and gateway probes above. */
export function serviceAvailable(name: keyof typeof SERVICE_URLS | string): Promise<boolean> {
  serviceUp[name] ??= probe(`${SERVICE_URLS[name]}/api/v1/health`, true);
  return serviceUp[name] as Promise<boolean>;
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

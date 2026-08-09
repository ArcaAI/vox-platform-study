/**
 * Self-registration (TASK-648 W9) — admin-console registers its build
 * identity with the gateway on boot, then heartbeats every 5 minutes.
 * Contract (frozen by U0): `docs/implementation/TASK-648-Service-Version-
 * And-Release-Registry/contracts/service-release.api.yaml`
 * `POST /internal/service-releases` — idempotent upsert; a repeat call IS
 * the heartbeat, there is no separate heartbeat path.
 *
 * Next.js instrumentation hook (`register()`), guarded to the Node.js
 * runtime only (`NEXT_RUNTIME === 'nodejs'`) — this must never run at the
 * edge or during the build.
 *
 * THE CRITICAL RULE (ticket §3.7): registration is best-effort and must
 * NEVER block or fail process boot. `register()` never awaits the initial
 * call, every call carries a bounded timeout, and no exception escapes past
 * this module.
 *
 * This module is intentionally self-contained — it cannot import
 * `@arcaai/applications` (a NestJS-oriented server package admin-console
 * does not otherwise depend on) and per the unit's write-set restriction no
 * helper file may be added under `src/**`, so the build-info read and the
 * request payload are inlined here rather than reusing the shared TS
 * `BuildInfoService`.
 */

const DEFAULT_BUILD_INFO_PATH = '/app/build-info.json';

/** Ticket §3.4 — "heartbeats every 5 minutes". */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** Bounded — this must never hang a heartbeat, let alone process boot. */
const REGISTER_TIMEOUT_MS = 5_000;

interface BuildInfo {
  service: string;
  version: string;
  releaseTag: string | null;
  gitBranch: string;
  gitCommitSha: string;
  buildAt: string;
  ciPipelineId: string | null;
  ciPipelineUrl: string | null;
}

function isBuildInfoShaped(value: unknown): value is BuildInfo {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (['service', 'version', 'gitBranch', 'gitCommitSha', 'buildAt'] as const).every((key) => typeof record[key] === 'string');
}

/**
 * Reads the baked `/app/build-info.json` (W3/W4 contract) once. NEVER
 * throws — a missing/malformed file degrades to a placeholder identity
 * rather than raising, mirroring `BuildInfoService`'s posture on the boot
 * path of every other HOPE process.
 */
async function readBuildInfo(): Promise<BuildInfo> {
  const fallback: BuildInfo = {
    service: 'admin-console',
    version: '0.0.0-unknown.unknown',
    releaseTag: null,
    gitBranch: '',
    gitCommitSha: 'unknown',
    buildAt: new Date(0).toISOString(),
    ciPipelineId: null,
    ciPipelineUrl: null,
  };
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(DEFAULT_BUILD_INFO_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isBuildInfoShaped(parsed)) {
      return {
        service: parsed.service,
        version: parsed.version,
        releaseTag: parsed.releaseTag ?? null,
        gitBranch: parsed.gitBranch,
        gitCommitSha: parsed.gitCommitSha,
        buildAt: parsed.buildAt,
        ciPipelineId: parsed.ciPipelineId ?? null,
        ciPipelineUrl: parsed.ciPipelineUrl ?? null,
      };
    }
    console.warn(`[service-release] ${DEFAULT_BUILD_INFO_PATH} does not match the build-info contract; falling back`);
  } catch (error) {
    console.warn(`[service-release] could not read ${DEFAULT_BUILD_INFO_PATH}; falling back:`, (error as Error)?.message ?? error);
  }
  return fallback;
}

/**
 * Contract `Environment` enum (`service-release.api.yaml`). Reuses
 * `next.config.ts`'s own existing `NODE_ENV` convention (`development` in
 * local dev, `production` for the standalone build; no `.env` file is read
 * for CI/production per that same convention) — a values-only projection of
 * NODE_ENV's `development|test|production` onto `dev|staging|prod`. `STAGE`/
 * `DEPLOYMENT_ENVIRONMENT` are read too since a k8s overlay may set either
 * (mirrors the Python services' `DEPLOYMENT_ENVIRONMENT` convention);
 * anything unrecognized maps to `dev` rather than rejected.
 */
function normalizeEnvironment(raw: string | undefined): 'dev' | 'staging' | 'prod' {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'staging') return 'staging';
  if (value === 'prod' || value === 'production') return 'prod';
  return 'dev';
}

function resolveEnvironment(): 'dev' | 'staging' | 'prod' {
  return normalizeEnvironment(process.env.DEPLOYMENT_ENVIRONMENT || process.env.NODE_ENV);
}

/** Pod name via `HOSTNAME` (Kubernetes sets this) else `hostname:pid`. */
async function resolveInstanceId(): Promise<string> {
  if (process.env.HOSTNAME) return process.env.HOSTNAME;
  const { hostname } = await import('node:os');
  return `${hostname()}:${process.pid}`;
}

async function registerOnce(): Promise<void> {
  // Gateway origin: the SAME server-side var the BFF proxy
  // (`src/app/api/hope/[...path]/route.ts`) forwards to — `API_URL`
  // (`.env.sample` "Gateway origin (server side)"). No new env var.
  const gatewayOrigin = process.env.API_URL || 'http://localhost:8868';

  // GAP (reported, not silently widened): unlike the six Python services
  // and the gateway, admin-console has no existing `X-Service-Token`
  // credential anywhere in `.env.sample`, and
  // `ServiceReleaseTokenGuard.KNOWN_SECRETS` (apps/api/src/modules/
  // service-release/service-release-token.guard.ts) does not list an
  // admin-console secret — so no value this reads will authenticate until
  // that guard's owner adds one. `API_GATEWAY_KEY` is reused here as the
  // least-bad existing candidate (it is the one KNOWN_SECRETS entry not
  // scoped to a single named Python service) rather than inventing a new
  // env var; every attempt is swallowed either way (§3.7).
  const serviceToken = process.env.API_GATEWAY_KEY || '';

  const buildInfo = await readBuildInfo();
  const payload = {
    service: buildInfo.service,
    version: buildInfo.version,
    releaseTag: buildInfo.releaseTag,
    gitBranch: buildInfo.gitBranch,
    gitCommitSha: buildInfo.gitCommitSha,
    buildAt: buildInfo.buildAt,
    ciPipelineId: buildInfo.ciPipelineId,
    ciPipelineUrl: buildInfo.ciPipelineUrl,
    environment: resolveEnvironment(),
    instanceId: await resolveInstanceId(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTER_TIMEOUT_MS);
  try {
    const response = await fetch(`${gatewayOrigin.replace(/\/$/, '')}/api/v1/internal/service-releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Token': serviceToken },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn('[service-release] registration rejected', response.status);
    }
  } catch (error) {
    // NEVER throws past this point (§3.7) — a down/unreachable/timed-out
    // gateway logs a warning and the process keeps serving traffic.
    console.warn('[service-release] registration failed (non-fatal):', (error as Error)?.message ?? error);
  } finally {
    clearTimeout(timer);
  }
}

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Next.js instrumentation entry point, invoked once per server instance
 * before any request is handled. Fire-and-forget: never awaited by the
 * caller, so a slow or unreachable gateway cannot delay the app becoming
 * ready.
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Fire-and-forget initial registration.
  void registerOnce();

  heartbeatTimer = setInterval(() => {
    void registerOnce();
  }, HEARTBEAT_INTERVAL_MS);
  // A live heartbeat interval must never be the reason the process fails to exit.
  heartbeatTimer.unref?.();

  const stop = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

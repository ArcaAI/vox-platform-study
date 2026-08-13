import * as os from 'node:os';
import { BuildInfo, BuildInfoService, IServiceReleaseService, RegisterInstanceRequest } from '@arcaai/applications';

/**
 * Gateway self-registration.
 *
 * The gateway is the ONLY process that registers in-process — it already
 * holds `IServiceReleaseService`, so it calls `registerInstance()` directly
 * rather than making a self-HTTP call. Every other HOPE
 * process (the 6 Python services, admin-console, the 2 workers) POSTs to
 * `/api/v1/internal/service-releases` instead.
 *
 * THE CRITICAL RULE: registration is best-effort and must
 * NEVER block or fail process boot. `startServiceReleaseRegistration` never
 * awaits the initial call, every call is wrapped in a bounded timeout, and
 * no exception escapes past this module.
 */

/** "heartbeats every 5 minutes". */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** Bounded — this must never hang a heartbeat, let alone process boot. */
export const DEFAULT_REGISTER_TIMEOUT_MS = 5_000;

/**
 * Contract `Environment` enum (`service-release.api.yaml`). Reuses
 * `main.ts`'s own existing `nodeEnv` convention
 * (`process.env.NODE_ENV || 'development'`) rather than inventing a new
 * source — this is a values-only projection of NODE_ENV's
 * `development|test|staging|production` onto `dev|staging|prod`. Anything
 * unrecognized maps to `dev` (the safe side — never mistaken for
 * production) rather than rejected, so a mislabeled dev/CI process can never
 * fail to boot over a telemetry field.
 */
const ENVIRONMENT_ALIASES: Record<string, 'dev' | 'staging' | 'prod'> = {
  dev: 'dev',
  development: 'dev',
  test: 'dev',
  staging: 'staging',
  prod: 'prod',
  production: 'prod',
};

export function normalizeEnvironment(raw: string | undefined): 'dev' | 'staging' | 'prod' {
  return ENVIRONMENT_ALIASES[(raw ?? '').trim().toLowerCase()] ?? 'dev';
}

/** Pod name via `HOSTNAME` (Kubernetes sets this) else `hostname:pid`. */
export function resolveInstanceId(): string {
  return process.env.HOSTNAME || `${os.hostname()}:${process.pid}`;
}

/** The `RegisterInstanceRequest` wire shape: baked build-info + the two runtime facts only the process knows. */
export function buildRegisterInstancePayload(buildInfo: BuildInfo, nodeEnv: string | undefined, instanceId: string): RegisterInstanceRequest {
  return {
    service: buildInfo.service,
    version: buildInfo.version,
    releaseTag: buildInfo.releaseTag,
    gitBranch: buildInfo.gitBranch,
    gitCommitSha: buildInfo.gitCommitSha,
    buildAt: buildInfo.buildAt,
    ciPipelineId: buildInfo.ciPipelineId,
    ciPipelineUrl: buildInfo.ciPipelineUrl,
    environment: normalizeEnvironment(nodeEnv),
    instanceId,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`service-release registration timed out after ${timeoutMs}ms`)), timeoutMs);
    // Timer must never keep the event loop (or a test) alive past its own completion.
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

/**
 * One registration/heartbeat call. NEVER throws — every failure (a down
 * dependency, a rejected upsert, a timeout) is swallowed and logged.
 */
async function registerOnce(
  serviceReleaseService: IServiceReleaseService,
  payload: RegisterInstanceRequest,
  timeoutMs: number,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    await withTimeout(serviceReleaseService.registerInstance(payload), timeoutMs);
  } catch (error) {
    onError?.(error);
  }
}

export interface StartServiceReleaseRegistrationOptions {
  intervalMs?: number;
  timeoutMs?: number;
  instanceId?: string;
  onError?: (error: unknown) => void;
}

export interface ServiceReleaseRegistrationHandle {
  /** Cancels the heartbeat timer. Idempotent; safe to call more than once. */
  stop(): void;
}

/**
 * Fire-and-forget: schedules the initial registration + heartbeat interval
 * and returns immediately (never awaited on the boot path). Stop the
 * heartbeat with the returned handle on shutdown.
 */
export function startServiceReleaseRegistration(
  serviceReleaseService: IServiceReleaseService,
  buildInfoService: BuildInfoService,
  nodeEnv: string | undefined,
  options: StartServiceReleaseRegistrationOptions = {},
): ServiceReleaseRegistrationHandle {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTER_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const payload = buildRegisterInstancePayload(buildInfoService.getBuildInfo(), nodeEnv, options.instanceId ?? resolveInstanceId());

  // Fire-and-forget: `void` deliberately does not await this on the boot path.
  void registerOnce(serviceReleaseService, payload, timeoutMs, options.onError);

  const timer = setInterval(() => {
    void registerOnce(serviceReleaseService, payload, timeoutMs, options.onError);
  }, intervalMs);
  // A live heartbeat interval must never be the reason the process (or a test) hangs on exit.
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}

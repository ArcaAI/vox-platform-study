import { serverEnv } from '@/config/env';
import { getBuildVersion } from '@/server/build-info';

const SERVICE_NAME = 'admin-console';

/**
 * Detailed health check — mirrors `apps/api`'s public `/health` shape
 * (service, version, uptime, timestamp, checks) so the gateway and this BFF
 * read the same way wherever an operator or a dashboard looks at either.
 *
 * Always 200 — this is informational, not a gate (only `/api/health/ready`
 * gates traffic via its HTTP status). `status`/`checks.config.status` report
 * the same process-level config check `/api/health/ready` uses; see that
 * route for why it deliberately never calls out to the gateway.
 *
 * Unauthenticated and internet-reachable through the ingress, so it exposes
 * `version` only — never `gitBranch`/`gitCommitSha`/`ciPipelineId` (operator
 * detail; see `src/server/build-info.ts`), and never the reason a check
 * failed.
 */
export async function GET(): Promise<Response> {
  let configStatus: 'healthy' | 'unhealthy' = 'healthy';
  try {
    serverEnv();
  } catch {
    configStatus = 'unhealthy';
  }

  return Response.json({
    status: configStatus,
    service: SERVICE_NAME,
    version: getBuildVersion(),
    uptime_seconds: Math.round(process.uptime() * 10) / 10,
    timestamp: new Date().toISOString(),
    checks: {
      config: { status: configStatus },
    },
  });
}

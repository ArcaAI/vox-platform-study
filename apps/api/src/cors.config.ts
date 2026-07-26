/**
 * CORS origin resolution for the API gateway.
 *
 * Extracted from `main.ts` so the dev / staging / production branches
 * can be unit-tested without booting the Nest application. The exported
 * `getCorsOrigins(nodeEnv)` is the value passed to `app.enableCors({
 * origin })`. The dev branch returns a localhost-only RegExp; the
 * staging / production branches use a callback.
 */
import { Logger } from '@nestjs/common';

const corsLogger = new Logger('CORS');

const DEV_LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * TASK-558 lane I — where the allowed-origin list comes from at REQUEST time.
 *
 * `corsAllowedOrigins` is a `global-kv` platform setting now, so the list an
 * operator tightens takes effect on the next request instead of the next
 * deploy (plan §9.2 L1). This module cannot inject a Nest provider — it is
 * imported by `main.ts` before the module graph exists — so the resolver is
 * INSTALLED by `PlatformKnobsBinder` once the graph is up. Until then (and in
 * any process that never installs one) `CORS_ALLOWED_ORIGINS` is read directly:
 * the documented bootstrap fallback, byte-identical to the pre-lane behaviour.
 */
let platformOriginsResolver: (() => string | undefined) | null = null;

/** Install the DB-backed resolver. Called once from `PlatformKnobsBinder`. */
export function setPlatformCorsOriginsResolver(resolver: (() => string | undefined) | null): void {
  platformOriginsResolver = resolver;
}

/** The raw comma-separated allow-list: platform setting, else the env fallback. */
function resolveAllowedOrigins(): string | undefined {
  if (platformOriginsResolver) {
    const resolved = platformOriginsResolver();
    if (resolved !== undefined && resolved !== '') return resolved;
  }
  return process.env.CORS_ALLOWED_ORIGINS;
}

/**
 * Structured debug log for the staging / production callback CORS path.
 * Dev no longer hits this — the RegExp value is interpreted by Express's
 * `cors` middleware directly.
 */
function logCorsDecision(origin: string | undefined, allowed: boolean, reason: string): boolean {
  if (process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV === 'development') {
    corsLogger.debug({
      message: 'CORS decision',
      origin: origin || 'none',
      allowed,
      reason,
    });
  }
  return allowed;
}

/**
 * Shared origin validator for staging / production. Used by the
 * callback returned from `getCorsOrigins` and re-exported for any
 * WebSocket adapter that wants the same posture.
 */
export function isOriginAllowed(origin: string | undefined, nodeEnv: string): boolean {
  if (!origin) {
    return logCorsDecision(origin, true, 'no_origin_provided');
  }

  if (nodeEnv === 'production') {
    const allowedOrigins = resolveAllowedOrigins();
    if (allowedOrigins) {
      const originList = allowedOrigins.split(',').map((o) => o.trim());
      if (originList.includes(origin)) {
        return logCorsDecision(origin, true, 'cors_allowed_origins_match');
      }
    }

    const defaultAllowedOrigins = ['https://app.arcaai.com', 'https://dashboard.arcaai.com', 'https://admin.arcaai.com'];

    if (defaultAllowedOrigins.includes(origin)) {
      return logCorsDecision(origin, true, 'default_allowed_domain');
    }

    const devToolPatterns = [/\.ngrok\.io$/, /\.ngrok-free\.app$/, /\.loca\.lt$/, /\.vercel\.app$/, /\.netlify\.app$/];

    if (devToolPatterns.some((pattern) => pattern.test(origin))) {
      return logCorsDecision(origin, true, 'dev_tool_pattern_match');
    }

    if (origin.startsWith('https://')) {
      const blockedPatterns = [/\.onion$/, /localhost/, /127\.0\.0\.1/, /192\.168\./, /10\./, /172\.(1[6-9]|2[0-9]|3[0-1])\./];

      const isBlocked = blockedPatterns.some((pattern) => pattern.test(origin));
      if (isBlocked) {
        return logCorsDecision(origin, false, 'suspicious_pattern_blocked');
      }

      return logCorsDecision(origin, true, 'https_sdk_allowed');
    }

    return logCorsDecision(origin, false, 'not_https');
  } else if (nodeEnv === 'staging') {
    const localhostPatterns = [
      /^http:\/\/localhost:\d+$/,
      /^https:\/\/localhost:\d+$/,
      /^http:\/\/127\.0\.0\.1:\d+$/,
      /^https:\/\/127\.0\.0\.1:\d+$/,
    ];

    const stagingDomains = ['https://staging.arcaai.com', 'https://staging-app.arcaai.com', 'https://staging-dashboard.arcaai.com'];

    const devToolPatterns = [
      /\.ngrok\.io$/,
      /\.ngrok-free\.app$/,
      /\.loca\.lt$/,
      /\.cloudflare\.com$/,
      /\.vercel\.app$/,
      /\.netlify\.app$/,
      /\.surge\.sh$/,
      /\.repl\.co$/,
      /\.gitpod\.io$/,
      /\.codesandbox\.io$/,
    ];

    const isLocalhost = localhostPatterns.some((pattern) => pattern.test(origin));
    const isStagingDomain = stagingDomains.includes(origin);
    const isDevTool = devToolPatterns.some((pattern) => pattern.test(origin));

    if (isLocalhost) {
      return logCorsDecision(origin, true, 'localhost_pattern_match');
    }
    if (isStagingDomain) {
      return logCorsDecision(origin, true, 'staging_domain');
    }
    if (isDevTool) {
      return logCorsDecision(origin, true, 'dev_tool_pattern_match');
    }

    return logCorsDecision(origin, false, 'staging_not_allowed');
  } else {
    // Dev fallback (only reachable if a caller misuses isOriginAllowed
    // with nodeEnv='development'; `getCorsOrigins` no longer goes through
    // this function in dev). Mirrors the DEV_LOCALHOST_ORIGIN RegExp so the
    // posture is identical regardless of which entry point is used.
    return logCorsDecision(origin, DEV_LOCALHOST_ORIGIN.test(origin), 'development_localhost_only');
  }
}

/**
 * Value passed to `app.enableCors({ origin })`.
 *
 *   - development → localhost-only RegExp.
 *   - production / staging → callback delegating to `isOriginAllowed`.
 *
 * The dev branch must NOT return `true`: combined with
 * `credentials: true`, browsers reject that config (the spec forbids
 * wildcard + credentials), so the intent is "localhost only in dev" —
 * this pins it explicitly so the server's response headers match the
 * browser's behaviour.
 */
export function getCorsOrigins(
  nodeEnv: string,
): RegExp | string[] | boolean | ((origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void) {
  if (nodeEnv === 'development') {
    return DEV_LOCALHOST_ORIGIN;
  }
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    const isAllowed = isOriginAllowed(origin, nodeEnv);
    callback(null, isAllowed);
  };
}

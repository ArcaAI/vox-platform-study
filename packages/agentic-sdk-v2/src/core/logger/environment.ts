/**
 * @arcaai/vox - Deployment environment resolution
 *
 * Shared by the fail-closed third-party monitoring transports (Highlight,
 * Clarity) to answer one question: *is this a production DEPLOYMENT?*
 *
 * ## Why `NODE_ENV` alone is the wrong test
 *
 * `NODE_ENV` describes the BUILD MODE, not the deployment stage. Every browser
 * bundler (Vite, Next.js, webpack) substitutes `process.env.NODE_ENV` at build
 * time and sets it to `'production'` for ANY optimised build — including the
 * build that gets deployed to staging. A `NODE_ENV`-only gate therefore reads
 * "production" on a staging deploy and silently disables the transport exactly
 * where the telemetry is most wanted.
 *
 * ## The rule
 *
 * An explicitly declared `environment` wins, because only the deploying app
 * knows which stage it is running as. `NODE_ENV` is the fallback when nothing
 * was declared.
 *
 * The fail-closed property is preserved in both directions:
 *   - `environment: 'production' | 'prod' | 'live'` → blocked.
 *   - `environment` undeclared + `NODE_ENV === 'production'` → blocked
 *     (identical to the previous behaviour).
 *
 * Enabling a transport on a production deploy therefore still requires someone
 * to explicitly mislabel that deploy as a non-production stage — an auditable
 * declaration, not an accident.
 */

/** Environment names treated as production. Compared case-insensitively. */
const PRODUCTION_ENVIRONMENT_NAMES: readonly string[] = Object.freeze(['production', 'prod', 'live']);

/**
 * Resolve whether the current deployment is production.
 *
 * @param declaredEnvironment  The `environment` the host app declared on the
 *   transport config (e.g. `'staging'`, `'development'`, `'production'`).
 *   When omitted, `NODE_ENV` is consulted instead.
 */
export function isProductionEnvironment(declaredEnvironment?: string): boolean {
  const declared = declaredEnvironment?.trim();
  if (declared) {
    return PRODUCTION_ENVIRONMENT_NAMES.includes(declared.toLowerCase());
  }

  // `process` may be undefined in some browser bundles — treat as non-prod.
  const nodeEnv = typeof process !== 'undefined' ? process.env?.NODE_ENV : undefined;
  return nodeEnv === 'production';
}

/**
 * The throttle module's local name for the client-address primitive.
 *
 * The implementation moved to `@arcaai/applications`
 * (`packages/applications/src/common/client-ip.ts`) in TASK-993 lane J,
 * because two OTHER readers of the client address — `UnifiedAuthGuard`, which
 * lives inside that package, and `ServiceAccountTokenController` — were still
 * trusting `X-Forwarded-For`, and `packages/applications` cannot import from
 * `apps/api`. There is exactly ONE implementation; this file is the re-export
 * that keeps the throttle module (and lane A's tests, which are untouched)
 * importing it by its original path.
 *
 * `resolveAttributedClientIp` is deliberately NOT re-exported here: the
 * throttler never wants it. Its `undefined` means "fall back to `req.ip`",
 * which is precisely what the base class does, whereas the audit variant
 * always answers an address.
 */
export { isTrustedProxy, parseIp, parseTrustedProxies, resolveClientIp, trustedProxiesFromEnv, type TrustedProxy } from '@arcaai/applications';

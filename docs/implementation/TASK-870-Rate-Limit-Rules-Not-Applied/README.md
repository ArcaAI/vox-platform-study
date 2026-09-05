# TASK-870 — Platform rate-limit RULES are not applied by the throttler

**Status:** Pending
**Raised by:** TASK-869 (e2e full-coverage), 2026-09-05
**Severity:** the affected control is brute-force protection on `POST /auth/login`.

## 1. Summary

On a gateway with throttling fully enabled, a platform `RateLimitRule` has no effect. Requests
sail past the configured limit with no `429`. Both gates that guard the throttler were verified
OPEN at the time of the measurement, and the gateway was restarted afterwards so the rule cache
was rebuilt from the database.

This was found while making `auth-throttle-per-endpoint.spec.ts` run in the managed e2e suite
(TASK-869). The spec had been skipped since it was written, so the gap has never been exercised.

## 2. Reproduction (measured 2026-09-05, isolated test gateway on :8969)

```
# Gate 1 — process env, read from the LIVE process (ps eww):
PORT=8969   RATE_LIMIT_ENABLED=true   TEXT_URL=http://127.0.0.1:8992

# Gate 2 — the DB flag, read from Postgres AFTER the run:
rate-limit.enabled | true

# The rule, created through the admin API and visible in GET /admin/rate-limit/rules:
{"id":"…","tenantId":"00000000-0000-0000-0000-000000000000","platform":true,
 "routeMatch":"GET:/api/v1/auth/me","matchKind":"EXACT","limitValue":2,"windowMs":60000,
 "active":true,"version":1}

# Four consecutive authenticated requests:
GET /api/v1/auth/me  →  200 200 200 200        ← expected at least one 429

# Same shape on the anonymous route, rule 5/min:
POST /api/v1/auth/login  →  401 401 401 401 401 401 401   ← no 429
```

Restarting the gateway (so `RateLimitRuleCache.onModuleInit` → `refresh()` reloads from the DB
with the flag already true) changed nothing: `200 200 200 200`.

## 3. What has been ruled out

| Hypothesis | Status |
|---|---|
| `RATE_LIMIT_ENABLED` not reaching the process | **Ruled out** — read from the live process env |
| DB kill-switch off | **Ruled out** — `rate-limit.enabled = true` in Postgres |
| Cache had not picked up the rule | **Ruled out** — full gateway restart, same result |
| Guard not registered | **Ruled out** — unconditional `APP_GUARD` (`app.module.ts:197`) |
| `RateLimitRuleCache` unprovided | **Ruled out** — provided AND exported by `RateLimitServiceModule`, which `app.module` imports |
| Only anonymous traffic affected | **Ruled out** — an authenticated route with a platform rule behaves identically |
| Legacy per-route override disabling it | **Ruled out** — no `rate-limit.route.*` rows are seeded |

## 4. Where to start

The chain is: `TieredThrottlerGuard.handleRequest` → `resolveRouteKey(context)` →
`ruleCache.getPlatformRules()` → `resolveRateLimit({...})`.

- `resolveRouteKey` (`tiered-throttler.guard.ts:260`) builds `` `${METHOD}:${baseUrl}${route.path}` ``
  via `buildRouteKey` (`rate-limit-rule.constants.ts:53`). **The first thing to check is what that
  string actually is at runtime under the global `api/v1` prefix on this Nest/Express version** —
  the admin DTO's own example is `POST:/api/v1/auth/login`, so a mismatch here would produce
  exactly this silent no-op.
- `getPlatformRules()` (`rate-limit-rule.cache.ts:80`) keys on `RATE_LIMIT_RULE_SYSTEM_TENANT_ID`;
  confirm the created row lands in that bucket.
- `resolveRateLimit` (`rate-limit-resolver.ts:187`) pushes the platform rule OUTSIDE the
  `if (input.tenantId)` block, so an anonymous request should still see rank 4.

## 5. Secondary defects found alongside

1. **`GET /admin/rate-limit/explain` answers 500.** The one diagnostic built for this exact
   question is unusable, which is part of why the primary defect went unnoticed. Gateway log shows
   an unhandled error, correlationId `01a070f4-89cb-74c6-a862-7db6a09cdee7`.
2. **`RateLimitRule` soft-deletes, but the unique index still counts the dead row.** A deleted rule
   is invisible to `GET /rules` *and* blocks re-creating the same route key with
   `409 PERSISTENCE.UNIQUE_CONSTRAINT_VIOLATION`. Any caller that creates-then-deletes a rule for a
   route can never recreate it. TASK-869's spec works around this by relaxing the limit instead of
   deleting; the constraint should probably exclude soft-deleted rows.
3. **`routeMatch: '*'` is rejected with 400** even though `ALL_ROUTES_PATTERN` is the resolver's
   documented tenant-wide pattern (`rate-limit-resolver.ts:165`) — so the tenant-wide lane may not
   be reachable through the admin API at all.

## 6. Effect on TASK-869

`auth-throttle-per-endpoint.spec.ts` now runs in the managed suite on the isolated gateway. Two of
its three tests pass. The third — `POST /auth/login enforces 5/min` — is marked `test.fixme`
against THIS ticket rather than deleted or weakened: the contract it states is correct and the
product does not currently meet it. Un-fixme it as the acceptance test when this lands.

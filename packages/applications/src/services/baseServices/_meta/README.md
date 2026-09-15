# Config, App Settings and Secrets — the three configuration primitives

Three related but distinct services under `baseServices/_meta/`, all part of `@arcaai/applications`
and wired in by `CommonServiceModule`: `ConfigService` (env-derived static config), `AppSettingsService`
(the `GlobalSetting` cache — platform + per-tenant registry overrides), and `SecretsService` (Vault-or-env
secret resolution). See `00-project-context.md` and `09-infrastructure-devops.md` for where each
configuration tier belongs; this file documents only the three services themselves.

## Layout

| Path | What it holds |
|---|---|
| `config/` | `ConfigService` (`IConfigService`), `ConfigModule` — env-var-derived static `AppConfig` |
| `appSettings/` | `AppSettingsService` (`IAppSettingsService`), `AppSettingsModule` — the `GlobalSetting` in-memory cache |
| `secrets/` | `SecretsService`, `ISecretsProvider`, `providers/`, `secrets.module.ts`, Vault lease renewal and rotation workers |
| `JWT-MIGRATION.md` | Historical note on the JWT secret rotation migration |
| `__tests__/` | Vitest suites for `ConfigService` and `AppSettingsService` |

## How it works

### ConfigService — static, env-derived

`IConfigService` (`config/IConfigService.ts`) wraps `IAppConfig` (from `@arcaai/domains`) and exposes
`getConfiguration()`, `getConfigValue<K>(key)`, `reloadConfiguration()`, `isDevelopment()`,
`isProduction()`, `isDebugEnabled()`. It is the bootstrap-floor tier — connection strings, ports,
topology — never a place to add per-tenant or runtime-toggleable config (see
`09-infrastructure-devops.md` Configuration Tiers).

### AppSettingsService — the `GlobalSetting` cache

`IAppSettingsService` (`appSettings/IAppSettingsService.ts`) caches `GlobalSetting` rows in memory and
exposes both a platform-only surface (`getFromCache`, `getValueFromCache`, `getValueWithDefault`,
`hasSetting`, `getAllKeys`, `getCacheStats`, `refreshCache`, `validateSettingValue`) and a
tenant-scoped one: `getTenantValueFromCache(tenantId, key)` reads a **separate**,
`${tenantId}::${key}`-keyed map — the cascade to the platform default on absence lives in
`TenantSettingsService`, not here.

The platform-only cache is keyed by setting name ALONE. That is safe only because it admits
`GlobalSetting` rows for the reserved SYSTEM tenant (`00000000-0000-0000-0000-000000000000`)
EXCLUSIVELY — every other tenant's rows are filtered out before they reach the key-only map. Do not
widen that filter to admit any other tenant, including the `50000000-...` "Global" playground tenant.

Propagation on write is `EventEmitter2` publishing on the `app-settings:invalidate` channel
(`APP_SETTINGS_INVALIDATION_CHANNEL`, exported from `appSettings.service.ts`) — every process drops
the affected key on receipt. The cron refresh is a bounded-staleness backstop, not the propagation
path (see Gotchas for its actual period).

### SecretsService — Vault-backed, env fallback

`secrets/SecretsService.ts` resolves secrets through `ISecretsProvider` implementations under
`secrets/providers/`, with lease renewal (`vault-lease-renewer.ts`) and scheduled rotation
(`vault-rotation-worker.ts`, `scheduled-rotation.policy.ts`) for Vault-backed secrets. `SecretsModule.forRoot({ warmupKeys })`
awaits `SecretsService.boot({ warmupKeys })` before the module resolves, so downstream synchronous
readers (`getSecretSync`) never observe a cold cache for a warmed key — see
`COMMON_SERVICE_WARMUP_KEYS` in `../common.service.module.ts` for the current warm-up list.
`secrets-invalidation.subscriber.ts` mirrors `AppSettingsService`'s invalidation pattern on its own
Redis channel for rotations.

## Gotchas

- **The 45-second refresh is not an interval — it is a cron fixed at `:45` of every minute**
  (`DEFAULT_CACHE_REFRESH_INTERVAL = '45 * * * * *'` in `appSettings.service.ts`). Worst-case
  staleness between a write and the next tick is close to 60 seconds, not 45.
- **`getTenantValueFromCache` never falls back to the platform value.** The cascade + clamp are
  `TenantSettingsService`'s job; calling this accessor directly and treating a `null` as "use the
  platform default" skips that layer.
- Do not read secrets via Vault as a manual HTTP call from application code — go through
  `SecretsService` / `ISecretsProvider` so lease renewal and the invalidation channel stay in effect.

## Related

- [`00-project-context.md`](../../../../../../.claude/rules/00-project-context.md) — Environment Files, Configuration Principles
- [`09-infrastructure-devops.md`](../../../../../../.claude/rules/09-infrastructure-devops.md) — Configuration Tiers, config cache rules
- [`@arcaai/applications` README](../../../../README.md) — service anatomy and `BaseService`

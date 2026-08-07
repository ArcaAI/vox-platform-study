/**
 * Platform-Knob Settings Seed (TASK-558 lane I)
 *
 * Creates the platform-scope `GlobalSetting` rows for the operational knobs
 * that moved out of `process.env` into the `global-kv` tier: log level,
 * shutdown timings, API-key policy, refresh-token TTL and the rate-limit
 * baselines. (CORS origins were one of these ten at lane I, then removed
 * outright by TASK-610 §4A.1 — the allow-list is the `TenantAllowedOrigin`
 * table now, not a `global-kv` knob; there is no row and no env var for it
 * any more.)
 *
 * BEHAVIOUR ON UPGRADE IS UNCHANGED. Each row is seeded from the SAME env
 * variable the reader used before this lane, falling back to the same code
 * default — so a platform that resolved these from env resolves identical
 * values from these rows. Nothing needs to be set for an upgrade to be a no-op.
 *
 * The rows live on the reserved platform tenant (`SEED_TENANT_ID`,
 * `50000000-…`) under the `registry` namespace, which is what
 * `SettingsRegistryWriteService` writes and what `AppSettingsService` admits
 * into its platform (key-only) cache lane. Per-TENANT overrides are NOT seeded:
 * their absence means "inherit the platform value", which is the correct
 * starting state for every tenant.
 *
 * IDEMPOTENT, and CREATE-ONLY for the `value` column: a re-seed refreshes
 * metadata but never clobbers an admin-tuned value, matching
 * `12-rate-limit-settings.ts`. That property is what makes it safe to run
 * `pnpm db:seed` against a live database.
 *
 * KEY NAMES ARE MIRRORED BY HAND from
 * `packages/applications/src/services/settings-registry/descriptors/platform-knobs.descriptors.ts`
 * — the database package must not depend on `@arcaai/applications` (the same
 * constraint `12-rate-limit-settings.ts` documents). A registry test asserts
 * every key seeded here is a registered `global-kv` descriptor, so the two
 * cannot drift silently.
 */
import type { CorePrismaClient } from '../../../client';
import { ValueType } from '../../../generated/core-prisma-client/client.js';
import { SEED_TENANT_ID, SEED_USER_IDS } from './00-constants';

const CREATED_BY = SEED_USER_IDS.SUPER_ADMIN;

/** The namespace `SettingsRegistryWriteService` stamps on every registry row. */
const NAMESPACE = 'registry';

interface KnobSeed {
  /** Registry descriptor key (dotted lowerCamel). */
  key: string;
  /** Human label — mirrors the descriptor's `label`. */
  name: string;
  /** The env variable this knob used to be read from (its bootstrap fallback). */
  envVar: string;
  dataType: ValueType;
  /** The reader's historical code default, used when the env var is unset. */
  fallback: string;
  description: string;
}

const KNOBS: KnobSeed[] = [
  {
    key: 'logLevel',
    name: 'Log level',
    envVar: 'LOG_LEVEL',
    dataType: ValueType.String,
    fallback: 'info',
    description: 'Gateway log level, applied live without a redeploy. LOG_LEVEL remains the pre-bootstrap value.',
  },
  {
    key: 'shutdown.timeoutMs',
    name: 'Graceful shutdown timeout (ms)',
    envVar: 'SHUTDOWN_TIMEOUT_MS',
    dataType: ValueType.Integer,
    fallback: '30000',
    description: 'Upper bound on graceful shutdown before the process is forced down.',
  },
  {
    key: 'shutdown.drainDelayMs',
    name: 'Shutdown drain delay (ms)',
    envVar: 'SHUTDOWN_DRAIN_DELAY_MS',
    dataType: ValueType.Integer,
    fallback: '5000',
    description: 'Delay between failing readiness and closing the server, so a load balancer stops routing first.',
  },
  {
    key: 'apiKey.allowQueryParam',
    name: 'Allow API key in query parameter',
    envVar: 'API_KEY_ALLOW_QUERY_PARAM',
    dataType: ValueType.Boolean,
    fallback: 'false',
    description: 'When true, an API key may be presented as a query parameter. Platform-only; keep OFF unless forced.',
  },
  {
    key: 'refreshToken.ttlSeconds',
    name: 'Refresh token TTL (seconds)',
    envVar: 'REFRESH_TOKEN_TTL_SECONDS',
    dataType: ValueType.Integer,
    fallback: String(7 * 24 * 60 * 60),
    description: 'Refresh-token lifetime, resolved for the issuing tenant. A tenant may only shorten it.',
  },
  {
    key: 'rateLimit.enabled',
    name: 'Rate limiting enabled',
    envVar: 'RATE_LIMIT_ENABLED',
    dataType: ValueType.Boolean,
    fallback: 'true',
    description: 'Whether throttling is enforced. A tenant may switch it ON for itself but never off.',
  },
  {
    key: 'rateLimit.maxRequests',
    name: 'Default tier request limit',
    envVar: 'RATE_LIMIT_MAX_REQUESTS',
    dataType: ValueType.Integer,
    fallback: '100',
    description: 'Requests per window for the always-on default throttler tier, resolved per tenant.',
  },
  {
    key: 'rateLimit.windowMs',
    name: 'Default tier window (ms)',
    envVar: 'RATE_LIMIT_WINDOW_MS',
    dataType: ValueType.Integer,
    fallback: '60000',
    description: 'Window length for the always-on default throttler tier, resolved per tenant.',
  },
];

/**
 * `apiKey.maxLifetimeDays` is deliberately NOT in the list above.
 *
 * Its descriptor carries NO default because UNSET MEANS UNLIMITED — seeding a
 * row would silently impose a ceiling on every existing API key on the first
 * `db:seed` after upgrade, which is exactly the behaviour change this seed
 * exists to avoid. It is seeded ONLY when the operator has an
 * `API_KEY_MAX_LIFETIME_DAYS` today, i.e. when a ceiling already applies.
 */
const CONDITIONAL_KNOBS: KnobSeed[] = [
  {
    key: 'apiKey.maxLifetimeDays',
    name: 'API key maximum lifetime (days)',
    envVar: 'API_KEY_MAX_LIFETIME_DAYS',
    dataType: ValueType.Integer,
    fallback: '',
    description: 'Ceiling on a requested API-key expiry, resolved for the key’s tenant. Unset means unlimited.',
  },
];

/** The env value for a knob, trimmed, or its historical code default. */
function seedValue(knob: KnobSeed): string {
  const raw = (process.env[knob.envVar] ?? '').trim();
  return raw !== '' ? raw : knob.fallback;
}

export const seedPlatformKnobSettings = async (client: CorePrismaClient): Promise<void> => {
  const conditional = CONDITIONAL_KNOBS.filter((knob) => seedValue(knob) !== '');
  const rows = [...KNOBS, ...conditional];

  console.log(`Seeding platform-knob Global Settings (${rows.length} platform rows, namespace='${NAMESPACE}')...`);

  for (const knob of rows) {
    const value = seedValue(knob);
    await client.globalSetting.upsert({
      where: {
        GlobalSetting_tenantId_name_key_unique: {
          tenantId: SEED_TENANT_ID,
          name: knob.name,
          key: knob.key,
        },
      },
      // Idempotent: refresh metadata but NEVER clobber an admin-tuned `value`
      // on re-seed — operators expect their live config to survive `db:seed`.
      update: {
        dataType: knob.dataType,
        description: knob.description,
        namespace: NAMESPACE,
      },
      create: {
        tenantId: SEED_TENANT_ID,
        namespace: NAMESPACE,
        name: knob.name,
        key: knob.key,
        value,
        defaultValue: value,
        dataType: knob.dataType,
        description: knob.description,
        locked: false,
        createdBy: CREATED_BY,
      },
    });
    console.log(`  ${NAMESPACE}/${knob.key} = ${value} (from ${knob.envVar})`);
  }

  if (conditional.length === 0) {
    console.log('  apiKey.maxLifetimeDays not seeded (API_KEY_MAX_LIFETIME_DAYS unset ⇒ unlimited, unchanged)');
  }

  console.log(`Seeded ${rows.length} platform-knob Global Settings`);
};

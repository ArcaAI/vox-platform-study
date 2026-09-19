// The bootstrap floor — tier `env`.
//
// THE GOVERNING PRINCIPLE: a variable MUST stay in env if it is
// required *to reach the database* or *to authenticate to Vault*. Everything
// else is a candidate for DB or Vault. That test is objective and settles every
// case below without debate.
//
// WHY DECLARE THEM AT ALL, IF THEY ARE NOT ADMIN-EDITABLE?
// Because a catalog with a hole in it is not a catalog. Zero keys
// declared-but-unread; the mirror obligation is zero keys READ-but-
// undeclared. Declaring the floor makes it EXPLICIT — a reviewer can see exactly
// which variables a deployable must be handed before it can boot, and the
// schema generator can emit the per-deployable zod schema and `.env.sample`
// from this list instead of hand-maintaining one.
//
// FIELD SEMANTICS FOR THIS TIER
//   - `editableBy: 'none'`  There is NO admin write path for a deploy-time value.
//                           Naming a CASL subject would advertise an editor
//                           surface that does not exist. Governance tests bind
//                           `tier === 'env'` ⟺ `editableBy === 'none'`.
//   - `failMode`            DECLARATIVE here, not behavioural: `EffectiveSettingsService`
//                           has no `env` branch (an env key raises "no effective
//                           resolver" — deliberately, since env is not a control
//                           plane). It encodes the BOOT contract:
//                             `closed`          → required; absence must fail fast
//                                                 at boot (zod `.required()`).
//                             `open-to-default` → optional; the reader has a code
//                                                 fallback, transcribed into `default`.
//   - `default`             The reader's ACTUAL fallback, verified against the
//                           reading line — never an aspirational value.

import { EDITABLE_BY_NONE, SettingDescriptor } from '../registry.types';

/** Shared shape for a bootstrap-floor variable. */
function envFloor(
  key: string,
  dataType: SettingDescriptor['dataType'],
  category: string,
  label: string,
  description: string,
  failMode: SettingDescriptor['failMode'],
  defaultValue?: unknown,
): SettingDescriptor {
  return {
    key,
    tier: 'env',
    dataType,
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: EDITABLE_BY_NONE,
    failMode,
    category,
    label,
    description,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  };
}

export const BOOTSTRAP_ENV_SETTINGS: SettingDescriptor[] = [
  // ── Process identity ──────────────────────────────────────────────────────
  envFloor(
    'nodeEnv',
    'enum',
    'Bootstrap',
    'Node environment',
    'Selects the env file `loadEnv()` reads (`.env.dev` / `.env.test` / `.env.production`); CI and production load NO file and use host env only.',
    'open-to-default',
    'development',
  ),
  envFloor('port', 'number', 'Bootstrap', 'API gateway port', 'HTTP listen port for the NestJS gateway.', 'open-to-default', 8868),

  // ── Reaching the database (the floor, by definition) ──────────────────────
  {
    ...envFloor(
      'databaseUrl',
      'string',
      'Bootstrap',
      'Database URL',
      'Primary PostgreSQL connection string (PgBouncer transaction mode in production). Cannot come from the database or from Vault — this IS the credential that reaches them. No fallback exists: absence is a hard boot error.',
      'closed',
    ),
    // Template-only (see `sampleValue`'s doc comment) — the LOCAL superuser
    // credentials `infrastructure/docker/docker-compose.yml` provisions for
    // every developer, not a runtime fallback: `failMode: 'closed'` above still
    // means an absent `DATABASE_URL` fails boot in every real environment.
    sampleValue: 'postgresql://postgres:postgres@localhost:5432/hope',
  },
  {
    ...envFloor(
      'directUrl',
      'string',
      'Bootstrap',
      'Direct (un-pooled) database URL',
      'Migrations-only, un-pooled PostgreSQL endpoint (`packages/database/src/migration-url.ts`). Falls back to `DATABASE_URL` when unset, which is correct in dev but wrong behind a transaction-mode pooler — production must set it explicitly.',
      'open-to-default',
    ),
    sampleValue: 'postgresql://postgres:postgres@localhost:5432/hope',
  },
  // TASK-993 lane D: 5 → 15. The old value predates the BullMQ workers that now
  // share this pool with the request handlers inside the same gateway process,
  // and it is the value that applies IN THE CLUSTER, because the deployment repo
  // sets this variable nowhere. Sizing, and both connection budgets, are in the
  // description below and derived in
  // `packages/applications/src/services/baseServices/redis/queue-concurrency.ts`.
  envFloor(
    'prisma.pgMax',
    'number',
    'Bootstrap',
    'Prisma pool size',
    'Driver-adapter connection-pool size, PER PrismaClient. The Prisma v6 `connection_limit` URL parameter is ignored. A non-positive-integer value is a hard error, not a silent fallback. Budget rule: `pods × 2 × PRISMA_PG_MAX ≤ 0.7 × PG max_connections` — the ×2 is not a typo, because in env mode `getExtendedPrismaClient()` and `getPlatformAdminPrismaClient_Unscoped()` each build their own pg pool of this size. Demand per gateway pod at the MEASURED 10-tenant × 100-user load (229 req/s platform-wide, from a 30/70 active/parked mix at 26.0 and 8.5 req/min): 8 slots reserved for in-flight HTTP (76 req/s/pod × 6 ms DB time × 3 spike = 1.4, reserved high because a document load is 8.0 correlated requests and a handler that cannot get a connection in 5 s fails) plus 18 DB-bound BullMQ worker slots at a 0.35 duty cycle = 6.3, total 14.3. At 15 the cluster footprint is 2 × 15 × 3 api pods = 90 against a 140 budget (max_connections 200), and a single local gateway is 30 against a 70 budget (max_connections 100).',
    'open-to-default',
    15,
  ),

  // ── Reaching Redis ────────────────────────────────────────────────────────
  {
    ...envFloor(
      'redis.url',
      'string',
      'Bootstrap',
      'Redis URL',
      'Full Redis connection URL; when set it wins over the host/port pair.',
      'open-to-default',
    ),
    sampleValue: 'redis://localhost:6379',
  },
  envFloor('redis.host', 'string', 'Bootstrap', 'Redis host', 'Redis host, used when `REDIS_URL` is unset.', 'open-to-default', 'localhost'),
  envFloor('redis.port', 'number', 'Bootstrap', 'Redis port', 'Redis port, used when `REDIS_URL` is unset.', 'open-to-default', 6379),

  // ── Authenticating to Vault (the other half of the floor) ─────────────────
  {
    ...envFloor(
      'secretsProvider',
      'enum',
      'Bootstrap',
      'Secrets provider',
      'Selects the secrets backend (`env` | `vault` | …). It decides where every `vault-kv` descriptor is actually read from, so it necessarily precedes all of them.',
      'open-to-default',
      'env',
    ),
    sampleValue: 'vault',
  },
  envFloor(
    'vault.addr',
    'string',
    'Bootstrap',
    'Vault address',
    'Vault API address. Required when `SECRETS_PROVIDER=vault`.',
    'open-to-default',
    'http://localhost:8200',
  ),
  envFloor(
    'vault.roleId',
    'string',
    'Bootstrap',
    'Vault AppRole role_id',
    'AppRole role_id. Non-secret by Vault design (it is the public half of the AppRole pair) and useless without a secret_id, so it is classified `internal`, not `secret`.',
    'open-to-default',
  ),
  {
    ...envFloor(
      'vault.secretId',
      'string',
      'Bootstrap',
      'Vault AppRole secret_id (raw)',
      'RAW, reusable AppRole secret_id — the DEV path (`scripts/refresh-vault-creds.sh`; `secret_id_num_uses=0`, `secret_id_ttl=720h`), because a response-wrapped token is single-use and dies on the first watch-mode restart. This is genuine credential material, but it CANNOT live in Vault: it is what authenticates TO Vault.',
      'open-to-default',
    ),
    sensitivity: 'secret',
    dataType: 'secret',
    failMode: 'closed',
  },
  {
    ...envFloor(
      'vault.wrappedSecretId',
      'string',
      'Bootstrap',
      'Vault AppRole secret_id (response-wrapped)',
      'PRODUCTION path: a single-use response-wrapping token unwrapped once per process start. Blank in dev so the raw path is taken. Same bootstrap exemption as `VAULT_SECRET_ID`.',
      'open-to-default',
    ),
    sensitivity: 'secret',
    dataType: 'secret',
    failMode: 'closed',
  },
  envFloor(
    'vault.kvMount',
    'string',
    'Bootstrap',
    'Vault kv-v2 mount',
    'Mount path of the kv-v2 engine. Final secret path: `<mount>/data/<prefix>/<NAME>`.',
    'open-to-default',
    'secret',
  ),
  envFloor(
    'vault.kvPrefix',
    'string',
    'Bootstrap',
    'Vault kv-v2 prefix',
    'Prefix beneath the kv-v2 mount under which every platform secret is stored.',
    'open-to-default',
    'hope',
  ),
  {
    ...envFloor(
      'vault.dbAdminPass',
      'string',
      'Bootstrap',
      'Vault database-engine admin password',
      'Password for the `vault_admin` PostgreSQL role that VAULT ITSELF uses to mint short-lived DB credentials. ' +
        'CLASSIFIED `env`, NOT `vault-kv`, DELIBERATELY: it is consumed at Vault PROVISIONING time by `infrastructure/docker/configs/vault/dev-init.sh`, `scripts/setup-dev-vault-db.sh` and docker-compose — before any Vault kv-v2 read is possible. Storing it in Vault would be circular. ' +
        'It is a real credential and belongs on the rotation list; the bootstrap floor is where it has to live.',
      'open-to-default',
    ),
    sensitivity: 'secret',
    dataType: 'secret',
    failMode: 'closed',
  },
];

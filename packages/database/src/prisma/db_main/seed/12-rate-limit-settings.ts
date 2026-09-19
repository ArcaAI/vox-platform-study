import type { CorePrismaClient } from '../../../client';
import { ValueType } from '../../../generated/core-prisma-client/client.js';
import { SYSTEM_TENANT_ID, SEED_USER_IDS, SEED_GLOBAL_SETTING_IDS } from './00-constants';

/**
 * DB-backed, admin-controlled rate-limit configuration seed.
 *
 * Rate limiting is a gateway-wide concern, so a SINGLE authoritative set of
 * rows lives under the SYSTEM tenant (`SYSTEM_TENANT_ID`) — the sole platform
 * configuration tier (owner ruling 2026-08-20,; GLOBAL/`SEED_TENANT_ID`
 * is a CUSTOMER tenant, never a runtime tier). The
 * `AppSettingsService` cache is keyed by flat `key` across all tenants;
 * seeding one platform row per key keeps that lookup deterministic and avoids
 * tripping the boot-time duplicate-key invariant.
 *
 * Seeds the global kill-switch, the four tier baselines (limit/ttl), the
 * per-principal bucket (TASK-993 OD-2) and the breach posture (TASK-993 D-2).
 * Every one of those has a code baseline, so an absent row changes nothing
 * about how the gateway behaves — they are seeded so a platform admin sees a
 * STORED value on the rate-limit screen instead of an empty field, which is
 * exactly why the nine tier rows are seeded too. Per-route
 * overrides (`rate-limit.route.<id>.*`) are intentionally NOT seeded — their
 * absence means "fall back to the route's `@Throttle` decorator", so the
 * shipped behavior is unchanged until an admin opts a specific endpoint in.
 *
 * `RateLimitRule` rows are NOT seeded either, for the same reason
 * and one more. Under OD-2 a route's `@Throttle` decorator already seeds rank 5,
 * so a platform rule mirroring it would add no behaviour; it would only add a
 * second copy of a number that lives in code, which then drifts the moment the
 * decorator changes. Instead `GET /admin/rate-limit/routes` surfaces each
 * route's decorator value straight from the module walk, so an admin sees the
 * effective default and writes a rule only when they want to CHANGE it.
 *
 * Key scheme + defaults mirror
 * `packages/applications/src/services/rate-limit/rate-limit.constants.ts`
 * (kept in sync manually — the database package must not depend on
 * @arcaai/applications). No migration: reuses the existing `GlobalSetting` table.
 */

const IDS = SEED_GLOBAL_SETTING_IDS;
const CREATED_BY = SEED_USER_IDS.SUPER_ADMIN;
const NAMESPACE = 'rate-limit';

interface RateLimitSettingDef {
  id: string;
  name: string;
  key: string;
  value: string;
  dataType: ValueType;
  description: string;
}

// Exported (not just local) so `seed-global-settings.test.ts` can pin these
// keys into the cross-seed `(tenantId, key)` uniqueness check — every row
// here lands on SYSTEM_TENANT_ID.
export const RATE_LIMIT_SETTINGS: RateLimitSettingDef[] = [
  {
    id: IDS.RATE_LIMIT_ENABLED,
    name: 'Rate Limit Enabled',
    key: 'rate-limit.enabled',
    value: 'true',
    dataType: ValueType.Boolean,
    description: 'Global rate-limit kill-switch. Set to false to disable throttling platform-wide.',
  },
  // ── default tier (gates every route; per-route @Throttle still wins) ─────
  {
    id: IDS.RATE_LIMIT_TIER_DEFAULT_LIMIT,
    name: 'Rate Limit Tier default Limit',
    key: 'rate-limit.tier.default.limit',
    value: '100',
    dataType: ValueType.Integer,
    description: 'Max requests per window for the default tier (routes without a @Throttle decorator).',
  },
  {
    id: IDS.RATE_LIMIT_TIER_DEFAULT_TTL,
    name: 'Rate Limit Tier default Ttl',
    key: 'rate-limit.tier.default.ttl',
    value: '60000',
    dataType: ValueType.Integer,
    description: 'Window length in milliseconds for the default tier.',
  },
  // ── strict tier (opt-in) ────────────────────────────────────────────────
  {
    id: IDS.RATE_LIMIT_TIER_STRICT_LIMIT,
    name: 'Rate Limit Tier strict Limit',
    key: 'rate-limit.tier.strict.limit',
    value: '10',
    dataType: ValueType.Integer,
    description: 'Max requests per window for the strict tier.',
  },
  {
    id: IDS.RATE_LIMIT_TIER_STRICT_TTL,
    name: 'Rate Limit Tier strict Ttl',
    key: 'rate-limit.tier.strict.ttl',
    value: '60000',
    dataType: ValueType.Integer,
    description: 'Window length in milliseconds for the strict tier.',
  },
  // ── heavy tier (opt-in) ─────────────────────────────────────────────────
  {
    id: IDS.RATE_LIMIT_TIER_HEAVY_LIMIT,
    name: 'Rate Limit Tier heavy Limit',
    key: 'rate-limit.tier.heavy.limit',
    value: '20',
    dataType: ValueType.Integer,
    description: 'Max requests per window for the heavy tier.',
  },
  {
    id: IDS.RATE_LIMIT_TIER_HEAVY_TTL,
    name: 'Rate Limit Tier heavy Ttl',
    key: 'rate-limit.tier.heavy.ttl',
    value: '60000',
    dataType: ValueType.Integer,
    description: 'Window length in milliseconds for the heavy tier.',
  },
  // ── relaxed tier (opt-in) ───────────────────────────────────────────────
  {
    id: IDS.RATE_LIMIT_TIER_RELAXED_LIMIT,
    name: 'Rate Limit Tier relaxed Limit',
    key: 'rate-limit.tier.relaxed.limit',
    value: '300',
    dataType: ValueType.Integer,
    description: 'Max requests per window for the relaxed tier.',
  },
  {
    id: IDS.RATE_LIMIT_TIER_RELAXED_TTL,
    name: 'Rate Limit Tier relaxed Ttl',
    key: 'rate-limit.tier.relaxed.ttl',
    value: '60000',
    dataType: ValueType.Integer,
    description: 'Window length in milliseconds for the relaxed tier.',
  },
  // ── the per-principal bucket, level two of the two-level model (OD-2) ───
  // Level one is the tenant aggregate above; this bounds how much of it ONE
  // caller (user / API key / service account) may take, so a runaway browser
  // tab or a looping integration cannot starve the other 99 doctors. Absent
  // rows already resolve to these exact numbers in code — they are seeded so
  // the admin screen shows a stored value, as the nine tier rows above do.
  {
    id: IDS.RATE_LIMIT_PRINCIPAL_ENABLED,
    name: 'Rate Limit Principal Enabled',
    key: 'rate-limit.principal.enabled',
    value: 'true',
    dataType: ValueType.Boolean,
    description: 'Whether each caller is additionally counted in its own bucket underneath its tenant-wide ceiling. OFF restores the single tenant-wide counter.',
  },
  {
    id: IDS.RATE_LIMIT_PRINCIPAL_LIMIT,
    name: 'Rate Limit Principal Limit',
    key: 'rate-limit.principal.limit',
    value: '150',
    dataType: ValueType.Integer,
    description: 'Max requests ONE caller may make per window inside its tenant. Sized from the measured worst case for a single console user (44.1 req/min) with the approved 3x headroom.',
  },
  {
    id: IDS.RATE_LIMIT_PRINCIPAL_TTL,
    name: 'Rate Limit Principal Ttl',
    key: 'rate-limit.principal.ttl',
    value: '60000',
    dataType: ValueType.Integer,
    description: 'Window length in milliseconds for the per-principal bucket.',
  },
  // ── what a BREACH costs (D-2) ──────────────────────────────────────────
  {
    id: IDS.RATE_LIMIT_LOCKOUT_ENABLED,
    name: 'Rate Limit Lockout Enabled',
    key: 'rate-limit.lockout.enabled',
    value: 'false',
    dataType: ValueType.Boolean,
    description: 'ON: exceeding a limit refuses the bucket for a FULL window measured from the breach. OFF (the default): the refusal lasts only until the current window rolls.',
  },
];

export const seedRateLimitSettings = async (client: CorePrismaClient) => {
  console.log(`Seeding rate-limit Global Settings (${RATE_LIMIT_SETTINGS.length} platform rows)...`);

  for (const s of RATE_LIMIT_SETTINGS) {
    await client.globalSetting.upsert({
      where: {
        GlobalSetting_tenantId_name_key_unique: {
          tenantId: SYSTEM_TENANT_ID,
          name: s.name,
          key: s.key,
        },
      },
      // Idempotent: refresh metadata but NEVER clobber an admin-tuned
      // `value` on re-seed (operators expect their live config to survive
      // a `db:seed` run).
      update: {
        dataType: s.dataType,
        description: s.description,
        namespace: NAMESPACE,
      },
      create: {
        id: s.id,
        tenantId: SYSTEM_TENANT_ID,
        namespace: NAMESPACE,
        name: s.name,
        key: s.key,
        value: s.value,
        defaultValue: s.value,
        dataType: s.dataType,
        description: s.description,
        locked: false,
        createdBy: CREATED_BY,
      },
    });
    console.log(`  ${NAMESPACE}/${s.key}`);
  }

  console.log(`Seeded ${RATE_LIMIT_SETTINGS.length} rate-limit Global Settings`);
};

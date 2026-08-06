// Metering descriptors (TASK-615 WS-H).
//
// Two families, both already-live `global-kv` settings that were never
// cataloged (the platform-ops.descriptors.ts pattern — registering them
// changes ZERO runtime behaviour, every default below is transcribed
// verbatim from the consuming service's own fallback constant):
//
//   - `metering.outbox.drain.*` — WS-B's handoff (ws-b-contract.md §11):
//     the outbox-drainer schedule, already read via
//     `IAppSettingsService.getValueWithDefault` in
//     `usage-outbox.processor.ts#UsageOutboxScheduler.getConfig`.
//   - `metering.reconcile.enabled` — the `TenantUsageMeter` snapshot-persist
//     job kill-switch (`metering.service.ts`), same shape as
//     `audit-retention.enabled` (platform-ops.descriptors.ts): OFF by
//     default because reads never depend on it (`getCurrentUsage` is a live
//     aggregate) — the job only warms a persisted snapshot table.
//
// `metering.reconcile.enabledDefault` is the ONE key here that is NOT a
// runtime gate — mirrors `entitlements.enabledDefault`
// (feature-flags.descriptors.ts) exactly: SEED-TIME ONLY, read by
// `seed/15-entitlements.ts` to decide the value of the
// `metering.reconcile.enabled` GlobalSetting row on a FRESH database (OQ3:
// ON in dev/staging via `METERING_RECONCILE_ENABLED_DEFAULT`, OFF in
// test/CI/prod). Its migration path is the same as its sibling's: DELETION,
// once seeding takes its default from the descriptor instead of the
// environment.

import { EDITABLE_BY_NONE, SettingDescriptor } from '../registry.types';
import { DRAIN_DEFAULTS, DRAIN_ENABLED_KEY, DRAIN_INTERVAL_SECONDS_KEY } from '../../usageLedger/usage-ledger.constants';
import { METERING_DEFAULTS, METERING_ENABLED_KEY } from '../../metering/metering.constants';

export const METERING_SETTINGS: SettingDescriptor[] = [
  // ── Outbox drain schedule (WS-B handoff) ──────────────────────────────────
  {
    key: DRAIN_ENABLED_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    // PROTECTION-enable flag (defaults ON) — same polarity as
    // `rate-limit.enabled`: turning it OFF removes a protection (the ledger
    // stops draining) rather than disabling an enforcement path, so this is
    // deliberately NOT `killSwitch: true` (which requires a default-OFF
    // invariant the registry enforces at assembly).
    label: 'Usage-outbox drain enabled',
    description:
      'Master switch for the TASK-615 usage-outbox BullMQ drainer (rates + appends AiUsageEvent rows, maintains the hourly/daily rollups). Defaults ON — an undrained outbox means no usage lands on the ledger at all.',
    default: DRAIN_DEFAULTS.enabled,
  },
  {
    key: DRAIN_INTERVAL_SECONDS_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Usage-outbox drain interval (seconds)',
    description: 'Sweep interval for the usage-outbox drainer tick (BullMQ `upsertJobScheduler`).',
    default: DRAIN_DEFAULTS.intervalSeconds,
  },

  // ── TenantUsageMeter reconcile job ─────────────────────────────────────────
  {
    key: METERING_ENABLED_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    killSwitch: true,
    label: 'Metering reconcile sweep enabled',
    description:
      'Enables the scheduled job that PERSISTS per-(tenant, metric, window) usage snapshots into TenantUsageMeter. Capability/usage READS (`MeteringService.getCurrentUsage`, quota assertions) are always a live Postgres aggregate and are correct even with this OFF — the job only warms the persisted snapshot table (history + a future fast-path). Fail-safe: defaults OFF, same shape as `audit-retention.enabled`.',
    default: METERING_DEFAULTS.enabled,
  },
  {
    key: 'metering.reconcile.enabledDefault',
    tier: 'env',
    targetTier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: EDITABLE_BY_NONE,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Metering reconcile seed default',
    description:
      "SEED-TIME ONLY, and not itself a runtime gate: `seed/15-entitlements.ts` reads it to decide the value of the `metering.reconcile.enabled` GlobalSetting row on a FRESH database (OQ3 — ON in dev/staging via METERING_RECONCILE_ENABLED_DEFAULT, OFF in test/CI/prod). The live control plane is `metering.reconcile.enabled` (already cataloged above, tier `global-kv`, kill-switch). Mirrors `entitlements.enabledDefault` exactly; its migration is DELETION, once seeding takes its default from the descriptor instead of the environment.",
    default: false,
  },
];

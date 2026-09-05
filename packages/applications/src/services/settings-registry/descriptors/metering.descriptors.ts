// Metering descriptors.
//
// Two families, both already-live `global-kv` settings that were never
// cataloged (the platform-ops.descriptors.ts pattern — registering them
// changes ZERO runtime behaviour, every default below is transcribed
// verbatim from the consuming service's own fallback constant):
//
// `metering.outbox.drain.*` — handoff:
//     the outbox-drainer schedule, already read via
//     `IAppSettingsService.getValueWithDefault` in
//     `usage-outbox.processor.ts#UsageOutboxScheduler.getConfig`.
//   - `metering.reconcile.enabled` — the `TenantUsageMeter` snapshot-persist
//     job kill-switch (`metering.service.ts`), same shape as
//     `audit-retention.enabled` (platform-ops.descriptors.ts): OFF by
//     default because reads never depend on it (`getCurrentUsage` is a live
//     aggregate) — the job only warms a persisted snapshot table.
//
// Every key here is a runtime knob. The one exception —
// `metering.reconcile.enabledDefault`, a seed-time-only companion — was
// deleted in TASK-872 along with its `entitlements.enabledDefault` twin; see
// the note where it stood. `seed/15-entitlements.ts` still honours the
// `METERING_RECONCILE_ENABLED_DEFAULT` host-env override, which is where a
// seed-time variable belongs.

import { SettingDescriptor } from '../registry.types';
import {
  DRAIN_DEFAULTS,
  DRAIN_ENABLED_KEY,
  DRAIN_INTERVAL_SECONDS_KEY,
  PRUNE_CRON_KEY,
  PRUNE_DEFAULTS,
  PRUNE_ENABLED_KEY,
  PRUNE_RETENTION_DAYS_KEY,
} from '../../usageLedger/usage-ledger.constants';
import { METERING_DEFAULTS, METERING_ENABLED_KEY } from '../../metering/metering.constants';
import {
  SHADOW_METERING_CRON_KEY,
  SHADOW_METERING_DEFAULTS,
  SHADOW_METERING_ENABLED_KEY,
} from '../../metering/reconciliation/shadow-metering.constants';

export const METERING_SETTINGS: SettingDescriptor[] = [
  // ── Outbox drain schedule ─────────────────────────────────────────────
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
      'Master switch for the usage-outbox BullMQ drainer (rates + appends AiUsageEvent rows, maintains the hourly/daily rollups). Defaults ON — an undrained outbox means no usage lands on the ledger at all.',
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
  // `metering.reconcile.enabledDefault` was declared here, and its own
  // description named the exit: "its migration is DELETION". TASK-872 took it,
  // with the sibling `entitlements.enabledDefault`
  // (feature-flags.descriptors.ts) that it mirrored.
  //
  // Seeding is unchanged: `seed/15-entitlements.ts` reads
  // `process.env.METERING_RECONCILE_ENABLED_DEFAULT` as an explicit override
  // over its own derived default (`isDeployedEnvironment()`), never this
  // descriptor, and the variable stays in `turbo.json#globalEnv` because that
  // read still exists. What goes is the generated `.env.sample` stanza — a
  // committed declaration of a seed-time-only variable that no running process
  // ever reads.

  // ── Shadow-metering drift report ────────────────────────────────────────
  {
    key: SHADOW_METERING_ENABLED_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    killSwitch: true,
    label: 'Shadow-metering drift report enabled',
    description:
      'Enables the scheduled job that compares ledger totals (AiUsageRollupDaily) against SummaryMeta token sums and the persisted TenantUsageMeter snapshot, alerting (via metering.shadow-drift-detected) when any comparison drifts beyond 2%. Read-only — never blocks, corrects, or enforces anything. Defaults OFF, same shape as metering.reconcile.enabled.',
    default: SHADOW_METERING_DEFAULTS.enabled,
  },
  {
    key: SHADOW_METERING_CRON_KEY,
    tier: 'global-kv',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Shadow-metering drift report cron',
    description: 'Cron schedule for the shadow-metering drift report sweep (all tenants, one comparison pass per tick).',
    default: SHADOW_METERING_DEFAULTS.cron,
  },

  // ── DISPATCHED-outbox pruning ──────────────────────────────────────────
  {
    key: PRUNE_ENABLED_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    killSwitch: true,
    label: 'Usage-outbox pruning enabled',
    description:
      'Enables the scheduled HARD DELETE of already-drained (DISPATCHED) AiUsageOutbox rows older than metering.outbox.prune.retentionDays. The durable usage record is the AiUsageEvent the drainer already produced — a DISPATCHED outbox row is a completed work item, not history. PENDING and FAILED rows are never touched regardless of age. Defaults OFF, same shape as audit-retention.enabled (an operator opts into a hard delete explicitly).',
    default: PRUNE_DEFAULTS.enabled,
  },
  {
    key: PRUNE_CRON_KEY,
    tier: 'global-kv',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Usage-outbox pruning cron',
    description: 'Cron schedule for the DISPATCHED-outbox prune sweep.',
    default: PRUNE_DEFAULTS.cron,
  },
  {
    key: PRUNE_RETENTION_DAYS_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Usage-outbox pruning retention (days)',
    description: 'How long a DISPATCHED AiUsageOutbox row survives before it becomes eligible for hard deletion.',
    default: PRUNE_DEFAULTS.retentionDays,
  },
];

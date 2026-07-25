// Platform-operations descriptors (the orphaned keys).
//
// These three families were already live `global-kv` settings — their consuming
// services read them through `IAppSettingsService.getValueWithDefault` — but
// none of them was CATALOGED, so they were invisible to
// `GET /admin/settings/catalog` and unreachable through any write surface.
//
// Registering them changes ZERO runtime behaviour: every `default` below is
// transcribed verbatim from the consuming service's own fallback constant, so
// a read that misses the DB resolves to exactly the value it resolves to today.
// The registry lane merely makes them discoverable and writable.
//
// Sources of truth for the defaults:
//   - rate-limit.*        `rate-limit/rate-limit.constants.ts`
//   - audit-retention.*   `audit-retention/audit-retention.service.ts`
//   - agentic.trajectory.* `agent-trajectory-retention/agent-trajectory-retention.service.ts`

// Every descriptor here is `failMode: 'open-to-default'` (plan §4 B3): these are
// schedules, retention windows and enable-flags, so a control-plane miss must
// resolve to the SAME code default the consuming service already falls back to.
// Fail-closed would turn an unwritten row into a broken sweep or a lifted
// throttle — strictly worse than the status quo these descriptors transcribe.

import { SettingDescriptor } from '../registry.types';

export const PLATFORM_OPS_SETTINGS: SettingDescriptor[] = [
  // ── Rate limiting ────────────────────────────────────────────────────────
  {
    key: 'rate-limit.enabled',
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Rate limiting enabled',
    description:
      'Master switch for tiered request rate limiting. NOTE: this is a PROTECTION-ENABLE flag and ' +
      'therefore defaults ON — the opposite polarity to an enforcement kill-switch. It is deliberately ' +
      'NOT marked `killSwitch`, because the registry governance invariant requires kill-switches to ' +
      'default OFF (fail-safe rollout) and turning this OFF REMOVES a protection rather than disabling ' +
      'an enforcement path. Disabling it lifts all request throttling.',
    // Matches RATE_LIMIT_GLOBAL_ENABLED_DEFAULT.
    default: true,
  },

  // ── Audit-log retention ──────────────────────────────────────────────────
  {
    key: 'audit-retention.enabled',
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    killSwitch: true,
    label: 'Audit retention sweep enabled',
    description: 'Enables the scheduled audit-log retention purge. Fail-safe: defaults OFF.',
    default: false,
  },
  {
    key: 'audit-retention.cron',
    tier: 'global-kv',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Audit retention schedule',
    description: 'Cron expression for the audit-log retention sweep.',
    default: '0 3 * * *',
  },
  {
    key: 'audit-retention.retention-days',
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Audit retention window (days)',
    description: 'Audit-log rows older than this are purged by the sweep.',
    default: 365,
  },
  {
    key: 'audit-retention.batch-size',
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Audit retention batch size',
    description: 'Rows deleted per batch by the retention sweep.',
    default: 1000,
  },
  {
    key: 'audit-retention.max-batches-per-run',
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Audit retention max batches per run',
    description: 'Upper bound on batches processed in a single sweep, bounding its runtime.',
    default: 1000,
  },

  // ── Agent-trajectory retention ───────────────────────────────────────────
  {
    key: 'agentic.trajectory.enabled',
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    killSwitch: true,
    label: 'Agent trajectory retention enabled',
    description: 'Enables the scheduled agent-trajectory retention purge. Fail-safe: defaults OFF.',
    default: false,
  },
  {
    key: 'agentic.trajectory.cron',
    tier: 'global-kv',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Agent trajectory retention schedule',
    description: 'Cron expression for the agent-trajectory retention sweep.',
    default: '0 4 * * *',
  },
  // ── Pipeline template resync ──────────────────────────
  {
    key: 'pipeline.templateResync.enabled',
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    killSwitch: true,
    label: 'Pipeline template resync enabled',
    description:
      "Enables the nightly sweep that reconciles every tenant's ASR pipeline catalog against the SYSTEM templates: missing templates are cloned in, and locked copies that are still pristine are fast-forwarded to the template's current config. Customized (unlocked) pipelines are never touched. Fail-safe: the DEFAULT is OFF, because the sweep writes tenant data unattended — deployments turn it on with a platform value.",
    default: false,
  },
  {
    key: 'pipeline.templateResync.cron',
    tier: 'global-kv',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Pipeline template resync schedule',
    description: 'Cron expression for the nightly SYSTEM-template resync sweep.',
    default: '0 3 * * *',
  },
  // ── Agent golden-library template resync (TASK-548) ────
  {
    key: 'departmentAgent.templateResync.enabled',
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    killSwitch: true,
    label: 'Agent template resync enabled',
    description:
      "Enables the nightly sweep that reconciles every tenant's DepartmentAgent catalog against the SYSTEM agent golden library: missing golden agents are cloned in (with an APPROVED template snapshot), and locked copies that are still pristine are fast-forwarded to the golden template's current content. Customized (unlocked) agents are never touched. Fail-safe: the DEFAULT is OFF, because the sweep writes tenant data unattended — deployments turn it on with a platform value.",
    default: false,
  },
  {
    key: 'departmentAgent.templateResync.cron',
    tier: 'global-kv',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Agent template resync schedule',
    description: 'Cron expression for the nightly SYSTEM agent-library resync sweep.',
    default: '0 4 * * *',
  },
  {
    key: 'agentic.trajectory.retentionDays',
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Agent trajectory retention window (days)',
    description: 'Agent-trajectory rows older than this are purged by the sweep.',
    default: 30,
  },
];

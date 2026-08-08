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
  // ── Origin (CORS) enforcement — TASK-610 §4C, reversed by TASK-641 FR-6 ───
  //
  // The ONE switch that decides whether any of TASK-610's origin machinery
  // enforces. Unlike its neighbours above, this key was not transcribed from an
  // existing service fallback — its DEFAULT IS THE PLATFORM POSTURE. No row is
  // seeded for it — the descriptor default is the value on a fresh database,
  // and the registry write lane creates the row when an operator first sets it.
  //
  // TASK-610 shipped this defaulting OFF (permissive: every origin admitted)
  // on an explicit owner directive. TASK-641 reverses that directive — "no
  // default is off" — so the default below is now `true`: enforcing, out of
  // the box, in every environment including a fresh local `pnpm setup:dev`,
  // with no row present and no opt-in step. This is safe ONLY because TASK-641
  // also makes the SYSTEM allowed-origin rows unconditional bootstrap data
  // (`seed/11b-tenant-allowed-origins.ts`, no longer `RUN_SEED`-gated) — an
  // unseeded environment would otherwise refuse every browser origin with no
  // escape hatch (see that ticket's H-2).
  //
  // WHY IT IS NOT `killSwitch: true`. The `killSwitch` invariant
  // (`SettingsRegistry.killSwitches()`) requires a DEFAULT-OFF value (fail-safe
  // rollout: an enforcement/engine gate ships OFF so a bad rollout degrades to
  // the previous behaviour) — and would now reject this descriptor outright,
  // since it defaults `true`. That is not incidental: this is a
  // PROTECTION-ENABLE flag, not a rollout gate — turning it off REMOVES a
  // protection rather than disabling a newly-added enforcement path. Same
  // reasoning, and now also the same default polarity, as `rate-limit.enabled`
  // above (both default `true`; unlike a kill-switch, `false` is the state that
  // needs justifying, not `true`).
  {
    key: 'origin.enforcementEnabled',
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    // `failMode: 'open-to-default'` is unchanged from TASK-610, but its
    // consequence inverts with the default below (TASK-641 H-3). Previously
    // "fails open" meant an unreadable control plane fell back to permissive —
    // the comment here used to argue that was the only acceptable outcome,
    // because failing the other way would turn a settings outage into a
    // platform-wide browser outage. With `default: true`, the SAME mechanism
    // now fails INTO enforcement: a settings-read failure refuses browser
    // origins that are not in the (bootstrap-seeded) allow-list, rather than
    // admitting everything.
    //
    // This is accepted deliberately, not overlooked. Two reasons: (1) the
    // failure window is narrow — a settings backend that cannot be read while
    // the database it lives in is otherwise up is not a state this platform
    // tolerates gracefully anywhere else either (the registry itself has its
    // own fail-closed behaviour on an unreadable table; this key does not
    // invent a second, different failure mode on top of it — see the plan's
    // explicit instruction not to touch `failMode`). (2) TASK-641's whole
    // premise is that browser-origin enforcement is the platform's default
    // SECURITY STANCE, not an opt-in hardening step an operator remembers to
    // flip — so the fail-open-to-default behaviour failing into that same
    // stance is consistent, not surprising. A genuinely broken settings
    // backend is an operational incident either way; this key does not change
    // whether that incident happens, only which side of "admit" vs "refuse"
    // browser traffic lands on while it is unresolved.
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Origin (CORS) enforcement enabled',
    description:
      "Master switch for browser-origin enforcement. TRUE is the DEFAULT — for every tenant including SYSTEM and GLOBAL, in every environment, with no row present and no opt-in step (TASK-641 FR-6; reverses TASK-610 §4C's permissive-by-default posture): " +
      '`isOriginAllowed` consults the `TenantAllowedOrigin` registry, `OriginTenantBindingGuard` enforces origin↔tenant binding, and the STT WebSocket handshake checks the registry — an unregistered origin is refused. ' +
      "Setting it FALSE restores TASK-610's original behaviour live, with no redeploy: every origin is admitted for every tenant and the allow-list is not consulted. " +
      'Register the origins each tenant needs BEFORE relying on enforcement, or legitimate browser traffic gets refused (grep the `origin_registry_miss` log reason). The SYSTEM rows needed for local development ship as unconditional bootstrap seed data, not demo data, precisely so this default is safe on a fresh database. ' +
      'Authentication and tenancy remain the enforcing controls either way; CORS is advisory browser behaviour and never was an authorization boundary.',
    default: true,
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

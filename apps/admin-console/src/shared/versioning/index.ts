/**
 * `@/shared/versioning` — TASK-965 WS-3: the console-wide kit for VERSIONED items.
 *
 * Seven screens manage something that has versions — agents and workflow definitions
 * (row-per-version lineages), prompt templates, context schemas, document templates and DNA
 * writing styles (head + immutable version rows) — and before this kit each of them answered
 * "which one is live?" in its own words, its own colours and its own list markup. The kit is the
 * one vocabulary (`lifecycle-status.ts`), the one badge set, the one version list, the one set of
 * consequence-naming confirmations and the one comparison.
 *
 * Nothing here may import from `@/features/**`: a component that knows about an agent belongs in
 * the agents feature, not in the kit. Features map their own types onto `VersionRow` and supply
 * their own verbs.
 *
 * See `README.md` in this folder for the vocabulary table and each component's intent.
 */
export { EXPOSABLE_PALETTE_KEY, IntegrationPanel } from './integration-panel';
export type { AgentIntegrationProps, IntegrationAgentTask, IntegrationPanelProps, WorkflowIntegrationProps } from './integration-panel';

export { LIFECYCLE_STATUS, LIFECYCLE_STATUS_ORDER, isLifecycleStatus, lifecycleStatusLabel } from './lifecycle-status';
export type { LifecycleBadgeVariant, LifecycleStatus, LifecycleStatusMeta } from './lifecycle-status';

export { LifecycleStatusBadge } from './lifecycle-status-badge';
export type { LifecycleStatusBadgeProps } from './lifecycle-status-badge';

export { ActiveBadge, AssignmentBadges, OriginBadge, SYSTEM_TENANT_ID } from './state-badges';
export type { ActiveBadgeProps, AssignmentBadgesProps, AssignmentSummary, OriginBadgeProps } from './state-badges';

export { VersionHistoryPanel } from './version-history-panel';
export type { VersionHistoryPanelProps, VersionRow, VersionRowAction, VersionSkew } from './version-history-panel';

export { ActivateVersionDialog, DeprecateVersionDialog, DiscardDraftDialog } from './lifecycle-dialogs';
export type { ActivateVersionDialogProps, DeprecateVersionDialogProps, DiscardDraftDialogProps } from './lifecycle-dialogs';

export { VersionCompareDialog } from './version-compare-dialog';
export type { VersionCompareDialogProps, VersionCompareMode, VersionComparePayload } from './version-compare-dialog';

export { diffLines, toComparableJson } from './line-diff';
export type { DiffLine, DiffLineKind, LineDiff } from './line-diff';

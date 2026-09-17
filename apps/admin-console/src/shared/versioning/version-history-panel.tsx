'use client';

/**
 * TASK-965 §3.3 — `VersionHistoryPanel`, the ONE version list for both versioning models.
 *
 * Before it: the agents Versions tab showed `vN · name`, status and `updatedAt` and nothing else
 * (AG-18); the studio had no lineage view at all although `GET :id/versions` and its hook already
 * existed unused (WF-18); and every head+version screen hand-rolled its own `<ul>` (INV-5). Four
 * near-identical lists, four different answers to "which one is live".
 *
 * The panel knows nothing about agents, workflow definitions, schemas or templates. It takes
 * `VersionRow`s — a KIT type — and a caller-supplied action list, so the feature owns the verbs
 * (Activate, Deprecate, New draft from this, Compare, Discard, Export) and their permissions,
 * while the kit owns the ordering, the markers, the keyboard behaviour and the empty/error/loading
 * states. A feature type must never appear in this file.
 *
 * Accessibility contract, since all three are easy to lose in a rewrite:
 *
 * - the list is a real `<ul>`/`<li>`, so a screen reader announces "3 items";
 * - the detail disclosure is a `<button>` carrying `aria-expanded` and naming its version, never
 *   a clickable row (a row that is a button cannot also contain the actions menu);
 * - a disabled action keeps a VISIBLE reason beside it (rule 11 §5) rather than a silent
 *   greyed-out item — Radix keeps disabled items focusable so the reason is reachable.
 */
import { useId, useState, type ComponentType, type ReactNode } from 'react';
import { IconChevronRight, IconDotsVertical, IconHistory } from '@tabler/icons-react';
import {
  Badge,
  Button,
  Card,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Skeleton,
  cn,
} from '@arcaai/ui';
import { formatDateTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { ActiveBadge } from './state-badges';
import { LifecycleStatusBadge } from './lifecycle-status-badge';
import type { LifecycleStatus } from './lifecycle-status';

/** How an older version compares with the one being served — model B's server-computed skew. */
export type VersionSkew = 'IDENTICAL' | 'ADDITIVE' | 'BREAKING';

/**
 * One row of a lineage, in the kit's own vocabulary. Every field but `id`, `versionNumber` and
 * `status` is optional: a model-B version has no `validatedAt`, a draft has no `publishedAt`, and
 * a workflow definition has no author at all until OD-965-5 lands `createdBy`/`updatedBy`.
 */
export interface VersionRow {
  id: string;
  versionNumber: number;
  status: LifecycleStatus | (string & {});
  /** A per-version name, where the entity has one (agents name each version). */
  label?: string | null;
  /** Model A: the version this lineage serves. */
  isActive?: boolean;
  /** Model B: the version the head is pinned to. */
  isPinned?: boolean;
  createdAt?: string | null;
  validatedAt?: string | null;
  publishedAt?: string | null;
  deprecatedAt?: string | null;
  updatedAt?: string | null;
  /** Who moved it here — publisher, approver or last editor, whichever the entity records. */
  by?: string | null;
  /** Compiled-config checksum, where the entity computes one. */
  checksum?: string | null;
  /** Drift against the served version (model B). */
  skew?: VersionSkew | null;
  /** The change reason an admin typed, where the entity captures one. */
  note?: string | null;
  /** Anything only this feature can render — model, fallbacks, node count. Gated behind a disclosure. */
  detail?: ReactNode;
}

export interface VersionRowAction {
  /** Stable key for React; also the test handle. */
  key: string;
  label: string;
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  destructive?: boolean;
  disabled?: boolean;
  /** Why it is disabled. Rendered beside the item — a disabled control owes a visible reason. */
  disabledReason?: string;
  onSelect: (row: VersionRow) => void;
}

export interface VersionHistoryPanelProps {
  versions: VersionRow[];
  isPending?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** The verbs for one row. Called per row so a caller can gate on that row's own state. */
  actions?: (row: VersionRow) => VersionRowAction[];
  /** When present each row offers an explicit "Open vN" button (never a clickable row). */
  onOpenVersion?: (row: VersionRow) => void;
  /** A sentence above the list explaining what "served" means for THIS entity. */
  caption?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  'aria-label'?: string;
  className?: string;
}

const SKEW_BADGE: Record<VersionSkew, { label: string; className: string; title: string }> = {
  BREAKING: {
    label: 'Breaking drift',
    className: 'border-destructive/40 text-destructive',
    title: 'A client still on this version breaks against what is served now.',
  },
  ADDITIVE: {
    label: 'Additive drift',
    className: 'border-success/40 text-success',
    title: 'A client still on this version keeps working against what is served now.',
  },
  IDENTICAL: { label: 'Identical to served', className: '', title: 'Byte-identical to the version being served.' },
};

/** The date that MATTERS for a row is the one its status put there. */
function rowTimestamp(row: VersionRow): { label: string; value: string | null | undefined } {
  if (row.status === 'DEPRECATED' && row.deprecatedAt) return { label: 'Deprecated', value: row.deprecatedAt };
  if (row.publishedAt) return { label: 'Published', value: row.publishedAt };
  if (row.validatedAt) return { label: 'Validated', value: row.validatedAt };
  if (row.updatedAt) return { label: 'Updated', value: row.updatedAt };
  return { label: 'Created', value: row.createdAt };
}

function VersionActionsMenu({ row, actions }: { row: VersionRow; actions: VersionRowAction[] }) {
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={`Actions for v${row.versionNumber}`}>
          <IconDotsVertical aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.key}
            variant={action.destructive ? 'destructive' : 'default'}
            disabled={action.disabled}
            onSelect={() => action.onSelect(row)}
            className="flex-col items-start gap-0.5"
          >
            <span className="flex items-center gap-2">
              {action.icon ? <action.icon aria-hidden className="size-4" /> : null}
              {action.label}
            </span>
            {action.disabled && action.disabledReason ? <span className="text-muted-foreground text-xs">{action.disabledReason}</span> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function VersionHistoryRow({
  row,
  actions,
  onOpenVersion,
}: {
  row: VersionRow;
  actions?: (row: VersionRow) => VersionRowAction[];
  onOpenVersion?: (row: VersionRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const timestamp = rowTimestamp(row);
  const rowActions = actions?.(row) ?? [];

  return (
    <li>
      <Card className="gap-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {row.detail ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              aria-expanded={expanded}
              aria-controls={detailId}
              aria-label={`${expanded ? 'Hide' : 'Show'} details for v${row.versionNumber}`}
              onClick={() => setExpanded((open) => !open)}
            >
              <IconChevronRight aria-hidden className={cn('size-4 transition-transform', expanded && 'rotate-90')} />
            </Button>
          ) : null}
          <span data-testid="version-number" className="font-mono text-sm font-medium">
            v{row.versionNumber}
          </span>
          {row.label ? <span className="min-w-0 truncate text-sm">{row.label}</span> : null}
          <LifecycleStatusBadge status={row.status} />
          <ActiveBadge active={row.isActive} pinnedVersionNumber={row.isPinned ? row.versionNumber : undefined} />
          {row.skew && !row.isActive && !row.isPinned ? (
            <Badge variant="outline" className={SKEW_BADGE[row.skew].className} title={SKEW_BADGE[row.skew].title}>
              {SKEW_BADGE[row.skew].label}
            </Badge>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {onOpenVersion ? (
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenVersion(row)}>
                Open v{row.versionNumber}
              </Button>
            ) : null}
            <VersionActionsMenu row={row} actions={rowActions} />
          </span>
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span>
            {timestamp.label} {formatDateTime(timestamp.value)}
          </span>
          {row.by ? <span className="truncate font-mono">by {row.by}</span> : null}
          {row.checksum ? (
            <span className="truncate font-mono" title="Checksum of the compiled configuration frozen into this version.">
              {row.checksum}
            </span>
          ) : null}
        </div>
        {row.note ? <p className="text-muted-foreground truncate text-xs">{row.note}</p> : null}
        {row.detail ? (
          <div id={detailId} hidden={!expanded} className="border-t pt-2 text-sm">
            {row.detail}
          </div>
        ) : null}
      </Card>
    </li>
  );
}

export function VersionHistoryPanel({
  versions,
  isPending = false,
  error,
  onRetry,
  actions,
  onOpenVersion,
  caption,
  emptyTitle = 'No versions yet',
  emptyDescription = 'Versions appear here as soon as the first one is created.',
  'aria-label': ariaLabel = 'Version history',
  className,
}: VersionHistoryPanelProps) {
  if (isPending) {
    // Rule 10: a skeleton shaped like the rows it replaces — never a spinner or "Loading…".
    return (
      <div className={cn('flex flex-col gap-2', className)} aria-hidden>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (error) return <ErrorState error={error} onRetry={onRetry} />;

  if (versions.length === 0) return <EmptyState icon={IconHistory} title={emptyTitle} description={emptyDescription} />;

  const sorted = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {caption ? <p className="text-muted-foreground text-sm">{caption}</p> : null}
      <ul aria-label={ariaLabel} className="flex flex-col gap-2">
        {sorted.map((row) => (
          <VersionHistoryRow key={row.id} row={row} actions={actions} onOpenVersion={onOpenVersion} />
        ))}
      </ul>
    </div>
  );
}

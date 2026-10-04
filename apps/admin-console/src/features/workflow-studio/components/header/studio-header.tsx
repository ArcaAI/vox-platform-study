'use client';

/**
 * `StudioHeader` — the Workflow Studio's identity and lifecycle strip (TASK-1036 §3.6).
 *
 * The breadcrumb stays in the shell topbar; this is the page header (rule 11, Screen Template).
 * Left: the name (the one `h1`, renamed in place), then slug + copy, the lifecycle badge, the
 * version number and the version count that opens the history sheet. Right: the caller's `actions`
 * (switcher, new, details, …), the Pins rail, Settings, Validate and Publish.
 *
 * PUBLISH IS NOT THIS COMPONENT'S DECISION. `publishDisabledReason` comes from the caller, which
 * derives it from the SERVER-stored validation report (`publishBlockedReason`) — never a client
 * guess — and the reason is rendered next to the button so a disabled control always explains
 * itself (rule 11 §5). Validate and Publish are hidden on a read-only version: there is nothing
 * left to validate or publish.
 */
import type { ReactNode } from 'react';
import { IconHistory, IconLock, IconSettings } from '@tabler/icons-react';
import { Badge, Button } from '@arcaai/ui';
import { LifecycleStatusBadge } from '@/shared/versioning';
import type { AgentPin } from './agent-pins';
import { InlineName } from './inline-name';
import { PinsRail } from './pins-rail';
import { SlugCopy } from './slug-copy';

export interface StudioHeaderProps {
  name: string;
  /** Stages a rename (the studio's one Save writes it). */
  onNameChange: (next: string) => void;
  slug: string;
  status: string;
  versionNumber: number;
  /** Versions in this lineage; `null` while it loads. */
  versionCount: number | null;
  onOpenHistory: () => void;
  pins: readonly AgentPin[];
  onOpenSettings: () => void;
  onValidate: () => void;
  validating?: boolean;
  onPublish: () => void;
  publishing?: boolean;
  /** Why Publish is unavailable, or `null` when it is. */
  publishDisabledReason: string | null;
  readOnly?: boolean;
  needsReview?: boolean;
  /** Left-to-right extra controls ahead of the lifecycle ones (switcher, New, Edit details, ⋯). */
  actions?: ReactNode;
}

export function StudioHeader({
  name,
  onNameChange,
  slug,
  status,
  versionNumber,
  versionCount,
  onOpenHistory,
  pins,
  onOpenSettings,
  onValidate,
  validating,
  onPublish,
  publishing,
  publishDisabledReason,
  readOnly,
  needsReview,
  actions,
}: StudioHeaderProps) {
  const historyLabel = versionCount === null ? 'Version history' : `${versionCount} ${versionCount === 1 ? 'version' : 'versions'}`;
  return (
    <div className="flex flex-wrap items-start justify-between gap-4" data-slot="studio-header">
      <div className="flex min-w-0 flex-col gap-1">
        <InlineName name={name} onChange={onNameChange} readOnly={readOnly} />
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <SlugCopy slug={slug} />
          <span className="font-mono text-xs">{`v${versionNumber}`}</span>
          <LifecycleStatusBadge status={status} />
          {readOnly ? (
            <Badge variant="outline" className="gap-1">
              <IconLock aria-hidden="true" className="size-3" />
              Locked
            </Badge>
          ) : null}
          {needsReview ? (
            <Badge variant="destructive" title="Published against an older node registry — re-publish to clear.">
              Needs review
            </Badge>
          ) : null}
          <Button type="button" variant="ghost" size="sm" aria-label={`Version history, ${historyLabel}`} onClick={onOpenHistory}>
            <IconHistory aria-hidden="true" />
            {historyLabel}
          </Button>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        {actions}
        <PinsRail pins={pins} />
        <Button type="button" variant="outline" size="sm" onClick={onOpenSettings}>
          <IconSettings aria-hidden="true" />
          Settings
        </Button>
        {!readOnly ? (
          <>
            <Button type="button" variant="outline" size="sm" onClick={onValidate} disabled={validating}>
              {validating ? 'Validating…' : 'Validate'}
            </Button>
            <span title={publishDisabledReason ?? undefined}>
              <Button type="button" size="sm" onClick={onPublish} disabled={publishDisabledReason !== null || publishing}>
                {publishing ? 'Publishing…' : 'Publish'}
              </Button>
            </span>
            {publishDisabledReason ? <span className="text-muted-foreground max-w-64 text-xs">{publishDisabledReason}</span> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

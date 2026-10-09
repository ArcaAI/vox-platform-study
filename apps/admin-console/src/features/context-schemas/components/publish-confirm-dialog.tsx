'use client';

/**
 * The publish confirmation — a `ConfirmDialog` whose words come from
 * `publishCopy`, so the sentence leads with the EFFECT of the change rather
 * than asking "are you sure?".
 *
 * It is one dialog across all three outcomes on purpose. An admin clicks
 * Publish once; if the server refuses because a pinned consumer would stop
 * accepting consultations (`SCHEMA_IMPACT_UNACKNOWLEDGED`) or because the change
 * breaks existing clients (`breakingChanges`), the SAME dialog re-states itself
 * with what it now knows and a checkbox naming the consequence. Closing and
 * re-opening a second, differently-worded dialog would read as a new decision;
 * it is the same one, better informed.
 *
 * Change reason lives here because it describes the act being confirmed, not
 * the definition being edited.
 */

import { useActionConfirmation } from '@/shared/action-confirmations/use-action-confirmation';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import type { ContextSchemaUsagesResponse } from '../api/types';
import { publishCopy } from '../lib/publish-copy';

export interface PublishConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The version this publish would create. */
  nextVersion: number;
  /** The version currently pinned — what existing apps are built on. */
  currentVersion: number | null;
  /** New kind keys this draft introduces, diffed against the pinned version. */
  additions: string[];
  /** Who depends on this schema today; `null` when that read failed. */
  impact: ContextSchemaUsagesResponse | null;
  /** Set once the server has refused as breaking; drives the destructive variant. */
  breakingChanges: string[] | null;
  /** Receives the acknowledgement flags the current variant implies and the change reason typed into the policy field. */
  onConfirm: (acknowledgements: { allowBreakingChange?: boolean; acknowledgeImpact?: boolean; changeReason?: string }) => void;
  isPending: boolean;
}

export function PublishConfirmDialog({
  open,
  onOpenChange,
  nextVersion,
  currentVersion,
  additions,
  impact,
  breakingChanges,
  onConfirm,
  isPending,
}: PublishConfirmDialogProps) {
  // TASK-1057 — the platform decides whether the impact checkbox is demanded (the server still gets acknowledgeImpact:true).
  const impactPolicy = useActionConfirmation('contextSchema.publishImpact');
  const copy = publishCopy({ nextVersion, currentVersion, additions, breakingChanges, impact });

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={copy.title}
      description={copy.description}
      body={
        <div className="flex flex-col gap-3">
          {copy.breakingChanges && copy.breakingChanges.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {copy.breakingChanges.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          ) : null}
          {copy.variant === 'some-refuse' && copy.refusing.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {copy.refusing.map((consumer) => (
                <li key={consumer.key}>
                  {consumer.name} {'—'} {consumer.boundLabel}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      }
      acknowledgement={copy.variant === 'some-refuse' && !impactPolicy.isRequired() ? null : copy.acknowledgement}
      reasonActionId="contextSchema.publish"
      confirmLabel={copy.confirmLabel}
      destructive={copy.destructive}
      isPending={isPending}
      onConfirm={({ reason }) =>
        onConfirm({
          ...(reason ? { changeReason: reason } : {}),
          allowBreakingChange: copy.variant === 'breaking' ? true : undefined,
          acknowledgeImpact: copy.variant === 'some-refuse' ? true : undefined,
        })
      }
    />
  );
}

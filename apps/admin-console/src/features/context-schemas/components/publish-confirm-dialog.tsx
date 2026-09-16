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

import { useId } from 'react';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
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
  changeReason: string;
  onChangeReasonChange: (next: string) => void;
  /** Receives the acknowledgement flags the current variant implies. */
  onConfirm: (acknowledgements: { allowBreakingChange?: boolean; acknowledgeImpact?: boolean }) => void;
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
  changeReason,
  onChangeReasonChange,
  onConfirm,
  isPending,
}: PublishConfirmDialogProps) {
  const uid = useId();
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
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-change-reason`}>Change reason (optional)</Label>
            <Input
              id={`${uid}-change-reason`}
              value={changeReason}
              onChange={(event) => onChangeReasonChange(event.target.value)}
              placeholder="Add referral_letter kind for cardiology intake"
              autoComplete="off"
            />
          </div>
        </div>
      }
      acknowledgement={copy.acknowledgement}
      confirmLabel={copy.confirmLabel}
      destructive={copy.destructive}
      isPending={isPending}
      onConfirm={() =>
        onConfirm({
          allowBreakingChange: copy.variant === 'breaking' ? true : undefined,
          acknowledgeImpact: copy.variant === 'some-refuse' ? true : undefined,
        })
      }
    />
  );
}

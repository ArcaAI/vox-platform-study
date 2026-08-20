'use client';

/**
 * Assignment matrix — the cell editor (TASK-733 half (a) Task 6). One tier
 * (`scope` + `scopeId` + `paletteKey`) per open; the `Select` carries an
 * `INHERIT_SENTINEL` option (Radix reserves the empty string) that maps to
 * "no explicit assignment here" — choosing it and saving DELETEs an existing
 * explicit row, and leaving it selected with nothing pre-existing disables Save
 * (there is nothing to write). Every write is OCC-guarded: create has no
 * If-Match (nothing to CAS against yet — `client.ts` doc comment), update and
 * delete both require the row's current `version` echoed back as If-Match.
 */
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
} from '@arcaai/ui';
import { IconInfoCircle } from '@tabler/icons-react';
import { GatewayError } from '@/shared/api';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import type { AssignmentCellSource } from '../../lib/assignment-cascade';
import { etagFromVersion, useCreateWorkflowAssignment, useDeleteWorkflowAssignment, useUpdateWorkflowAssignment } from '../../api';
import type { WorkflowAssignment, WorkflowAssignmentScope } from '../../api/types';

export const INHERIT_SENTINEL = '__inherit__';

function isOccError(error: unknown): boolean {
  return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

const SOURCE_LABEL: Record<AssignmentCellSource, string> = {
  explicit: 'Explicit assignment at this tier',
  tenant: 'Inherited from the tenant default',
  'platform-default': 'Inherited — platform default',
};

export interface AssignmentDefinitionOption {
  slug: string;
  name: string;
}

export interface AssignmentEditDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: WorkflowAssignmentScope;
  scopeId: string | null;
  /** Department name (or "Tenant default") for the header/meta. */
  scopeLabel: string;
  paletteKey: string;
  paletteLabel: string;
  /** The explicit row AT THIS EXACT TIER, or `null` when this tier inherits. */
  existing: WorkflowAssignment | null;
  /** What this cell currently resolves to, for the "currently resolves to" meta line. */
  resolvedSlug: string | null;
  resolvedSource: AssignmentCellSource;
  /** PUBLISHED + active definitions on this palette, eligible for assignment. */
  definitionOptions: AssignmentDefinitionOption[];
  /** Re-reads the palette's assignment rows — called after a reload from a 412/428. */
  onReloadLatest: () => void;
}

export function AssignmentEditDrawer({
  open,
  onOpenChange,
  scope,
  scopeId,
  scopeLabel,
  paletteKey,
  paletteLabel,
  existing,
  resolvedSlug,
  resolvedSource,
  definitionOptions,
  onReloadLatest,
}: AssignmentEditDrawerProps) {
  const uid = useId();
  const create = useCreateWorkflowAssignment();
  const update = useUpdateWorkflowAssignment();
  const remove = useDeleteWorkflowAssignment();

  const initialSelected = existing?.workflowDefinitionSlug ?? INHERIT_SENTINEL;
  const [selected, setSelected] = useState(initialSelected);
  const [reason, setReason] = useState('');

  const pending = create.isPending || update.isPending || remove.isPending;
  const error = create.error ?? update.error ?? remove.error;
  const dirty = selected !== initialSelected;
  const canSave = dirty && !(selected === INHERIT_SENTINEL && !existing);

  const inheritDescription = scope === 'TENANT' ? 'platform default' : 'the tenant default (or the platform default)';

  function handleReload() {
    create.reset();
    update.reset();
    remove.reset();
    onReloadLatest();
    onOpenChange(false);
  }

  function handleSave() {
    if (!canSave) return;

    if (selected === INHERIT_SENTINEL) {
      if (!existing) return;
      remove.mutate(
        { id: existing.id, etag: etagFromVersion(existing.version), reason: reason.trim() || undefined },
        {
          onSuccess: () => {
            toast.success('Assignment cleared — this tier now inherits');
            onOpenChange(false);
          },
          onError: (err) => {
            if (!isOccError(err)) toast.error(err instanceof GatewayError ? err.message : 'Could not clear the assignment.');
          },
        },
      );
      return;
    }

    if (existing) {
      update.mutate(
        {
          body: { scope, scopeId, paletteKey, workflowDefinitionSlug: selected, reason: reason.trim() || undefined, expectedVersion: existing.version },
          etag: etagFromVersion(existing.version),
        },
        {
          onSuccess: () => {
            toast.success('Assignment updated');
            onOpenChange(false);
          },
          onError: (err) => {
            if (!isOccError(err)) toast.error(err instanceof GatewayError ? err.message : 'Could not update the assignment.');
          },
        },
      );
      return;
    }

    create.mutate(
      { scope, scopeId, paletteKey, workflowDefinitionSlug: selected, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          toast.success('Assignment created');
          onOpenChange(false);
        },
        onError: (err) => toast.error(err instanceof GatewayError ? err.message : 'Could not create the assignment.'),
      },
    );
  }

  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={`${scopeLabel} · ${paletteLabel}`}
      badges={<Badge variant={resolvedSource === 'explicit' ? 'default' : 'outline'}>{SOURCE_LABEL[resolvedSource]}</Badge>}
      meta={
        <span>
          Currently resolves to:{' '}
          <span className="font-mono">{resolvedSlug ?? 'no override — platform default'}</span>
        </span>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <p aria-hidden className="text-muted-foreground font-mono text-xs">
            {existing ? `v${existing.version} · If-Match on save` : 'first write for this tier'}
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={!canSave || pending} onClick={handleSave}>
              {pending ? <Spinner /> : null}
              Save
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <OccConflictAlert error={error} onReload={handleReload} />
        {definitionOptions.length === 0 ? (
          <Alert>
            <IconInfoCircle aria-hidden />
            <AlertTitle>No published definitions on this palette</AlertTitle>
            <AlertDescription>
              Publish and activate a &ldquo;{paletteLabel}&rdquo; workflow definition in Workflow Studio before assigning it here.
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-definition`}>Workflow definition</Label>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger id={`${uid}-definition`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT_SENTINEL}>Inherit &mdash; {inheritDescription}</SelectItem>
              {definitionOptions.map((option) => (
                <SelectItem key={option.slug} value={option.slug}>
                  {option.name} ({option.slug})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-reason`}>Reason</Label>
          <Textarea
            id={`${uid}-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            className="resize-none"
            placeholder="Why this assignment changed — recorded on the audit trail."
          />
        </div>
      </div>
    </DetailDrawer>
  );
}

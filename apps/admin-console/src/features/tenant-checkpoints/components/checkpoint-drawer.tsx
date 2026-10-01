'use client';

import { useState } from 'react';
import { IconDownload, IconRestore, IconTrash, IconX } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatBytes, formatDateTime } from '@/shared/format';
import { isRestoreLockError, useCancelCheckpoint, useDeleteCheckpoint, useDownloadUrl } from '../api/hooks';
import { isCheckpointActive, type TenantCheckpoint } from '../api/types';
import { CheckpointStatusBadge } from './status-badges';

const EMPTY = '—';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function CheckpointDrawer({
  checkpoint,
  tenantId,
  onClose,
  onRestore,
  onLocked,
}: {
  checkpoint: TenantCheckpoint | null;
  tenantId: string;
  onClose: () => void;
  onRestore: (checkpoint: TenantCheckpoint) => void;
  onLocked?: () => void;
}) {
  const download = useDownloadUrl(tenantId);
  const cancel = useCancelCheckpoint(tenantId);
  const remove = useDeleteCheckpoint(tenantId);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function fail(error: Error) {
    if (isRestoreLockError(error)) onLocked?.();
    toast.error(error.message);
  }

  function handleDownload(target: TenantCheckpoint) {
    download.mutate(target.id, {
      onSuccess: ({ url }) => window.location.assign(url),
      onError: fail,
    });
  }

  function handleCancel(target: TenantCheckpoint) {
    cancel.mutate(target.id, { onSuccess: () => toast.success('Checkpoint cancelled'), onError: fail });
  }

  function handleDelete(target: TenantCheckpoint) {
    remove.mutate(target.id, {
      onSuccess: () => {
        toast.success('Checkpoint deleted');
        setConfirmDelete(false);
        onClose();
      },
      onError: fail,
    });
  }

  const active = checkpoint ? isCheckpointActive(checkpoint.status) : false;
  const ready = checkpoint?.status === 'READY';

  return (
    <>
      <DetailDrawer
        open={checkpoint !== null}
        onOpenChange={(open) => !open && onClose()}
        title={checkpoint?.label ?? 'Checkpoint'}
        badges={checkpoint ? <CheckpointStatusBadge checkpoint={checkpoint} /> : null}
        meta={checkpoint ? <span className="font-mono">{checkpoint.id}</span> : null}
        footer={
          checkpoint ? (
            <>
              {ready ? (
                <>
                  <Button variant="outline" onClick={() => handleDownload(checkpoint)} disabled={download.isPending}>
                    <IconDownload aria-hidden />
                    Download
                  </Button>
                  <Button onClick={() => onRestore(checkpoint)}>
                    <IconRestore aria-hidden />
                    Restore&hellip;
                  </Button>
                </>
              ) : null}
              {active ? (
                <Button variant="outline" onClick={() => handleCancel(checkpoint)} disabled={cancel.isPending}>
                  <IconX aria-hidden />
                  Cancel
                </Button>
              ) : null}
              <Button variant="destructive" onClick={() => setConfirmDelete(true)} disabled={active}>
                <IconTrash aria-hidden />
                Delete
              </Button>
            </>
          ) : null
        }
      >
        {checkpoint ? (
          <div className="flex flex-col gap-4">
            <dl className="grid gap-4 sm:grid-cols-2">
              <Field label="Kind">
                <Badge variant={checkpoint.kind === 'SAFETY' ? 'secondary' : 'outline'}>{checkpoint.kind === 'SAFETY' ? 'Safety' : 'Manual'}</Badge>
              </Field>
              <Field label="Origin">{checkpoint.origin === 'UPLOADED' ? 'Uploaded' : 'Created here'}</Field>
              <Field label="Size">{formatBytes(checkpoint.sizeBytes)}</Field>
              <Field label="Includes media">{checkpoint.includesMedia ? 'Yes' : 'No'}</Field>
              <Field label="Passphrase protected">{checkpoint.passphraseProtected ? 'Yes' : 'No'}</Field>
              <Field label="Created">{formatDateTime(checkpoint.createdAt)}</Field>
              <Field label="Expires">{checkpoint.expiresAt ? formatDateTime(checkpoint.expiresAt) : EMPTY}</Field>
            </dl>
            {checkpoint.status === 'FAILED' ? (
              <div role="alert" className="border-destructive/40 flex flex-col gap-1 rounded-md border p-3">
                <p className="text-destructive text-sm font-medium">{checkpoint.failureReason ?? 'Checkpoint failed'}</p>
                {checkpoint.failureDetail ? <p className="text-muted-foreground font-mono text-xs break-words">{checkpoint.failureDetail}</p> : null}
              </div>
            ) : null}
            {checkpoint.passphraseProtected ? (
              <p className="text-muted-foreground text-xs">Opening this archive outside HOPE needs its passphrase; HOPE cannot recover it.</p>
            ) : null}
          </div>
        ) : null}
      </DetailDrawer>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete checkpoint"
        description={
          <>
            Permanently deletes <span className="font-medium">{checkpoint?.label}</span> and its stored archive. This cannot be undone.
          </>
        }
        confirmLabel="Delete checkpoint"
        destructive
        isPending={remove.isPending}
        onConfirm={() => (checkpoint ? handleDelete(checkpoint) : undefined)}
      />
    </>
  );
}

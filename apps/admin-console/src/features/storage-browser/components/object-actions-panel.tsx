'use client';

import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { IconDownload, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { CopyButton } from '@/shared/copy-button';
import { formatBytes } from '@/shared/format';
import { useDeleteFile, usePresignedDownload, useUploadFile } from '../api/hooks';
import type { StorageObject } from '../api/types';
import { guessContentType, objectBasename } from './file-meta';

function mutationMessage(error: unknown, fallback: string): string {
  return error instanceof GatewayError ? error.message : fallback;
}

/** Detail row in the selected-object summary. */
function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-muted-foreground w-24 shrink-0">{label}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}

/**
 * Presigned-URL actions for one object — key/size/content-type meta plus
 * Download (presigned GET) and a type-to-confirm Delete. Hosted inside the
 * console-wide `DetailDrawer` (frame 31 redesign) once a file row is selected.
 */
export function SelectedObjectActions({ bucketName, object, onDeleted }: { bucketName: string; object: StorageObject; onDeleted: () => void }) {
  const presign = usePresignedDownload();
  const deleteFile = useDeleteFile();
  const [confirming, setConfirming] = useState(false);

  const name = objectBasename(object.key);
  const contentType = guessContentType(name);

  function handleDownload() {
    presign.mutate(
      { bucketName, key: object.key },
      {
        onSuccess: ({ url }) => {
          // Presigned GET (1 h expiry): the browser fetches the bytes
          // straight from the store, not through the gateway.
          window.open(url, '_blank', 'noopener,noreferrer');
        },
        onError: (error) => toast.error(mutationMessage(error, 'Could not presign the download.')),
      },
    );
  }

  function handleDeleteConfirmed() {
    deleteFile.mutate(
      { bucketName, key: object.key },
      {
        onSuccess: () => {
          toast.success('Object deleted');
          setConfirming(false);
          onDeleted();
        },
        onError: (error) => {
          toast.error(mutationMessage(error, 'Could not delete the object.'));
          setConfirming(false);
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <MetaRow label="Selected">
          <span className="flex items-center gap-1 font-mono text-xs">
            <span className="min-w-0 truncate">{object.key}</span>
            <CopyButton value={object.key} label={`Copy object key ${object.key}`} />
          </span>
        </MetaRow>
        <MetaRow label="Size">
          <span className="tabular-nums">{formatBytes(object.size)}</span>
        </MetaRow>
        <MetaRow label="Content type">
          {contentType ? <span className="font-mono text-xs">{contentType}</span> : <span className="text-muted-foreground">unknown</span>}
        </MetaRow>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleDownload} disabled={presign.isPending}>
          {presign.isPending ? <Spinner /> : <IconDownload aria-hidden />}
          Download
        </Button>
        <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>
          <IconTrash aria-hidden />
          Delete
        </Button>
      </div>
      <p aria-hidden className="text-muted-foreground font-mono text-xs">
        GET /storage/buckets/:name/files/:key {'\u2192'} presigned GET {'\u00b7'} 60 min
      </p>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete object?"
        description={`This permanently deletes ${object.key} from ${bucketName}. This cannot be undone.`}
        confirmLabel="Delete object"
        destructive
        typeToConfirm={name}
        onConfirm={handleDeleteConfirmed}
        isPending={deleteFile.isPending}
      />
    </div>
  );
}

/** Stable DOM id so page upload actions can open this input. */
export const UPLOAD_INPUT_ID = 'storage-browser-upload-input';

/**
 * Hidden file picker for the page-level upload actions. Selecting a file starts
 * the multipart upload immediately and resets the input so the same file can be
 * selected again after a failure.
 */
export function UploadZone({ bucketName }: { bucketName: string }) {
  const upload = useUploadFile();
  const inputId = UPLOAD_INPUT_ID;
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    upload.mutate(
      { bucketName, file },
      {
        onSuccess: (result) => {
          toast.success(`Uploaded ${result.key} (${formatBytes(result.size)})`);
        },
        onError: (error) => toast.error(mutationMessage(error, 'Could not upload the file.')),
        onSettled: () => {
          if (inputRef.current) inputRef.current.value = '';
        },
      },
    );
  }

  return (
    <>
      <Label htmlFor={inputId} className="sr-only">
        Upload files to {bucketName}
      </Label>
      <Input ref={inputRef} id={inputId} type="file" className="hidden" onChange={handleFileChange} aria-describedby={`${inputId}-hint`} />
      <span id={`${inputId}-hint`} className="sr-only">
        Multipart POST, max 100 MB. The key defaults to the file name at the bucket root.
      </span>
    </>
  );
}

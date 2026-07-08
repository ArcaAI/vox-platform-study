'use client';

import { useRef, useState, type ReactNode } from 'react';
import { IconDownload, IconFile, IconTrash, IconUpload, IconX } from '@tabler/icons-react';
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

/** Stable DOM id so the header "Upload files" action can move focus here. */
export const UPLOAD_INPUT_ID = 'storage-browser-upload-input';

/**
 * Frame 31 upload zone (redesign): a compact, permanently-visible toolbar
 * control — visible label, native file input, chosen file name/size with a
 * remove control (rule 11 §9), multipart POST on submit. Ref-based reset
 * because file inputs are uncontrolled.
 */
export function UploadZone({ bucketName }: { bucketName: string }) {
    const upload = useUploadFile();
    const inputId = UPLOAD_INPUT_ID;
    const inputRef = useRef<HTMLInputElement>(null);
    const [file, setFile] = useState<File | null>(null);

    function clearSelection() {
        setFile(null);
        if (inputRef.current) inputRef.current.value = '';
    }

    function handleUpload() {
        if (!file) return;
        upload.mutate(
            { bucketName, file },
            {
                onSuccess: (result) => {
                    toast.success(`Uploaded ${result.key} (${formatBytes(result.size)})`);
                    clearSelection();
                },
                onError: (error) => toast.error(mutationMessage(error, 'Could not upload the file.')),
            },
        );
    }

    return (
        <div className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor={inputId} className="text-muted-foreground text-xs font-normal">
                    Upload to {bucketName}
                </Label>
                <Input
                    ref={inputRef}
                    id={inputId}
                    type="file"
                    className="h-9 w-56 max-w-full"
                    onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                    aria-describedby={`${inputId}-hint`}
                />
                <span id={`${inputId}-hint`} className="sr-only">
                    Multipart POST, max 100 MB. The key defaults to the file name at the bucket root.
                </span>
            </div>
            {file ? (
                <div className="bg-muted/50 flex h-9 items-center gap-2 rounded-md border px-2 text-sm">
                    <IconFile aria-hidden className="text-muted-foreground size-4 shrink-0" />
                    <span className="min-w-0 max-w-40 flex-1 truncate font-mono text-xs">{file.name}</span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatBytes(file.size)}</span>
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove selected file ${file.name}`} onClick={clearSelection}>
                        <IconX aria-hidden />
                    </Button>
                </div>
            ) : null}
            <Button size="sm" onClick={handleUpload} disabled={!file || upload.isPending}>
                {upload.isPending ? <Spinner /> : <IconUpload aria-hidden />}
                Upload
            </Button>
        </div>
    );
}

'use client';

import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { DIALOG_SIZE_CLASS } from '@/shared/dialog/dialog-size';
import { formatBytes } from '@/shared/format';
import { isRestoreLockError, useAbortUpload, useCompleteUpload, useInitUpload } from '../api/hooks';
import { putPartViaFetch, uploadInParts } from '../api/upload';

export function UploadCheckpointDialog({
  open,
  onOpenChange,
  tenantId,
  onLocked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  onLocked?: () => void;
}) {
  const uid = useId();
  const init = useInitUpload(tenantId);
  const complete = useCompleteUpload(tenantId);
  const abort = useAbortUpload(tenantId);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const uploadId = useRef<string | null>(null);

  function reset() {
    setFile(null);
    setProgress(null);
    setError(null);
    setUploading(false);
    controller.current = null;
    uploadId.current = null;
  }

  async function handleUpload() {
    if (!file) return;
    setError(null);
    setUploading(true);
    const signal = (controller.current = new AbortController()).signal;
    try {
      const started = await init.mutateAsync({ filename: file.name, sizeBytes: file.size });
      uploadId.current = started.uploadId;
      setProgress({ done: 0, total: started.parts.length });
      const parts = await uploadInParts(file, started, putPartViaFetch, {
        signal,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      await complete.mutateAsync({ uploadId: started.uploadId, parts });
      toast.success('Checkpoint uploaded; verifying');
      reset();
      onOpenChange(false);
    } catch (caught) {
      if (isRestoreLockError(caught)) onLocked?.();
      if (!(caught instanceof Error && caught.name === 'AbortError')) {
        setError(caught instanceof Error ? caught.message : 'Upload failed');
        // An initiated-but-unfinished upload would otherwise hold storage until the sweeper runs.
        if (uploadId.current) abort.mutate(uploadId.current);
      }
      setUploading(false);
    }
  }

  function handleAbort() {
    controller.current?.abort();
    if (uploadId.current) abort.mutate(uploadId.current, { onSuccess: () => toast.success('Upload aborted') });
    reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next && uploading) return;
    if (!next) reset();
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={DIALOG_SIZE_CLASS.sm}>
        <DialogHeader>
          <DialogTitle>Upload checkpoint</DialogTitle>
          <DialogDescription>Upload a .hcp archive exported from this deployment. It is verified before it can be restored.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-file`}>Checkpoint file (.hcp) *</Label>
            <Input id={`${uid}-file`} type="file" accept=".hcp" disabled={uploading} onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
            {file ? (
              <p className="text-muted-foreground text-xs">
                <span className="font-mono">{file.name}</span> &middot; {formatBytes(file.size)}
              </p>
            ) : null}
          </div>
          {progress ? (
            <div className="flex flex-col gap-1">
              <Progress value={progress.total > 0 ? (progress.done / progress.total) * 100 : 0} aria-label="Upload progress" />
              <p aria-live="polite" className="text-muted-foreground text-xs">
                Part {progress.done} of {progress.total} uploaded
              </p>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          {uploading ? (
            <Button variant="outline" onClick={handleAbort}>
              Abort upload
            </Button>
          ) : (
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
          )}
          <Button disabled={!file || uploading} onClick={() => void handleUpload()}>
            {uploading ? <Spinner /> : null}
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

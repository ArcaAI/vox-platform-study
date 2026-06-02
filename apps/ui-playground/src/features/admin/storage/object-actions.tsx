import { Button } from '@arcaai/ui/button';
import { Link2, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '../components';
import { useDeleteTenantBucketObject, useTenantBucketPresignedUrl } from '../api/tenant-storage';

/** Presigned download links expire after 1 hour (mirrors the API default). */
const PRESIGNED_EXPIRY_LABEL = '1 hour';

interface ObjectActionsProps {
  tenantId: string;
  bucketId: string;
  bucketName: string;
  objectKey: string;
  /** Folder prefix the object lives under, for precise list invalidation. */
  prefix?: string;
  /** Compact icon-only layout for dense list rows. */
  compact?: boolean;
  onDeleted?: () => void;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to failure */
  }
  return false;
}

export function ObjectActions({ tenantId, bucketId, bucketName, objectKey, prefix, compact, onDeleted }: ObjectActionsProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const presign = useTenantBucketPresignedUrl(tenantId);
  const deleteObject = useDeleteTenantBucketObject(tenantId);

  const handleCopyLink = () => {
    presign.mutate(
      { bucketId, fileKey: objectKey },
      {
        onSuccess: async ({ url }) => {
          const copied = await copyToClipboard(url);
          if (copied) {
            toast.success(`Link copied — valid for ${PRESIGNED_EXPIRY_LABEL}.`);
          } else {
            window.open(url, '_blank', 'noopener,noreferrer');
            toast.success(`Link opened — valid for ${PRESIGNED_EXPIRY_LABEL}.`);
          }
        },
        onError: (error: Error) => toast.error(error.message),
      },
    );
  };

  const handleConfirmDelete = () => {
    deleteObject.mutate(
      { bucketId, bucketName, fileKey: objectKey, path: prefix },
      {
        onSuccess: () => {
          toast.success('File deleted.');
          setConfirmOpen(false);
          onDeleted?.();
        },
        onError: (error: Error) => toast.error(error.message),
      },
    );
  };

  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        type="button"
        variant="ghost"
        size={compact ? 'icon' : 'sm'}
        onClick={handleCopyLink}
        disabled={presign.isPending}
        title="Copy presigned download link"
        aria-label="Copy presigned download link"
      >
        {presign.isPending ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
        {!compact && <span className="ml-1">Copy link</span>}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size={compact ? 'icon' : 'sm'}
        className="text-destructive hover:text-destructive"
        onClick={() => setConfirmOpen(true)}
        title="Delete file"
        aria-label="Delete file"
      >
        <Trash2 className="size-4" />
        {!compact && <span className="ml-1">Delete</span>}
      </Button>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete file?"
        description={`This permanently removes "${objectKey}" from the storage provider. This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        isLoading={deleteObject.isPending}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}

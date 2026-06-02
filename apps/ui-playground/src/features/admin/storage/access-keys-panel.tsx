import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Copy, KeyRound, Loader2, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  type StorageAccessKey,
  type StorageAccessKeyWithSecret,
  useCreateStorageAccessKey,
  useRevokeStorageAccessKey,
  useStorageAccessKeys,
} from '../api/storage-keys';
import { ConfirmDialog } from '../components';

interface AccessKeysPanelProps {
  tenantId: string;
}

function formatDate(value?: string) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

/** Mask a secret/access-key id, revealing only the last 4 characters. */
function mask(value: string) {
  if (!value) return '';
  const tail = value.slice(-4);
  return `••••••••${tail}`;
}

export function AccessKeysPanel({ tenantId }: AccessKeysPanelProps) {
  const { data: keys = [], isLoading } = useStorageAccessKeys(tenantId, {
    refetchOnWindowFocus: false,
  });
  const createKey = useCreateStorageAccessKey(tenantId);
  const revokeKey = useRevokeStorageAccessKey(tenantId);

  const [newKeyName, setNewKeyName] = useState('');
  const [createdSecret, setCreatedSecret] = useState<StorageAccessKeyWithSecret | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<StorageAccessKey | null>(null);

  const handleCreate = () => {
    if (!newKeyName.trim()) {
      toast.error('Key name is required.');
      return;
    }
    createKey.mutate(
      { name: newKeyName.trim() },
      {
        onSuccess: (created) => {
          setCreatedSecret(created);
          setNewKeyName('');
          toast.success('Access key created. Copy the secret now — it is shown only once.');
        },
        onError: (error: Error) => toast.error(error.message),
      },
    );
  };

  const handleCopySecret = async () => {
    if (!createdSecret?.secretAccessKey) return;
    try {
      await navigator.clipboard?.writeText(createdSecret.secretAccessKey);
      toast.success('Secret copied to clipboard.');
    } catch {
      toast.error('Could not copy to clipboard.');
    }
  };

  const handleConfirmRevoke = () => {
    if (!revokeTarget) return;
    revokeKey.mutate(revokeTarget.id, {
      onSuccess: () => {
        toast.success('Access key revoked.');
        setRevokeTarget(null);
      },
      onError: (error: Error) => toast.error(error.message),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Label htmlFor="new-storage-key-name">New access key</Label>
          <Input
            id="new-storage-key-name"
            placeholder="e.g. backup-worker"
            value={newKeyName}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setNewKeyName(event.target.value)}
          />
        </div>
        <Button onClick={handleCreate} disabled={createKey.isPending}>
          {createKey.isPending ? <Loader2 className="size-4 animate-spin" data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
          Generate key
        </Button>
      </div>

      {createdSecret && (
        <div className="border-primary/40 bg-primary/5 rounded-md border p-3" data-testid="created-secret">
          <div className="text-foreground flex items-center gap-2 text-sm font-medium">
            <ShieldAlert className="text-primary size-4" />
            Copy this secret now — it will not be shown again.
          </div>
          <div className="mt-2 grid gap-1 text-xs">
            <span className="text-muted-foreground">Access key ID</span>
            <code className="bg-muted rounded px-2 py-1">{createdSecret.accessKeyId}</code>
            <span className="text-muted-foreground mt-1">Secret access key</span>
            <code className="bg-muted rounded px-2 py-1 break-all" data-testid="secret-value">
              {createdSecret.secretAccessKey}
            </code>
          </div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" onClick={handleCopySecret}>
              <Copy data-icon="inline-start" />
              Copy secret
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreatedSecret(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {isLoading ? (
          <>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </>
        ) : keys.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center text-sm">
            <KeyRound className="size-5" />
            No access keys yet. Generate one to grant programmatic storage access.
          </div>
        ) : (
          keys.map((key) => (
            <div key={key.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">{key.name}</p>
                  {key.permissions?.length > 0 && <Badge variant="outline">{key.permissions.join(', ')}</Badge>}
                </div>
                <p className="text-muted-foreground truncate text-xs">
                  <span className="font-mono">{key.accessKeyId}</span> · secret <span className="font-mono">{mask(key.accessKeyId)}</span>
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  Created {formatDate(key.createdAt)} · Last used {formatDate(key.lastUsedAt)}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-destructive hover:text-destructive"
                onClick={() => setRevokeTarget(key)}
                title="Revoke key"
                aria-label={`Revoke ${key.name}`}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))
        )}
      </div>

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="Revoke access key?"
        description={`"${revokeTarget?.name ?? ''}" will stop working immediately. Any client using it will lose access.`}
        confirmLabel="Revoke"
        variant="destructive"
        isLoading={revokeKey.isPending}
        onConfirm={handleConfirmRevoke}
      />
    </div>
  );
}

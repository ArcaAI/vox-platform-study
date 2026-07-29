'use client';

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { useApiKeyScopes, useCreateApiKey, useUpdateApiKey } from '../api/hooks';
import type { ApiKey, CreateApiKeyResult } from '../api/types';

/** Scope picker fed by GET /admin/api-keys/scopes, grouped by category. */
function ScopePicker({ selected, onToggle }: { selected: string[]; onToggle: (scope: string, checked: boolean) => void }) {
  const uid = useId();
  const { data: catalog, isPending } = useApiKeyScopes();

  if (isPending) {
    return (
      <div className="flex flex-col gap-2 rounded-md border p-3">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-5 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex max-h-64 flex-col gap-3 overflow-y-auto rounded-md border p-3">
      {Object.entries(catalog ?? {}).map(([category, scopes]) => (
        <fieldset key={category} className="flex flex-col gap-2">
          <legend className="text-muted-foreground pb-1 text-xs font-medium">{category}</legend>
          {scopes.map(({ scope, description }) => {
            const id = `${uid}-${scope}`;
            return (
              <div key={scope} className="flex items-start gap-2">
                <Checkbox id={id} checked={selected.includes(scope)} onCheckedChange={(checked) => onToggle(scope, checked === true)} />
                <div className="flex min-w-0 flex-col">
                  <Label htmlFor={id} className="font-mono text-xs font-normal">
                    {scope}
                  </Label>
                  <p className="text-muted-foreground text-xs">{description}</p>
                </div>
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}

/**
 * Create/edit dialog (frame 23). Create posts name + scopes (+ optional
 * expiry) and hands the one-time CreateApiKeyResult up to the screen; edit
 * PATCHes name + scopes (this route carries no ETag contract).
 */
export function ApiKeyFormDialog({
  initial,
  onOpenChange,
  onCreated,
}: {
  /** null = create mode. */
  initial: ApiKey | null;
  onOpenChange: (open: boolean) => void;
  onCreated?: (result: CreateApiKeyResult) => void;
}) {
  const uid = useId();
  const isEdit = initial !== null;
  const [name, setName] = useState(initial?.keyName ?? '');
  const [scopes, setScopes] = useState<string[]>(initial?.scopes ?? []);
  const [expiresAt, setExpiresAt] = useState('');
  const createMutation = useCreateApiKey();
  const updateMutation = useUpdateApiKey();
  const isPending = createMutation.isPending || updateMutation.isPending;

  function toggleScope(scope: string, checked: boolean) {
    setScopes((current) => (checked ? [...current, scope] : current.filter((entry) => entry !== scope)));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isEdit) {
      updateMutation.mutate(
        { id: initial.id, body: { keyName: name.trim(), scopes } },
        {
          onSuccess: () => {
            toast.success('API key updated');
            onOpenChange(false);
          },
          onError: (error) => toast.error(error.message),
        },
      );
    } else {
      createMutation.mutate(
        {
          keyName: name.trim(),
          scopes,
          ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
        },
        {
          onSuccess: (result) => {
            toast.success('API key created');
            onCreated?.(result);
          },
          onError: (error) => toast.error(error.message),
        },
      );
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit API key' : 'Create API key'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Rename the key or adjust its scopes. The secret itself never changes here — use rotate for that.'
              : 'The secret key is generated server-side and shown exactly once after creation.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-name`}>
              Name
              <span aria-hidden className="text-destructive">
                *
              </span>
            </Label>
            <Input
              id={`${uid}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              className="font-mono"
              placeholder="svc_reporting"
            />
          </div>
          <div className="flex min-h-0 flex-col gap-2">
            <span className="text-sm font-medium">
              Scopes
              <span aria-hidden className="text-destructive">
                *
              </span>
            </span>
            <ScopePicker selected={scopes} onToggle={toggleScope} />
          </div>
          {!isEdit ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${uid}-expires`}>Expires</Label>
              <Input id={`${uid}-expires`} type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
              <p className="text-muted-foreground text-xs">Leave empty for a non-expiring key.</p>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={isPending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !name.trim() || scopes.length === 0}>
              {isPending ? <Spinner /> : null}
              {isEdit ? 'Save changes' : 'Create key'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

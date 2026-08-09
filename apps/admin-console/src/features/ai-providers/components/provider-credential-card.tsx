'use client';

import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useDeleteProviderConnection, useProviderConnection, usePutProviderConnection } from '../api/hooks';
import type { ProviderService } from '../api/types';
import type { ProviderField, ProviderMeta } from './provider-meta';

/** Rule 10: skeleton shaped like the loaded card. */
function CardSkeleton() {
  return (
    <Card className="gap-3 p-4" aria-hidden>
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-8 w-full" />
      <div className="flex justify-end">
        <Skeleton className="h-8 w-28" />
      </div>
    </Card>
  );
}

/**
 * One `(service, provider)` BYO-credential card — the shared masked
 * `CredentialCard` interaction (Configured / None + enabled badges, a
 * WRITE-ONLY password field, inline remove confirmation, toasts, OCC
 * If-Match) generalized over the unified `admin/providers/:service` route
 * (C2/C3, TASK-569) so ONE component drives the LLM, STT, and TTS tabs.
 *
 * Composes the interaction already proven by the LLM lane's
 * `ByoCredentialCard` (`features/ai-task-defaults/components/byo-credential-card.tsx`)
 * and the TTS/STT `CredentialCard` variants — parametrized by `service` +
 * per-service field metadata (`provider-meta.ts`) rather than forked per
 * capability.
 *
 * The key is never rendered, never returned by any read, and there is no
 * reveal flow — the field always starts empty and reports only Configured /
 * None.
 */
export function ProviderCredentialCard({ service, meta }: { service: ProviderService; meta: ProviderMeta }) {
  const uid = useId();
  const query = useProviderConnection(service, meta.id);
  const putMutation = usePutProviderConnection();
  const deleteMutation = useDeleteProviderConnection();

  const [apiKey, setApiKey] = useState('');
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [enabledDraft, setEnabledDraft] = useState<boolean | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  if (query.isPending) return <CardSkeleton />;
  if (query.error || !query.data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const current = query.data.data;
  const etag = query.data.etag;
  const hasKey = current.hasKey;
  const enabled = enabledDraft ?? current.enabled;
  const currentColumns = current as unknown as Record<string, unknown>;

  /** Stored value for a field: a column reads its column, an `extra` field reads `extraJson[name]`. */
  const storedValue = (field: ProviderField): string => {
    const raw = field.store === 'extra' ? current.extraJson?.[field.name] : currentColumns[field.name];
    return typeof raw === 'string' ? raw : '';
  };
  const valueOf = (field: ProviderField) => draft?.[field.name] ?? storedValue(field);

  function handleSave() {
    if (apiKey.trim().length === 0) return;
    const body: Record<string, unknown> = { apiKey: apiKey.trim(), enabled };
    const extra: Record<string, unknown> = {};
    for (const field of meta.fields) {
      const value = valueOf(field).trim() || null;
      if (field.store === 'extra') {
        extra[field.name] = value;
      } else {
        body[field.name] = value;
      }
    }
    if (Object.keys(extra).length > 0) {
      body.extraJson = extra;
    }
    putMutation.mutate(
      { service, provider: meta.id, body, etag },
      {
        onSuccess: () => {
          toast.success(`${meta.label} credential saved`);
          setApiKey('');
          setDraft(null);
          setEnabledDraft(null);
        },
        // A 412/428 renders the OCC alert below; only other failures toast.
        onError: (error) => {
          if (!(error as { isVersionConflict?: boolean; isMissingPrecondition?: boolean }).isVersionConflict) {
            toast.error(error.message);
          }
        },
      },
    );
  }

  function handleRemove() {
    deleteMutation.mutate(
      { service, provider: meta.id },
      {
        onSuccess: () => {
          toast.success(`${meta.label} credential removed`);
          setConfirmingRemove(false);
          setDraft(null);
          setEnabledDraft(null);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${uid}-title`} className="text-sm font-semibold">
          {meta.label}
        </h3>
        {hasKey ? (
          <Badge variant="default">configured{current.keyVersion != null ? ` · v${current.keyVersion}` : ''}</Badge>
        ) : (
          <Badge variant="outline">not configured</Badge>
        )}
        <Badge variant={current.enabled ? 'secondary' : 'outline'}>{current.enabled ? 'enabled' : 'disabled'}</Badge>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-key`} className="text-muted-foreground text-xs font-medium">
          {meta.keyLabel ?? 'API key'} {hasKey ? '(enter to rotate)' : ''}
        </Label>
        <Input
          id={`${uid}-key`}
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={hasKey ? '•••••••• (write-only — never shown)' : (meta.keyPlaceholder ?? 'Paste the provider API key')}
          className="h-8 font-mono text-xs"
        />
        <p className="text-muted-foreground text-xs">Encrypted at rest via Vault Transit; the key is never returned by any read.</p>
      </div>

      {meta.fields.map((field) => (
        <div key={field.name} className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-${field.name}`} className="text-muted-foreground text-xs font-medium">
            {field.label}
          </Label>
          <Input
            id={`${uid}-${field.name}`}
            value={valueOf(field)}
            onChange={(event) => setDraft((prev) => ({ ...prev, [field.name]: event.target.value }))}
            placeholder={field.placeholder}
            className="h-8 font-mono text-xs"
          />
        </div>
      ))}

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Switch id={`${uid}-enabled`} checked={enabled} onCheckedChange={setEnabledDraft} />
          <Label htmlFor={`${uid}-enabled`} className="text-muted-foreground text-xs">
            Enabled
          </Label>
        </div>
        {/*
          Turning this OFF is a VETO, not "unused" — it blocks the
          platform-provided key for this provider too, and calls that select it
          fail rather than falling through to another provider. An admin cannot
          be expected to infer that from a switch, and the resulting 409 is
          otherwise unexplainable. Removing the credential entirely returns this
          provider to "no opinion" instead.
        */}
        <p id={`${uid}-enabled-help`} className="text-muted-foreground pl-10 text-xs">
          {enabled
            ? 'Your credential serves this provider. Remove it to fall back to the platform-provided key.'
            : 'Disabled blocks this provider for your tenant entirely — including the platform-provided key. Remove the credential instead to allow the platform default.'}
        </p>
      </div>

      <OccConflictAlert
        error={putMutation.error}
        onReload={() => {
          // Reload-merge: the typed key and field drafts stay in memory.
          putMutation.reset();
          void query.refetch();
        }}
      />

      <div className="flex flex-wrap items-center justify-end gap-2">
        {hasKey ? (
          confirmingRemove ? (
            <>
              <span className="text-muted-foreground text-xs">Remove this credential?</span>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingRemove(false)} disabled={deleteMutation.isPending}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={handleRemove} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? <Spinner /> : null}
                Confirm remove
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirmingRemove(true)} aria-label={`Remove the ${meta.label} credential`}>
              Remove
            </Button>
          )
        ) : null}
        <Button
          size="sm"
          onClick={handleSave}
          disabled={apiKey.trim().length === 0 || putMutation.isPending}
          aria-label={`${hasKey ? 'Rotate' : 'Save'} key for ${meta.label} · If-Match`}
        >
          {putMutation.isPending ? <Spinner /> : null}
          {hasKey ? 'Rotate key' : 'Save key'}
        </Button>
      </div>
    </Card>
  );
}

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
import { useDeleteProviderConnection, useProviderConnection, usePutProviderConnection } from '../api/providers-hooks';
import type { CloudByoProvider } from '../api/providers-types';

/** A field backed by a first-class connection column. */
type ColumnFieldName = 'baseUrl' | 'region' | 'apiVersion' | 'deploymentName';

/**
 * One editable text field on a provider card. Most map 1:1 to a connection
 * column (`store: 'column'`, the default); a field with `store: 'extra'` writes
 * into `extraJson[name]` instead (Vertex `project` — the connection table has no
 * dedicated column for it).
 */
interface ProviderField {
  name: ColumnFieldName | 'project';
  label: string;
  placeholder: string;
  store?: 'column' | 'extra';
}

export interface ProviderMeta {
  id: CloudByoProvider;
  label: string;
  fields: readonly ProviderField[];
  /** Overrides for the secret input (Vertex uploads a service-account JSON, not a key). */
  keyLabel?: string;
  keyPlaceholder?: string;
}

export const CLOUD_PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'azure',
    label: 'Azure OpenAI',
    fields: [
      { name: 'baseUrl', label: 'Endpoint', placeholder: 'https://<resource>.openai.azure.com' },
      { name: 'apiVersion', label: 'API version', placeholder: '2024-10-21' },
      { name: 'deploymentName', label: 'Deployment name', placeholder: 'gpt-4o-mini' },
    ],
  },
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    fields: [{ name: 'region', label: 'Region', placeholder: 'us-east-1' }],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    fields: [{ name: 'baseUrl', label: 'Base URL', placeholder: 'https://api.openai.com/v1' }],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    fields: [{ name: 'baseUrl', label: 'Base URL', placeholder: 'https://api.anthropic.com' }],
  },
  {
    id: 'vertex',
    label: 'Google Vertex AI',
    keyLabel: 'Service account JSON',
    keyPlaceholder: 'Paste the service-account key JSON',
    fields: [
      { name: 'project', label: 'Project', placeholder: 'my-gcp-project', store: 'extra' },
      { name: 'region', label: 'Location', placeholder: 'us-central1' },
    ],
  },
];

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
 * One cloud provider's BYO-credential card (tenant lane).
 *
 * Follows the TTS `CredentialCard` interaction exactly — Configured /
 * None + enabled badges, a WRITE-ONLY password field, inline remove
 * confirmation, toasts — with one deliberate divergence: this row carries the
 * house `_version`, so the save is OCC-guarded (`If-Match` from the row read,
 * `"0"` on create) and a 412 surfaces the reload-merge alert instead of
 * silently clobbering another admin's write.
 *
 * The key is never rendered, never returned by any read, and there is no reveal
 * flow — the field always starts empty and reports only Configured / None.
 */
export function ByoCredentialCard({ meta }: { meta: ProviderMeta }) {
  const uid = useId();
  const query = useProviderConnection(meta.id);
  const putMutation = usePutProviderConnection();
  const deleteMutation = useDeleteProviderConnection();

  const [apiKey, setApiKey] = useState('');
  const [draft, setDraft] = useState<Partial<Record<ProviderField['name'], string>> | null>(null);
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

  /** Stored value for a field: a column reads its column, an `extra` field reads `extraJson[name]`. */
  const storedValue = (field: ProviderField): string => {
    if (field.store === 'extra') {
      const raw = current.extraJson?.[field.name];
      return typeof raw === 'string' ? raw : '';
    }
    return current[field.name as ColumnFieldName] ?? '';
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
      { provider: meta.id, body, etag },
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
    deleteMutation.mutate(meta.id, {
      onSuccess: () => {
        toast.success(`${meta.label} credential removed`);
        setConfirmingRemove(false);
        setDraft(null);
        setEnabledDraft(null);
      },
      onError: (error) => toast.error(error.message),
    });
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

      <div className="flex items-center gap-2">
        <Switch id={`${uid}-enabled`} checked={enabled} onCheckedChange={setEnabledDraft} />
        <Label htmlFor={`${uid}-enabled`} className="text-muted-foreground text-xs">
          Enabled
        </Label>
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

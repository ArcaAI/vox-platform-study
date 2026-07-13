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
import { ErrorState } from '@/shared/state/error-state';
import { useRemoveTtsCredential, useSetTtsCredential, useTtsCredentials, type TtsCredential, type TtsProvider } from '../api';

interface ProviderMeta {
  id: TtsProvider;
  label: string;
  endpointLabel: string;
  endpointPlaceholder: string;
}

const PROVIDERS: readonly ProviderMeta[] = [
  { id: 'azure', label: 'Azure Speech', endpointLabel: 'Region', endpointPlaceholder: 'eastus' },
  { id: 'sarvam', label: 'Sarvam', endpointLabel: 'Base URL', endpointPlaceholder: 'https://api.sarvam.ai' },
];

/** One provider's BYO-key card: write-only key entry over a masked status line. */
function CredentialCard({ meta, current }: { meta: ProviderMeta; current: TtsCredential | undefined }) {
  const uid = useId();
  const setMutation = useSetTtsCredential();
  const removeMutation = useRemoveTtsCredential();
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState(current?.endpoint ?? '');
  const [enabled, setEnabled] = useState(current?.enabled ?? true);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const hasKey = current?.hasKey ?? false;

  function handleSave() {
    if (apiKey.trim().length === 0) return;
    setMutation.mutate(
      { provider: meta.id, body: { apiKey: apiKey.trim(), endpoint: endpoint.trim() || undefined, enabled } },
      {
        onSuccess: () => {
          toast.success(`${meta.label} key saved`);
          setApiKey('');
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  function handleRemove() {
    removeMutation.mutate(meta.id, {
      onSuccess: () => {
        toast.success(`${meta.label} key removed`);
        setConfirmingRemove(false);
        setEndpoint('');
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
          <Badge variant="default">configured{current?.keyVersion != null ? ` · v${current.keyVersion}` : ''}</Badge>
        ) : (
          <Badge variant="outline">not configured</Badge>
        )}
        <Badge variant={current?.enabled ? 'secondary' : 'outline'}>{current?.enabled ? 'enabled' : 'disabled'}</Badge>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-key`} className="text-muted-foreground text-xs font-medium">
          API key {hasKey ? '(enter to rotate)' : ''}
        </Label>
        <Input
          id={`${uid}-key`}
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={hasKey ? '•••••••• (write-only — never shown)' : 'Paste the provider API key'}
          className="h-8 font-mono text-xs"
        />
        <p className="text-muted-foreground text-xs">Encrypted at rest via Vault Transit; the key is never returned by any read.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-endpoint`} className="text-muted-foreground text-xs font-medium">
          {meta.endpointLabel}
        </Label>
        <Input
          id={`${uid}-endpoint`}
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder={meta.endpointPlaceholder}
          className="h-8 font-mono text-xs"
        />
      </div>

      <div className="flex items-center gap-2">
        <Switch id={`${uid}-enabled`} checked={enabled} onCheckedChange={setEnabled} />
        <Label htmlFor={`${uid}-enabled`} className="text-muted-foreground text-xs">
          Enabled
        </Label>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {hasKey ? (
          confirmingRemove ? (
            <>
              <span className="text-muted-foreground text-xs">Remove this key?</span>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingRemove(false)} disabled={removeMutation.isPending}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={handleRemove} disabled={removeMutation.isPending}>
                {removeMutation.isPending ? <Spinner /> : null}
                Confirm remove
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirmingRemove(true)}>
              Remove
            </Button>
          )
        ) : null}
        <Button size="sm" onClick={handleSave} disabled={apiKey.trim().length === 0 || setMutation.isPending}>
          {setMutation.isPending ? <Spinner /> : null}
          {hasKey ? 'Rotate key' : 'Save key'}
        </Button>
      </div>
    </Card>
  );
}

function CredentialsSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2" aria-hidden>
      <Skeleton className="h-64" />
      <Skeleton className="h-64" />
    </div>
  );
}

/** BYO credentials tab: one write-only key card per supported provider. */
export function TtsCredentialsTab() {
  const query = useTtsCredentials();

  if (query.isPending) return <CredentialsSkeleton />;
  if (query.error || !query.data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const byProvider = new Map(query.data.map((credential) => [credential.provider, credential]));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        Bring-your-own provider keys, encrypted at rest via Vault Transit.{' '}
        <span className="font-mono text-xs">PUT /admin/tts-config/credentials/:provider</span> — write-only, masked on read.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {PROVIDERS.map((meta) => (
          <CredentialCard key={meta.id} meta={meta} current={byProvider.get(meta.id)} />
        ))}
      </div>
    </div>
  );
}

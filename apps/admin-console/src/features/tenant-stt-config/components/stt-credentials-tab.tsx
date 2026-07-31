'use client';

import { useId, useState } from 'react';
import { IconCircleCheck, IconCircleX, IconPlugConnected } from '@tabler/icons-react';
import { toast } from 'sonner';
import { cn } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useRemoveSttCredential, useSetSttCredential, useSttCredentials, useTestSttCredential, type SttCredential, type SttProvider } from '../api';

interface TextField {
  key: 'region' | 'endpoint' | 'model';
  label: string;
  placeholder: string;
}

interface ProviderMeta {
  id: SttProvider;
  label: string;
  fields: readonly TextField[];
}

/** Per-provider non-secret config surfaced beside the write-only key. */
const PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'azure-speech',
    label: 'Azure Speech',
    fields: [
      { key: 'region', label: 'Region', placeholder: 'eastus' },
      { key: 'endpoint', label: 'Endpoint (Azure Foundry resource)', placeholder: 'https://<resource>.cognitiveservices.azure.com' },
      { key: 'model', label: 'Model (optional)', placeholder: 'mai-transcribe-1.5' },
    ],
  },
  {
    id: 'sarvam',
    label: 'Sarvam',
    fields: [
      { key: 'endpoint', label: 'Base URL (optional)', placeholder: 'https://api.sarvam.ai' },
      { key: 'model', label: 'Model (optional)', placeholder: 'saaras:v4' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    fields: [
      { key: 'endpoint', label: 'Base URL (optional)', placeholder: 'https://api.openai.com/v1' },
      { key: 'model', label: 'Model (optional)', placeholder: 'gpt-4o-transcribe' },
    ],
  },
];

function isOccError(error: unknown): boolean {
  return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

/** One provider's BYO-key card: write-only key entry over a masked status line. */
function CredentialCard({ meta, current }: { meta: ProviderMeta; current: SttCredential | undefined }) {
  const uid = useId();
  const setMutation = useSetSttCredential();
  const removeMutation = useRemoveSttCredential();
  const testMutation = useTestSttCredential();
  const [apiKey, setApiKey] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({
    region: current?.region ?? '',
    endpoint: current?.endpoint ?? '',
    model: current?.model ?? '',
  });
  const [enabled, setEnabled] = useState(current?.enabled ?? true);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const hasKey = current?.hasKey ?? false;
  const version = current?.version ?? 0;

  function handleSave() {
    if (apiKey.trim().length === 0) return;
    const body: Record<string, unknown> = { apiKey: apiKey.trim(), enabled };
    for (const field of meta.fields) {
      const value = fields[field.key]?.trim();
      if (value) body[field.key] = value;
    }
    setMutation.mutate(
      { provider: meta.id, body: body as Parameters<typeof setMutation.mutate>[0]['body'], version },
      {
        onSuccess: () => {
          toast.success(`${meta.label} key saved`);
          setApiKey('');
        },
        onError: (error) => {
          if (!isOccError(error)) toast.error(error.message);
        },
      },
    );
  }

  /**
   * Ephemeral probe of the CURRENTLY TYPED key/region/endpoint — never the
   * saved value (the saved key is write-only and never returned to the
   * client). Independent of `handleSave`: an admin can test before saving, or
   * skip testing and save directly.
   */
  function handleTest() {
    const key = apiKey.trim();
    if (key.length === 0) return;
    const body: { apiKey: string; region?: string; endpoint?: string } = { apiKey: key };
    const region = fields.region?.trim();
    const endpoint = fields.endpoint?.trim();
    if (region) body.region = region;
    if (endpoint) body.endpoint = endpoint;
    testMutation.mutate(
      { provider: meta.id, body },
      {
        onSuccess: (result) => {
          if (result.ok) toast.success(result.message);
          else toast.error(result.message);
        },
        onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not test the connection.'),
      },
    );
  }

  function handleRemove() {
    removeMutation.mutate(meta.id, {
      onSuccess: () => {
        toast.success(`${meta.label} key removed`);
        setConfirmingRemove(false);
        setFields({ region: '', endpoint: '', model: '' });
      },
      onError: (error) => toast.error(error.message),
    });
  }

  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${uid}-title`} className="text-sm font-semibold">
          {meta.label}
        </h2>
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

      {meta.fields.map((field) => (
        <div key={field.key} className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-${field.key}`} className="text-muted-foreground text-xs font-medium">
            {field.label}
          </Label>
          <Input
            id={`${uid}-${field.key}`}
            value={fields[field.key] ?? ''}
            onChange={(event) => setFields((current) => ({ ...current, [field.key]: event.target.value }))}
            placeholder={field.placeholder}
            className="h-8 font-mono text-xs"
          />
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={apiKey.trim().length === 0 || testMutation.isPending} onClick={handleTest}>
          {testMutation.isPending ? <Spinner /> : <IconPlugConnected aria-hidden className="size-4" />}
          Test connection
        </Button>
        {testMutation.data ? (
          <span className={cn('flex items-center gap-1.5 text-xs', testMutation.data.ok ? 'text-success' : 'text-destructive')}>
            {testMutation.data.ok ? <IconCircleCheck aria-hidden className="size-4" /> : <IconCircleX aria-hidden className="size-4" />}
            {testMutation.data.message}
          </span>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">Tests the key typed above (never the saved key) &mdash; independent of Save.</p>

      <div className="flex items-center gap-2">
        <Switch id={`${uid}-enabled`} checked={enabled} onCheckedChange={setEnabled} />
        <Label htmlFor={`${uid}-enabled`} className="text-muted-foreground text-xs">
          Enabled
        </Label>
      </div>

      <OccConflictAlert error={setMutation.error} onReload={() => setMutation.reset()} />

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
          {hasKey ? 'Rotate key · If-Match' : 'Save key · If-Match'}
        </Button>
      </div>
    </Card>
  );
}

function CredentialsSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2" aria-hidden>
      <Skeleton className="h-72" />
      <Skeleton className="h-72" />
      <Skeleton className="h-72" />
    </div>
  );
}

/** BYO credentials tab: one write-only key card per supported provider. */
export function SttCredentialsTab() {
  const query = useSttCredentials();

  if (query.isPending) return <CredentialsSkeleton />;
  if (query.error || !query.data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const byProvider = new Map(query.data.map((credential) => [credential.provider, credential]));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        Bring-your-own provider keys, encrypted at rest via Vault Transit.{' '}
        <span className="font-mono text-xs">PUT /admin/stt-config/credentials/:provider</span> — write-only, masked on read, OCC If-Match.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {PROVIDERS.map((meta) => (
          <CredentialCard key={meta.id} meta={meta} current={byProvider.get(meta.id)} />
        ))}
      </div>
    </div>
  );
}

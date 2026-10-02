'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { ErrorState } from '@/shared/state/error-state';
import { usePlatformStorageConfig, useSavePlatformStorageConfig } from '../api/hooks';
import type { PlatformStorageChanges } from '../api/client';
import type { StorageProviderType, TenantStorageConfig } from '../api/types';

const PROVIDER_LABELS: Record<StorageProviderType, string> = {
  MINIO: 'MinIO',
  AWS_S3: 'AWS S3',
  AZURE_BLOB: 'Azure Blob',
};

/** A pasted origin often carries a trailing slash; anything else is left for the gateway to judge. */
function normalizeOrigin(value: string): string | null {
  return value.trim().replace(/\/+$/, '') || null;
}

type TextField = 'endpoint' | 'publicEndpoint' | 'region' | 'containerPrefix';

const TEXT_FIELDS: { key: TextField; label: string; placeholder?: string; mono?: boolean; help?: string }[] = [
  { key: 'endpoint', label: 'Endpoint', placeholder: 'https://hope-minio:9000', mono: true },
  {
    key: 'publicEndpoint',
    label: 'Public download endpoint',
    placeholder: 'https://admin.example.com',
    mono: true,
    help: 'Download links are signed for this origin, so it must be the address browsers reach stored files at — the admin console\u2019s own address when the ingress routes signed storage requests there. Scheme, host and optional port only. Leave empty to sign links with the storage endpoint.',
  },
  { key: 'region', label: 'Region', mono: true },
  { key: 'containerPrefix', label: 'Container prefix', mono: true },
];

function clean(key: TextField, value: string): string | null {
  const trimmed = value.trim();
  return (key === 'publicEndpoint' ? normalizeOrigin(trimmed) : trimmed) || null;
}

type FieldKey = TextField | 'forcePathStyle';
const FIELD_LABEL: Record<FieldKey, string> = {
  endpoint: 'Endpoint',
  publicEndpoint: 'Public download endpoint',
  region: 'Region',
  containerPrefix: 'Container prefix',
  forcePathStyle: 'Force path-style addressing',
};

function PlatformStorageForm({ platform }: { platform: TenantStorageConfig }) {
  const save = useSavePlatformStorageConfig();
  const exists = (platform.version ?? 0) > 0;
  const initial = (): Record<TextField, string> => ({
    endpoint: platform.endpoint ?? '',
    publicEndpoint: platform.publicEndpoint ?? '',
    region: platform.region ?? '',
    containerPrefix: platform.containerPrefix ?? '',
  });
  const [provider, setProvider] = useState<StorageProviderType>(platform.provider);
  const [text, setText] = useState(initial);
  const [pathStyle, setPathStyle] = useState(platform.forcePathStyle === true);
  const [seededVersion, setSeededVersion] = useState(platform.version);
  const [resetField, setResetField] = useState<FieldKey | null>(null);

  // Re-seed when a save (or another admin) moves the row (render-time reset, not an effect).
  if (platform.version !== seededVersion) {
    setSeededVersion(platform.version);
    setProvider(platform.provider);
    setText(initial());
    setPathStyle(platform.forcePathStyle === true);
  }

  const changes: PlatformStorageChanges = {};
  for (const { key } of TEXT_FIELDS) {
    const next = clean(key, text[key]);
    if (next !== (platform[key] ?? null) || (!exists && next !== null)) changes[key] = next;
  }
  if (pathStyle !== (platform.forcePathStyle === true) || (!exists && pathStyle)) changes.forcePathStyle = pathStyle;
  const providerChanged = provider !== platform.provider;

  const missingRequired = !exists && (!provider || !clean('endpoint', text.endpoint));
  const dirty = providerChanged || Object.keys(changes).length > 0;

  function submit(extra: PlatformStorageChanges, onDone?: () => void) {
    save.mutate(
      { platform: { ...platform, provider }, changes: extra },
      {
        onSuccess: () => {
          toast.success('Platform storage saved');
          onDone?.();
        },
        onError: (error) => {
          toast.error(
            error instanceof GatewayError && error.status === 412
              ? 'The platform storage default changed elsewhere — reloaded the latest values; review and save again.'
              : error instanceof GatewayError
                ? error.message
                : 'Could not save the platform storage default.',
          );
          onDone?.();
        },
      },
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (missingRequired || !dirty) return;
    submit(changes);
  }

  const stored: Record<FieldKey, boolean> = {
    endpoint: platform.endpoint != null,
    publicEndpoint: platform.publicEndpoint != null,
    region: platform.region != null,
    containerPrefix: platform.containerPrefix != null,
    forcePathStyle: platform.forcePathStyle != null,
  };

  const resetButton = (field: FieldKey) => {
    if (!exists || !stored[field]) return null;
    return (
      <Button type="button" variant="ghost" size="sm" aria-label={`Reset ${FIELD_LABEL[field]} to default`} onClick={() => setResetField(field)}>
        Reset to default
      </Button>
    );
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="platform-provider">Provider</Label>
        <NativeSelect id="platform-provider" value={provider} onChange={(event) => setProvider(event.target.value as StorageProviderType)}>
          {(Object.keys(PROVIDER_LABELS) as StorageProviderType[]).map((value) => (
            <NativeSelectOption key={value} value={value}>
              {PROVIDER_LABELS[value]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {TEXT_FIELDS.map(({ key, label, placeholder, mono, help }) => (
        <div key={key} className="flex flex-col gap-2">
          <Label htmlFor={`platform-${key}`}>
            {label}
            {!exists && key === 'endpoint' ? ' *' : ''}
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={`platform-${key}`}
              value={text[key]}
              onChange={(event) => setText((current) => ({ ...current, [key]: event.target.value }))}
              className={mono ? 'min-w-0 flex-1 font-mono' : 'min-w-0 flex-1'}
              placeholder={placeholder}
              aria-describedby={help ? `platform-${key}-help` : undefined}
            />
            {resetButton(key)}
          </div>
          {help ? (
            <p id={`platform-${key}-help`} className="text-muted-foreground text-xs">
              {help}
            </p>
          ) : null}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox id="platform-forcePathStyle" checked={pathStyle} onCheckedChange={(checked) => setPathStyle(checked === true)} />
        <Label htmlFor="platform-forcePathStyle" className="font-normal">
          Force path-style addressing
        </Label>
        {resetButton('forcePathStyle')}
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="text-muted-foreground text-sm">Credentials ref (read-only)</span>
        <span className="font-mono text-xs">{platform.credentialsRef ?? '—'}</span>
      </div>
      {platform.provider === 'AZURE_BLOB' || provider === 'AZURE_BLOB' ? (
        <p className="text-muted-foreground text-sm">Azure download links are already public; a public download endpoint applies to S3 and MinIO only.</p>
      ) : null}
      {!exists ? (
        <p className="text-muted-foreground text-sm">
          No platform row exists yet. Provider and endpoint are both required to create one — a half-filled row would win over the bootstrap
          settings and point every tenant at nothing.
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={save.isPending || !dirty || missingRequired}>
          {save.isPending ? <Spinner /> : null}
          Save platform storage
        </Button>
      </div>
      <ConfirmDialog
        open={resetField !== null}
        onOpenChange={(open) => {
          if (!open) setResetField(null);
        }}
        title={`Reset ${resetField ? FIELD_LABEL[resetField] : ''} to default?`}
        description="The stored value is cleared, so every tenant without its own storage config falls back to the bootstrap value on the next file operation."
        confirmLabel="Reset to default"
        isPending={save.isPending}
        onConfirm={() => {
          if (resetField) submit({ [resetField]: null }, () => setResetField(null));
        }}
      />
    </form>
  );
}

/**
 * The PLATFORM storage default (SYSTEM row), shown on the Configs tab when a
 * platform admin has no working tenant — the working tenant decides scope, so
 * there is no toggle. TASK-1033: every non-secret field is editable in one
 * If-Match form (`credentialsRef` stays read-only). A missing row is created
 * only with provider + endpoint together: a half-filled SYSTEM row would win
 * wholesale over the bootstrap tier and point every tenant at nothing.
 */
export function PlatformStorageDefaultPanel() {
  const { data, isPending, error, refetch } = usePlatformStorageConfig();

  let body: ReactNode;
  if (isPending) {
    body = (
      <div className="flex flex-col gap-2" aria-hidden>
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-80" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  } else if (error || !data) {
    body = <ErrorState error={error} onRetry={() => void refetch()} />;
  } else {
    body = <PlatformStorageForm platform={data} />;
  }

  return (
    <section aria-labelledby="platform-storage-default-heading" className="flex flex-col gap-3 rounded-md border p-4">
      <div className="flex flex-col gap-1">
        <h2 id="platform-storage-default-heading" className="text-base font-medium">
          Platform storage default
        </h2>
        <p className="text-muted-foreground text-sm">
          The storage every tenant falls back to. Select a working tenant to manage that tenant&apos;s own storage configs.
        </p>
      </div>
      {body}
    </section>
  );
}

'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { IconServer } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { usePlatformStorageConfig, useSetPlatformPublicEndpoint } from '../api/hooks';
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

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="text-muted-foreground w-32 shrink-0 text-sm">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function PublicEndpointForm({ platform }: { platform: TenantStorageConfig }) {
  const setPublicEndpoint = useSetPlatformPublicEndpoint();
  const [value, setValue] = useState(platform.publicEndpoint ?? '');
  const [seededVersion, setSeededVersion] = useState(platform.version);

  // Re-seed when a save (or another admin) moves the row (render-time reset, not an effect).
  if (platform.version !== seededVersion) {
    setSeededVersion(platform.version);
    setValue(platform.publicEndpoint ?? '');
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPublicEndpoint.mutate(
      { platform, publicEndpoint: normalizeOrigin(value) },
      {
        onSuccess: () => toast.success('Public download endpoint saved'),
        onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not save the public download endpoint.'),
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <Label htmlFor="platform-public-endpoint">Public download endpoint</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="platform-public-endpoint"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="min-w-0 flex-1 font-mono"
          placeholder="https://admin.example.com"
          aria-describedby="platform-public-endpoint-help"
        />
        <Button type="submit" disabled={setPublicEndpoint.isPending}>
          {setPublicEndpoint.isPending ? <Spinner /> : null}
          Save public endpoint
        </Button>
      </div>
      <p id="platform-public-endpoint-help" className="text-muted-foreground text-xs">
        Download links are signed for this origin, so it must be the address browsers reach stored files at — the admin console&apos;s own
        address when the ingress routes signed storage requests there. Scheme, host and optional port only. Leave empty to sign links with the
        storage endpoint.
      </p>
    </form>
  );
}

/**
 * The PLATFORM storage default (SYSTEM row), shown on the Configs tab when a
 * platform admin has no working tenant — the working tenant decides scope, so
 * there is no toggle. Read-only apart from the public download endpoint
 * (TASK-984). A missing row is NOT created here: a half-filled SYSTEM row would
 * win wholesale over the bootstrap tier and point every tenant at nothing.
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
  } else if (!data.version) {
    body = (
      <EmptyState
        icon={IconServer}
        title="Platform storage row not found"
        description="The platform storage default has not been seeded, so storage runs on the deploy-time bootstrap settings. Run the storage seed to make it manageable here."
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <dl className="flex flex-col gap-1.5">
          <SummaryRow label="Provider">{PROVIDER_LABELS[data.provider]}</SummaryRow>
          <SummaryRow label="Endpoint">
            <span className="font-mono text-xs break-all">{data.endpoint ?? data.accountName ?? '—'}</span>
          </SummaryRow>
          <SummaryRow label="Region">
            <span className="font-mono text-xs">{data.region ?? '—'}</span>
          </SummaryRow>
          <SummaryRow label="Credentials ref">
            <span className="font-mono text-xs">{data.credentialsRef ?? '—'}</span>
          </SummaryRow>
        </dl>
        {data.provider === 'AZURE_BLOB' ? (
          <p className="text-muted-foreground text-sm">Azure download links are already public; a public download endpoint applies to S3 and MinIO only.</p>
        ) : (
          <PublicEndpointForm platform={data} />
        )}
      </div>
    );
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

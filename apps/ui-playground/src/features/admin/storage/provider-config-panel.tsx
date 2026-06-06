import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Switch } from '@arcaai/ui/switch';
import { Loader2, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { type StorageProvider, type StorageTopology, useTenantStorageConfigs, useUpsertTenantStorageConfig } from '../api/storage-config';
import { type TenantBucket, useSetTenantBucketDefaults, useTenantBucketDefaults } from '../api/tenant-storage';

interface ProviderConfigPanelProps {
  tenantId: string;
  buckets: TenantBucket[];
}

const PROVIDERS: { value: StorageProvider; label: string }[] = [
  { value: 'MINIO', label: 'MinIO' },
  { value: 'AWS_S3', label: 'AWS S3' },
  { value: 'AZURE_BLOB', label: 'Azure Blob' },
];

const TOPOLOGIES: { value: StorageTopology; label: string }[] = [
  { value: 'SHARED', label: 'Shared (platform default)' },
  { value: 'DEDICATED', label: 'Dedicated (tenant-owned credentials)' },
];

const NONE = '__none__';

export function ProviderConfigPanel({ tenantId, buckets }: ProviderConfigPanelProps) {
  const { data: configs = [], isLoading } = useTenantStorageConfigs(tenantId, { refetchOnWindowFocus: false });
  const upsertConfig = useUpsertTenantStorageConfig(tenantId);
  const { data: defaults, isLoading: defaultsLoading } = useTenantBucketDefaults(tenantId, { refetchOnWindowFocus: false });
  const setDefaults = useSetTenantBucketDefaults(tenantId);

  // The tenant-wide default config has no bucketId; fall back to the first row.
  const tenantConfig = useMemo(() => configs.find((c) => !c.bucketId) ?? configs[0] ?? null, [configs]);

  const [provider, setProvider] = useState<StorageProvider>('MINIO');
  const [topology, setTopology] = useState<StorageTopology>('SHARED');
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('');
  const [forcePathStyle, setForcePathStyle] = useState(false);
  const [containerPrefix, setContainerPrefix] = useState('');
  const [credentialsRef, setCredentialsRef] = useState('');

  const [audioBucketId, setAudioBucketId] = useState<string>(NONE);
  const [attachmentsBucketId, setAttachmentsBucketId] = useState<string>(NONE);
  const [miscBucketId, setMiscBucketId] = useState<string>(NONE);

  useEffect(() => {
    if (!tenantConfig) return;
    setProvider(tenantConfig.provider);
    setTopology(tenantConfig.topology);
    setEndpoint(tenantConfig.endpoint ?? '');
    setRegion(tenantConfig.region ?? '');
    setForcePathStyle(!!tenantConfig.forcePathStyle);
    setContainerPrefix(tenantConfig.containerPrefix ?? '');
    setCredentialsRef(tenantConfig.credentialsRef ?? '');
  }, [tenantConfig]);

  useEffect(() => {
    if (!defaults) return;
    setAudioBucketId(defaults.audio?.id ?? NONE);
    setAttachmentsBucketId(defaults.attachments?.id ?? NONE);
    setMiscBucketId(defaults.misc?.id ?? NONE);
  }, [defaults]);

  const handleSaveConfig = () => {
    if (topology === 'DEDICATED' && !credentialsRef.trim()) {
      toast.error('A credentials reference is required for a DEDICATED topology.');
      return;
    }
    upsertConfig.mutate(
      {
        provider,
        topology,
        endpoint: endpoint.trim() || null,
        region: region.trim() || null,
        forcePathStyle,
        containerPrefix: containerPrefix.trim() || null,
        credentialsRef: credentialsRef.trim() || null,
      },
      {
        onSuccess: () => toast.success('Storage provider settings saved.'),
        onError: (error: Error) => toast.error(error.message),
      },
    );
  };

  const handleSaveDefaults = () => {
    setDefaults.mutate(
      {
        audioBucketId: audioBucketId === NONE ? undefined : audioBucketId,
        attachmentsBucketId: attachmentsBucketId === NONE ? undefined : attachmentsBucketId,
        miscBucketId: miscBucketId === NONE ? undefined : miscBucketId,
      },
      {
        onSuccess: () => toast.success('Default buckets updated.'),
        onError: (error: Error) => toast.error(error.message),
      },
    );
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h4 className="text-sm font-semibold">Provider settings</h4>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="storage-provider">Provider type</Label>
            <Select value={provider} onValueChange={(value: StorageProvider) => setProvider(value)}>
              <SelectTrigger id="storage-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="storage-topology">Topology</Label>
            <Select value={topology} onValueChange={(value: StorageTopology) => setTopology(value)}>
              <SelectTrigger id="storage-topology">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TOPOLOGIES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="storage-endpoint">Endpoint</Label>
            <Input
              id="storage-endpoint"
              placeholder="https://minio.local:9000"
              value={endpoint}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setEndpoint(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="storage-region">Region</Label>
            <Input
              id="storage-region"
              placeholder="us-east-1"
              value={region}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setRegion(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="storage-container-prefix">Container/bucket prefix</Label>
            <Input
              id="storage-container-prefix"
              placeholder="optional"
              value={containerPrefix}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setContainerPrefix(event.target.value)}
            />
          </div>
          {topology === 'DEDICATED' && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="storage-credentials-ref">Credentials reference</Label>
              <Input
                id="storage-credentials-ref"
                placeholder="secrets-manager key name"
                value={credentialsRef}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setCredentialsRef(event.target.value)}
              />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Switch id="storage-force-path-style" checked={forcePathStyle} onCheckedChange={setForcePathStyle} />
          <Label htmlFor="storage-force-path-style">Force path-style URLs (required for MinIO)</Label>
        </div>
        <div>
          <Button onClick={handleSaveConfig} disabled={upsertConfig.isPending}>
            {upsertConfig.isPending ? <Loader2 className="size-4 animate-spin" data-icon="inline-start" /> : <Save data-icon="inline-start" />}
            Save provider settings
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h4 className="text-sm font-semibold">Default buckets</h4>
        {defaultsLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(
              [
                { label: 'Audio', value: audioBucketId, set: setAudioBucketId, id: 'default-audio' },
                { label: 'Attachments', value: attachmentsBucketId, set: setAttachmentsBucketId, id: 'default-attachments' },
                { label: 'Misc', value: miscBucketId, set: setMiscBucketId, id: 'default-misc' },
              ] as const
            ).map((slot) => (
              <div key={slot.id} className="flex flex-col gap-1">
                <Label htmlFor={slot.id}>{slot.label}</Label>
                <Select value={slot.value} onValueChange={slot.set}>
                  <SelectTrigger id={slot.id}>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {buckets.map((bucket) => (
                      <SelectItem key={bucket.id} value={bucket.id}>
                        {bucket.slug}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        )}
        <div>
          <Button variant="outline" onClick={handleSaveDefaults} disabled={setDefaults.isPending}>
            {setDefaults.isPending ? <Loader2 className="size-4 animate-spin" data-icon="inline-start" /> : <Save data-icon="inline-start" />}
            Save default buckets
          </Button>
        </div>
      </section>
    </div>
  );
}

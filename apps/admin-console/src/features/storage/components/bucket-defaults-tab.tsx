'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { ErrorState } from '@/shared/state/error-state';
import { useBucketDefaults, useBuckets, useSetBucketDefaults } from '../api/hooks';
import type { BucketDefaults, SetBucketDefaultsRequest, TenantBucket } from '../api/types';

/** Radix Select reserves '', so "not set" maps through a sentinel. */
const NOT_SET = '__not_set__';

interface DefaultSlot {
  key: 'audio' | 'attachments' | 'misc';
  requestKey: 'audioBucketId' | 'attachmentsBucketId' | 'miscBucketId';
  label: string;
  hint: string;
}

const SLOTS: DefaultSlot[] = [
  { key: 'audio', requestKey: 'audioBucketId', label: 'Audio default', hint: 'Consultation recordings land here.' },
  { key: 'attachments', requestKey: 'attachmentsBucketId', label: 'Attachments default', hint: 'Document and file attachments land here.' },
  { key: 'misc', requestKey: 'miscBucketId', label: 'Misc default', hint: 'Everything without a dedicated purpose.' },
];

function DefaultsForm({ defaults, buckets }: { defaults: BucketDefaults; buckets: TenantBucket[] }) {
  const setDefaults = useSetBucketDefaults();
  const [selection, setSelection] = useState<Record<DefaultSlot['key'], string>>({
    audio: defaults.audio?.id ?? NOT_SET,
    attachments: defaults.attachments?.id ?? NOT_SET,
    misc: defaults.misc?.id ?? NOT_SET,
  });

  function handleSave() {
    const body: SetBucketDefaultsRequest = {};
    for (const slot of SLOTS) {
      if (selection[slot.key] !== NOT_SET) body[slot.requestKey] = selection[slot.key];
    }
    setDefaults.mutate(body, {
      onSuccess: () => toast.success('Bucket defaults saved'),
      onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not save the bucket defaults.'),
    });
  }

  return (
    <Card className="gap-4 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Default buckets by purpose</h2>
        <p className="text-muted-foreground text-xs">System writes route to these buckets. Slots without a selection are left unchanged.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {SLOTS.map((slot) => (
          <div key={slot.key} className="flex flex-col gap-2">
            <Label htmlFor={`bucket-default-${slot.key}`}>{slot.label}</Label>
            <Select value={selection[slot.key]} onValueChange={(next) => setSelection((current) => ({ ...current, [slot.key]: next }))}>
              <SelectTrigger id={`bucket-default-${slot.key}`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NOT_SET}>Not set</SelectItem>
                {buckets.map((bucket) => (
                  <SelectItem key={bucket.id} value={bucket.id}>
                    {bucket.name} ({bucket.slug})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">{slot.hint}</p>
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={setDefaults.isPending}>
          {setDefaults.isPending ? <Spinner /> : null}
          Save defaults
        </Button>
      </div>
    </Card>
  );
}

/** Frame 14 defaults editor: purpose -> bucket mapping (GET/PUT .../buckets/defaults). */
export function BucketDefaultsTab() {
  const defaultsQuery = useBucketDefaults();
  const bucketsQuery = useBuckets();

  if (defaultsQuery.isPending || bucketsQuery.isPending) {
    return (
      <Card className="gap-4 p-4">
        <Skeleton className="h-4 w-48" />
        <div className="grid gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      </Card>
    );
  }
  if (defaultsQuery.error || !defaultsQuery.data) {
    return <ErrorState title={'Couldn\u2019t load the bucket defaults'} error={defaultsQuery.error} onRetry={() => defaultsQuery.refetch()} />;
  }

  const defaults = defaultsQuery.data;
  const buckets = bucketsQuery.data ?? [];
  const seedKey = `${defaults.audio?.id ?? ''}:${defaults.attachments?.id ?? ''}:${defaults.misc?.id ?? ''}`;
  return <DefaultsForm key={seedKey} defaults={defaults} buckets={buckets} />;
}

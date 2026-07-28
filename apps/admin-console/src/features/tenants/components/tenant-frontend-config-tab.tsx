'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { formatRelativeTime } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useFrontendConfig, useUpdateFrontendConfig } from '../api/hooks';
import type { TenantFrontendConfig, UpsertTenantFrontendConfigRequest } from '../api/types';

/** The PUT-able subset of the row (server-computed fields stay out). */
const EDITABLE_KEYS = [
  'asrModel',
  'noiseCancel',
  'vad',
  'voiceEnrollment',
  'diarization',
  'captureRawAudio',
  'transcriptionMode',
  'transcriptionModeLocked',
  'captureMode',
  'configJson',
] as const;

function toEditableJson(config: TenantFrontendConfig | null): string {
  if (!config) return '{}';
  const subset: Record<string, unknown> = {};
  for (const key of EDITABLE_KEYS) subset[key] = config[key];
  return JSON.stringify(subset, null, 2);
}

function isOccError(error: unknown): boolean {
  return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

/**
 * Frame 12.1 frontend-config tab (capability row 6): the branding/pipeline
 * flags served to tenant apps, edited as one JSON document with client-side
 * parse validation and the If-Match/expectedVersion OCC contract on the PUT.
 */
export function TenantFrontendConfigTab({ tenantId }: { tenantId: string }) {
  const { data, isLoading, error, refetch } = useFrontendConfig(tenantId);
  const update = useUpdateFrontendConfig();
  const [draft, setDraft] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  if (isLoading) {
    return (
      <Card className="gap-4 p-6">
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-72 w-full" />
        <div className="flex justify-end gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-32" />
        </div>
      </Card>
    );
  }
  if (error) {
    return <ErrorState error={error} onRetry={() => refetch()} />;
  }

  const config = data?.data ?? null;
  const serialized = toEditableJson(config);
  const value = draft ?? serialized;
  const dirty = draft !== null && draft !== serialized;

  function discard() {
    setDraft(null);
    setParseError(null);
    update.reset();
  }

  function handleSave() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      setParseError('The document is not valid JSON. Fix it before saving.');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setParseError('The document must be a JSON object.');
      return;
    }
    setParseError(null);
    update.mutate(
      {
        body: { ...(parsed as UpsertTenantFrontendConfigRequest), ...(config ? { expectedVersion: config.version } : {}) },
        etag: data?.etag ?? undefined,
        tenantId,
      },
      {
        onSuccess: () => {
          toast.success('Frontend config saved');
          setDraft(null);
        },
        onError: (mutationError) => {
          if (!isOccError(mutationError)) {
            toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Could not save the frontend config.');
          }
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <OccConflictAlert
        error={update.error}
        onReload={() => {
          discard();
          refetch();
        }}
      />
      <Card className="gap-4 p-6">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Branding & pipeline flags served to tenant apps</p>
          <p className="text-muted-foreground text-xs">
            {config
              ? `v${config.version} \u00b7 updated ${formatRelativeTime(config.updatedAt)}`
              : 'No frontend config yet \u2014 saving creates it.'}
          </p>
          {config && !config.platformRawCaptureCapable ? (
            <p className="text-muted-foreground text-xs">Platform raw-audio capture is unavailable; captureRawAudio has no effect.</p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="frontend-config-json">Frontend config JSON</Label>
          <Textarea
            id="frontend-config-json"
            value={value}
            onChange={(event) => {
              setDraft(event.target.value);
              setParseError(null);
            }}
            spellCheck={false}
            className="min-h-72 resize-y font-mono text-xs"
          />
          {parseError ? (
            <p role="alert" className="text-destructive text-sm">
              {parseError}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" disabled={!dirty || update.isPending} onClick={discard}>
            Discard
          </Button>
          <Button disabled={!dirty || update.isPending} onClick={handleSave}>
            {update.isPending ? <Spinner /> : null}
            Save changes
          </Button>
        </div>
      </Card>
    </div>
  );
}

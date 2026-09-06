'use client';

import { useId, useState } from 'react';
import { IconPlugConnectedX, IconTestPipe } from '@tabler/icons-react';
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
import { useDeleteProviderConnection, useProviderConnection, usePutProviderConnection, useTestProviderConnection } from '../api/hooks';
import { CONNECTION_CEILINGS, connectionStateOf, declarableService, type ConnectionCeiling, type ConnectionState, type ProviderService } from '../api/types';
import { ConnectionModelsEditor } from './connection-models-editor';
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
 * The three-state vocabulary of a `(service, provider)` row, as the console
 * names it. Mirrors the gateway's `CONNECTION_ENABLED_SEMANTICS`: absent = the
 * platform default may serve; enabled + keyed = this tenant's own credential
 * serves; disabled = a VETO that blocks the platform key too.
 */
const STATE_LABEL: Record<ConnectionState, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  'platform-default': { label: 'Use platform default', variant: 'outline' },
  'bring-your-own': { label: 'Bring your own', variant: 'default' },
  disabled: { label: 'Disabled for this tenant', variant: 'destructive' },
};

/** Parse a ceiling input: blank = clear (null); a positive integer = the cap; anything else = invalid. */
function parseCeiling(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * One `(service, provider)` connection card — the shared masked credential
 * interaction (state badge, a WRITE-ONLY password field, per-provider fields,
 * the TASK-862 connection CEILINGS, an ephemeral "Test connection" probe,
 * inline remove confirmation, toasts, OCC If-Match) generalized over the
 * unified `admin/providers/:service` route so ONE component drives every tab.
 *
 * `tenantId` is the tier the screen selected (SYSTEM or the working tenant);
 * every read and write on this card carries it.
 *
 * The key is never rendered, never returned by any read, and there is no
 * reveal flow — the field always starts empty and reports only Configured /
 * None. The probe re-tests a STORED key without the operator re-entering it.
 */
export function ProviderCredentialCard({
  service,
  meta,
  tenantId,
  enabled: queriesEnabled = true,
}: {
  service: ProviderService;
  meta: ProviderMeta;
  tenantId?: string;
  enabled?: boolean;
}) {
  const uid = useId();
  const query = useProviderConnection(service, meta.id, tenantId, queriesEnabled);
  const putMutation = usePutProviderConnection();
  const deleteMutation = useDeleteProviderConnection();
  const testMutation = useTestProviderConnection();

  const [apiKey, setApiKey] = useState('');
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [ceilingDraft, setCeilingDraft] = useState<Partial<Record<ConnectionCeiling, string>> | null>(null);
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
  const state = connectionStateOf(current);
  const currentColumns = current as unknown as Record<string, unknown>;

  /** Stored value for a field: a column reads its column, an `extra` field reads `extraJson[name]`. */
  const storedValue = (field: ProviderField): string => {
    const raw = field.store === 'extra' ? current.extraJson?.[field.name] : currentColumns[field.name];
    return typeof raw === 'string' ? raw : '';
  };
  const valueOf = (field: ProviderField) => draft?.[field.name] ?? storedValue(field);
  const ceilingValueOf = (name: ConnectionCeiling): string => ceilingDraft?.[name] ?? (current[name] == null ? '' : String(current[name]));

  const invalidCeilings = CONNECTION_CEILINGS.filter((c) => parseCeiling(ceilingValueOf(c.name)) === undefined).map((c) => c.label);
  // A key is required on the FIRST save; afterwards the stored key stays and
  // the other fields (endpoint, ceilings, enabled) can be edited on their own.
  const canSave = invalidCeilings.length === 0 && !putMutation.isPending && (apiKey.trim().length > 0 || hasKey);

  function buildBody(): Record<string, unknown> {
    const body: Record<string, unknown> = { enabled };
    if (apiKey.trim().length > 0) body.apiKey = apiKey.trim();
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
    for (const ceiling of CONNECTION_CEILINGS) {
      body[ceiling.name] = parseCeiling(ceilingValueOf(ceiling.name)) ?? null;
    }
    return body;
  }

  function handleSave() {
    if (!canSave) return;
    putMutation.mutate(
      { service, provider: meta.id, body: buildBody(), etag, tenantId },
      {
        onSuccess: () => {
          toast.success(`${meta.label} connection saved`);
          setApiKey('');
          setDraft(null);
          setCeilingDraft(null);
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

  function handleTest() {
    // Ephemeral: the typed key (if any) plus the drafted endpoint fields; an
    // omitted key means "probe the stored one".
    const body: Record<string, string> = {};
    if (apiKey.trim().length > 0) body.apiKey = apiKey.trim();
    for (const field of meta.fields) {
      if (field.store === 'extra') continue;
      const value = valueOf(field).trim();
      if (value) body[field.name] = value;
    }
    testMutation.mutate(
      { service, provider: meta.id, body, tenantId },
      {
        onSuccess: (result) => {
          const via = result.probe === 'auth' ? 'credential verified' : 'endpoint reachable';
          const from = result.source === 'request' ? 'typed values' : result.source === 'tenant' ? 'the tenant row' : 'the platform row';
          if (result.ok) toast.success(`${meta.label}: ${result.message} (${via}, ${from})`);
          else toast.error(`${meta.label}: ${result.message}`);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  function handleRemove() {
    deleteMutation.mutate(
      { service, provider: meta.id, tenantId },
      {
        onSuccess: () => {
          toast.success(`${meta.label} connection removed — the platform default serves this provider again`);
          setConfirmingRemove(false);
          setDraft(null);
          setCeilingDraft(null);
          setEnabledDraft(null);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${uid}-title`} className="text-sm font-medium">
          {meta.label}
        </h3>
        <Badge variant={STATE_LABEL[state].variant}>{STATE_LABEL[state].label}</Badge>
        {hasKey ? (
          <Badge variant="secondary">key configured{current.keyVersion != null ? ` · v${current.keyVersion}` : ''}</Badge>
        ) : (
          <Badge variant="outline">no key</Badge>
        )}
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

      <fieldset className="flex flex-col gap-2">
        <legend className="text-muted-foreground text-xs font-medium">Ceilings (blank = no opinion)</legend>
        <div className="grid grid-cols-2 gap-2">
          {CONNECTION_CEILINGS.map((ceiling) => (
            <div key={ceiling.name} className="flex flex-col gap-1">
              <Label htmlFor={`${uid}-${ceiling.name}`} className="text-muted-foreground text-xs">
                {ceiling.label}
              </Label>
              <Input
                id={`${uid}-${ceiling.name}`}
                inputMode="numeric"
                value={ceilingValueOf(ceiling.name)}
                onChange={(event) => setCeilingDraft((prev) => ({ ...prev, [ceiling.name]: event.target.value }))}
                placeholder={ceiling.placeholder}
                aria-describedby={`${uid}-${ceiling.name}-help`}
                aria-invalid={parseCeiling(ceilingValueOf(ceiling.name)) === undefined || undefined}
                className="h-8 font-mono text-xs"
              />
              <span id={`${uid}-${ceiling.name}-help`} className="text-muted-foreground text-xs">
                {ceiling.help}
              </span>
            </div>
          ))}
        </div>
        {invalidCeilings.length > 0 ? (
          <p className="text-destructive text-xs" role="alert">
            {invalidCeilings.join(', ')}: enter a positive whole number, or leave blank.
          </p>
        ) : null}
      </fieldset>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Switch id={`${uid}-enabled`} checked={enabled} onCheckedChange={setEnabledDraft} aria-describedby={`${uid}-enabled-help`} />
          <Label htmlFor={`${uid}-enabled`} className="text-muted-foreground text-xs">
            Enabled
          </Label>
        </div>
        {/*
          Turning this OFF is a VETO, not "unused" — it blocks the
          platform-provided key for this provider too, and calls that select it
          fail rather than falling through to another provider. Removing the
          connection entirely returns this provider to "use platform default".
        */}
        <p id={`${uid}-enabled-help`} className="text-muted-foreground pl-10 text-xs">
          {enabled
            ? 'Your credential serves this provider. Remove the connection to fall back to the platform-provided key.'
            : 'Disabled blocks this provider for your tenant entirely — including the platform-provided key. Remove the connection instead to use the platform default.'}
        </p>
      </div>

      {/*
        TASK-890 §3.7a — provider AND model, in one place. Only once a row
        exists: the models are declared ON a connection, so there is nothing to
        hang them off until the credential is saved (the gateway 404s that
        case, and an editor that could only fail is worse than one that waits).
        `discoveredModels` comes from the last probe on THIS card, so "derive"
        reflects the credential the admin just tested.
      */}
      {current.version > 0 && declarableService(service) ? (
        <ConnectionModelsEditor
          service={service}
          provider={meta.id}
          label={meta.label}
          tenantId={tenantId}
          models={current.models ?? []}
          discoveredModels={testMutation.data?.discoveredModels}
        />
      ) : null}

      <OccConflictAlert
        error={putMutation.error}
        onReload={() => {
          // Reload-merge: the typed key and field drafts stay in memory.
          putMutation.reset();
          void query.refetch();
        }}
      />

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleTest}
          disabled={testMutation.isPending || (apiKey.trim().length === 0 && !hasKey)}
          aria-label={`Test the ${meta.label} connection`}
          title={apiKey.trim().length === 0 && !hasKey ? 'Enter a key (or save one) to test this connection' : undefined}
        >
          {testMutation.isPending ? <Spinner /> : <IconTestPipe aria-hidden />}
          Test connection
        </Button>
        {current.version > 0 ? (
          confirmingRemove ? (
            <>
              <span className="text-muted-foreground text-xs">Remove this connection and use the platform default?</span>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingRemove(false)} disabled={deleteMutation.isPending}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={handleRemove} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? <Spinner /> : null}
                Confirm remove
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirmingRemove(true)} aria-label={`Remove the ${meta.label} connection (use platform default)`}>
              <IconPlugConnectedX aria-hidden />
              Use platform default
            </Button>
          )
        ) : null}
        <Button size="sm" onClick={handleSave} disabled={!canSave} aria-label={`${hasKey ? 'Save' : 'Save key'} for ${meta.label} · If-Match`}>
          {putMutation.isPending ? <Spinner /> : null}
          {hasKey ? (apiKey.trim().length > 0 ? 'Rotate key & save' : 'Save') : 'Save key'}
        </Button>
      </div>
    </Card>
  );
}

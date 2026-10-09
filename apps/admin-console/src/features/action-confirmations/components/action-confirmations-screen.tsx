'use client';

import { useMemo, useState } from 'react';
import { IconAlertTriangle, IconChecklist, IconLock, IconRestore } from '@tabler/icons-react';
import { toast } from 'sonner';
import { CONFIRMATION_KINDS, type ConfirmationKind, type ConfirmationMode } from '@arcaai/types';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { ToggleGroup, ToggleGroupItem } from '@arcaai/ui/components/shadcn/toggle-group';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useActionConfirmationRows, usePutActionConfirmations } from '../api/hooks';
import type { ActionConfirmationRow, ActionConfirmationWrite, ActionConfirmationWriteError } from '../api/types';

const KIND_LABELS: Record<ConfirmationKind, string> = {
  reason: 'Reason',
  evidence: 'Evidence',
  acknowledgement: 'Acknowledgement',
  typeToConfirm: 'Typed confirmation',
  reasonCode: 'Reason code',
  breakGlass: 'Break-glass',
  stepUp: 'Password step-up',
};

const MODE_LABELS: Record<ConfirmationMode, string> = {
  required: 'Required',
  'when-risky': 'When risky',
  'not-required': 'Not required',
};

const AUDIENCE_LABELS = { platform: 'Platform', tenant: 'Tenant', both: 'Platform + tenant' } as const;

const ALL_KINDS = 'all';

/** A staged value: a mode, or `null` = reset to the catalogue default. */
type Edits = Record<string, ConfirmationMode | null>;

/** What the server holds for the row: a stored mode, or `null` when no row exists. */
const storedOf = (row: ActionConfirmationRow): ConfirmationMode | null => (row.source === 'system' ? row.mode : null);

const isSwitchable = (row: ActionConfirmationRow) => !row.locked && row.modes.length > 1;

function ScreenSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      {[4, 3].map((rowCount, section) => (
        <div key={section} className="flex flex-col gap-2">
          <Skeleton className="h-5 w-40" />
          <div className="flex flex-col gap-2 rounded-md border p-3">
            {Array.from({ length: rowCount }, (_, index) => (
              <div key={index} className="flex items-center gap-4">
                <Skeleton className="h-4 w-64" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="ml-auto h-8 w-60 rounded-md" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Action confirmations (/action-confirmations, Platform Ops tier 10-19, `(global)` group).
 *
 * The platform-wide switch for which admin actions demand a reason, evidence, acknowledgement or
 * typed confirmation. There is no tenant override (owner decision); the audit log records the policy
 * either way. Edits are STAGED and saved as one batch with a per-row `expectedVersion`; the gateway
 * answers 200 with per-row `errors`, so a drifted row is reported inline instead of discarding the rest.
 */
export function ActionConfirmationsScreen() {
  const query = useActionConfirmationRows();
  const save = usePutActionConfirmations();
  const [edits, setEdits] = useState<Edits>({});
  const [kindFilter, setKindFilter] = useState<string>(ALL_KINDS);
  const [search, setSearch] = useState('');
  const [rowErrors, setRowErrors] = useState<Record<string, ActionConfirmationWriteError>>({});

  const rows = useMemo(() => query.data?.items ?? [], [query.data]);

  const stage = (row: ActionConfirmationRow, next: ConfirmationMode | null) => {
    setEdits((current) => {
      const draft = { ...current };
      // Editing back to the stored value is not an edit.
      if (next === storedOf(row)) delete draft[row.actionId];
      else draft[row.actionId] = next;
      return draft;
    });
    setRowErrors((current) => {
      if (!(row.actionId in current)) return current;
      const { [row.actionId]: _dropped, ...rest } = current;
      return rest;
    });
  };

  /** The mode shown: a staged mode, a staged reset (the catalogue default), or what the server resolved. */
  const modeOf = (row: ActionConfirmationRow): ConfirmationMode => {
    if (row.actionId in edits) return edits[row.actionId] ?? row.default;
    return row.mode;
  };
  const isDefault = (row: ActionConfirmationRow): boolean => {
    if (row.actionId in edits) return edits[row.actionId] === null;
    return row.source === 'default';
  };

  const applyToKind = (kind: ConfirmationKind, mode: ConfirmationMode) => {
    for (const row of rows) {
      if (row.kind === kind && isSwitchable(row) && row.modes.includes(mode) && modeOf(row) !== mode) stage(row, mode);
    }
  };

  const needle = search.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      (kindFilter === ALL_KINDS || row.kind === kindFilter) &&
      (needle === '' || `${row.label} ${row.actionId} ${row.domain}`.toLowerCase().includes(needle)),
  );
  const domains = useMemo(() => {
    const map = new Map<string, ActionConfirmationRow[]>();
    for (const row of visible) {
      const bucket = map.get(row.domain);
      if (bucket) bucket.push(row);
      else map.set(row.domain, [row]);
    }
    return [...map.entries()];
  }, [visible]);
  const switchableKinds = CONFIRMATION_KINDS.filter((kind) => rows.some((row) => row.kind === kind && isSwitchable(row)));

  const dirtyCount = Object.keys(edits).length;
  const drifted = Object.values(rowErrors).some((error) => error.status === 412);

  const onSave = () => {
    const byId = new Map(rows.map((row) => [row.actionId, row]));
    const cells: ActionConfirmationWrite[] = Object.entries(edits).map(([actionId, mode]) => {
      const version = byId.get(actionId)?.version ?? 0;
      // A zero version means no row exists, so there is nothing to precondition a first write against.
      return { actionId, mode, ...(version > 0 ? { expectedVersion: version } : {}) };
    });
    save.mutate(cells, {
      onSuccess: (result) => {
        const failed = new Map(result.errors.map((error) => [error.actionId, error]));
        setRowErrors(Object.fromEntries(failed));
        // Keep only the refused edits staged so they can be retried or discarded.
        setEdits((current) => Object.fromEntries(Object.entries(current).filter(([actionId]) => failed.has(actionId))));
        if (failed.size > 0) toast.error(`${failed.size} of ${cells.length} change(s) were refused.`);
        else toast.success(`${cells.length} confirmation setting(s) saved.`);
      },
      onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not save the action confirmations.'),
    });
  };

  const header = (
    <PageHeader
      title="Action confirmations"
      meta={
        <span>
          which admin actions must give a reason, evidence, acknowledgement or typed confirmation &middot; platform-wide &middot; the audit
          log records the policy either way
        </span>
      }
    />
  );

  if (query.isPending) {
    return (
      <ScreenTemplate header={header}>
        <ScreenSkeleton />
      </ScreenTemplate>
    );
  }
  if (query.error) {
    return (
      <ScreenTemplate header={header}>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </ScreenTemplate>
    );
  }

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={kindFilter} onValueChange={setKindFilter}>
        <SelectTrigger className="w-52" aria-label="Filter by kind">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_KINDS}>All kinds</SelectItem>
          {CONFIRMATION_KINDS.map((kind) => (
            <SelectItem key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input type="search" className="w-64" placeholder="Search actions" aria-label="Search actions" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => { setEdits({}); setRowErrors({}); }} disabled={dirtyCount === 0 || save.isPending}>
          Discard
        </Button>
        <Button size="sm" onClick={onSave} disabled={dirtyCount === 0 || save.isPending}>
          {save.isPending ? <Spinner /> : null}
          Save changes{dirtyCount > 0 ? ` (${dirtyCount})` : ''}
        </Button>
      </div>
    </div>
  );

  const failures = Object.values(rowErrors);

  return (
    <ScreenTemplate
      header={header}
      toolbar={toolbar}
      statusBanner={
        failures.length > 0 ? (
          <Alert variant="destructive">
            <IconAlertTriangle aria-hidden />
            <AlertTitle>{failures.length} change(s) were not applied</AlertTitle>
            <AlertDescription>
              {drifted ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span>Another admin changed some rows since you loaded them.</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setRowErrors({});
                      setEdits({});
                      void query.refetch();
                    }}
                  >
                    Reload latest
                  </Button>
                </div>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : undefined
      }
      footer={
        <StatusFooter
          start={<span>{dirtyCount > 0 ? `${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}` : 'No unsaved changes'}</span>}
          end={
            <span aria-hidden className="font-mono">
              GET /admin/settings/action-confirmations
            </span>
          }
        />
      }
    >
      <div className="flex flex-col gap-6">
        {switchableKinds.length > 0 ? (
          <section aria-labelledby="apply-all-heading" className="flex flex-col gap-2">
            <h2 id="apply-all-heading" className="text-sm font-medium">
              Apply to all
            </h2>
            <p className="text-muted-foreground text-xs">Stages every unlocked row of a kind. Nothing is saved until you press Save changes.</p>
            <div className="flex flex-wrap gap-3">
              {switchableKinds.map((kind) => (
                <div key={kind} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                  <span className="font-medium">{KIND_LABELS[kind]}</span>
                  <Button size="sm" variant="outline" onClick={() => applyToKind(kind, 'required')} aria-label={`Set all ${KIND_LABELS[kind]} to Required`}>
                    Required
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => applyToKind(kind, 'not-required')} aria-label={`Set all ${KIND_LABELS[kind]} to Not required`}>
                    Not required
                  </Button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {domains.length === 0 ? (
          <EmptyState icon={IconChecklist} title="No matching actions" description="Change the kind filter or the search to see more." />
        ) : (
          domains.map(([domain, domainRows]) => (
            <section key={domain} aria-label={domain} className="flex flex-col gap-2">
              <h2 className="text-base font-medium">
                {domain} <span className="text-muted-foreground text-sm font-normal">({domainRows.length})</span>
              </h2>
              <ul className="flex flex-col divide-y rounded-md border">
                {domainRows.map((row) => {
                  const mode = modeOf(row);
                  const error = rowErrors[row.actionId];
                  const dirty = row.actionId in edits;
                  return (
                    <li key={row.actionId} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{row.label}</span>
                          <Badge variant="secondary">{KIND_LABELS[row.kind]}</Badge>
                          <Badge variant="outline">{AUDIENCE_LABELS[row.audience]}</Badge>
                          <Badge variant="outline">{row.enforcement === 'server' ? 'Server' : 'Console only'}</Badge>
                          {isDefault(row) && !row.locked ? <Badge variant="outline">Default</Badge> : null}
                          {dirty ? <Badge>Unsaved</Badge> : null}
                        </div>
                        <span className="text-muted-foreground font-mono text-xs">{row.actionId}</span>
                        {error ? (
                          <p role="alert" className="text-destructive text-sm">
                            {error.message}
                          </p>
                        ) : null}
                      </div>
                      {row.locked ? (
                        <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
                          <IconLock className="size-4" aria-hidden />
                          Always required — cannot be switched off
                        </span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <ToggleGroup
                            type="single"
                            variant="outline"
                            size="sm"
                            aria-label={row.label}
                            value={mode}
                            onValueChange={(next) => {
                              // Radix emits '' when the active item is pressed again; a mode is always chosen.
                              if (next) stage(row, next as ConfirmationMode);
                            }}
                          >
                            {row.modes.map((option) => (
                              <ToggleGroupItem key={option} value={option} aria-label={MODE_LABELS[option]}>
                                {MODE_LABELS[option]}
                              </ToggleGroupItem>
                            ))}
                          </ToggleGroup>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Reset ${row.label} to default`}
                            disabled={isDefault(row) && !dirty}
                            onClick={() => stage(row, null)}
                          >
                            <IconRestore aria-hidden />
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </ScreenTemplate>
  );
}

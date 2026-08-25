'use client';

import { useMemo, useState } from 'react';
import { IconFilterOff, IconPlus, IconShieldOff } from '@tabler/icons-react';
import { type ColumnDef, type SortRule } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import type { FilterOption } from '@/shared/data/filter-bar';
import { formatDateTime, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { CONSENT_PURPOSES, GRANT_METHOD_META, PURPOSE_META, grantLifecycle, useConsentGrants } from '../api';
import type { ConsentGrant, ConsentGrantState } from '../api';
import { ConsentStatusBadge } from './consent-status-badge';
import { RecordConsentDialog } from './record-consent-dialog';
import { RevokeConsentDialog } from './revoke-consent-dialog';

/** Omni search targets (→ gateway `searchFields`) and the implicit sort — stable refs for the hook. */
const CONSENT_SEARCH_FIELDS = ['externalPatientId'];
const CONSENT_DEFAULT_SORT: SortRule[] = [{ id: 'grantedAt', desc: true }];

const PURPOSE_OPTIONS: FilterOption[] = CONSENT_PURPOSES.map((value) => ({ value, label: PURPOSE_META[value].label }));

const STATE_OPTIONS: Array<{ value: ConsentGrantState; label: string }> = [
  { value: 'ACTIVE', label: 'Active only' },
  { value: 'REVOKED', label: 'Withdrawn only' },
  { value: 'ALL', label: 'All grants' },
];

/**
 * Consent register (`/consent`, tier 30-49).
 *
 * Tenant-scoped: grants key on `(tenantId, externalPatientId, purpose)` and a
 * super admin reads them through the working tenant, so the screen sits behind
 * `WorkingTenantGate` like every other 30-49 surface.
 */
export function ConsentScreen() {
  return (
    <WorkingTenantGate
      title="Patient consent"
      meta={<span>Purpose-of-use grants · effective immediately</span>}
      description="Consent grants are tenant-scoped. Pick a working tenant from the top-bar switcher to load its register."
    >
      <ConsentBody />
    </WorkingTenantGate>
  );
}

function ConsentBody() {
  const grid = useAdminGridParams({ searchFields: CONSENT_SEARCH_FIELDS, defaultSort: CONSENT_DEFAULT_SORT });
  // Lifecycle is a dedicated toolbar control rather than a grid facet: it is
  // not a column predicate (it spans `revokedAt` AND `expiresAt` against now),
  // so the server owns it and the grid must not try to filter it client-side.
  const [state, setState] = useState<ConsentGrantState>('ACTIVE');

  const listParams = useMemo(() => ({ ...grid.listParams, state }), [grid.listParams, state]);
  const { data, isLoading, isFetching, error, refetch } = useConsentGrants(listParams);
  const { rows, total } = normalizeList<ConsentGrant>(data, { pageBase: 1 });
  const totalCount = total ?? 0;

  const [recordOpen, setRecordOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ConsentGrant | null>(null);

  const columns = useMemo<ColumnDef<ConsentGrant>[]>(
    () => [
      {
        accessorKey: 'externalPatientId',
        header: 'Patient',
        meta: { label: 'Patient' },
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.externalPatientId}</span>,
        size: 200,
        minSize: 140,
      },
      {
        accessorKey: 'purpose',
        header: 'Purpose',
        enableGlobalFilter: false,
        meta: { label: 'Purpose', variant: 'multiSelect', options: PURPOSE_OPTIONS },
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{PURPOSE_META[row.original.purpose].label}</span>
            <span className="text-muted-foreground line-clamp-1 text-xs">{PURPOSE_META[row.original.purpose].description}</span>
          </div>
        ),
        size: 280,
        minSize: 180,
      },
      {
        id: 'lifecycle',
        header: 'Status',
        enableSorting: false,
        enableGlobalFilter: false,
        meta: { label: 'Status' },
        cell: ({ row }) => <ConsentStatusBadge grant={row.original} />,
        size: 120,
      },
      {
        accessorKey: 'grantMethod',
        header: 'Captured as',
        enableGlobalFilter: false,
        meta: { label: 'Captured as' },
        cell: ({ row }) => <span className="text-sm">{GRANT_METHOD_META[row.original.grantMethod].label}</span>,
        size: 150,
      },
      {
        accessorKey: 'grantedAt',
        header: 'Granted',
        enableGlobalFilter: false,
        meta: { label: 'Granted' },
        cell: ({ row }) => <span className="text-muted-foreground text-xs">{formatRelativeTime(row.original.grantedAt)}</span>,
        size: 130,
      },
      {
        accessorKey: 'expiresAt',
        header: 'Expires',
        enableGlobalFilter: false,
        meta: { label: 'Expires' },
        cell: ({ row }) =>
          row.original.expiresAt ? (
            <span className="text-muted-foreground text-xs">{formatDateTime(row.original.expiresAt)}</span>
          ) : (
            <span className="text-muted-foreground text-xs">No end date</span>
          ),
        size: 160,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        meta: { label: 'Actions' },
        enableSorting: false,
        enableHiding: false,
        enableResizing: false,
        enableGlobalFilter: false,
        size: 130,
        minSize: 130,
        cell: ({ row }) =>
          // Only a live grant can be withdrawn — a withdrawn or expired row has
          // nothing left to revoke, and the gateway would reject it anyway
          // ("Grant is already revoked").
          grantLifecycle(row.original) === 'ACTIVE' ? (
            <span className="flex w-full items-center justify-end">
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Withdraw ${PURPOSE_META[row.original.purpose].label} consent for ${row.original.externalPatientId}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setRevokeTarget(row.original);
                }}
              >
                Withdraw
              </Button>
            </span>
          ) : null,
      },
    ],
    [],
  );

  return (
    <>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            title="Patient consent"
            meta={<span>Purpose-of-use grants · effective immediately</span>}
            actions={
              <Button onClick={() => setRecordOpen(true)}>
                <IconPlus aria-hidden data-icon="inline-start" />
                Record consent
              </Button>
            }
          />
        }
        toolbar={
          <div className="flex items-center gap-2">
            <label htmlFor="consent-state" className="text-muted-foreground text-sm">
              Show
            </label>
            <Select value={state} onValueChange={(next) => setState(next as ConsentGrantState)}>
              <SelectTrigger id="consent-state" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
        footer={
          <StatusFooter
            start={<span>{isFetching && !isLoading ? 'Refreshing' : 'Up to date'}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/consent-grants · {totalCount} grant{totalCount === 1 ? '' : 's'}
              </span>
            }
          />
        }
      >
        <AdminDataGrid<ConsentGrant>
          gridId="consent-grants"
          aria-label="Patient consent grants"
          columns={columns}
          rows={rows}
          total={totalCount}
          queryState={grid.queryState}
          onQueryStateChange={grid.setQueryState}
          isLoading={isLoading}
          isBusy={isFetching && !isLoading}
          error={error ?? undefined}
          onRetry={() => void refetch()}
          emptyState={
            <EmptyState
              icon={IconShieldOff}
              title={state === 'ACTIVE' ? 'No active consent on record' : 'No consent grants yet'}
              description="Nothing is consented in this tenant, so every AI documentation and history-retrieval call for these patients will be refused. Record a grant to unblock them."
              action={
                <Button onClick={() => setRecordOpen(true)}>
                  <IconPlus aria-hidden data-icon="inline-start" />
                  Record consent
                </Button>
              }
            />
          }
          emptyFilteredState={<EmptyState icon={IconFilterOff} title="No grants match the filters" description="Adjust the search or filters." />}
        />
      </ScreenTemplate>

      <RecordConsentDialog open={recordOpen} onOpenChange={setRecordOpen} onRecorded={() => void refetch()} />
      <RevokeConsentDialog
        grant={revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        onRevoked={() => void refetch()}
      />
    </>
  );
}

'use client';

import { useState, type ReactNode } from 'react';
import { IconAdjustmentsHorizontal, IconInfoCircle } from '@tabler/icons-react';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { useSession } from '@/shared/auth';
import { FilterBar, FilterSearch, FilterSelect } from '@/shared/data/filter-bar';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { usePipelinePolicyEffective, usePipelinePolicyRow, useSystemPipelinePolicyRow, type PipelinePolicyRow, type PipelineToggleKey } from '../api';
import {
  EM_DASH,
  resolveInherited,
  systemPin,
  toggleColumnByParam,
  toggleLabel,
  TOGGLE_COLUMNS,
  winningTier,
  type CascadeRows,
  type CascadeTier,
  type ToggleColumn,
} from './cascade';
import { ScopeRowEditor } from './scope-row-editor';

const SCOPE_FILTER_OPTIONS = [
  { value: 'SYSTEM', label: 'system' },
  { value: 'TENANT', label: 'tenant' },
  { value: 'DEPARTMENT', label: 'department' },
  { value: 'DOCTOR', label: 'doctor' },
];

interface MatrixRow {
  tier: CascadeTier;
  label: string;
  row: PipelinePolicyRow | null;
  pending: boolean;
}

/** One matrix/resolve-card pin cell — dash = inherit, `?` = not readable. */
function PinCell({
  tier,
  row,
  keyName,
  rows,
  showEffective,
}: {
  tier: CascadeTier;
  row: PipelinePolicyRow | null;
  keyName: PipelineToggleKey;
  rows: CascadeRows;
  showEffective: boolean;
}): ReactNode {
  const pin = tier === 'SYSTEM' && !row ? systemPin(keyName, rows) : (row?.[keyName] ?? null);
  if (pin === undefined) {
    return (
      <span className="text-muted-foreground" title="Not readable from this session">
        ?
      </span>
    );
  }
  if (pin === null) {
    const resolved = showEffective ? resolveInherited(keyName, tier, rows) : null;
    if (resolved === null) return <span className="text-muted-foreground">{EM_DASH}</span>;
    return <span className="text-muted-foreground">{`${toggleLabel(keyName, resolved)} \u00b7 inh`}</span>;
  }
  return toggleLabel(keyName, pin);
}

/**
 * Cascade resolve card (frame 39 panel a) — one key, every tier's pin with
 * the winning (nearest defined) tier marked, and the EFFECTIVE line.
 */
function CascadeResolveCard({ column, matrixRows, rows }: { column: ToggleColumn; matrixRows: MatrixRow[]; rows: CascadeRows }) {
  const winner = winningTier(column.key, rows.effective);
  const effective = rows.effective;
  return (
    <Card className="gap-3 p-4" role="group" aria-label={`Cascade resolve for ${column.param}`}>
      <h2 className="text-sm font-medium">Cascade resolve &middot; one key</h2>
      <div className="flex flex-col gap-1 font-mono text-xs">
        <p className="text-muted-foreground">{column.param}</p>
        {matrixRows.map((matrixRow) => {
          const wins = winner === matrixRow.tier;
          return (
            <p key={matrixRow.tier} className={wins ? 'font-medium' : undefined}>
              <span className="text-muted-foreground">{matrixRow.label}</span>{' '}
              <PinCell tier={matrixRow.tier} row={matrixRow.row} keyName={column.key} rows={rows} showEffective={false} />
              {wins ? <span> {'\u2190'} wins</span> : null}
            </p>
          );
        })}
        {effective ? (
          <p className="mt-1 font-medium">
            EFFECTIVE {toggleLabel(column.key, effective[column.key])}
            {winner === null ? <span className="text-muted-foreground font-normal"> (code default)</span> : null}
          </p>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">Nearest defined scope wins.</p>
    </Card>
  );
}

/** Skeletons mirroring the resolve card / matrix / editor panels (rule 10). */
function ScreenSkeleton() {
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_minmax(0,1.2fr)]" aria-hidden>
      <Skeleton className="h-52" />
      <div className="flex flex-col gap-3 rounded-md border p-3">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
      <Skeleton className="h-52" />
    </div>
  );
}

/**
 * Frame 39 — Pipeline Policy (/harness/pipeline-policy, tier 30-49). Despite
 * the page's former "Realtime" name, these toggles are consumed ONLY by the
 * POST-consultation pipeline (`consultation-event.handler.ts`) — the live
 * transcription / live-NER / partial-summarization lane
 * (`LiveDocumentationService`) never reads them (F-23, item 7). The
 * status banner and the toggle labels below exist so an admin does not read
 * this screen as a live-lane kill-switch.
 *
 * The API exposes one row per (scope, scopeId) — there is no list-all-rows
 * endpoint — so the matrix shows the SYSTEM + TENANT tiers plus the rows for
 * the department/doctor IDs entered in the context filters, which also drive
 * the effective resolution.
 */
export function PipelinePolicyScreen() {
  const meta = (
    <>
      <span>
        Cascade: system {'\u2192'} tenant {'\u2192'} department {'\u2192'} user
      </span>
      <span aria-hidden>&middot;</span>
      <span>separate subject from HarnessPolicy (by design)</span>
    </>
  );
  const session = useSession();
  const isElevated = session.data?.isElevated ?? false;

  const [scopeFilter, setScopeFilter] = useQueryState('scope', parseAsString.withDefault(''));
  const [keyParam, setKeyParam] = useQueryState('key', parseAsString.withDefault('auto-summary'));
  const [showEffective, setShowEffective] = useQueryState('effective', parseAsBoolean.withDefault(true));
  const [department, setDepartment] = useQueryState('department', parseAsString.withDefault(''));
  const [doctor, setDoctor] = useQueryState('doctor', parseAsString.withDefault(''));
  const [selectedTier, setSelectedTier] = useState<CascadeTier | null>(null);

  const effectiveQuery = usePipelinePolicyEffective({ departmentId: department || undefined, doctorId: doctor || undefined });
  const tenantRowQuery = usePipelinePolicyRow('TENANT', null);
  const departmentRowQuery = usePipelinePolicyRow('DEPARTMENT', department || null, department !== '');
  const doctorRowQuery = usePipelinePolicyRow('DOCTOR', doctor || null, doctor !== '');
  const systemRowQuery = useSystemPipelinePolicyRow(isElevated);

  const rows: CascadeRows = {
    effective: effectiveQuery.data ?? null,
    systemRow: systemRowQuery.data?.data ?? null,
    tenantRow: tenantRowQuery.data?.data ?? null,
    departmentRow: department ? (departmentRowQuery.data?.data ?? null) : null,
    doctorRow: doctor ? (doctorRowQuery.data?.data ?? null) : null,
  };

  const chosenColumn = toggleColumnByParam(keyParam);
  // A dept/doctor selection is only meaningful while its context ID is set.
  const selection =
    selectedTier === null || (selectedTier === 'DEPARTMENT' && !department) || (selectedTier === 'DOCTOR' && !doctor) ? null : selectedTier;

  const pending = effectiveQuery.isPending || tenantRowQuery.isPending;
  const blockError =
    effectiveQuery.error ?? tenantRowQuery.error ?? (department ? departmentRowQuery.error : null) ?? (doctor ? doctorRowQuery.error : null);

  const matrixRows: MatrixRow[] = [
    { tier: 'SYSTEM' as const, label: 'system', row: rows.systemRow, pending: isElevated && systemRowQuery.isPending },
    { tier: 'TENANT' as const, label: 'tenant', row: rows.tenantRow, pending: false },
    ...(department
      ? [{ tier: 'DEPARTMENT' as const, label: `dept ${department}`, row: rows.departmentRow, pending: departmentRowQuery.isPending }]
      : []),
    ...(doctor ? [{ tier: 'DOCTOR' as const, label: `doctor ${doctor}`, row: rows.doctorRow, pending: doctorRowQuery.isPending }] : []),
  ];
  const visibleRows = scopeFilter ? matrixRows.filter((row) => row.tier === scopeFilter) : matrixRows;

  const overridesExist = [tenantRowQuery.data, department ? departmentRowQuery.data : null, doctor ? doctorRowQuery.data : null].some(
    (result) => result && result.data.version > 0,
  );
  const showEmpty = !pending && !blockError && !overridesExist && selection === null;

  const scopeIdFor = (tier: CascadeTier): string | null => (tier === 'DEPARTMENT' ? department : tier === 'DOCTOR' ? doctor : null);
  const selectedQuery =
    selection === 'TENANT' ? tenantRowQuery : selection === 'DEPARTMENT' ? departmentRowQuery : selection === 'DOCTOR' ? doctorRowQuery : null;
  const selectedLabel = matrixRows.find((row) => row.tier === selection)?.label ?? 'tenant';
  const previewSubject = doctor ? `doctor ${doctor}${department ? ` @ dept ${department}` : ''}` : department ? `dept ${department}` : 'tenant';

  return (
    <WorkingTenantGate title="Pipeline Policy (Post-Consultation)" meta={meta}>
      <ScreenTemplate
        header={<PageHeader title="Pipeline Policy (Post-Consultation)" meta={meta} />}
        statusBanner={
          <Alert>
            <IconInfoCircle aria-hidden />
            <AlertTitle>Post-consultation only</AlertTitle>
            <AlertDescription>
              These toggles control the pipeline that runs after a consultation recording ends. They do not affect live transcription, live entity
              extraction, or partial summarization while the consultation is in progress.
            </AlertDescription>
          </Alert>
        }
        toolbar={
          <FilterBar>
            <FilterSelect
              id="pp-scope"
              label="Scope"
              value={scopeFilter}
              onChange={(next) => void setScopeFilter(next || null)}
              options={SCOPE_FILTER_OPTIONS}
            />
            <div className="flex items-center gap-1.5">
              <Label htmlFor="pp-key" className="text-muted-foreground text-sm font-normal">
                Key:
              </Label>
              <Select value={chosenColumn.param} onValueChange={(next) => void setKeyParam(next === 'auto-summary' ? null : next)}>
                <SelectTrigger id="pp-key" size="sm" className="min-w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TOGGLE_COLUMNS.map((column) => (
                    <SelectItem key={column.param} value={column.param}>
                      {column.param}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <Label htmlFor="pp-effective" className="text-muted-foreground text-sm font-normal">
                Show effective:
              </Label>
              <Switch id="pp-effective" checked={showEffective} onCheckedChange={(next) => void setShowEffective(next ? null : false)} />
            </div>
            <FilterSearch
              label="Department ID context"
              placeholder={'Department ID\u2026'}
              value={department}
              onChange={(value) => void setDepartment(value || null)}
            />
            <FilterSearch
              label="Doctor ID context"
              placeholder={'Doctor user ID\u2026'}
              value={doctor}
              onChange={(value) => void setDoctor(value || null)}
            />
          </FilterBar>
        }
        footer={
          <StatusFooter
            end={
              <span aria-hidden className="font-mono">
                GET /admin/harness/pipeline-policy
              </span>
            }
          />
        }
      >
        {pending ? (
          <ScreenSkeleton />
        ) : blockError ? (
          <ErrorState
            error={blockError}
            onRetry={() => {
              void effectiveQuery.refetch();
              void tenantRowQuery.refetch();
              if (department) void departmentRowQuery.refetch();
              if (doctor) void doctorRowQuery.refetch();
            }}
          />
        ) : showEmpty ? (
          <EmptyState
            icon={IconAdjustmentsHorizontal}
            title="No scope overrides yet"
            description="All rows inherit the system defaults. Adding a scope row pins toggles for this tenant, a department or a doctor."
            action={<Button onClick={() => setSelectedTier('TENANT')}>Add scope row</Button>}
          />
        ) : (
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_minmax(0,1.2fr)]">
            <CascadeResolveCard column={chosenColumn} matrixRows={matrixRows} rows={rows} />
            <div className="flex flex-col gap-2">
              {/* Fixed cascade matrix (tiers × toggle keys), not a paginated list —
                                design-spec Rule 3 "non-list display" → the shadcn Table primitive. */}
              <div className="rounded-md border">
                <Table aria-label="Pipeline policy scope rows">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col" className="font-mono text-xs">
                        Scope
                      </TableHead>
                      {TOGGLE_COLUMNS.map((column) => (
                        <TableHead scope="col" key={column.key} className="font-mono text-xs">
                          {column.heading}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleRows.map((matrixRow) => (
                      <TableRow key={matrixRow.tier} className="cursor-pointer" onClick={() => setSelectedTier(matrixRow.tier)}>
                        {/* The row-wide onClick is a pointer affordance only; the scope
                            cell carries a real <button> so the editor is reachable by
                            keyboard too (WCAG 2.1.1). Both call the same setter. */}
                        <TableHead scope="row" className="h-auto p-0 font-normal">
                          <button
                            type="button"
                            className="focus-visible:ring-ring/50 w-full px-2 py-2 text-left font-mono text-xs focus-visible:ring-[3px] focus-visible:outline-none"
                            aria-pressed={selectedTier === matrixRow.tier}
                            onClick={() => setSelectedTier(matrixRow.tier)}
                          >
                            {matrixRow.label}
                          </button>
                        </TableHead>
                        {TOGGLE_COLUMNS.map((column) => (
                          <TableCell key={column.key} className="font-mono text-xs">
                            {matrixRow.pending ? (
                              <Skeleton className="h-4 w-10" />
                            ) : (
                              <PinCell tier={matrixRow.tier} row={matrixRow.row} keyName={column.key} rows={rows} showEffective={showEffective} />
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-muted-foreground text-xs">
                Cascade matrix &middot; row click {'\u2192'} scope editor &middot; {EM_DASH} = inherit from parent scope
              </p>
            </div>
            {selection === null ? (
              <Card className="gap-2 p-4">
                <h2 className="text-sm font-medium">Effective preview &middot; PUT row</h2>
                <p className="text-muted-foreground text-sm">
                  Select a matrix row to edit its pins. <span className="font-mono text-xs">PUT /admin/harness/pipeline-policy/row</span> upserts one
                  scope row &mdash; preview recomputes before save.
                </p>
              </Card>
            ) : selection === 'SYSTEM' ? (
              <Card className="gap-2 p-4">
                <h2 className="text-sm font-medium">SYSTEM defaults</h2>
                <p className="text-muted-foreground text-sm">The SYSTEM tier is the platform default row and is read-only on this tenant surface.</p>
                <div>
                  <Button variant="outline" size="sm" onClick={() => setSelectedTier(null)}>
                    Close
                  </Button>
                </div>
              </Card>
            ) : selectedQuery?.data ? (
              <ScopeRowEditor
                key={`${selection}:${scopeIdFor(selection) ?? ''}`}
                scope={selection}
                scopeId={scopeIdFor(selection)}
                scopeLabel={selectedLabel}
                row={selectedQuery.data.data}
                etag={selectedQuery.data.etag}
                rows={rows}
                previewSubject={previewSubject}
                context={{ department: department || null, doctor: doctor || null }}
                isElevated={isElevated}
                onReloadLatest={() => {
                  void selectedQuery.refetch();
                  void effectiveQuery.refetch();
                }}
                onClose={() => setSelectedTier(null)}
              />
            ) : (
              <Skeleton className="h-52" />
            )}
          </div>
        )}
      </ScreenTemplate>
    </WorkingTenantGate>
  );
}

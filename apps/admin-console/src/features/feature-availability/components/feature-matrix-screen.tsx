'use client';

import { useMemo, useState } from 'react';
import { IconAlertTriangle, IconRestore, IconToggleLeft } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useFeatureMatrix, usePutFeatureMatrix } from '../api/hooks';
import { PLATFORM_COLUMN, type FeatureMatrix, type FeatureMatrixFeature, type FeatureMatrixWrite } from '../api/types';
import { TriStateCell, columnLabel, type CellValue } from './tri-state-cell';

/**
 * Sub-area for a feature key, so the matrix reads as sections rather than as one
 * undifferentiated list. Derived from the key's own namespace — the registry
 * already groups by category, and a second hand-maintained table of key → area
 * would be one more thing to forget to update.
 */
function subAreaOf(key: string): string {
  if (key.startsWith('console.')) return 'Console screens';
  if (key.startsWith('registration.')) return 'Registration';
  if (key.startsWith('workflowExposure.')) return 'Workflows';
  if (key.startsWith('consultation.') || key.startsWith('liveDoc.')) return 'Consultation';
  return 'Other';
}

// Composite cell id. `|` cannot occur in a tenant id (uuid / 'system') or a descriptor key (dotted name).
const CELL_KEY_SEPARATOR = '|';
const cellKey = (key: string, tenantId: string) => `${tenantId}${CELL_KEY_SEPARATOR}${key}`;

interface EditState {
  [composite: string]: CellValue;
}

function FeatureMatrixSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      {Array.from({ length: 2 }, (_, section) => (
        <div key={section} className="flex flex-col gap-2">
          <Skeleton className="h-5 w-40" />
          <div className="flex flex-col gap-2 rounded-md border p-3">
            {Array.from({ length: 4 }, (_, row) => (
              <div key={row} className="flex items-center gap-4">
                <Skeleton className="h-4 w-56" />
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="size-8 rounded-md" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Feature availability (/features, Platform Ops tier 10-19, `(global)` group).
 *
 * -- WHAT THIS REPLACES (TASK-932 R-8) --------------------------------------
 * "Feature Flags" used to mean three different things at once: env gates nobody
 * could write, consultation kill-switches, and a legacy `GlobalSetting`
 * namespace of advisory rows with no reader. This screen is the one place a
 * platform admin decides which features exist, and for whom.
 *
 * -- THE THIRD STATE IS THE POINT (D-3) -------------------------------------
 * Availability is CONFIGURATION, so it cascades: tenant -> SYSTEM -> descriptor
 * default. A cell therefore has three values, not two — on, off, and "no
 * opinion, follow the platform" — and reset means REMOVING the tenant row, not
 * copying the platform's current value into it. Copying looks identical today
 * and diverges silently the next time the platform default moves, leaving a
 * tenant pinned to a number nobody chose. (It is deliberately NOT a
 * `TenantEntitlement` column: entitlements bound what a tenant may set, they
 * never supply a value — rule 09.)
 *
 * -- WHY EDITS BATCH ---------------------------------------------------------
 * A matrix invites several changes at once, and each cell is a separate
 * `GlobalSetting` row under a separate tenant with its own version. One save
 * sends them together, and the gateway answers 200 either way with per-cell
 * errors: a single drifted cell must not discard the rest of the screen, and
 * must say WHICH cell to re-read.
 */
export function FeatureMatrixScreen() {
  const matrixQuery = useFeatureMatrix();
  const save = usePutFeatureMatrix();
  const [edits, setEdits] = useState<EditState>({});
  /** Below `md` the grid degrades to one tenant at a time. */
  const [mobileTenant, setMobileTenant] = useState<string>(PLATFORM_COLUMN);

  const matrix: FeatureMatrix | undefined = matrixQuery.data;

  const stored = useMemo(() => {
    const map = new Map<string, { value: CellValue; version: number }>();
    for (const cell of matrix?.cells ?? []) map.set(cellKey(cell.key, cell.tenantId), { value: cell.value, version: cell.version });
    return map;
  }, [matrix]);

  const sections = useMemo(() => {
    const map = new Map<string, FeatureMatrixFeature[]>();
    for (const feature of matrix?.features ?? []) {
      const area = subAreaOf(feature.key);
      const bucket = map.get(area);
      if (bucket) bucket.push(feature);
      else map.set(area, [feature]);
    }
    return [...map.entries()];
  }, [matrix]);

  const columns = useMemo(
    () => [{ id: PLATFORM_COLUMN, name: 'Platform default' }, ...(matrix?.tenants ?? []).map((t) => ({ id: t.id, name: t.name }))],
    [matrix],
  );

  const valueOf = (key: string, tenantId: string): CellValue => {
    const composite = cellKey(key, tenantId);
    if (composite in edits) return edits[composite] as CellValue;
    return stored.get(composite)?.value ?? null;
  };

  /** What a tenant cell resolves to when it holds no opinion: the platform cell. */
  const platformValueOf = (feature: FeatureMatrixFeature): boolean => {
    const platform = valueOf(feature.key, PLATFORM_COLUMN);
    return platform ?? feature.default;
  };

  const setCell = (key: string, tenantId: string, next: CellValue) => {
    const composite = cellKey(key, tenantId);
    const original = stored.get(composite)?.value ?? null;
    setEdits((current) => {
      const draft = { ...current };
      // Editing back to the stored value is not an edit — dropping it keeps the
      // dirty count honest and stops a no-op landing in the batch.
      if (next === original) delete draft[composite];
      else draft[composite] = next;
      return draft;
    });
  };

  const resetRow = (feature: FeatureMatrixFeature) => {
    setEdits((current) => {
      const draft = { ...current };
      for (const column of columns) {
        if (column.id === PLATFORM_COLUMN) continue;
        const composite = cellKey(feature.key, column.id);
        if ((stored.get(composite)?.value ?? null) === null) delete draft[composite];
        else draft[composite] = null;
      }
      return draft;
    });
  };

  const dirtyCount = Object.keys(edits).length;

  // Shared between the desktop grid and the sub-md list (m1) — a feature with
  // no per-tenant row has nothing to reset per tenant.
  const resettableFeatures = sections.flatMap(([, features]) => features).filter((feature) => feature.maxScope !== 'system');

  const onSave = () => {
    const cells: FeatureMatrixWrite[] = Object.entries(edits).map(([composite, value]) => {
      const [tenantId, key] = composite.split(CELL_KEY_SEPARATOR);
      const version = stored.get(composite)?.version ?? 0;
      return {
        key: key!,
        tenantId: tenantId!,
        value,
        // A zero version means no row exists, so there is nothing to
        // precondition a first write against — sending it would 412 forever.
        ...(version > 0 ? { expectedVersion: version } : {}),
      };
    });

    save.mutate(cells, {
      onSuccess: (result) => {
        setEdits({});
        if (result.errors.length > 0) {
          toast.error(`${result.errors.length} of ${cells.length} change(s) were refused — reload and re-apply those cells.`);
          return;
        }
        toast.success(`${cells.length} feature change(s) saved.`);
      },
      onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not save the feature matrix.'),
    });
  };

  const header = (
    <PageHeader
      title="Feature availability"
      meta={<span>which features exist, per tenant &middot; a blank cell inherits the platform default</span>}
      actions={
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEdits({})} disabled={dirtyCount === 0 || save.isPending}>
            Discard
          </Button>
          <Button size="sm" onClick={onSave} disabled={dirtyCount === 0 || save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save changes{dirtyCount > 0 ? ` (${dirtyCount})` : ''}
          </Button>
        </div>
      }
    />
  );

  if (matrixQuery.isPending) {
    return (
      <ScreenTemplate header={header}>
        <FeatureMatrixSkeleton />
      </ScreenTemplate>
    );
  }

  if (matrixQuery.error) {
    return (
      <ScreenTemplate header={header}>
        <ErrorState error={matrixQuery.error} onRetry={() => void matrixQuery.refetch()} />
      </ScreenTemplate>
    );
  }

  if (sections.length === 0) {
    return (
      <ScreenTemplate header={header}>
        <EmptyState
          icon={IconToggleLeft}
          title="No feature-availability settings"
          description="The registry declares no keys in the Feature Availability category."
        />
      </ScreenTemplate>
    );
  }

  const failures = save.data?.errors ?? [];

  return (
    <ScreenTemplate
      header={header}
      statusBanner={
        failures.length > 0 ? (
          <Alert variant="destructive">
            <IconAlertTriangle aria-hidden />
            <AlertTitle>{failures.length} change(s) were not applied</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {failures.map((failure) => (
                  <li key={`${failure.tenantId}-${failure.key}`}>
                    <span className="font-mono text-xs">{failure.key}</span> · {columnLabel(failure.tenantId, matrix?.tenants.find((t) => t.id === failure.tenantId)?.name)} —{' '}
                    {failure.message}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : undefined
      }
      footer={
        <StatusFooter
          start={
            <span>
              {matrix?.features.length ?? 0} feature(s) &times; {columns.length} column(s)
              {dirtyCount > 0 ? ` · ${dirtyCount} unsaved change(s)` : ' · no unsaved changes'}
            </span>
          }
          end={
            <span aria-hidden className="font-mono">
              GET /admin/settings/features/matrix
            </span>
          }
        />
      }
    >
      {/* Desktop: the full grid. One horizontal scroll container, first column
          sticky, so the feature never scrolls out from under its own row. */}
      <div className="hidden md:block">
        <div tabIndex={0} role="region" aria-label="Feature availability matrix" className="overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Feature availability per tenant. Each cell is a three-state control: on, off, or inheriting the platform default.
            </caption>
            <thead>
              <tr className="bg-muted/40">
                <th scope="col" className="bg-muted/40 sticky left-0 z-10 min-w-64 p-3 text-left font-medium">
                  Feature
                </th>
                {columns.map((column) => (
                  <th key={column.id} scope="col" className="min-w-32 p-3 text-center font-medium">
                    {column.name}
                  </th>
                ))}
              </tr>
            </thead>
            {sections.map(([area, features]) => (
              <tbody key={area}>
                <tr>
                  <th scope="colgroup" colSpan={columns.length + 1} className="bg-muted/20 text-muted-foreground p-2 text-left text-xs font-medium">
                    {area}
                  </th>
                </tr>
                {features.map((feature) => {
                  const platformOnly = feature.maxScope === 'system';
                  return (
                    <tr key={feature.key} className="border-t">
                      <th scope="row" className="bg-background sticky left-0 z-10 max-w-80 p-3 text-left font-normal">
                        <span className="flex flex-col gap-0.5">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium">{feature.label ?? feature.key}</span>
                            {feature.killSwitch ? <Badge variant="outline">Off by default</Badge> : null}
                            {platformOnly ? <Badge variant="secondary">Platform-wide only</Badge> : null}
                          </span>
                          <span className="text-muted-foreground font-mono text-xs">{feature.key}</span>
                        </span>
                      </th>
                      {columns.map((column) => {
                        const isPlatform = column.id === PLATFORM_COLUMN;
                        const composite = cellKey(feature.key, column.id);
                        const raw = valueOf(feature.key, column.id);
                        return (
                          <td key={column.id} className="p-3 text-center">
                            <TriStateCell
                              value={isPlatform ? (raw ?? feature.default) : raw}
                              inheritedValue={isPlatform ? feature.default : platformValueOf(feature)}
                              label={`${feature.label ?? feature.key} for ${column.name}`}
                              disabled={platformOnly && !isPlatform}
                              disabledReason={
                                platformOnly
                                  ? 'This feature has no per-tenant row: its consumer has no tenant to resolve against, so an override could never take effect.'
                                  : undefined
                              }
                              dirty={composite in edits}
                              twoState={isPlatform}
                              usingDefault={isPlatform && raw === null}
                              onChange={(next) => setCell(feature.key, column.id, next)}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {resettableFeatures.length > 0 ? (
            <span className="text-muted-foreground text-xs">Reset a whole row to the platform default:</span>
          ) : null}
          {resettableFeatures.map((feature) => (
            <Button
              key={feature.key}
              variant="outline"
              size="sm"
              onClick={() => resetRow(feature)}
              aria-label={`Reset ${feature.label ?? feature.key} for every tenant to the platform default`}
            >
              <IconRestore aria-hidden />
              {feature.label ?? feature.key}
            </Button>
          ))}
        </div>
      </div>

      {/* Below md: one tenant at a time. A 2-D grid does not survive a phone
          viewport, and horizontal scrolling a matrix on touch loses the row
          heading the cell belongs to. */}
      <div className="flex flex-col gap-4 md:hidden">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="feature-matrix-tenant">Column</Label>
          <Select value={mobileTenant} onValueChange={setMobileTenant}>
            <SelectTrigger id="feature-matrix-tenant">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {columns.map((column) => (
                <SelectItem key={column.id} value={column.id}>
                  {column.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {sections.map(([area, features]) => (
          <section key={area} className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">{area}</h2>
            <ul className="flex flex-col gap-2 rounded-md border p-3">
              {features.map((feature) => {
                const isPlatform = mobileTenant === PLATFORM_COLUMN;
                const platformOnly = feature.maxScope === 'system';
                const raw = valueOf(feature.key, mobileTenant);
                return (
                  <li key={feature.key} className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{feature.label ?? feature.key}</span>
                      <span className="text-muted-foreground truncate font-mono text-xs">{feature.key}</span>
                    </span>
                    <TriStateCell
                      value={isPlatform ? (raw ?? feature.default) : raw}
                      inheritedValue={isPlatform ? feature.default : platformValueOf(feature)}
                      label={`${feature.label ?? feature.key} for ${columnLabel(mobileTenant, columns.find((c) => c.id === mobileTenant)?.name)}`}
                      disabled={platformOnly && !isPlatform}
                      disabledReason="This feature has no per-tenant row."
                      dirty={cellKey(feature.key, mobileTenant) in edits}
                      twoState={isPlatform}
                      usingDefault={isPlatform && raw === null}
                      onChange={(next) => setCell(feature.key, mobileTenant, next)}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {resettableFeatures.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-xs">Reset a whole row to the platform default:</span>
            <div className="flex flex-wrap items-center gap-2">
              {resettableFeatures.map((feature) => (
                <Button
                  key={feature.key}
                  variant="outline"
                  size="sm"
                  onClick={() => resetRow(feature)}
                  aria-label={`Reset ${feature.label ?? feature.key} for every tenant to the platform default`}
                >
                  <IconRestore aria-hidden />
                  {feature.label ?? feature.key}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </ScreenTemplate>
  );
}

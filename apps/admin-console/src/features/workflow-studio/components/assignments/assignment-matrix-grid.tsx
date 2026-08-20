'use client';

/**
 * Assignment matrix table (TASK-733 half (a) Task 6). Rows = a synthetic
 * "Tenant default" row + the tenant's departments; columns = the code-owned
 * palettes (never hard-coded — derived from the node registry by the screen).
 * Follows `features/rbac/components/permission-matrix.tsx`'s shape for a
 * fixed (non-paginated, non-virtualized) matrix: a plain `<table>` with a
 * sticky first column inside its own horizontally-scrollable region, rather
 * than `VirtualizedDataGrid` (built for row-per-record lists with server-side
 * sort/filter/pagination — not a fit for a small, densely-headed matrix whose
 * cells are interactive pickers). The search toolbar lives INSIDE this
 * component, above the table, per rule 13 ("a matrix/grid page puts its
 * toolbar inside the grid, not the template's toolbar slot").
 */
import { useId, useMemo, useState } from 'react';
import { IconBuilding, IconLayoutGrid, IconSearch } from '@tabler/icons-react';
import { Badge, Input, Label } from '@arcaai/ui';
import { EmptyState } from '@/shared/state/empty-state';
import { humanizeKey } from '../../lib/schema-form';
import {
  resolveDepartmentCell,
  resolveTenantCell,
  type AssignmentCellSource,
  type ResolvedAssignmentCell,
} from '../../lib/assignment-cascade';
import type { DepartmentOption, WorkflowAssignment } from '../../api/types';

export const TENANT_ROW_ID = '__tenant__';

export interface MatrixCellTarget {
  scope: 'TENANT' | 'DEPARTMENT';
  scopeId: string | null;
  scopeLabel: string;
  paletteKey: string;
  paletteLabel: string;
  cell: ResolvedAssignmentCell;
}

/** Never by color alone (rule 11 §11) — every state pairs a badge label with a distinct variant. */
const SOURCE_BADGE: Record<AssignmentCellSource, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  explicit: { label: 'Explicit', variant: 'default' },
  tenant: { label: 'Inherits tenant', variant: 'secondary' },
  'platform-default': { label: 'Platform default', variant: 'outline' },
};

function departmentLabel(department: DepartmentOption): string {
  return department.name || department.code || department.id;
}

function MatrixCellButton({ cell, onClick, ariaLabel }: { cell: ResolvedAssignmentCell; onClick: () => void; ariaLabel: string }) {
  const badge = SOURCE_BADGE[cell.source];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="hover:bg-muted focus-visible:ring-ring flex min-h-11 w-full min-w-40 flex-col items-start gap-1 rounded-md px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:outline-none"
    >
      <span className="w-full truncate font-mono text-xs">{cell.slug ?? <span className="text-muted-foreground">&mdash;</span>}</span>
      <Badge variant={badge.variant} className="text-[10px]">
        {badge.label}
      </Badge>
    </button>
  );
}

export interface AssignmentMatrixGridProps {
  departments: DepartmentOption[];
  paletteKeys: readonly string[];
  /** One palette's raw rows per palette key — the matrix derives inheritance client-side. */
  assignmentsByPalette: Record<string, WorkflowAssignment[]>;
  onSelectCell: (target: MatrixCellTarget) => void;
}

export function AssignmentMatrixGrid({ departments, paletteKeys, assignmentsByPalette, onSelectCell }: AssignmentMatrixGridProps) {
  const searchId = useId();
  const [query, setQuery] = useState('');

  const filteredDepartments = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return departments;
    return departments.filter((department) => departmentLabel(department).toLowerCase().includes(needle) || (department.code ?? '').toLowerCase().includes(needle));
  }, [departments, query]);

  if (paletteKeys.length === 0) {
    return (
      <EmptyState
        icon={IconLayoutGrid}
        title="No palettes registered"
        description="The node registry has no palette-bearing node types yet — nothing to assign."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Label htmlFor={searchId} className="sr-only">
            Search departments
          </Label>
          <IconSearch aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
          <Input
            id={searchId}
            type="search"
            value={query}
            placeholder="Search departments"
            className="w-64 pl-8"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ul aria-label="Legend" className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {(Object.keys(SOURCE_BADGE) as AssignmentCellSource[]).map((source) => (
            <li key={source} className="flex items-center gap-1.5">
              <Badge variant={SOURCE_BADGE[source].variant} className="text-[10px]">
                {SOURCE_BADGE[source].label}
              </Badge>
              <span>
                {source === 'explicit' ? 'assigned at this tier' : source === 'tenant' ? 'inherited from tenant default' : 'inherited from platform default'}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-md border" tabIndex={0} role="region" aria-label="Workflow assignment matrix">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Workflow assignment matrix — departments by palette. Each cell shows the resolved workflow definition and whether it is explicitly
            assigned or inherited.
          </caption>
          <thead>
            <tr className="border-b">
              <th scope="col" className="bg-background sticky left-0 z-10 min-w-48 px-3 py-2 text-left font-medium">
                Department
              </th>
              {paletteKeys.map((paletteKey) => (
                <th key={paletteKey} scope="col" className="min-w-40 px-3 py-2 text-left font-medium">
                  {humanizeKey(paletteKey)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b">
              <th scope="row" className="bg-background sticky left-0 z-10 flex items-center gap-2 px-3 py-2 text-left font-normal">
                <IconBuilding aria-hidden className="text-muted-foreground size-4 shrink-0" />
                Tenant default
              </th>
              {paletteKeys.map((paletteKey) => {
                const rows = assignmentsByPalette[paletteKey] ?? [];
                const cell = resolveTenantCell(rows);
                const paletteLabel = humanizeKey(paletteKey);
                return (
                  <td key={paletteKey} className="p-1">
                    <MatrixCellButton
                      cell={cell}
                      ariaLabel={`Tenant default, ${paletteLabel}: ${cell.slug ?? 'platform default'} (${SOURCE_BADGE[cell.source].label})`}
                      onClick={() =>
                        onSelectCell({ scope: 'TENANT', scopeId: null, scopeLabel: 'Tenant default', paletteKey, paletteLabel, cell })
                      }
                    />
                  </td>
                );
              })}
            </tr>
            {filteredDepartments.map((department) => (
              <tr key={department.id} className="border-b last:border-b-0">
                <th scope="row" className="bg-background sticky left-0 z-10 px-3 py-2 text-left font-normal">
                  <span className="flex flex-col">
                    <span className="truncate">{departmentLabel(department)}</span>
                    {department.code ? <span className="text-muted-foreground font-mono text-xs">{department.code}</span> : null}
                  </span>
                </th>
                {paletteKeys.map((paletteKey) => {
                  const rows = assignmentsByPalette[paletteKey] ?? [];
                  const cell = resolveDepartmentCell(rows, department.id);
                  const paletteLabel = humanizeKey(paletteKey);
                  return (
                    <td key={paletteKey} className="p-1">
                      <MatrixCellButton
                        cell={cell}
                        ariaLabel={`${departmentLabel(department)}, ${paletteLabel}: ${cell.slug ?? 'platform default'} (${SOURCE_BADGE[cell.source].label})`}
                        onClick={() =>
                          onSelectCell({
                            scope: 'DEPARTMENT',
                            scopeId: department.id,
                            scopeLabel: departmentLabel(department),
                            paletteKey,
                            paletteLabel,
                            cell,
                          })
                        }
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filteredDepartments.length === 0 && departments.length > 0 ? (
        <p className="text-muted-foreground text-center text-sm">No departments match &ldquo;{query}&rdquo;.</p>
      ) : null}
    </div>
  );
}

'use client';

import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { cx } from '@/shared/cx';
import {
    MATRIX_ACTION_LABELS,
    MATRIX_ACTIONS,
    MATRIX_LEGEND,
    type CellState,
    type MatrixAction,
    type PermissionMatrix as PermissionMatrixData,
} from '../lib/permission-matrix';

/** Glyph + accessible label per cell state (never color-only — WCAG 1.4.1). */
const CELL_META: Record<CellState, { glyph: string; label: string; className: string }> = {
    granted: { glyph: '✓', label: 'Granted', className: 'text-primary' },
    inherited: { glyph: '◐', label: 'Inherited from a system policy', className: 'text-muted-foreground' },
    conditional: { glyph: '✓', label: 'Granted with conditions', className: 'text-primary' },
    none: { glyph: '—', label: 'Not granted', className: 'text-muted-foreground/60' },
};

export type PermissionMatrixLayout = 'table' | 'cards';

function MatrixLegend() {
    return (
        <ul aria-label="Legend" className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {MATRIX_LEGEND.map((entry) => (
                <li key={`${entry.state}-${entry.label}`} className="flex items-center gap-1.5">
                    <span aria-hidden className={cx('font-mono', CELL_META[entry.state].className)}>
                        {entry.glyph}
                    </span>
                    <span>{entry.label}</span>
                </li>
            ))}
        </ul>
    );
}

function Cell({ state }: { state: CellState }) {
    const meta = CELL_META[state];
    return (
        <>
            <span aria-hidden className={cx('font-mono text-sm', meta.className)}>
                {meta.glyph}
            </span>
            <span className="sr-only">{meta.label}</span>
        </>
    );
}

function MatrixTable({ data }: { data: PermissionMatrixData }) {
    return (
        <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
                <caption className="sr-only">
                    Permission matrix — resources by action. Cell states: granted, inherited from a system policy, granted with conditions, or not
                    granted.
                </caption>
                <thead>
                    <tr className="border-b">
                        <th scope="col" className="bg-background sticky left-0 z-10 px-3 py-2 text-left font-medium">
                            Resource
                        </th>
                        {MATRIX_ACTIONS.map((action) => (
                            <th key={action} scope="col" className="px-3 py-2 text-center font-medium">
                                {MATRIX_ACTION_LABELS[action]}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {data.rows.map((row) => (
                        <tr key={row.subject} className="border-b last:border-b-0">
                            <th scope="row" className="bg-background sticky left-0 z-10 px-3 py-2 text-left font-normal">
                                {row.label}
                            </th>
                            {MATRIX_ACTIONS.map((action) => (
                                <td key={action} className="px-3 py-2 text-center">
                                    <Cell state={row.cells[action]} />
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function ActionChip({ action, state }: { action: MatrixAction; state: CellState }) {
    const meta = CELL_META[state];
    const active = state !== 'none';
    return (
        <Badge variant={active ? 'secondary' : 'outline'} className="gap-1">
            <span aria-hidden className={cx('font-mono', meta.className)}>
                {meta.glyph}
            </span>
            <span>{MATRIX_ACTION_LABELS[action]}</span>
            <span className="sr-only">— {meta.label}</span>
        </Badge>
    );
}

function MatrixCards({ data }: { data: PermissionMatrixData }) {
    return (
        <ul className="flex flex-col gap-3" aria-label="Permissions by resource">
            {data.rows.map((row) => (
                <li key={row.subject} className="rounded-lg border p-3">
                    <p className="mb-2 text-sm font-medium">{row.label}</p>
                    <div className="flex flex-wrap gap-1.5">
                        {MATRIX_ACTIONS.map((action) => (
                            <ActionChip key={action} action={action} state={row.cells[action]} />
                        ))}
                    </div>
                </li>
            ))}
        </ul>
    );
}

/**
 * Effective-permissions matrix (build spec §4). Read-only derived view: rows =
 * resources, columns = actions, cells = granted ✓ / inherited ◐ / conditional /
 * none —. Every glyph is paired with `sr-only` text so meaning never rides on
 * color alone. Desktop/tablet render a semantic `<table>`; mobile renders
 * per-resource cards with action chips (artboard 5g).
 */
export function PermissionMatrix({ data, layout = 'table' }: { data: PermissionMatrixData; layout?: PermissionMatrixLayout }) {
    return (
        <div className="flex flex-col gap-3">
            <MatrixLegend />
            {layout === 'cards' ? <MatrixCards data={data} /> : <MatrixTable data={data} />}
        </div>
    );
}

/** Skeleton matching the matrix table shape while policies load. */
export function PermissionMatrixSkeleton({ rows = 6 }: { rows?: number }) {
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-4">
                {Array.from({ length: 4 }, (_, index) => (
                    <Skeleton key={index} className="h-4 w-28" />
                ))}
            </div>
            <div className="flex flex-col gap-2">
                {Array.from({ length: rows }, (_, index) => (
                    <Skeleton key={index} className="h-8 w-full" />
                ))}
            </div>
        </div>
    );
}

/**
 * AdminDataGrid wrapper. Covers the console defaults it adds
 * over VirtualizedDataGrid: server-driven rows, the block-vs-banner error split,
 * empty vs filtered-empty slots, the selection action bar, and the header-sort
 * query-state emission. The URL binding + page-reset live in useAdminGridParams,
 * exercised directly against the nuqs testing adapter.
 *
 * The virtualization DOM shims (getBoundingClientRect/clientHeight) come from
 * src/test/setup.ts — without them react-virtual renders zero rows in happy-dom.
 */

import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColumnDef, DataQueryState, SortRule } from '@arcaai/ui';
import { renderWithProviders } from '@/test/render';
import { AdminDataGrid, type AdminDataGridProps, useAdminGridParams } from '../admin-data-grid';

interface Row {
    id: string;
    name: string;
    status: string;
}

const ROWS: Row[] = [
    { id: 'r1', name: 'Alpha', status: 'ACTIVE' },
    { id: 'r2', name: 'Beta', status: 'ARCHIVED' },
];

const columns: ColumnDef<Row>[] = [
    { accessorKey: 'name', header: 'Name', meta: { label: 'Name' } },
    {
        accessorKey: 'status',
        header: 'Status',
        meta: {
            label: 'Status',
            variant: 'select',
            options: [
                { label: 'Active', value: 'ACTIVE' },
                { label: 'Archived', value: 'ARCHIVED' },
            ],
        },
    },
];

const DEFAULT_SORT: SortRule[] = [{ id: 'updatedAt', desc: true }];

const baseQuery: DataQueryState = {
    pagination: { mode: 'offset', page: 0, limit: 25 },
    sorting: [],
    filters: [],
    globalSearch: undefined,
};

function renderGrid(props: Partial<AdminDataGridProps<Row>> = {}) {
    const onQueryStateChange = vi.fn();
    const utils = renderWithProviders(
        <AdminDataGrid<Row>
            gridId="test"
            aria-label="Test grid"
            columns={columns}
            rows={ROWS}
            total={ROWS.length}
            queryState={baseQuery}
            onQueryStateChange={onQueryStateChange}
            persistenceEnabled={false}
            {...props}
        />,
    );
    return { onQueryStateChange, ...utils };
}

afterEach(cleanup);

describe('AdminDataGrid', () => {
    it('renders server-driven rows under the accessible grid label', async () => {
        renderGrid();

        expect(await screen.findByRole('grid', { name: /test grid/i })).toBeDefined();
        expect(await screen.findByText('Alpha')).toBeDefined();
        expect(screen.getByText('Beta')).toBeDefined();
    });

    it('shows the plain empty state when no search/filter is active', async () => {
        renderGrid({ rows: [], total: 0, emptyState: <div>Nothing here yet</div>, emptyFilteredState: <div>No matches</div> });

        expect(await screen.findByText('Nothing here yet')).toBeDefined();
        expect(screen.queryByText('No matches')).toBeNull();
    });

    it('shows the filtered empty state when a search/filter is active', async () => {
        renderGrid({
            rows: [],
            total: 0,
            queryState: { ...baseQuery, globalSearch: 'zzz' },
            emptyState: <div>Nothing here yet</div>,
            emptyFilteredState: <div>No matches</div>,
        });

        expect(await screen.findByText('No matches')).toBeDefined();
        expect(screen.queryByText('Nothing here yet')).toBeNull();
    });

    it('renders a block error with a working retry when there are no rows', async () => {
        const onRetry = vi.fn();
        renderGrid({ rows: [], total: 0, error: new Error('Service unavailable'), onRetry });

        expect(await screen.findByRole('alert')).toBeDefined();
        expect(screen.getByText(/service unavailable/i)).toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('keeps rows visible behind a stale-data banner when a refetch errors', async () => {
        renderGrid({ error: new Error('refetch failed'), onRetry: vi.fn() });

        expect(await screen.findByText('Alpha')).toBeDefined();
        const banner = screen.getByRole('alert');
        expect(within(banner).getByText(/showing last loaded data/i)).toBeDefined();
    });

    it('surfaces the selection action bar once a row is selected', async () => {
        renderGrid({ selection: { value: { r1: true }, onChange: vi.fn() }, actionBar: <div>Bulk bar</div> });

        expect(await screen.findByText('Bulk bar')).toBeDefined();
    });

    it('emits a sorting query-state change from a column header menu', async () => {
        const { onQueryStateChange } = renderGrid();
        await screen.findByText('Alpha');

        fireEvent.pointerDown(screen.getByRole('button', { name: /name column options/i }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
        fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /^asc$/i }));

        expect(onQueryStateChange).toHaveBeenCalledWith(expect.objectContaining({ sorting: [{ id: 'name', desc: false }] }));
    });
});

describe('useAdminGridParams', () => {
    function wrapper(searchParams: string, onUrlUpdate?: (event: { searchParams: URLSearchParams }) => void) {
        function UrlStateWrapper({ children }: { children: ReactNode }) {
            return (
                <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
                    {children}
                </NuqsTestingAdapter>
            );
        }
        return UrlStateWrapper;
    }

    it('derives gateway list params from the URL with the default sort applied', () => {
        const { result } = renderHook(() => useAdminGridParams({ searchFields: ['name', 'key'], defaultSort: DEFAULT_SORT }), {
            wrapper: wrapper('?page=2&limit=50'),
        });

        // URL `page=2` is the 0-based grid index (the THIRD page); the gateway list contract
        // is 1-based (`skip=(page-1)*limit`), so `listParams.page` is 3. (fix.)
        expect(result.current.listParams).toMatchObject({ page: 3, limit: 50, sort: 'updatedAt:desc', searchFields: 'name,key' });
    });

    it('resets to the first page and serializes bracket filters on a filter change', async () => {
        const onUrlUpdate = vi.fn();
        const { result } = renderHook(() => useAdminGridParams({ searchFields: ['name', 'key'], defaultSort: DEFAULT_SORT }), {
            wrapper: wrapper('?page=2&limit=50', onUrlUpdate),
        });

        act(() => {
            result.current.setQueryState({
                ...result.current.queryState,
                filters: [{ id: 'resourceStatus', operator: 'eq', variant: 'select', value: 'SUSPENDED' }],
            });
        });

        // nuqs throttles URL writes, so onUrlUpdate flushes on a later tick.
        await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
        const last = onUrlUpdate.mock.calls.at(-1)?.[0] as { searchParams: URLSearchParams };
        // Page reset (dropped) because the result set changed; filters travel in `f`.
        expect(last.searchParams.get('page')).toBeNull();
        expect(last.searchParams.get('f')).toContain('resourceStatus');
    });

    it('serializes an active filter to the gateway bracket grammar', () => {
        const f = encodeURIComponent(JSON.stringify([['resourceStatus', 'eq', 'select', 'SUSPENDED']]));
        const { result } = renderHook(() => useAdminGridParams({ searchFields: ['name', 'key'], defaultSort: DEFAULT_SORT }), {
            wrapper: wrapper(`?f=${f}`),
        });

        expect(result.current.listParams.filters).toBe('resourceStatus[equals]:SUSPENDED');
    });
});

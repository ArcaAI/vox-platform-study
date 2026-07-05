import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayError } from '@/shared/api';
import { DataTable, type DataTableColumn } from '../data-table';

afterEach(cleanup);

interface Row {
    id: string;
    name: string;
    plan: string;
}

const columns: DataTableColumn<Row>[] = [
    { key: 'name', header: 'Name', sortKey: 'name', cell: (row) => row.name },
    { key: 'id', header: 'ID', mono: true, cell: (row) => row.id },
    { key: 'plan', header: 'Plan', cell: (row) => row.plan },
];

const rows: Row[] = [
    { id: 'tnt_1', name: 'Sunrise Medical Group', plan: 'Enterprise' },
    { id: 'tnt_2', name: 'Bayview Health', plan: 'Pro' },
];

describe('DataTable', () => {
    it('renders header cells and data rows with table semantics', () => {
        render(<DataTable aria-label="Tenants" columns={columns} rows={rows} rowKey={(row) => row.id} />);
        expect(screen.getByRole('table', { name: 'Tenants' })).toBeDefined();
        expect(screen.getByRole('columnheader', { name: /name/i })).toBeDefined();
        expect(screen.getByText('Sunrise Medical Group')).toBeDefined();
        expect(screen.getByText('tnt_2')).toBeDefined();
    });

    it('renders skeleton placeholder rows while loading', () => {
        const { container } = render(<DataTable aria-label="Tenants" columns={columns} rows={[]} rowKey={(row) => row.id} isLoading />);
        expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
        expect(screen.queryByText('Sunrise Medical Group')).toBeNull();
    });

    it('renders the empty slot when there are no rows', () => {
        render(
            <DataTable aria-label="Tenants" columns={columns} rows={[]} rowKey={(row) => row.id} empty={<p>No tenants yet</p>} />,
        );
        expect(screen.getByText('No tenants yet')).toBeDefined();
    });

    it('renders a block error state (with retry) when the load failed and no data exists', () => {
        const onRetry = vi.fn();
        render(
            <DataTable
                aria-label="Tenants"
                columns={columns}
                rows={[]}
                rowKey={(row) => row.id}
                error={new GatewayError(503, 'Service unavailable')}
                onRetry={onRetry}
            />,
        );
        expect(screen.getByRole('alert')).toBeDefined();
        fireEvent.click(screen.getByRole('button', { name: /retry/i }));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('keeps stale rows and shows an inline banner when a refetch fails', () => {
        render(
            <DataTable
                aria-label="Tenants"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                error={new GatewayError(503, 'Service unavailable')}
            />,
        );
        expect(screen.getByText('Sunrise Medical Group')).toBeDefined();
        expect(screen.getByRole('alert')).toBeDefined();
        expect(screen.getByText(/last loaded data/i)).toBeDefined();
    });

    it('invokes onRowClick and supports keyboard activation', () => {
        const onRowClick = vi.fn();
        render(<DataTable aria-label="Tenants" columns={columns} rows={rows} rowKey={(row) => row.id} onRowClick={onRowClick} />);
        fireEvent.click(screen.getByText('Bayview Health'));
        expect(onRowClick).toHaveBeenCalledWith(rows[1]);
        const row = screen.getByText('Sunrise Medical Group').closest('tr');
        fireEvent.keyDown(row as HTMLElement, { key: 'Enter' });
        expect(onRowClick).toHaveBeenCalledWith(rows[0]);
    });

    it('cycles server sort direction through the sortable header button', () => {
        const onSortChange = vi.fn();
        render(
            <DataTable aria-label="Tenants" columns={columns} rows={rows} rowKey={(row) => row.id} sort="name:asc" onSortChange={onSortChange} />,
        );
        const nameHeader = screen.getByRole('columnheader', { name: /name/i });
        expect(nameHeader.getAttribute('aria-sort')).toBe('ascending');
        fireEvent.click(screen.getByRole('button', { name: /name/i }));
        expect(onSortChange).toHaveBeenCalledWith('name:desc');
    });
});

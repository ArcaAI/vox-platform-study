import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';

import { Badge } from '../../shadcn/badge';
import { Button } from '../../shadcn/button';
import { VirtualizedDataGrid } from '../../data-grid';
import type { VirtualizedDataGridProps } from '../../data-grid';

interface Tenant {
  id: string;
  name: string;
  plan: string;
  seats: number;
  active: boolean;
  createdAt: string;
}

const PLANS = ['FREE', 'PRO', 'ENTERPRISE'];

function makeTenants(n: number): Tenant[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    name: `Tenant ${String(i + 1).padStart(3, '0')}`,
    plan: PLANS[i % PLANS.length]!,
    seats: ((i * 7) % 480) + 1,
    active: i % 3 !== 0,
    createdAt: new Date(2026, 0, 1 + (i % 300)).toISOString().slice(0, 10),
  }));
}

const columns: ColumnDef<Tenant>[] = [
  { accessorKey: 'name', header: 'Name', meta: { label: 'Name', variant: 'text' }, size: 220 },
  {
    accessorKey: 'plan',
    header: 'Plan',
    meta: {
      label: 'Plan',
      variant: 'multiSelect',
      options: PLANS.map((p) => ({ label: p, value: p })),
    },
    cell: ({ getValue }) => <Badge variant="secondary">{String(getValue())}</Badge>,
    size: 160,
  },
  { accessorKey: 'seats', header: 'Seats', meta: { label: 'Seats', variant: 'number' }, size: 120 },
  {
    accessorKey: 'active',
    header: 'Active',
    meta: {
      label: 'Active',
      variant: 'boolean',
      options: [
        { label: 'Active', value: 'true' },
        { label: 'Suspended', value: 'false' },
      ],
    },
    cell: ({ getValue }) => (getValue() ? 'Active' : 'Suspended'),
    size: 130,
  },
  { accessorKey: 'createdAt', header: 'Created', meta: { label: 'Created', variant: 'date' }, size: 160 },
];

/**
 * `VirtualizedDataGrid` in fill-height mode. Toggle the Storybook **Theme**
 * toolbar (light/dark) to verify both palettes; resize the preview to watch the
 * toolbar collapse into a Filters button and the pager window drop end-controls.
 */
const meta = {
  title: 'Custom/DataGrid',
  component: VirtualizedDataGrid,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="flex h-[560px] w-full flex-col p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof VirtualizedDataGrid<Tenant>>;

export default meta;
type Story = StoryObj<typeof meta>;

const baseArgs: VirtualizedDataGridProps<Tenant> = {
  data: makeTenants(200),
  columns,
  getRowId: (row) => row.id,
  'aria-label': 'Tenants',
};

export const FillHeight: Story = { args: baseArgs };

export const EmbeddedFixedHeight: Story = {
  args: { ...baseArgs, height: 360, data: makeTenants(50) },
};

export const Loading: Story = { args: { ...baseArgs, data: [], isLoading: true } };

export const EmptyNoData: Story = { args: { ...baseArgs, data: [] } };

export const ErrorState: Story = {
  args: { ...baseArgs, data: [], error: new Error('Failed to load tenants'), onRetry: () => {} },
};

export const Busy: Story = {
  args: { ...baseArgs, data: makeTenants(50), manual: { pagination: true }, rowCount: 480, isBusy: true },
};

export const WithSelectionActionBar: Story = {
  render: (args) => {
    const [selection, setSelection] = useState({ t0: true, t1: true });
    const count = Object.values(selection).filter(Boolean).length;
    return (
      <VirtualizedDataGrid<Tenant>
        {...args}
        selection={{ value: selection, onChange: setSelection }}
        actionBar={
          <div className="flex items-center justify-between rounded-md border bg-card px-3 py-2 text-sm">
            <span className="text-muted-foreground tabular-nums">{count} selected</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setSelection({})}>
                Clear
              </Button>
              <Button size="sm" variant="destructive">
                Delete
              </Button>
            </div>
          </div>
        }
      />
    );
  },
  args: baseArgs,
};

export const CursorMode: Story = {
  args: {
    ...baseArgs,
    data: makeTenants(25),
    pageMode: 'cursor',
    manual: { pagination: true },
    cursor: { hasMore: true, nextCursor: 'c1' },
  },
};

/** Forces the dark palette regardless of the Theme toolbar for side-by-side review. */
export const DarkFrame: Story = {
  args: baseArgs,
  decorators: [
    (Story) => (
      <div className="dark flex h-[560px] w-full flex-col rounded-lg bg-background p-4 text-foreground">
        <Story />
      </div>
    ),
  ],
};

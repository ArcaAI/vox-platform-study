import type { ColumnSort, Row, RowData } from '@tanstack/react-table';
import type { DataTableConfig } from '@/config/data-table';
import type { FilterItemSchema } from '@/lib/parsers';

declare module '@tanstack/react-table' {
  // biome-ignore lint/correctness/noUnusedVariables: TData is used in the TableMeta interface
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- module augmentation: the type-parameter NAME must match @tanstack/react-table's own `TableMeta<TData>` declaration or the interfaces stop merging (TS2428). An `_TData` rename silences the lint rule at the cost of breaking the build.
  interface TableMeta<TData extends RowData> {
    queryKeys?: QueryKeys;
  }

  // biome-ignore lint/correctness/noUnusedVariables: TData and TValue are used in the ColumnMeta interface
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- same as above: `ColumnMeta<TData, TValue>` must mirror the upstream parameter names exactly for declaration merging (TS2428).
  interface ColumnMeta<TData extends RowData, TValue> {
    label?: string;
    placeholder?: string;
    variant?: FilterVariant;
    options?: Option[];
    range?: [number, number];
    unit?: string;
    icon?: React.FC<React.SVGProps<SVGSVGElement>>;
    /**
     * TASK-443 — a FILTER-ONLY virtual column: it feeds a toolbar faceted
     * filter chip (via `variant`/`options`) but is never rendered as a table
     * column and is excluded from the column-visibility list. For predicates
     * with no presentable column (e.g. a derived server-side facet).
     */
    filterOnly?: boolean;
  }
}

export interface QueryKeys {
  page: string;
  perPage: string;
  sort: string;
  filters: string;
  joinOperator: string;
}

export interface Option {
  label: string;
  value: string;
  count?: number;
  icon?: React.FC<React.SVGProps<SVGSVGElement>>;
}

export type FilterOperator = DataTableConfig['operators'][number];
export type FilterVariant = DataTableConfig['filterVariants'][number];
export type JoinOperator = DataTableConfig['joinOperators'][number];

export interface ExtendedColumnSort<TData> extends Omit<ColumnSort, 'id'> {
  id: Extract<keyof TData, string>;
}

export interface ExtendedColumnFilter<TData> extends FilterItemSchema {
  id: Extract<keyof TData, string>;
}

export interface DataTableRowAction<TData> {
  row: Row<TData>;
  variant: 'update' | 'delete';
}

import { useMemo } from 'react';
import {
    type ColumnDef,
    type OnChangeFn,
    type PaginationState,
    type RowSelectionState,
    flexRender,
    getCoreRowModel,
    useReactTable,
} from '@tanstack/react-table';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@arcaai/ui/table';
import { Button } from '@arcaai/ui/button';
import { Checkbox } from '@arcaai/ui/checkbox';
import { Skeleton } from '@arcaai/ui/skeleton';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@arcaai/ui/select';
import {
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    Inbox,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '@arcaai/vox';

interface AdminDataTableProps<TData> {
    data: TData[];
    columns: ColumnDef<TData, unknown>[];
    searchPlaceholder?: string;
    searchValue?: string;
    onSearchChange?: (value: string) => void;
    pagination?: PaginationState;
    onPaginationChange?: OnChangeFn<PaginationState>;
    rowCount?: number;
    enableRowSelection?: boolean;
    rowSelection?: RowSelectionState;
    onRowSelectionChange?: OnChangeFn<RowSelectionState>;
    isLoading?: boolean;
    emptyMessage?: string;
    toolbar?: React.ReactNode;
    onRowClick?: (row: TData) => void;
}

export function AdminDataTable<TData>({
    data,
    columns: userColumns,
    pagination,
    onPaginationChange,
    rowCount,
    enableRowSelection,
    rowSelection,
    onRowSelectionChange,
    isLoading,
    emptyMessage = 'No results found.',
    toolbar,
    onRowClick,
}: AdminDataTableProps<TData>) {
    const columns = useMemo<ColumnDef<TData, unknown>[]>(() => {
        if (!enableRowSelection) return userColumns;

        const selectCol: ColumnDef<TData, unknown> = {
            id: '_select',
            header: ({ table }) => (
                <Checkbox
                    checked={
                        table.getIsAllPageRowsSelected() ||
                        (table.getIsSomePageRowsSelected() && 'indeterminate')
                    }
                    onCheckedChange={(v: boolean | 'indeterminate') => table.toggleAllPageRowsSelected(!!v)}
                    aria-label="Select all"
                />
            ),
            cell: ({ row }) => (
                <Checkbox
                    checked={row.getIsSelected()}
                    onCheckedChange={(v: boolean | 'indeterminate') => row.toggleSelected(!!v)}
                    aria-label="Select row"
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                />
            ),
            size: 40,
            enableSorting: false,
            enableHiding: false,
        };

        return [selectCol, ...userColumns];
    }, [userColumns, enableRowSelection]);

    const table = useReactTable({
        data,
        columns,
        state: {
            ...(pagination && { pagination }),
            ...(rowSelection !== undefined && { rowSelection }),
        },
        onPaginationChange,
        onRowSelectionChange,
        getCoreRowModel: getCoreRowModel(),
        manualPagination: true,
        rowCount: rowCount ?? data.length,
    });

    const hasPagination = pagination && onPaginationChange;
    const totalRows = rowCount ?? data.length;
    const pageSize = pagination?.pageSize ?? DEFAULT_PAGE_SIZE;
    const pageStart = totalRows > 0 ? (pagination?.pageIndex ?? 0) * pageSize + 1 : 0;
    const pageEnd = Math.min(((pagination?.pageIndex ?? 0) + 1) * pageSize, totalRows);
    const pageCount = table.getPageCount();

    return (
        <div className="flex flex-col gap-4">
            {toolbar && <div className="flex items-center gap-3">{toolbar}</div>}

            <div className="overflow-auto rounded-md border">
                <Table>
                    <TableHeader className="bg-background sticky top-0 z-10">
                        {table.getHeaderGroups().map((hg) => (
                            <TableRow key={hg.id}>
                                {hg.headers.map((header) => (
                                    <TableHead
                                        key={header.id}
                                        style={
                                            header.column.columnDef.size
                                                ? { width: header.column.columnDef.size }
                                                : undefined
                                        }
                                    >
                                        {header.isPlaceholder
                                            ? null
                                            : flexRender(
                                                  header.column.columnDef.header,
                                                  header.getContext(),
                                              )}
                                    </TableHead>
                                ))}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody>
                        {isLoading && table.getRowModel().rows.length === 0
                            ? Array.from({ length: 5 }).map((_, i) => (
                                  <TableRow key={`skeleton-${i}`}>
                                      {columns.map((_, ci) => (
                                          <TableCell key={ci}>
                                              <Skeleton className="h-4 w-24" />
                                          </TableCell>
                                      ))}
                                  </TableRow>
                              ))
                            : table.getRowModel().rows.length > 0
                              ? table.getRowModel().rows.map((row) => (
                                    <TableRow
                                        key={row.id}
                                        data-state={
                                            row.getIsSelected() ? 'selected' : undefined
                                        }
                                        className={cn(
                                            (enableRowSelection || onRowClick) && 'cursor-pointer',
                                        )}
                                        onClick={() => {
                                            if (onRowClick) {
                                                onRowClick(row.original);
                                            } else if (enableRowSelection) {
                                                row.toggleSelected(!row.getIsSelected());
                                            }
                                        }}
                                    >
                                        {row.getVisibleCells().map((cell) => (
                                            <TableCell key={cell.id}>
                                                {flexRender(
                                                    cell.column.columnDef.cell,
                                                    cell.getContext(),
                                                )}
                                            </TableCell>
                                        ))}
                                    </TableRow>
                                ))
                              : (
                                    <TableRow>
                                        <TableCell
                                            colSpan={columns.length}
                                            className="h-32"
                                        >
                                            <div className="flex flex-col items-center justify-center gap-2">
                                                <Inbox className="text-muted-foreground size-8" />
                                                <span className="text-muted-foreground text-sm">
                                                    {emptyMessage}
                                                </span>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                )}
                    </TableBody>
                </Table>
            </div>

            {hasPagination && (
                <div className="flex items-center justify-between border-t pt-4">
                    <div className="flex items-center gap-4">
                        <span className="text-muted-foreground text-sm tabular-nums">
                            {totalRows > 0
                                ? `${pageStart}–${pageEnd} of ${totalRows}`
                                : '0 results'}
                        </span>
                        <div className="flex items-center gap-2">
                            <span className="text-muted-foreground text-sm">Rows:</span>
                            <Select
                                value={String(pagination.pageSize)}
                                onValueChange={(v: string) =>
                                    table.setPageSize(Number(v))
                                }
                            >
                                <SelectTrigger className="h-8 w-18">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {PAGE_SIZE_OPTIONS.map((size) => (
                                        <SelectItem key={size} value={String(size)}>
                                            {size}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <div className="flex items-center gap-1">
                        <Button
                            variant="outline"
                            size="icon"
                            className="size-8"
                            onClick={() => table.firstPage()}
                            disabled={!table.getCanPreviousPage()}
                        >
                            <ChevronsLeft className="size-4" />
                        </Button>
                        <Button
                            variant="outline"
                            size="icon"
                            className="size-8"
                            onClick={() => table.previousPage()}
                            disabled={!table.getCanPreviousPage()}
                        >
                            <ChevronLeft className="size-4" />
                        </Button>
                        <span className="text-muted-foreground px-2 text-sm tabular-nums">
                            {pagination.pageIndex + 1} / {pageCount || 1}
                        </span>
                        <Button
                            variant="outline"
                            size="icon"
                            className="size-8"
                            onClick={() => table.nextPage()}
                            disabled={!table.getCanNextPage()}
                        >
                            <ChevronRight className="size-4" />
                        </Button>
                        <Button
                            variant="outline"
                            size="icon"
                            className="size-8"
                            onClick={() => table.lastPage()}
                            disabled={!table.getCanNextPage()}
                        >
                            <ChevronsRight className="size-4" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}

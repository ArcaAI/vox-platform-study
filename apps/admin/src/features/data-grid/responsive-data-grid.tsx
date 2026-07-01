import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Skeleton } from '@arcaai/ui/skeleton';
import { VirtualizedDataGrid, type VirtualizedDataGridProps } from '@arcaai/ui/components/data-grid';
import type { DataQueryState } from '@arcaai/ui/lib/shared';
import { ChevronLeft, ChevronRight, Inbox, RotateCcw, Search, TriangleAlert } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { cn } from '@/lib/utils';
import { paginationSummary, selectCondensedColumns } from './responsive-grid';

/** A single row rendered as a tappable card on mobile (`07 · Responsive` card-list). */
export interface MobileCardModel {
    id: string;
    /** Leading node (e.g. an `<Avatar/>`). */
    avatar?: ReactNode;
    title: ReactNode;
    subtitle?: ReactNode;
    /** Trailing status pill. */
    badge?: ReactNode;
    /** Optional secondary line under the subtitle (role, departments, …). */
    meta?: ReactNode;
    /** Tapping the card body. When set the card shows a trailing chevron. */
    onClick?: () => void;
    /** Trailing actions (e.g. a kebab menu); rendered outside the tap target. */
    actions?: ReactNode;
}

export interface ResponsiveDataGridProps<TData> extends VirtualizedDataGridProps<TData> {
    /**
     * Map a row to its mobile card. Required to enable the mobile card-list;
     * without it the grid is used at every breakpoint (horizontal scroll).
     */
    mobileCard?: (row: TData) => MobileCardModel;
    /**
     * Column ids kept on the tablet "condensed" table (others hidden). Order is
     * preserved from `columns`. Omit to keep every column on tablet.
     */
    condensedColumnIds?: readonly string[];
    /** Floating primary action shown on the mobile card-list (FAB). */
    mobilePrimaryAction?: { label: string; icon?: ReactNode; onClick: () => void };
    mobileSearchPlaceholder?: string;
    /**
     * Client-side mobile search predicate for grids that don't drive a server
     * `queryState` (e.g. the Tenants list). When provided, the card-list shows a
     * search box that filters `data` locally. Ignored when `onQueryStateChange`
     * is present (server search is used instead).
     */
    mobileFilter?: (row: TData, term: string) => boolean;
}

const MOBILE_SKELETON_ROWS = 6;

/**
 * Responsive wrapper over {@link VirtualizedDataGrid} (TASK-384). App-level by
 * design so the shared `packages/ui` grid is untouched:
 *  - **desktop** (`≥ lg`)  → the grid, unchanged.
 *  - **tablet**  (`md..lg`) → the grid with lower-priority columns hidden.
 *  - **mobile**  (`< md`)   → a tap-through card-list (+ search, pager, FAB).
 */
export function ResponsiveDataGrid<TData>(props: ResponsiveDataGridProps<TData>) {
    const { mobileCard, condensedColumnIds, mobilePrimaryAction, mobileSearchPlaceholder, mobileFilter, ...gridProps } = props;
    const { isMobile, isTablet } = useBreakpoint();

    const condensedColumns = useMemo(
        () => (isTablet ? selectCondensedColumns(gridProps.columns, condensedColumnIds) : gridProps.columns),
        [isTablet, gridProps.columns, condensedColumnIds],
    );

    if (isMobile && mobileCard) {
        return (
            <MobileCardList
                {...gridProps}
                mobileCard={mobileCard}
                primaryAction={mobilePrimaryAction}
                searchPlaceholder={mobileSearchPlaceholder}
                mobileFilter={mobileFilter}
            />
        );
    }

    return <VirtualizedDataGrid<TData> {...gridProps} columns={condensedColumns} />;
}

interface MobileCardListProps<TData> extends VirtualizedDataGridProps<TData> {
    mobileCard: (row: TData) => MobileCardModel;
    primaryAction?: { label: string; icon?: ReactNode; onClick: () => void };
    searchPlaceholder?: string;
    mobileFilter?: (row: TData, term: string) => boolean;
}

function MobileCardList<TData>({
    data,
    mobileCard,
    primaryAction,
    searchPlaceholder = 'Search…',
    mobileFilter,
    isLoading,
    error,
    onRetry,
    rowCount,
    queryState,
    onQueryStateChange,
    features,
    emptyState,
    ['aria-label']: ariaLabel,
}: MobileCardListProps<TData>) {
    const serverSearch = !!onQueryStateChange && features?.globalSearch !== false && !!queryState;
    const clientSearch = !serverSearch && !!mobileFilter;

    const [localTerm, setLocalTerm] = useState('');
    const term = serverSearch ? (queryState?.globalSearch ?? '') : localTerm;

    const setTerm = (value: string) => {
        if (serverSearch && queryState && onQueryStateChange) {
            onQueryStateChange({ ...queryState, globalSearch: value });
        } else {
            setLocalTerm(value);
        }
    };

    const rows = useMemo(() => {
        if (clientSearch && term.trim()) {
            const q = term.trim();
            return data.filter((row) => mobileFilter!(row, q));
        }
        return data;
    }, [data, clientSearch, term, mobileFilter]);

    // Server pager (offset mode only): summarize the current page from rowCount.
    const pager =
        queryState?.pagination.mode === 'offset' && onQueryStateChange && rowCount != null
            ? paginationSummary(queryState.pagination.page, queryState.pagination.limit, rowCount)
            : null;

    const goTo = (page: number) => {
        if (queryState?.pagination.mode === 'offset' && onQueryStateChange) {
            onQueryStateChange({ ...queryState, pagination: { ...queryState.pagination, page } });
        }
    };

    const showSearch = serverSearch || clientSearch;
    const showSkeleton = !!isLoading && rows.length === 0;
    const showEmpty = !isLoading && !error && rows.length === 0;

    return (
        <div className="flex flex-col gap-3" data-slot="responsive-card-list">
            {showSearch ? (
                <div className="relative">
                    <Search aria-hidden className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        aria-label="Search"
                        value={term}
                        onChange={(e) => setTerm(e.target.value)}
                        placeholder={searchPlaceholder}
                        className="h-11 w-full pl-9"
                    />
                </div>
            ) : null}

            {showSkeleton ? (
                <ul aria-label={ariaLabel ?? 'Results'} aria-busy className="flex flex-col gap-2">
                    {Array.from({ length: MOBILE_SKELETON_ROWS }).map((_, i) => (
                        <li key={i} className="flex items-center gap-3 rounded-lg border bg-card p-3">
                            <Skeleton className="size-10 shrink-0 rounded-full" />
                            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                                <Skeleton className="h-4 w-1/2" />
                                <Skeleton className="h-3 w-3/4" />
                            </div>
                            <Skeleton className="h-5 w-16 rounded-full" />
                        </li>
                    ))}
                </ul>
            ) : !isLoading && error ? (
                <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border bg-card p-8 text-center">
                    <TriangleAlert className="size-9 text-destructive" />
                    <div>
                        <p className="font-medium">Something went wrong</p>
                        <p className="text-sm text-muted-foreground">{error.message}</p>
                    </div>
                    {onRetry ? (
                        <Button variant="outline" className="h-11" onClick={onRetry}>
                            <RotateCcw className="size-4" />
                            Retry
                        </Button>
                    ) : null}
                </div>
            ) : showEmpty ? (
                (emptyState ?? (
                    <div className="flex flex-col items-center gap-2 rounded-lg border bg-card p-8 text-center">
                        <Inbox className="size-9 text-muted-foreground/50" />
                        <p className="font-medium">No results</p>
                        <p className="text-sm text-muted-foreground">There is nothing to show here yet.</p>
                    </div>
                ))
            ) : (
                <ul aria-label={ariaLabel ?? 'Results'} className="flex flex-col gap-2">
                    {rows.map((row) => {
                        const card = mobileCard(row);
                        return (
                            <li key={card.id} className="flex items-stretch gap-1 rounded-lg border bg-card transition-colors hover:bg-muted/40">
                                <button
                                    type="button"
                                    onClick={card.onClick}
                                    disabled={!card.onClick}
                                    className={cn(
                                        'flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-lg p-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                        card.onClick ? 'cursor-pointer' : 'cursor-default',
                                    )}
                                >
                                    {card.avatar ? <span className="shrink-0">{card.avatar}</span> : null}
                                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                        <span className="truncate text-sm font-medium">{card.title}</span>
                                        {card.subtitle ? <span className="truncate text-xs text-muted-foreground">{card.subtitle}</span> : null}
                                        {card.meta ? <span className="min-w-0 text-xs text-muted-foreground">{card.meta}</span> : null}
                                    </span>
                                    {card.badge ? <span className="shrink-0">{card.badge}</span> : null}
                                    {card.onClick ? <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground/60" /> : null}
                                </button>
                                {card.actions ? <span className="flex items-center pr-1.5">{card.actions}</span> : null}
                            </li>
                        );
                    })}
                </ul>
            )}

            {pager && pager.total > 0 ? (
                <div className="flex items-center justify-between gap-2 pt-1">
                    <p className="text-sm tabular-nums text-muted-foreground">
                        {pager.from}–{pager.to} of {pager.total}
                    </p>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="icon"
                            className="size-11"
                            aria-label="Previous page"
                            disabled={!pager.canPrev}
                            onClick={() => goTo(pager.page - 1)}
                        >
                            <ChevronLeft className="size-4" />
                        </Button>
                        <span className="text-sm font-medium tabular-nums">
                            {pager.page + 1} / {pager.pageCount}
                        </span>
                        <Button
                            variant="outline"
                            size="icon"
                            className="size-11"
                            aria-label="Next page"
                            disabled={!pager.canNext}
                            onClick={() => goTo(pager.page + 1)}
                        >
                            <ChevronRight className="size-4" />
                        </Button>
                    </div>
                </div>
            ) : null}

            {primaryAction ? (
                <Button
                    onClick={primaryAction.onClick}
                    aria-label={primaryAction.label}
                    className="fixed bottom-5 right-5 z-30 size-14 rounded-full shadow-lg"
                    size="icon"
                >
                    {primaryAction.icon ?? <span className="text-2xl leading-none">+</span>}
                </Button>
            ) : null}
        </div>
    );
}

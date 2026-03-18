import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"

import { cn } from "../../../lib/utils"
import {
  MasterDetailColumnTitle,
  MasterDetailColumnDescription,
  MasterDetailItem,
  MasterDetailSkeleton,
  MasterDetailEmpty,
} from "../../shadcn/master-detail-layout"
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "../../shadcn/resizable"
import { Skeleton } from "../../shadcn/skeleton"
import { Spinner } from "../../shadcn/spinner"
import { RefreshCw } from "lucide-react"
import type {
  MultiColumnConfig,
  MultiColumnContentConfig,
  MultiColumnState,
  MultiColumnDetailConfig,
  MultiColumnDetailState,
  MultiColumnLayoutProps,
  MultiColumnHeaderContext,
  AnyColumnConfig,
} from "./types"

// ---------------------------------------------------------------------------
// useSyncedHeaderHeight — keeps all column headers the same height
//
// Measures each header's natural (content-driven) height, takes the max,
// and applies it as `minHeight` directly on the DOM elements via refs.
// This avoids React inline-style conflicts and ResizeObserver feedback loops.
// ---------------------------------------------------------------------------

function useSyncedHeaderHeight(count: number) {
  const headerRefs = React.useRef<Map<number, HTMLDivElement>>(new Map())
  const measuringRef = React.useRef(false)

  const callbackCache = React.useRef<
    Map<number, (el: HTMLDivElement | null) => void>
  >(new Map())

  const setRef = React.useCallback(
    (index: number) => {
      let cb = callbackCache.current.get(index)
      if (!cb) {
        cb = (el: HTMLDivElement | null) => {
          if (el) headerRefs.current.set(index, el)
          else headerRefs.current.delete(index)
        }
        callbackCache.current.set(index, cb)
      }
      return cb
    },
    [],
  )

  React.useLayoutEffect(() => {
    const elements = Array.from(headerRefs.current.values())
    if (elements.length === 0) return

    const measure = () => {
      if (measuringRef.current) return
      measuringRef.current = true
      try {
        for (const el of elements) el.style.minHeight = "0px"
        void elements[0]!.offsetHeight

        let max = 0
        for (const el of elements) {
          max = Math.max(max, el.getBoundingClientRect().height)
        }

        const px = `${Math.ceil(max)}px`
        for (const el of elements) el.style.minHeight = px
      } finally {
        measuringRef.current = false
      }
    }

    measure()

    const ro = new ResizeObserver(() => {
      if (!measuringRef.current) measure()
    })
    for (const el of elements) ro.observe(el)

    return () => {
      ro.disconnect()
      for (const el of elements) el.style.removeProperty("min-height")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count])

  return { setRef }
}

// ---------------------------------------------------------------------------
// VirtualizedList — renders a single list column body with TanStack Virtual
// ---------------------------------------------------------------------------

function VirtualizedList<TItem>({
  config,
  state,
  columnIndex,
}: {
  config: MultiColumnConfig<TItem>
  state: MultiColumnState<TItem>
  columnIndex: number
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const itemCount =
    state.hasMore ? state.data.length + 1 : state.data.length

  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => config.estimateItemSize ?? 64,
    overscan: 5,
  })

  React.useEffect(() => {
    const items = virtualizer.getVirtualItems()
    const lastItem = items.at(-1)
    if (!lastItem) return

    if (
      lastItem.index >= state.data.length - 1 &&
      state.hasMore &&
      !state.isLoadingMore &&
      state.onLoadMore
    ) {
      state.onLoadMore()
    }
  }, [
    virtualizer.getVirtualItems(),
    state.data.length,
    state.hasMore,
    state.isLoadingMore,
    state.onLoadMore,
  ])

  return (
    <div
      ref={scrollRef}
      data-slot="multi-column-scroll"
      className="size-full overflow-auto"
    >
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const isSentinel = virtualRow.index >= state.data.length

          if (isSentinel) {
            return (
              <div
                key="__sentinel__"
                data-slot="multi-column-sentinel"
                className="flex items-center justify-center py-4"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {state.isLoadingMore && (
                  <Spinner className="text-muted-foreground size-4" />
                )}
              </div>
            )
          }

          const item = state.data[virtualRow.index]!
          const key = config.keyExtractor(item)

          return (
            <div
              key={key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <MasterDetailItem
                isSelected={
                  state.selectedIds
                    ? state.selectedIds.includes(key)
                    : state.selectedId === key
                }
                onClick={() => state.onSelect(key)}
                data-testid={`${config.id}-item-${key}`}
              >
                {config.renderItem(item, {
                  selectedId: state.selectedId,
                  columnIndex,
                })}
              </MasterDetailItem>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ColumnHeader — renders inside a shared-height grid row
// ---------------------------------------------------------------------------

function ColumnHeader({
  title,
  subtitle,
  itemCount,
  showItemCount,
  headerControls,
  headerActions,
  onRefresh,
  isRefreshing,
  renderHeader,
  headerContext,
}: {
  title: string | React.ReactNode
  subtitle?: string | React.ReactNode
  itemCount?: number
  showItemCount?: boolean
  headerControls?: React.ReactNode
  headerActions?: React.ReactNode
  onRefresh?: () => void
  isRefreshing?: boolean
  renderHeader?: ((ctx: MultiColumnHeaderContext) => React.ReactNode) | (() => React.ReactNode)
  headerContext?: MultiColumnHeaderContext
}) {
  if (renderHeader) {
    return headerContext
      ? (renderHeader as (ctx: MultiColumnHeaderContext) => React.ReactNode)(headerContext)
      : (renderHeader as () => React.ReactNode)()
  }

  const controls = headerControls ?? headerActions

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {typeof title === "string" ? (
            <MasterDetailColumnTitle>
              {title}
              {showItemCount && itemCount != null && (
                <span className="text-muted-foreground ml-1.5 font-normal">
                  ({itemCount})
                </span>
              )}
            </MasterDetailColumnTitle>
          ) : (
            title
          )}
          {subtitle &&
            (typeof subtitle === "string" ? (
              <MasterDetailColumnDescription>
                {subtitle}
              </MasterDetailColumnDescription>
            ) : (
              subtitle
            ))}
        </div>
        <div className="shrink-0">
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={onRefresh}
            disabled={!onRefresh}
            aria-label="Refresh column"
          >
            <RefreshCw className={cn("size-4", isRefreshing && "animate-spin")} />
          </button>
        </div>
      </div>
      {controls && (
        <div className="min-w-0">
          {controls}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DetailSkeleton — skeleton placeholder for the detail pane
// ---------------------------------------------------------------------------

function DetailSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div
      data-slot="multi-column-detail-skeleton"
      className="flex flex-col gap-4 p-4"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-20 w-full rounded-md" />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Type guard helpers
// ---------------------------------------------------------------------------

function isListColumn(col: AnyColumnConfig): col is MultiColumnConfig {
  return "keyExtractor" in col && "renderItem" in col
}

function isContentColumn(col: AnyColumnConfig): col is MultiColumnContentConfig {
  return "type" in col && col.type === "content"
}

// ---------------------------------------------------------------------------
// Shared column entry type
// ---------------------------------------------------------------------------

interface ColumnEntry {
  config: AnyColumnConfig | MultiColumnDetailConfig
  kind: "list" | "content" | "detail"
  index: number
}

// ---------------------------------------------------------------------------
// Compute default panel sizes from width hints
// ---------------------------------------------------------------------------

function parsePixelWidth(width: string | undefined): number | null {
  if (!width) return null
  const match = width.match(/^(\d+)px$/)
  return match ? Number(match[1]) : null
}

function computeDefaultSizes(entries: ColumnEntry[]): number[] {
  const sizes: number[] = []
  let totalFixed = 0
  let flexCount = 0

  for (const entry of entries) {
    const explicit = entry.config.defaultSize
    if (explicit != null) {
      sizes.push(explicit)
      totalFixed += explicit
    } else {
      const px = parsePixelWidth(entry.config.width)
      if (px) {
        sizes.push(-px)
        totalFixed += 0
      } else {
        sizes.push(0)
        flexCount++
      }
    }
  }

  // Estimate total container width for px→% conversion (assume 1200px as baseline)
  const estimatedContainerWidth = 1200
  let usedPercent = 0

  for (let i = 0; i < sizes.length; i++) {
    if (sizes[i]! < 0) {
      const px = Math.abs(sizes[i]!)
      const pct = Math.round((px / estimatedContainerWidth) * 100)
      sizes[i] = pct
      usedPercent += pct
    } else if (sizes[i]! > 0) {
      usedPercent += sizes[i]!
    }
  }

  const remaining = Math.max(0, 100 - usedPercent)
  const perFlex = flexCount > 0 ? Math.round(remaining / flexCount) : 0

  for (let i = 0; i < sizes.length; i++) {
    if (sizes[i] === 0) {
      sizes[i] = perFlex
    }
  }

  // Normalize to exactly 100
  const sum = sizes.reduce((a, b) => a + b, 0)
  if (sum !== 100 && sum > 0) {
    let lastFlexIdx = -1
    for (let i = sizes.length - 1; i >= 0; i--) {
      if (sizes[i] === perFlex) { lastFlexIdx = i; break }
    }
    if (lastFlexIdx >= 0) {
      sizes[lastFlexIdx] = sizes[lastFlexIdx]! + (100 - sum)
    } else {
      sizes[sizes.length - 1] = sizes[sizes.length - 1]! + (100 - sum)
    }
  }

  return sizes
}

// ---------------------------------------------------------------------------
// renderColumnHeader — builds the header JSX for a given column entry
// ---------------------------------------------------------------------------

function renderColumnHeader(
  entry: ColumnEntry,
  columnStates: MultiColumnState[],
) {
  const col = entry.config

  if (entry.kind === "list") {
    const listCol = col as MultiColumnConfig
    const state = columnStates[entry.index]
    const headerCtx: MultiColumnHeaderContext = {
      itemCount: state?.data.length ?? 0,
      isLoading: state?.isLoading ?? false,
    }
    return (
      <ColumnHeader
        title={listCol.title}
        subtitle={listCol.subtitle}
        itemCount={headerCtx.itemCount}
        showItemCount={listCol.showItemCount}
        headerControls={listCol.headerControls}
        headerActions={listCol.headerActions}
        onRefresh={listCol.onRefresh}
        isRefreshing={listCol.isRefreshing ?? headerCtx.isLoading}
        renderHeader={listCol.renderHeader}
        headerContext={headerCtx}
      />
    )
  }

  if (entry.kind === "content") {
    const contentCol = col as MultiColumnContentConfig
    return (
      <ColumnHeader
        title={contentCol.title}
        subtitle={contentCol.subtitle}
        headerControls={contentCol.headerControls}
        headerActions={contentCol.headerActions}
        onRefresh={contentCol.onRefresh}
        isRefreshing={contentCol.isRefreshing}
        renderHeader={contentCol.renderHeader as (() => React.ReactNode) | undefined}
      />
    )
  }

  const detailCol = col as MultiColumnDetailConfig
  return (
    <ColumnHeader
      title={detailCol.title}
      subtitle={detailCol.subtitle}
      headerControls={detailCol.headerControls}
      headerActions={detailCol.headerActions}
      onRefresh={detailCol.onRefresh}
      isRefreshing={detailCol.isRefreshing}
      renderHeader={detailCol.renderHeader}
    />
  )
}

// ---------------------------------------------------------------------------
// renderColumnBody — builds the body JSX for a given column entry
// ---------------------------------------------------------------------------

function renderColumnBody(
  entry: ColumnEntry,
  columnStates: MultiColumnState[],
  detailState: MultiColumnDetailState | undefined,
) {
  const col = entry.config

  if (entry.kind === "list") {
    const listCol = col as MultiColumnConfig
    const state = columnStates[entry.index]
    if (!state) return null

    const enabled = state.enabled !== false

    if (!enabled) {
      return (
        <MasterDetailEmpty
          icon={listCol.emptyIcon}
          title={listCol.emptyTitle ?? "No selection"}
          description={
            listCol.emptyDescription ??
            "Select an item from the previous column."
          }
        />
      )
    }
    if (state.isLoading) {
      return (
        <MasterDetailSkeleton
          count={listCol.skeletonCount ?? 5}
          height={listCol.skeletonHeight ?? "h-16"}
        />
      )
    }
    if (state.data.length === 0) {
      return (
        <MasterDetailEmpty
          icon={listCol.emptyIcon}
          title={listCol.emptyTitle ?? "No items"}
          description={listCol.emptyDescription ?? "No items found."}
        />
      )
    }
    return (
      <VirtualizedList
        config={listCol as MultiColumnConfig<unknown>}
        state={state}
        columnIndex={entry.index}
      />
    )
  }

  if (entry.kind === "content") {
    const contentCol = col as MultiColumnContentConfig
    const state = columnStates[entry.index]
    const enabled = state ? state.enabled !== false : true

    if (!enabled) {
      return (
        <MasterDetailEmpty
          icon={contentCol.emptyIcon}
          title={contentCol.emptyTitle ?? "No selection"}
          description={
            contentCol.emptyDescription ??
            "Select an item from the previous column."
          }
        />
      )
    }
    if (state?.isLoading) {
      return (
        <MasterDetailSkeleton
          count={contentCol.skeletonCount ?? 5}
          height={contentCol.skeletonHeight ?? "h-16"}
        />
      )
    }
    return (
      <div className="size-full overflow-auto">
        {contentCol.renderContent()}
      </div>
    )
  }

  // detail column
  if (!detailState) return null
  const detailCol = col as MultiColumnDetailConfig
  if (detailState.isLoading) {
    return <DetailSkeleton count={detailState.skeletonCount} />
  }
  if (!detailState.hasSelection) {
    return (
      <MasterDetailEmpty
        icon={detailCol.emptyIcon}
        title={detailCol.emptyTitle ?? "No selection"}
        description={
          detailCol.emptyDescription ??
          "Select an item to view details."
        }
      />
    )
  }
  return (
    <div className="size-full overflow-auto">
      {detailState.content}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ResizableColumnLayout — uses ResizablePanelGroup for drag-resizable columns
// ---------------------------------------------------------------------------

function ResizableColumnLayout({
  entries,
  defaultSizes,
  columnStates,
  detailState,
  height,
  className,
}: {
  entries: ColumnEntry[]
  defaultSizes: number[]
  columnStates: MultiColumnState[]
  detailState: MultiColumnDetailState | undefined
  height: string
  className?: string
}) {
  const { setRef } = useSyncedHeaderHeight(entries.length)

  return (
    <ResizablePanelGroup
      direction="horizontal"
      data-slot="multi-column-layout"
      className={cn("overflow-hidden rounded-lg border", className)}
      style={{ height }}
    >
      {entries.map((entry, visualIdx) => {
        const col = entry.config
        const isLast = visualIdx === entries.length - 1
        const colResizable = col.resizable !== false

        const panelContent = (
          <div className="flex size-full flex-col">
            <div
              ref={setRef(visualIdx)}
              data-slot="multi-column-header"
              className="flex shrink-0 flex-col justify-center border-b px-4 py-3"
            >
              {renderColumnHeader(entry, columnStates)}
            </div>
            <div
              data-slot="multi-column-body"
              className="min-h-0 flex-1 overflow-hidden"
            >
              {renderColumnBody(entry, columnStates, detailState)}
            </div>
          </div>
        )

        return (
          <React.Fragment key={col.id}>
            <ResizablePanel
              defaultSize={defaultSizes[visualIdx]}
              minSize={col.minSize ?? 10}
              maxSize={col.maxSize}
              id={col.id}
              order={visualIdx}
            >
              {panelContent}
            </ResizablePanel>
            {!isLast && (
              <ResizableHandle
                disabled={!colResizable && entries[visualIdx + 1]?.config.resizable === false}
              />
            )}
          </React.Fragment>
        )
      })}
    </ResizablePanelGroup>
  )
}

// ---------------------------------------------------------------------------
// FixedColumnLayout — original CSS grid layout (non-resizable fallback)
// ---------------------------------------------------------------------------

function FixedColumnLayout({
  entries,
  columnStates,
  detailState,
  height,
  className,
}: {
  entries: ColumnEntry[]
  columnStates: MultiColumnState[]
  detailState: MultiColumnDetailState | undefined
  height: string
  className?: string
}) {
  const gridCols = entries
    .map((entry) => entry.config.width ?? "1fr")
    .join(" ")
  const totalCols = entries.length

  return (
    <div
      data-slot="multi-column-layout"
      className={cn("grid overflow-hidden rounded-lg border", className)}
      style={{
        height,
        gridTemplateColumns: gridCols,
        gridTemplateRows: "auto 1fr",
      }}
    >
      {entries.map((entry, visualIdx) => {
        const isLast = visualIdx === totalCols - 1
        return (
          <div
            key={`header-${entry.config.id}`}
            data-slot="multi-column-header"
            className={cn(
              "flex min-h-14 flex-col justify-center border-b px-4 py-3",
              !isLast && "border-r",
            )}
          >
            {renderColumnHeader(entry, columnStates)}
          </div>
        )
      })}

      {entries.map((entry, visualIdx) => {
        const isLast = visualIdx === totalCols - 1
        return (
          <div
            key={`body-${entry.config.id}`}
            data-slot="multi-column-body"
            className={cn(
              "min-h-0 overflow-hidden",
              !isLast && "border-r",
            )}
          >
            {renderColumnBody(entry, columnStates, detailState)}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// MultiColumnLayout — main entry point
// ---------------------------------------------------------------------------

function MultiColumnLayout({
  columns,
  columnStates,
  detailColumn,
  detailState,
  height = "calc(100vh - 20rem)",
  className,
  resizable = true,
}: MultiColumnLayoutProps) {
  const entries: ColumnEntry[] = []

  columns.forEach((col, idx) => {
    if (isContentColumn(col)) {
      entries.push({ config: col, kind: "content", index: idx })
    } else {
      entries.push({ config: col, kind: "list", index: idx })
    }
  })

  if (detailColumn) {
    entries.push({ config: detailColumn, kind: "detail", index: -1 })
  }

  if (resizable) {
    const defaultSizes = computeDefaultSizes(entries)
    return (
      <ResizableColumnLayout
        entries={entries}
        defaultSizes={defaultSizes}
        columnStates={columnStates}
        detailState={detailState}
        height={height}
        className={className}
      />
    )
  }

  return (
    <FixedColumnLayout
      entries={entries}
      columnStates={columnStates}
      detailState={detailState}
      height={height}
      className={className}
    />
  )
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { MultiColumnLayout, VirtualizedList, DetailSkeleton, ColumnHeader }

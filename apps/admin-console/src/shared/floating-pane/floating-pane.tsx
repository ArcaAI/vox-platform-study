'use client';

/**
 * `FloatingPane` — a panel that floats over a positioned "stage" (TASK-1036 OD-17: the Workflow
 * Studio's palette and inspector float over the canvas instead of squeezing it).
 *
 * What it guarantees:
 *  - **Movable and resizable by pointer OR keyboard** (WCAG 2.5.7 — a drag always has a
 *    single-pointer / keyboard alternative). The header grip is a real button: Arrow keys move the
 *    pane by `STEP` px, Shift+Arrow resizes it. The edge handle is a focusable `separator` and
 *    resizes with plain arrows.
 *  - **Snaps to an edge.** `defaultDock` is where it starts (and where the Snap button returns
 *    it); moving it releases the dock. A docked pane tracks the stage on resize; a free pane keeps
 *    its pixel rect.
 *  - **Collapsible** to its header strip. `keepMounted` keeps the body in the tree (hidden) so a
 *    stateful child (a search box, a form) survives a collapse.
 *  - **Persisted per pane id in `localStorage`** — a convenience, never a dependency: every read
 *    and write is try/catch'd and the pane renders from its defaults when storage throws or holds
 *    junk (private windows, blocked site data).
 *  - **Never obscures the focused element** (WCAG 2.4.11): when focus lands on something OUTSIDE
 *    the pane that the pane currently covers, the pane yields (collapses, not persisted) and comes
 *    back when that element loses focus. The canvas is not a scroll container, so scrolling the
 *    element into view is not an option; getting out of the way is.
 *  - **Stacked below `md`.** Under the `md` breakpoint the pane is a static section in normal flow
 *    (no overlap is possible on a phone), and the geometry below only applies at `md` and up.
 *
 * Geometry reaches CSS through custom properties (`--fp-x`, …), because the numbers are runtime
 * values; the Tailwind classes that consume them are written out LITERALLY (v4 scans source text).
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { IconChevronDown, IconChevronUp, IconGripVertical, IconLayoutSidebar, IconLayoutSidebarRight, IconX } from '@tabler/icons-react';
import { Button, cn } from '@arcaai/ui';

export type FloatingPaneDock = 'left' | 'right';

/** Pixels one arrow key press moves / resizes by. */
const STEP = 16;
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 420;

interface PaneState {
  dock: FloatingPaneDock | null;
  x: number;
  y: number;
  width: number;
  height: number;
  collapsed: boolean;
}

export function floatingPaneStorageKey(id: string): string {
  return `hope.floating-pane.v1.${id}`;
}

function readStored(id: string): Partial<PaneState> | null {
  try {
    const raw = window.localStorage.getItem(floatingPaneStorageKey(id));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Record<string, unknown>;
    const out: Partial<PaneState> = {};
    if (value.dock === 'left' || value.dock === 'right' || value.dock === null) out.dock = value.dock;
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      const n = value[key];
      if (typeof n === 'number' && Number.isFinite(n)) out[key] = n;
    }
    if (typeof value.collapsed === 'boolean') out.collapsed = value.collapsed;
    return out;
  } catch {
    return null;
  }
}

function writeStored(id: string, state: PaneState): void {
  try {
    window.localStorage.setItem(floatingPaneStorageKey(id), JSON.stringify(state));
  } catch {
    /* storage is a convenience; the pane works without it */
  }
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  if (a.width === 0 || a.height === 0 || b.width === 0 || b.height === 0) return false;
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export interface FloatingPaneProps {
  /** Persistence key — unique per pane. */
  id: string;
  /** Names the region, the header and every control's accessible name. */
  title: string;
  children: ReactNode;
  /** Where the pane starts and what the Snap button returns it to. `null` = free-floating. Default `right`. */
  defaultDock?: FloatingPaneDock | null;
  defaultWidth?: number;
  defaultHeight?: number;
  /** Starting position when `defaultDock` is `null`. */
  defaultPosition?: { x: number; y: number };
  defaultCollapsed?: boolean;
  minWidth?: number;
  minHeight?: number;
  /** Renders a close control when supplied. */
  onClose?: () => void;
  /** Keep the body mounted (hidden) while collapsed / yielding. */
  keepMounted?: boolean;
  /** The pane body is the one scroll container (default). Pass `false` when the child scrolls itself. */
  bodyScroll?: boolean;
  /** Extra controls rendered in the header, before the pane's own. */
  headerActions?: ReactNode;
  className?: string;
}

export function FloatingPane({
  id,
  title,
  children,
  defaultDock = 'right',
  defaultWidth = DEFAULT_WIDTH,
  defaultHeight = DEFAULT_HEIGHT,
  defaultPosition = { x: 16, y: 16 },
  defaultCollapsed = false,
  minWidth = 220,
  minHeight = 160,
  onClose,
  keepMounted = false,
  bodyScroll = true,
  headerActions,
  className,
}: FloatingPaneProps) {
  const headingId = useId();
  const paneRef = useRef<HTMLElement>(null);
  const [state, setState] = useState<PaneState>(() => ({
    dock: defaultDock,
    x: defaultPosition.x,
    y: defaultPosition.y,
    width: defaultWidth,
    height: defaultHeight,
    collapsed: defaultCollapsed,
    ...(typeof window === 'undefined' ? null : readStored(id)),
  }));
  const [yielding, setYielding] = useState(false);

  const commit = useCallback(
    (patch: Partial<PaneState>) => {
      setState((previous) => {
        const next = { ...previous, ...patch };
        writeStored(id, next);
        return next;
      });
    },
    [id],
  );

  /** The stage this pane floats over — its positioned parent. Sizes are 0 where layout does not exist (jsdom). */
  const stageSize = useCallback(() => {
    const stage = paneRef.current?.parentElement;
    return { width: stage?.clientWidth ?? 0, height: stage?.clientHeight ?? 0 };
  }, []);

  const clampPosition = useCallback(
    (x: number, y: number, width: number) => {
      const stage = stageSize();
      const maxX = stage.width > 0 ? Math.max(0, stage.width - width) : Number.POSITIVE_INFINITY;
      const maxY = stage.height > 0 ? Math.max(0, stage.height - 40) : Number.POSITIVE_INFINITY;
      return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
    },
    [stageSize],
  );

  /** The pane's current pixel position, whether docked or free (a docked pane is measured). */
  const currentOrigin = useCallback((): { x: number; y: number } => {
    if (state.dock === null) return { x: state.x, y: state.y };
    const stage = stageSize();
    return { x: state.dock === 'right' ? Math.max(0, stage.width - state.width - 12) : 12, y: 12 };
  }, [state, stageSize]);

  const moveBy = useCallback(
    (dx: number, dy: number) => {
      const origin = currentOrigin();
      const next = clampPosition(origin.x + dx, origin.y + dy, state.width);
      commit({ dock: null, x: next.x, y: next.y });
    },
    [clampPosition, commit, currentOrigin, state.width],
  );

  /**
   * Resize by `(dw, dh)` where positive means "bigger". A right-docked pane's grabbable edge is its
   * LEFT edge, so the caller passes the already-signed delta.
   */
  const resizeBy = useCallback(
    (dw: number, dh: number) => {
      commit({
        width: Math.max(minWidth, state.width + dw),
        height: state.dock === null ? Math.max(minHeight, state.height + dh) : state.height,
      });
    },
    [commit, minHeight, minWidth, state.dock, state.height, state.width],
  );

  // --- keyboard -------------------------------------------------------------------------------
  function onGripKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const delta = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[event.key];
    if (!delta) return;
    event.preventDefault();
    if (event.shiftKey) {
      // Shift+Arrow resizes in the direction the arrow points: toward the dock edge shrinks.
      const growsRight = state.dock !== 'right';
      resizeBy(delta[0] === 0 ? 0 : (delta[0] > 0 ? 1 : -1) * (growsRight ? 1 : -1) * STEP, delta[1]);
      return;
    }
    moveBy(delta[0], delta[1]);
  }

  function onHandleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const delta = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const growsRight = state.dock !== 'right';
    resizeBy(delta[0] === 0 ? 0 : (delta[0] > 0 ? 1 : -1) * (growsRight ? 1 : -1) * STEP, delta[1]);
  }

  // --- pointer --------------------------------------------------------------------------------
  /** One pointer drag, shared by the grip (move) and the handle (resize). Window-level listeners so the pointer can leave the control. */
  const startDrag = useCallback((event: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') => {
    if (event.button !== undefined && event.button > 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = currentOrigin();
    const base = state;
    const growsRight = base.dock !== 'right';
    let latest: Partial<PaneState> = {};
    function onMove(move: PointerEvent) {
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      if (mode === 'move') {
        const next = clampPosition(origin.x + dx, origin.y + dy, base.width);
        latest = { dock: null, x: next.x, y: next.y };
      } else {
        latest = {
          width: Math.max(minWidth, base.width + (growsRight ? dx : -dx)),
          ...(base.dock === null ? { height: Math.max(minHeight, base.height + dy) } : null),
        };
      }
      setState((previous) => ({ ...previous, ...latest }));
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      commit(latest);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [clampPosition, commit, currentOrigin, minHeight, minWidth, state]);

  // --- WCAG 2.4.11: never cover the focused element -------------------------------------------
  useEffect(() => {
    function onFocusIn(event: FocusEvent) {
      const pane = paneRef.current;
      const target = event.target;
      if (!pane || !(target instanceof Element)) return;
      if (pane.contains(target)) {
        setYielding(false);
        return;
      }
      if (!pane.parentElement?.contains(target)) return;
      setYielding(overlaps(pane.getBoundingClientRect(), target.getBoundingClientRect()));
    }
    function onFocusOut() {
      setYielding(false);
    }
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  const collapsed = state.collapsed || yielding;
  const geometry = { '--fp-x': `${state.x}px`, '--fp-y': `${state.y}px`, '--fp-w': `${state.width}px`, '--fp-h': `${state.height}px` } as React.CSSProperties;
  const SnapIcon = (defaultDock ?? 'right') === 'left' ? IconLayoutSidebar : IconLayoutSidebarRight;
  const snapSide = defaultDock ?? 'right';

  return (
    <section
      ref={paneRef}
      role="region"
      aria-labelledby={headingId}
      data-slot="floating-pane"
      data-dock={state.dock ?? 'none'}
      data-x={state.x}
      data-y={state.y}
      data-width={state.width}
      data-height={state.height}
      data-collapsed={state.collapsed}
      data-yielding={yielding}
      style={geometry}
      className={cn(
        // Below md: an ordinary stacked section. At md and up: positioned over the stage.
        'bg-card text-card-foreground z-10 flex min-h-0 flex-col rounded-lg border shadow-lg md:absolute',
        state.dock === 'right' && !collapsed && 'md:top-3 md:right-3 md:bottom-3 md:w-[var(--fp-w)]',
        state.dock === 'right' && collapsed && 'md:top-3 md:right-3 md:w-[var(--fp-w)]',
        state.dock === 'left' && !collapsed && 'md:top-3 md:bottom-3 md:left-3 md:w-[var(--fp-w)]',
        state.dock === 'left' && collapsed && 'md:top-3 md:left-3 md:w-[var(--fp-w)]',
        state.dock === null && !collapsed && 'md:top-[var(--fp-y)] md:left-[var(--fp-x)] md:h-[var(--fp-h)] md:w-[var(--fp-w)]',
        state.dock === null && collapsed && 'md:top-[var(--fp-y)] md:left-[var(--fp-x)] md:w-[var(--fp-w)]',
        className,
      )}
    >
      <header className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Move ${title}`}
          title={`Drag, or use the arrow keys, to move ${title}. Shift+Arrow resizes it.`}
          className="cursor-grab touch-none active:cursor-grabbing"
          onPointerDown={(event) => startDrag(event, 'move')}
          onKeyDown={onGripKeyDown}
        >
          <IconGripVertical aria-hidden="true" />
        </Button>
        <h2 id={headingId} className="text-muted-foreground min-w-0 flex-1 truncate text-xs font-medium tracking-wide uppercase">
          {title}
        </h2>
        {headerActions}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Snap ${title} to the ${snapSide}`}
          title={`Snap to the ${snapSide} edge`}
          onClick={() => commit({ dock: snapSide })}
        >
          <SnapIcon aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
          title={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
          onClick={() => {
            setYielding(false);
            commit({ collapsed: !state.collapsed });
          }}
        >
          {collapsed ? <IconChevronDown aria-hidden="true" /> : <IconChevronUp aria-hidden="true" />}
        </Button>
        {onClose ? (
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Close ${title}`} title={`Close ${title}`} onClick={onClose}>
            <IconX aria-hidden="true" />
          </Button>
        ) : null}
      </header>
      {collapsed && !keepMounted ? null : (
        <div hidden={collapsed} className={cn('min-h-0 flex-1 p-2', bodyScroll ? 'overflow-y-auto' : 'overflow-hidden')}>
          {children}
        </div>
      )}
      {collapsed ? null : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${title}`}
          aria-valuenow={state.width}
          aria-valuemin={minWidth}
          aria-valuemax={1600}
          tabIndex={0}
          title={`Drag, or use the arrow keys, to resize ${title}`}
          onPointerDown={(event) => startDrag(event, 'resize')}
          onKeyDown={onHandleKeyDown}
          className={cn(
            'focus-visible:bg-ring/40 hover:bg-ring/20 absolute z-10 hidden touch-none md:block',
            state.dock === 'right' && 'inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l-lg',
            state.dock === 'left' && 'inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-lg',
            state.dock === null && 'right-0 bottom-0 size-4 cursor-nwse-resize rounded-br-lg',
          )}
        />
      )}
    </section>
  );
}

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
 *  - **Never stranded off the stage** (TASK-1036 R-C #4). The saved x / y / width are CLAMPED to
 *    the stage on mount and whenever it resizes, and the width is capped at a share of the stage
 *    (`MAX_STAGE_SHARE`), so a layout saved on a wide monitor cannot hide a pane, or the canvas,
 *    on a laptop. The clamp is display-only: the saved preference is left alone, so the author's
 *    own layout comes back on a bigger window. "Reset layout" restores the defaults, and a
 *    double-click on the header snaps the pane back to its edge.
 *  - **A drag moves, it never resizes** (owner, 2026-10-05). The clamp moves the pane to keep it
 *    on the stage and shrinks it only when the stage genuinely cannot hold it. A docked pane is
 *    DRAWN the stage's full height, so un-docking it (by pointer or keyboard) carries that drawn
 *    height into the free geometry — before, the free pane fell back to its stored default height
 *    and visibly shrank the moment it was picked up.
 *  - **Reports its footprint** (R-C #2): `onFootprintChange` hears how far the pane reaches in
 *    from the stage's left / right edge, so the canvas can fit its graph clear of it. (Nothing
 *    POSITIONS itself off it: the canvas chrome is anchored — owner, 2026-10-05.) A collapsed pane, an unmounted one and the stacked (below `md`) layout report
 *    none.
 *
 * Geometry reaches CSS through custom properties (`--fp-x`, …), because the numbers are runtime
 * values; the Tailwind classes that consume them are written out LITERALLY (v4 scans source text).
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { IconChevronDown, IconChevronUp, IconGripVertical, IconLayoutSidebar, IconLayoutSidebarRight, IconRestore, IconX } from '@tabler/icons-react';
import { Button, cn } from '@arcaai/ui';

export type FloatingPaneDock = 'left' | 'right';

/** Pixels one arrow key press moves / resizes by. */
const STEP = 16;
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 420;
/** The gap a docked pane keeps from the stage edge (`md:top-3` / `md:left-3` / `md:right-3`). */
const DOCK_MARGIN = 12;
/** How close to a side an undocked pane must sit to still reserve that side for the canvas fit. */
const EDGE_RESERVE = 48;
/** The widest a pane may be, as a share of the stage — two panes must still leave the canvas room. */
const MAX_STAGE_SHARE = 0.45;
/** How much of a pane's header must stay on the stage vertically. */
const HEADER_KEEP = 40;
/** The `md` breakpoint: below it the pane is a stacked section and floats over nothing. */
const OVERLAY_QUERY = '(min-width: 768px)';

/** How far a pane reaches in from the stage's left and right edges, in px. */
export interface FloatingPaneFootprint {
  left: number;
  right: number;
}

const NO_FOOTPRINT: FloatingPaneFootprint = { left: 0, right: 0 };

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

interface StageSize {
  width: number;
  height: number;
}

/**
 * R-C #4 — the geometry the pane is DRAWN with: the saved state, pulled onto the stage and with
 * its width capped. A stage that has not been measured (0 × 0: before layout, or a test with no
 * layout engine) clamps nothing.
 */
export function clampPaneGeometry<T extends Pick<PaneState, 'x' | 'y' | 'width' | 'height'> & { collapsed?: boolean }>(
  state: T,
  stage: StageSize,
  bounds: { minWidth: number; minHeight: number },
): T {
  if (stage.width <= 0 || stage.height <= 0) return state;
  const maxWidth = Math.max(bounds.minWidth, Math.floor(stage.width * MAX_STAGE_SHARE));
  const width = Math.min(Math.max(bounds.minWidth, state.width), maxWidth);
  // The SIZE gives way only when the stage cannot hold it; otherwise the POSITION does.
  const height = Math.min(Math.max(bounds.minHeight, state.height), Math.max(bounds.minHeight, stage.height));
  const { x, y } = clampOrigin(state.x, state.y, { width, height: state.collapsed ? HEADER_KEEP : height }, stage);
  if (width === state.width && x === state.x && y === state.y && height === state.height) return state;
  return { ...state, width, x, y, height };
}

/**
 * Pull an origin onto the stage so a pane of `size` fits wholly on it — the pane MOVES, its size is
 * untouched. An unmeasured stage (0 × 0) clamps only the top-left.
 */
function clampOrigin(x: number, y: number, size: { width: number; height: number }, stage: StageSize): { x: number; y: number } {
  const maxX = stage.width > 0 ? Math.max(0, stage.width - size.width) : Number.POSITIVE_INFINITY;
  const maxY = stage.height > 0 ? Math.max(0, stage.height - size.height) : Number.POSITIVE_INFINITY;
  return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
}

/** The height a DOCKED pane is drawn at (`md:top-3 … md:bottom-3`); its stored height before the stage is measured. */
function dockedHeight(stored: number, stage: StageSize): number {
  return stage.height > 0 ? Math.max(0, stage.height - 2 * DOCK_MARGIN) : stored;
}

/** R-C #1 — the band of the stage a pane covers, measured in from the edge it sits against. */
export function paneFootprint(geometry: Pick<PaneState, 'dock' | 'x' | 'width'>, stage: StageSize): FloatingPaneFootprint {
  if (geometry.dock === 'left') return { left: DOCK_MARGIN + geometry.width, right: 0 };
  if (geometry.dock === 'right') return { left: 0, right: DOCK_MARGIN + geometry.width };
  if (stage.width <= 0) return NO_FOOTPRINT;
  // An undocked pane reserves a side only while it sits against that side. Dragged into the middle,
  // it floats above the graph by the author's choice; squeezing the fit into what is left of it
  // pushed half of the graph off-screen (TASK-1036 live check).
  if (geometry.x <= EDGE_RESERVE) return { left: geometry.x + geometry.width, right: 0 };
  if (geometry.x + geometry.width >= stage.width - EDGE_RESERVE) return { left: 0, right: Math.max(0, stage.width - geometry.x) };
  return NO_FOOTPRINT;
}

function subscribeOverlay(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(OVERLAY_QUERY);
  query.addEventListener?.('change', onChange);
  return () => query.removeEventListener?.('change', onChange);
}
function readOverlay(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(OVERLAY_QUERY).matches;
}
/** Whether the pane floats (md and up) — only then does it cover any of the stage. */
function useFloats(): boolean {
  return useSyncExternalStore(subscribeOverlay, readOverlay, () => true);
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
  /**
   * R-C #1 — hears how far the pane reaches in from the stage's left / right edge (a collapsed,
   * stacked or unmounted pane reports `{ left: 0, right: 0 }`). Pass a STABLE callback.
   */
  onFootprintChange?: (footprint: FloatingPaneFootprint) => void;
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
  onFootprintChange,
  className,
}: FloatingPaneProps) {
  const headingId = useId();
  const paneRef = useRef<HTMLElement>(null);
  const [savedState, setState] = useState<PaneState>(() => ({
    dock: defaultDock,
    x: defaultPosition.x,
    y: defaultPosition.y,
    width: defaultWidth,
    height: defaultHeight,
    collapsed: defaultCollapsed,
    ...(typeof window === 'undefined' ? null : readStored(id)),
  }));
  const [yielding, setYielding] = useState(false);

  // --- the stage, measured (R-C #4) -----------------------------------------------------------
  const [stage, setStage] = useState<StageSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = paneRef.current?.parentElement;
    if (!element) return undefined;
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setStage((previous) => (previous.width === next.width && previous.height === next.height ? previous : next));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  /** What is DRAWN and what every gesture starts from: the saved state, clamped to the stage. */
  const state = clampPaneGeometry(savedState, stage, { minWidth, minHeight });
  const maxWidth = stage.width > 0 ? Math.max(minWidth, Math.floor(stage.width * MAX_STAGE_SHARE)) : 1600;

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
    const element = paneRef.current?.parentElement;
    return { width: element?.clientWidth ?? 0, height: element?.clientHeight ?? 0 };
  }, []);

  /**
   * The pane's current pixel RECT, whether docked or free. A docked pane is drawn from the dock
   * margin to the stage's far edge, so its height is the stage's (less the margins), not the
   * stored one — that is the size a move must carry over.
   */
  const currentRect = useCallback((): { x: number; y: number; width: number; height: number } => {
    if (state.dock === null) return { x: state.x, y: state.y, width: state.width, height: state.height };
    const stage = stageSize();
    return {
      x: state.dock === 'right' ? Math.max(0, stage.width - state.width - DOCK_MARGIN) : DOCK_MARGIN,
      y: DOCK_MARGIN,
      width: state.width,
      height: dockedHeight(state.height, stage),
    };
  }, [state, stageSize]);

  /** A MOVE: new origin, same size (a docked pane's drawn size becomes its free size). */
  const movedTo = useCallback(
    (rect: { x: number; y: number; width: number; height: number }, dx: number, dy: number): Partial<PaneState> => {
      const next = clampOrigin(rect.x + dx, rect.y + dy, { width: rect.width, height: state.collapsed ? HEADER_KEEP : rect.height }, stageSize());
      return { dock: null, x: next.x, y: next.y, width: rect.width, height: rect.height };
    },
    [stageSize, state.collapsed],
  );

  const moveBy = useCallback(
    (dx: number, dy: number) => {
      commit(movedTo(currentRect(), dx, dy));
    },
    [commit, currentRect, movedTo],
  );

  /**
   * Resize by `(dw, dh)` where positive means "bigger". A right-docked pane's grabbable edge is its
   * LEFT edge, so the caller passes the already-signed delta.
   */
  const resizeBy = useCallback(
    (dw: number, dh: number) => {
      commit({
        width: Math.min(maxWidth, Math.max(minWidth, state.width + dw)),
        height: state.dock === null ? Math.max(minHeight, state.height + dh) : state.height,
      });
    },
    [commit, maxWidth, minHeight, minWidth, state.dock, state.height, state.width],
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
    const rect = currentRect();
    const base = state;
    const growsRight = base.dock !== 'right';
    let latest: Partial<PaneState> = {};
    function onMove(move: PointerEvent) {
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      if (mode === 'move') {
        latest = movedTo(rect, dx, dy);
      } else {
        latest = {
          width: Math.min(maxWidth, Math.max(minWidth, base.width + (growsRight ? dx : -dx))),
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
  }, [commit, currentRect, maxWidth, minHeight, minWidth, movedTo, state]);

  // --- WCAG 2.4.11: never cover the focused element -------------------------------------------
  // Two cases never yield (TASK-1036 live check — dragging the inspector over the palette
  // collapsed the palette): focus inside ANOTHER floating pane (panes overlap by the author's
  // choice; stacking order handles that), and focus that came from a pointer (2.4.11 concerns
  // keyboard focus; a click must not collapse the pane the author is working in).
  useEffect(() => {
    let lastInput: 'keyboard' | 'pointer' = 'keyboard';
    function onPointerDown() {
      lastInput = 'pointer';
    }
    function onKeyDown() {
      lastInput = 'keyboard';
    }
    function onFocusIn(event: FocusEvent) {
      const pane = paneRef.current;
      const target = event.target;
      if (!pane || !(target instanceof Element)) return;
      if (pane.contains(target)) {
        setYielding(false);
        return;
      }
      if (!pane.parentElement?.contains(target)) return;
      if (lastInput === 'pointer' || target.closest('[data-slot="floating-pane"]')) {
        setYielding(false);
        return;
      }
      setYielding(overlaps(pane.getBoundingClientRect(), target.getBoundingClientRect()));
    }
    function onFocusOut() {
      setYielding(false);
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  // --- R-C #1: the footprint, for the canvas ---------------------------------------------------
  // Read off the SAVED collapse, not `yielding`: a pane that steps aside for a focused element must
  // not move the canvas chrome out from under that same focus.
  const floats = useFloats();
  const footprint = !floats || state.collapsed ? NO_FOOTPRINT : paneFootprint(state, stage);
  const footprintLeft = footprint.left;
  const footprintRight = footprint.right;
  useEffect(() => {
    onFootprintChange?.({ left: footprintLeft, right: footprintRight });
  }, [onFootprintChange, footprintLeft, footprintRight]);
  useEffect(() => {
    if (!onFootprintChange) return undefined;
    return () => onFootprintChange(NO_FOOTPRINT);
  }, [onFootprintChange]);

  // --- R-C #4: reset and snap ------------------------------------------------------------------
  const snapSide = defaultDock ?? 'right';
  function resetLayout() {
    setYielding(false);
    commit({ dock: defaultDock, x: defaultPosition.x, y: defaultPosition.y, width: defaultWidth, height: defaultHeight, collapsed: false });
  }
  function onHeaderDoubleClick(event: React.MouseEvent<HTMLElement>) {
    // A double-click that lands on a header control is that control's, not a snap.
    if (event.target instanceof Element && event.target.closest('button')) return;
    commit({ dock: snapSide });
  }

  const collapsed = state.collapsed || yielding;
  const geometry = { '--fp-x': `${state.x}px`, '--fp-y': `${state.y}px`, '--fp-w': `${state.width}px`, '--fp-h': `${state.height}px` } as React.CSSProperties;
  const SnapIcon = snapSide === 'left' ? IconLayoutSidebar : IconLayoutSidebarRight;

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
      // The DRAWN height: a docked pane spans the stage (less the dock margins).
      data-height={state.dock === null ? state.height : dockedHeight(state.height, stage)}
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
      {/* Double-click snaps home (R-C #4) — a pointer shortcut; the Snap button is the named path. */}
      <header className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5" onDoubleClick={onHeaderDoubleClick}>
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
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Reset ${title} layout`} title="Reset position and size" onClick={resetLayout}>
          <IconRestore aria-hidden="true" />
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
        <div
          hidden={collapsed}
          // A scrolling body is keyboard-scrollable even when everything in it is disabled (a locked palette) — WCAG 2.1.1.
          tabIndex={bodyScroll ? 0 : undefined}
          // A name needs a role to hang on (axe `aria-prohibited-attr`): the scrolling body is a named group.
          role={bodyScroll ? 'group' : undefined}
          aria-label={bodyScroll ? `${title} content` : undefined}
          className={cn(
            'min-h-0 flex-1 p-2',
            bodyScroll ? 'focus-visible:ring-ring overflow-y-auto rounded-b-md outline-none focus-visible:ring-2' : 'overflow-hidden',
          )}
        >
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
          aria-valuemax={maxWidth}
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

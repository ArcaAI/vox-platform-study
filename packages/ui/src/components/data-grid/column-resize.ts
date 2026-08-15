/**
 * Keyboard column-resize logic (WCAG 2.5.7 drag alternative).
 * The separator is a focusable `role="separator"`; these helpers turn key
 * presses into size deltas so the behaviour is unit-testable.
 */
import type { Column, RowData, Table } from '@tanstack/react-table';
import type { DataGridFeatures } from './table-features';

/**
 * ←/→ = ±16px, Shift+←/→ = ±48px, Home/Enter = reset. Everything else is
 * ignored (returns `null`) so the key event is not consumed.
 */
export function computeResizeDelta(key: string, shiftKey: boolean): number | 'reset' | null {
  switch (key) {
    case 'ArrowRight':
      return shiftKey ? 48 : 16;
    case 'ArrowLeft':
      return shiftKey ? -48 : -16;
    case 'Home':
    case 'Enter':
      return 'reset';
    default:
      return null;
  }
}

/**
 * Apply a keyboard resize to `column`, clamped to its `minSize`/`maxSize`.
 * Returns `true` when the event was handled (so the caller can `preventDefault`).
 */
export function applyResizeKeydown<TData extends RowData>(
  event: { key: string; shiftKey: boolean; preventDefault: () => void },
  column: Column<DataGridFeatures, TData>,
  table: Table<DataGridFeatures, TData>,
): boolean {
  const delta = computeResizeDelta(event.key, event.shiftKey);
  if (delta === null) return false;
  event.preventDefault();
  if (delta === 'reset') {
    column.resetSize();
    return true;
  }
  const min = column.columnDef.minSize ?? 40;
  const max = column.columnDef.maxSize ?? Number.MAX_SAFE_INTEGER;
  const next = Math.min(max, Math.max(min, column.getSize() + delta));
  table.setColumnSizing((prev) => ({ ...prev, [column.id]: next }));
  return true;
}

/**
 * TASK-890 black-box J4-F1 — the palette→canvas drag payload.
 *
 * A private MIME type carries the registry `type`, so a drop from the palette is
 * distinguishable from any other drag the browser might deliver to the pane. `text/plain` rides
 * along for the drag image / cross-surface paste only; a reader must still validate the type
 * against the live registry, which is why `readPaletteDragType` returns the raw string and
 * decides nothing about whether it exists.
 */
import { describe, expect, it } from 'vitest';
import { PALETTE_DRAG_MIME, readPaletteDragType, writePaletteDragType } from '../palette-drag';

function transfer(entries: Record<string, string> = {}): DataTransfer {
  const store = new Map(Object.entries(entries));
  return {
    effectAllowed: 'none',
    setData: (format: string, value: string) => void store.set(format, value),
    getData: (format: string) => store.get(format) ?? '',
  } as unknown as DataTransfer;
}

describe('palette drag payload', () => {
  it('round-trips the node type through the private MIME', () => {
    const dt = transfer();
    writePaletteDragType(dt, 'core.agent');

    expect(dt.getData(PALETTE_DRAG_MIME)).toBe('core.agent');
    expect(dt.getData('text/plain')).toBe('core.agent');
    expect(dt.effectAllowed).toBe('copy');
    expect(readPaletteDragType(dt)).toBe('core.agent');
  });

  it('reads nothing from a foreign drag (a file, a text selection, a null transfer)', () => {
    expect(readPaletteDragType(transfer({ 'text/plain': 'some pasted prose' }))).toBeNull();
    expect(readPaletteDragType(transfer())).toBeNull();
    expect(readPaletteDragType(null)).toBeNull();
  });

  it('tolerates a transfer that throws on read — a drop is never a crash', () => {
    const hostile = {
      getData: () => {
        throw new Error('permission denied');
      },
    } as unknown as DataTransfer;
    expect(readPaletteDragType(hostile)).toBeNull();
  });
});

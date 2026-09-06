/**
 * TASK-890 black-box J4-F1 — the palette→canvas drag payload.
 *
 * One private MIME type carrying the registry `type`, so the pane can tell a palette drag from
 * any other drag the browser hands it (a file, a text selection, a link). `text/plain` is written
 * too — it costs nothing, gives the drag a sensible representation outside the canvas, and is
 * NEVER read back as a node type: a stray text drop must not create a node.
 *
 * The drag is an enhancement over the palette's `<button>` click, never a replacement — adding a
 * node stays possible with the keyboard alone (WCAG 2.5.7).
 */

/** The one format a palette drag is recognised by. Private to this app; never a wire contract. */
export const PALETTE_DRAG_MIME = 'application/x-hope-workflow-node';

/** Stamp a palette item's registry type onto an outgoing drag. */
export function writePaletteDragType(dataTransfer: DataTransfer | null, type: string): void {
  if (!dataTransfer) return;
  dataTransfer.setData(PALETTE_DRAG_MIME, type);
  dataTransfer.setData('text/plain', type);
  dataTransfer.effectAllowed = 'copy';
}

/**
 * The registry type a drop carries, or `null` for anything that is not a palette drag. The
 * string is returned RAW: whether that type actually exists is the registry's answer, not this
 * module's. Total — a hostile/foreign `DataTransfer` that throws on read reads as "not ours".
 */
export function readPaletteDragType(dataTransfer: DataTransfer | null): string | null {
  if (!dataTransfer) return null;
  try {
    const type = dataTransfer.getData(PALETTE_DRAG_MIME);
    return typeof type === 'string' && type.length > 0 ? type : null;
  } catch {
    return null;
  }
}

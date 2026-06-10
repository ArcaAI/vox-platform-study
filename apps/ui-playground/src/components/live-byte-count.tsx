/**
 * LiveByteCount (TASK-351 P0-6 / H7).
 *
 * Leaf subscriber for a `ByteCounterHandle`: byte ticks re-render only this
 * span — never the parent panel or the transcript list next to it.
 */

import type { ByteCounterHandle } from '@/lib/byte-counter';
import { memo, useSyncExternalStore } from 'react';

export interface LiveByteCountProps {
  handle: ByteCounterHandle;
  /** Format the byte total for display. Defaults to the raw number. */
  format?: (bytes: number) => string;
  className?: string;
}

function LiveByteCountInner({ handle, format, className }: LiveByteCountProps) {
  const bytes = useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot);
  return <span className={className}>{format ? format(bytes) : String(bytes)}</span>;
}

export const LiveByteCount = memo(LiveByteCountInner);

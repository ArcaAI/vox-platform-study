/**
 * Byte counter store (TASK-351 P0-6 / H7).
 *
 * Tracks streaming byte totals outside React state so high-frequency commits
 * (4×/s while streaming) re-render only leaf subscribers (`LiveByteCount`)
 * instead of every component that consumes `useRealtimeTranscription()` —
 * previously each tick re-rendered the whole transcript subtree.
 *
 * The handle is `useSyncExternalStore`-compatible.
 */

export interface ByteCounterHandle {
  /** Subscribe to value changes. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Current byte total. */
  getSnapshot(): number;
}

export interface ByteCounter {
  handle: ByteCounterHandle;
  add(bytes: number): void;
  reset(): void;
}

export function createByteCounter(): ByteCounter {
  let value = 0;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    handle: {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      getSnapshot: () => value,
    },
    add(bytes) {
      if (bytes === 0) return;
      value += bytes;
      notify();
    },
    reset() {
      if (value === 0) return;
      value = 0;
      notify();
    },
  };
}

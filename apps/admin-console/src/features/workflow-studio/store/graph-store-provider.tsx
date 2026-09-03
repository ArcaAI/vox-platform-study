'use client';

/**
 * React context for the per-editor `GraphStore`. Mirrors rule 08 §Store
 * exactly: one `createGraphStore()` per `<GraphStoreProvider>` mount, published through
 * context; `useGraphStore(selector)` / `useGraphStoreApi()` both throw outside a provider.
 * NEVER export the store object itself or a module singleton.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createGraphStore, type GraphStore, type GraphStoreApi } from './create-graph-store';

const GraphStoreContext = createContext<GraphStoreApi | null>(null);
GraphStoreContext.displayName = 'GraphStoreContext';

export function GraphStoreProvider({ children }: { children: ReactNode }) {
  // `useState`'s lazy initializer (not `useRef`) creates the one store instance for this mount
  // — a ref read during render trips the `react-hooks/refs` lint rule (React Compiler-era rule:
  // refs are for effects/handlers, not render), and `useState` is the React-sanctioned way to
  // create a stable, render-visible value exactly once per mount.
  const [store] = useState<GraphStoreApi>(() => createGraphStore());
  return <GraphStoreContext.Provider value={store}>{children}</GraphStoreContext.Provider>;
}

/** Imperative, non-reactive access (`getState`/`setState`/`subscribe`). Throws outside a
 *  `<GraphStoreProvider>` — fail loud rather than silently falling back to a shared instance. */
export function useGraphStoreApi(): GraphStoreApi {
  const api = useContext(GraphStoreContext);
  if (!api) {
    throw new Error('useGraphStoreApi() (and useGraphStore()) must be used within a <GraphStoreProvider>.');
  }
  return api;
}

/** Reactive read. `useGraphStore(selector)` — select atomically per field; wrap multi-field
 *  selections in `useShallow` at the call site (rule 08 §Store). */
export function useGraphStore<T>(selector: (state: GraphStore) => T): T {
  return useStore(useGraphStoreApi(), selector);
}

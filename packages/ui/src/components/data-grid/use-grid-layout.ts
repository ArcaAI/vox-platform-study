'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { GridLayoutState, GridPersistenceConfig } from './types';

const DEFAULT_NAMESPACE = 'ui.data-grid';
const DEFAULT_DEBOUNCE_MS = 600;

export interface UseGridLayoutResult {
  layout: GridLayoutState;
  isLayoutReady: boolean;
  /** Update layout locally and schedule a best-effort debounced save (D8). */
  setLayout: (next: GridLayoutState) => void;
}

/**
 * Loads a per-user grid layout on mount and debounce-saves changes through an
 * injected adapter (D8). Server persistence is best-effort: when persistence is
 * disabled, no adapter is provided, or the adapter rejects, the grid falls back
 * to in-memory defaults and never throws or blocks.
 */
export function useGridLayout(opts: { persistence?: GridPersistenceConfig; defaultLayout: GridLayoutState }): UseGridLayoutResult {
  const { persistence, defaultLayout } = opts;
  const enabled = persistence?.enabled !== false && !!persistence?.adapter && !!persistence?.key;
  const namespace = persistence?.namespace ?? DEFAULT_NAMESPACE;
  const debounceMs = persistence?.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const [layout, setLayoutState] = useState<GridLayoutState>(defaultLayout);
  const [isLayoutReady, setIsLayoutReady] = useState<boolean>(!enabled);

  const loadedRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep latest config in refs so the load effect runs once without re-firing.
  const adapterRef = useRef(persistence?.adapter);
  adapterRef.current = persistence?.adapter;
  const keyRef = useRef(persistence?.key);
  keyRef.current = persistence?.key;

  useEffect(() => {
    if (!enabled || loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;
    const adapter = adapterRef.current;
    const key = keyRef.current;
    if (!adapter || !key) {
      setIsLayoutReady(true);
      return;
    }
    Promise.resolve()
      .then(() => adapter.load(namespace, key))
      .then((loaded) => {
        if (cancelled) return;
        if (loaded) setLayoutState((prev) => ({ ...prev, ...loaded }));
      })
      .catch(() => {
        // best-effort: keep defaults
      })
      .finally(() => {
        if (!cancelled) setIsLayoutReady(true);
      });
    return () => {
      cancelled = true;
      // Re-arm on cleanup so a re-mount (incl. React Strict Mode's dev
      // setup→cleanup→setup) starts a fresh load whose `.finally` isn't
      // cancelled — otherwise `isLayoutReady` would latch `false` forever.
      loadedRef.current = false;
    };
  }, [enabled, namespace]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const setLayout = useCallback(
    (next: GridLayoutState) => {
      setLayoutState(next);
      if (!enabled) return;
      const adapter = adapterRef.current;
      const key = keyRef.current;
      if (!adapter || !key) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        Promise.resolve()
          .then(() => adapter.save(namespace, key, next))
          .catch(() => {
            // best-effort: swallow save failures
          });
      }, debounceMs);
    },
    [enabled, namespace, debounceMs],
  );

  return { layout, isLayoutReady, setLayout };
}

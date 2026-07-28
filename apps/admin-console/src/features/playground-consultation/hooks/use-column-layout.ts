'use client';

/**
 * Per-user column layout for the Consultation Scribe workspace (TASK-543).
 *
 * The three resizable columns (consultations / live session / case note) are a
 * personalized interface setting: sizes persist per user through the SDK's own
 * `useUserSettings` hook (`PATCH user/me/settings/:namespace/:key`), the same
 * per-user settings plane the data-grid layout uses. Persistence is BEST-EFFORT
 * — a miss or a rejected save must never block or break the screen, so the hook
 * falls back to {@link DEFAULT_SCRIBE_SIZES} and swallows failures.
 *
 * The value is a small JSON blob under an app-specific namespace; the settings
 * controller accepts arbitrary namespaces (only `ui.data-grid` and the pipeline
 * keys carry a specific server-side guard), so no backend change is required.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUserSettings } from '@arcaai/vox';

/** App-specific settings namespace for this screen's UI personalization. */
export const SCRIBE_LAYOUT_NAMESPACE = 'ui.consultation-playground';
/** Settings key holding the resizable-column layout. */
export const SCRIBE_LAYOUT_KEY = 'columns';

const DEBOUNCE_MS = 600;
const PANEL_COUNT = 3;

/** Default percentages for [consultations, live session, case note] (≈100). */
export const DEFAULT_SCRIBE_SIZES: readonly number[] = [24, 38, 38];

interface StoredLayout {
  v: 1;
  sizes: number[];
}

/** A layout is valid only as three finite, strictly-positive percentages. */
function isValidSizes(sizes: unknown): sizes is number[] {
  return Array.isArray(sizes) && sizes.length === PANEL_COUNT && sizes.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
}

export interface UseColumnLayoutResult {
  /** Current column percentages (defaults until the persisted layout loads). */
  sizes: number[];
  /** False until the first settings read settles; gate the panel group on it so `defaultSize` reflects the loaded layout. */
  isReady: boolean;
  /** Update locally and schedule a debounced best-effort server save. */
  persist: (sizes: number[]) => void;
}

export function useColumnLayout(): UseColumnLayoutResult {
  const { list, updateByKey } = useUserSettings();

  const [sizes, setSizes] = useState<number[]>([...DEFAULT_SCRIBE_SIZES]);
  const [isReady, setIsReady] = useState(false);

  const loadedRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;

    Promise.resolve()
      .then(() => list())
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
        const row = rows.find((r) => r?.namespace === SCRIBE_LAYOUT_NAMESPACE && r?.key === SCRIBE_LAYOUT_KEY);
        if (!row || typeof row.value !== 'string') return;
        const parsed = JSON.parse(row.value) as StoredLayout;
        if (isValidSizes(parsed?.sizes)) setSizes(parsed.sizes);
      })
      .catch(() => {
        // best-effort: keep defaults on any miss/parse/transport error
      })
      .finally(() => {
        if (!cancelled) setIsReady(true);
      });

    return () => {
      cancelled = true;
      // Re-arm so a Strict-Mode remount re-loads (mirrors data-grid persistence).
      loadedRef.current = false;
    };
  }, [list]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const persist = useCallback(
    (next: number[]) => {
      if (!isValidSizes(next)) return;
      setSizes(next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const payload: StoredLayout = { v: 1, sizes: next };
        Promise.resolve()
          .then(() => updateByKey(SCRIBE_LAYOUT_NAMESPACE, SCRIBE_LAYOUT_KEY, JSON.stringify(payload)))
          .catch(() => {
            // best-effort: a failed persist must never surface to the UI
          });
      }, DEBOUNCE_MS);
    },
    [updateByKey],
  );

  return { sizes, isReady, persist };
}

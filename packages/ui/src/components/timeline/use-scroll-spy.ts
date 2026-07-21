'use client';

import * as React from 'react';

export interface UseScrollSpyParams {
  /** Milestone ids in DOM order. */
  ids: string[];
  /** Px from the top for the sticky marker — biases the active line via `rootMargin`. */
  offset?: number;
  onActiveChange?: (id: string) => void;
  enabled?: boolean;
}

export interface UseScrollSpyResult {
  activeId: string | null;
  /** Ref callback factory: attach `ref={register(id)}` to each entry element. */
  register: (id: string) => (el: HTMLElement | null) => void;
}

/**
 * Scroll-spy controller. An `IntersectionObserver` watches each
 * registered entry; the **topmost in-view** entry is reported as active. CSS-first
 * (no scroll listeners on the hot path); `offset` shrinks the observer root from
 * the top so the active line sits where the sticky marker pins.
 */
export function useScrollSpy({ ids, offset = 0, onActiveChange, enabled = true }: UseScrollSpyParams): UseScrollSpyResult {
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const elements = React.useRef(new Map<string, HTMLElement>());
  const idByElement = React.useRef(new Map<Element, string>());
  const entryState = React.useRef(new Map<string, { top: number; isIntersecting: boolean }>());
  const refCallbacks = React.useRef(new Map<string, (el: HTMLElement | null) => void>());
  const observerRef = React.useRef<IntersectionObserver | null>(null);

  const idsRef = React.useRef(ids);
  idsRef.current = ids;
  const activeIdRef = React.useRef<string | null>(null);
  const onActiveChangeRef = React.useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;

  const computeActive = React.useCallback((): string | null => {
    let best: string | null = null;
    let bestTop = Infinity;
    for (const id of idsRef.current) {
      const state = entryState.current.get(id);
      if (state?.isIntersecting && state.top < bestTop) {
        bestTop = state.top;
        best = id;
      }
    }
    return best;
  }, []);

  const register = React.useCallback((id: string) => {
    let cb = refCallbacks.current.get(id);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        const prev = elements.current.get(id);
        if (prev && prev !== el) {
          observerRef.current?.unobserve(prev);
          idByElement.current.delete(prev);
        }
        if (el) {
          elements.current.set(id, el);
          idByElement.current.set(el, id);
          observerRef.current?.observe(el);
        } else {
          elements.current.delete(id);
        }
      };
      refCallbacks.current.set(id, cb);
    }
    return cb;
  }, []);

  React.useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = idByElement.current.get(entry.target);
          if (!id) continue;
          entryState.current.set(id, { top: entry.boundingClientRect.top, isIntersecting: entry.isIntersecting });
        }
        const next = computeActive();
        if (next && next !== activeIdRef.current) {
          activeIdRef.current = next;
          setActiveId(next);
          onActiveChangeRef.current?.(next);
        }
      },
      { root: null, rootMargin: `-${offset}px 0px -55% 0px`, threshold: [0, 1] },
    );

    observerRef.current = observer;
    elements.current.forEach((el) => observer.observe(el));

    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [enabled, offset, computeActive]);

  return { activeId, register };
}

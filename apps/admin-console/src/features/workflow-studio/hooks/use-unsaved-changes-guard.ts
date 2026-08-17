'use client';

/**
 * Unsaved-changes guard (TASK-719 Task 15 remainder — design.md §Data flow: "Unsaved-changes
 * guard when `dirty`: `beforeunload` + a Next.js route-change confirm"). Two layers:
 *
 *  1. `beforeunload` — the standard, reliable guard for a tab close/reload/external navigation.
 *  2. A capture-phase `click` listener on same-origin anchor elements — Next.js 16's App Router
 *     has no `router.events`/`routeChangeStart` equivalent to intercept a client-side
 *     navigation, so this covers the CLICK-driven path instead: every nav affordance in this
 *     console (sidebar `NavEntry`s, breadcrumbs, `<Link>`s, the retired-route `redirect()`
 *     pattern) is, at the DOM level, a click on an `<a href>`. Honesty note: a `router.push()`
 *     call that does NOT originate from a click (none exist inside this editor screen today)
 *     would not be intercepted — that gap is a known Next.js App Router limitation, not an
 *     oversight here.
 */
import { useEffect } from 'react';

const DEFAULT_MESSAGE = 'You have unsaved changes. Leave this page?';

export function useUnsavedChangesGuard(shouldBlock: boolean, message: string = DEFAULT_MESSAGE): void {
  useEffect(() => {
    if (!shouldBlock) return;

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      // Chrome requires `returnValue` to be set for the native prompt to appear; the string
      // itself is ignored by modern browsers, which show their own fixed message.
      event.returnValue = '';
    }

    function handleClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('click', handleClick, true);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('click', handleClick, true);
    };
  }, [shouldBlock, message]);
}

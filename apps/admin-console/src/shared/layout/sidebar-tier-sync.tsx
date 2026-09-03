'use client';

import { useEffect, useRef } from 'react';
import { useSidebar } from '@arcaai/ui/components/shadcn/sidebar';
import { useViewportTier } from './use-viewport-tier';

/**
 * Tablet auto-collapse (redesign build spec Collapses the scoped sidebar
 * on the tablet tier (768–1279) and keeps it expanded on desktop. Since
 * the sidebar is `collapsible="offcanvas"`, so collapsed means
 * "capability rail only" — the rail keeps every domain reachable, which is why
 * this no longer costs the tablet tier its navigation. The
 * user's manual toggle wins for the rest of the session — once they change the
 * state themselves, syncing stops. Mobile is untouched (it uses the off-canvas
 * sheet, which carries the domain switcher inline). Rendered inside
 * `SidebarProvider`; renders nothing.
 */
export function SidebarTierSync() {
  const tier = useViewportTier();
  const { open, setOpen, isMobile } = useSidebar();
  const autoValue = useRef<boolean | null>(null);
  const userOverrode = useRef(false);

  // A change to `open` we didn't drive is a manual toggle → stop syncing.
  useEffect(() => {
    if (autoValue.current !== null && open !== autoValue.current) {
      userOverrode.current = true;
    }
  }, [open]);

  useEffect(() => {
    if (userOverrode.current || isMobile) return;
    const next = tier !== 'tablet'; // collapse on tablet, expand otherwise
    autoValue.current = next;
    if (open !== next) setOpen(next);
  }, [tier, isMobile, open, setOpen]);

  return null;
}

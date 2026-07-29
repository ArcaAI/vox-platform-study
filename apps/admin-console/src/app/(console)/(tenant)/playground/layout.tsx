import type { ReactNode } from 'react';
import { PlaygroundPersonaBar } from '@/features/playground-shared/components/playground-persona-bar';

/**
 * Playground routes now render inside the console shell
 * (AppSidebar + SiteHeader from (console)/layout.tsx, tenant-tier guard from
 * (tenant)/layout.tsx). This layout only adds the playground-specific persona
 * control as CONTENT above the page body — not chrome — superseding the
 * no-shell (playground) route group + PlaygroundTopBar.
 */
export default function PlaygroundLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PlaygroundPersonaBar />
      {children}
    </>
  );
}

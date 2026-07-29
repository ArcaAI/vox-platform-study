'use client';

import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { useSession } from '@/shared/auth/hooks';
import { PersonaControl } from './persona-control';

/**
 * Content-level persona/impersonation control (supersedes the
 * PlaygroundTopBar chrome). Playground routes now render inside the
 * console shell, so the persona control lives as ordinary scrolling content
 * above each screen instead of a replacement top bar — it self-fetches the
 * session rather than receiving it from a route-group server layout.
 */
export function PlaygroundPersonaBar() {
  const { data: session } = useSession();

  if (!session) {
    return <Skeleton className="mb-4 h-9 w-64" />;
  }

  return (
    <div className="mb-4">
      <PersonaControl session={session} />
    </div>
  );
}

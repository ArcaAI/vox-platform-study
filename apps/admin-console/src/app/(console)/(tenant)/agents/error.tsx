'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/components/shadcn/empty';

/**
 * TASK-965 (AG-23) — a render error on `/agents` used to fall through to the console-wide
 * boundary, which replaces the whole shell. Scoped here, the navigation and the rest of the
 * console keep working and the admin can retry just this screen.
 */
export default function AgentsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconAlertTriangle />
          </EmptyMedia>
          <EmptyTitle>Agents failed to load</EmptyTitle>
          <EmptyDescription>The rest of the console keeps working. Try the screen again.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={() => reset()}>
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

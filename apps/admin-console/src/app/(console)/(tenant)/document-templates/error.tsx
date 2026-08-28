'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/components/shadcn/empty';

/**
 * Route-level error boundary. Deliberately says what is NOT broken: a template
 * catalog that fails to load does not stop consultations — generation falls
 * back to the platform shape — so an admin hitting this should not think
 * clinical documentation has stopped.
 */
export default function DocumentTemplatesError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconAlertTriangle />
          </EmptyMedia>
          <EmptyTitle>The document template catalog failed to load</EmptyTitle>
          <EmptyDescription>
            Generation is unaffected — it resolves templates server-side and falls back to the platform shape when it cannot. Try the screen again.
          </EmptyDescription>
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

'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/components/shadcn/empty';

export default function ConsultationActivityError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <IconAlertTriangle />
        </EmptyMedia>
        <EmptyTitle>Couldn{'’'}t load this consultation</EmptyTitle>
        <EmptyDescription>An unexpected error occurred while loading its activity. Try again, or contact your administrator if it persists.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={() => reset()}>
          Try again
        </Button>
      </EmptyContent>
    </Empty>
  );
}

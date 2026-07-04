'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/components/shadcn/empty';

export default function ConsoleError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
    return (
        <div className="flex flex-1 items-center justify-center">
            <Empty>
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <IconAlertTriangle />
                    </EmptyMedia>
                    <EmptyTitle>This screen failed to load</EmptyTitle>
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

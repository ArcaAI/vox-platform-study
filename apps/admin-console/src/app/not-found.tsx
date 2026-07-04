import { IconError404 } from '@tabler/icons-react';
import Link from 'next/link';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/components/shadcn/empty';

export default function NotFound() {
    return (
        <div className="flex min-h-svh items-center justify-center p-6">
            <Empty>
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <IconError404 />
                    </EmptyMedia>
                    <EmptyTitle>Page not found</EmptyTitle>
                    <EmptyDescription>The page you are looking for does not exist or you do not have access to it.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                    <Button asChild variant="outline">
                        <Link href="/dashboard">Back to dashboard</Link>
                    </Button>
                </EmptyContent>
            </Empty>
        </div>
    );
}

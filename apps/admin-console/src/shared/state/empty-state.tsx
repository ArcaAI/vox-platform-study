import type { ComponentType, ReactNode } from 'react';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/components/shadcn/empty';

/**
 * Empty state per rule 11 §4 and the 09 template: icon + title + description
 * (+ optional CTA). Neutral tone — empty is not an error.
 */
export function EmptyState({
    icon: Icon,
    title,
    description,
    action,
}: {
    icon: ComponentType<{ className?: string }>;
    title: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
}) {
    return (
        <Empty>
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <Icon />
                </EmptyMedia>
                <EmptyTitle>{title}</EmptyTitle>
                {description ? <EmptyDescription>{description}</EmptyDescription> : null}
            </EmptyHeader>
            {action ? <EmptyContent>{action}</EmptyContent> : null}
        </Empty>
    );
}

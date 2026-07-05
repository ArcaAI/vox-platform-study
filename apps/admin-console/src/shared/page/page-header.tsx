import type { ReactNode } from 'react';

/**
 * Page header per the 09 list/detail templates: one h1, a muted meta line
 * (count, endpoint hints, badges) and a right-aligned primary-action slot.
 */
export function PageHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
    return (
        <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
                <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
                {meta ? <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">{meta}</div> : null}
            </div>
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
    );
}

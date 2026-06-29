import type { ReactNode } from 'react';

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
    return (
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
                <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
                {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
            </div>
            {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
    );
}

import type { ReactNode } from 'react';
import { cn } from '@arcaai/ui';

/**
 * In-canvas page header. The slim top bar names the page as
 * chrome ("Playground / {page}"); this is the page's own semantic heading —
 * one h1 per page (rule 11 §6) — with an optional description, badges and a
 * primary action, sized for the centered canvas rather than the console frame.
 */
export function CanvasHeader({ title, description, badges, actions }: { title: string; description?: ReactNode; badges?: ReactNode; actions?: ReactNode }) {
    return (
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
                <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
                {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
                {badges ? <div className="flex flex-wrap items-center gap-2 pt-0.5">{badges}</div> : null}
            </div>
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
    );
}

/**
 * The playground work column (artboard 4a): one centered column
 * (~760px) that reads configure → run → result top-to-bottom. Fluid below the
 * cap (full width on mobile, 5i). Scrolls inside the layout's canvas region.
 */
export function PlaygroundCanvas({ children, className }: { children: ReactNode; className?: string }) {
    return <div className={cn('mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 py-6', className)}>{children}</div>;
}

/**
 * Two-pane canvas for realtime tools: input (config/capture) and
 * live-output side by side on lg+, stacking below. Wider cap than the single
 * column since two panes need the room; still centered.
 */
export function SplitCanvas({ input, output, className }: { input: ReactNode; output: ReactNode; className?: string }) {
    return (
        <div className={cn('mx-auto grid w-full max-w-[1100px] items-start gap-4 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]', className)}>
            <div className="flex min-w-0 flex-col gap-4">{input}</div>
            <div className="flex min-w-0 flex-col gap-4">{output}</div>
        </div>
    );
}

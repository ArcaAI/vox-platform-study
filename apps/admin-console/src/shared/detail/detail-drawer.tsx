'use client';

import type { ReactNode } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@arcaai/ui/components/shadcn/sheet';
import { cx } from '@/shared/cx';

/**
 * The console-wide detail surface (redesign build spec §3). One right slide-over
 * on desktop that becomes a full-screen sheet below the `md` breakpoint (~768px),
 * replacing the per-feature hand-rolled Sheets. Ad-hoc record dialogs are retired
 * — dialogs remain only for short confirmations and break-glass step-up.
 *
 * Region contract (top → bottom): header (title · badges · close) → optional meta
 * line → optional tabs → scrollable body (`children`) → pinned footer actions.
 * The header and footer are `shrink-0`; only the body scrolls (one scroll
 * container per panel, per §1 of the UX principles). Focus is managed by Radix.
 *
 * Tabs: this component does NOT own the `Tabs` context. To use tabs, wrap the
 * `DetailDrawer` in `<Tabs>` and pass a `<TabsList variant="line">` as `tabs`
 * with the `<TabsContent>` panels as `children` — React context flows through the
 * Radix portal, so the list (in the header) and panels (in the body) share it.
 */
export type DetailDrawerSize = 'md' | 'lg' | 'xl';

const SIZE_CLASS: Record<DetailDrawerSize, string> = {
  md: 'md:max-w-xl',
  lg: 'md:max-w-[40vw]',
  xl: 'md:max-w-[56vw]',
};

export interface DetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Header title; renders inside the accessible dialog name. */
  title: ReactNode;
  /** Inline badges rendered next to the title (status, type, …). */
  badges?: ReactNode;
  /** Definition/meta line under the header (id + copy, timestamps, …). */
  meta?: ReactNode;
  /** A `<TabsList>` for the header; pass the panels as `children`. */
  tabs?: ReactNode;
  /** Pinned footer actions. */
  footer?: ReactNode;
  /** Desktop width. Mobile is always full-screen. */
  size?: DetailDrawerSize;
  className?: string;
  children: ReactNode;
}

export function DetailDrawer({ open, onOpenChange, title, badges, meta, tabs, footer, size = 'md', className, children }: DetailDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className={cx(
          // Mobile: full-screen sheet. Desktop (md+): constrained right slide-over.
          'flex h-svh w-full max-w-none flex-col gap-0 sm:max-w-none md:h-full',
          SIZE_CLASS[size],
          className,
        )}
      >
        <SheetHeader className="shrink-0 gap-1.5 border-b">
          <SheetTitle className="flex flex-wrap items-center gap-2 pr-8">
            {title}
            {badges}
          </SheetTitle>
          {/* Radix requires a Title; a hidden Description keeps the a11y
                        contract without adding a visible subtitle. */}
          <SheetDescription className="sr-only">Detail panel</SheetDescription>
          {meta ? <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">{meta}</div> : null}
          {tabs}
        </SheetHeader>
        {/* tabIndex + role/aria-label: a scrollable region must be keyboard
                    reachable on its own (WCAG 2.1.1) — content here can outgrow the
                    viewport with no other focusable element to carry the scroll. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4" tabIndex={0} role="region" aria-label="Drawer content">
          {children}
        </div>
        {footer ? <SheetFooter className="shrink-0 border-t">{footer}</SheetFooter> : null}
      </SheetContent>
    </Sheet>
  );
}

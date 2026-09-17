'use client';

import type { ReactNode } from 'react';
import { IconX } from '@tabler/icons-react';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@arcaai/ui/components/shadcn/sheet';
import { cx } from '@/shared/cx';

/**
 * The console-wide detail surface (redesign build spec One right slide-over
 * on desktop that becomes a full-screen sheet below the `md` breakpoint (~768px),
 * replacing the per-feature hand-rolled Sheets. Ad-hoc record dialogs are retired
 * — dialogs remain only for short confirmations and break-glass step-up.
 *
 * Region contract (top → bottom): header (title · badges · close) → optional meta
 * line → optional tabs → scrollable body (`children`) → pinned footer actions.
 * The header and footer are `shrink-0`; only the body scrolls (one scroll
 * container per panel, per of the UX principles). Focus is managed by Radix.
 *
 * Tabs: this component does NOT own the `Tabs` context. To use tabs, wrap the
 * `DetailDrawer` in `<Tabs>` and pass a `<TabsList variant="line">` as `tabs`
 * with the `<TabsContent>` panels as `children` — React context flows through the
 * Radix portal, so the list (in the header) and panels (in the body) share it.
 */
export type DetailDrawerSize = 'md' | 'lg' | 'xl';

/**
 * The desktop width scale. Owner decision OD-7 (TASK-983 R11) widened
 * every step — the report was that drawers "are too small to read
 * comfortably", and the previous scale (576px / 40vw / 56vw) put a
 * two-column detail body, a JSON editor or a versions table into a column
 * narrower than the reading it replaced.
 *
 * Every entry is `md:`-prefixed, so the mobile sheet stays full-screen at
 * every size; `lg`/`xl` are viewport-relative so a wide monitor gains room
 * while a small laptop does not lose any.
 */
const SIZE_CLASS: Record<DetailDrawerSize, string> = {
  md: 'md:max-w-3xl',
  lg: 'md:max-w-[52vw]',
  xl: 'md:max-w-[68vw]',
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
  /**
   * When set, closing is blocked and this string is the REASON, shown to the
   * user. Blocking silently is the anti-pattern this prop exists to prevent: a
   * close control that stays focusable and clickable while doing nothing is an
   * affordance without a function (WCAG 4.1.2 name/role/**value**), and for the
   * duration of a hung request it leaves the drawer with no exit at all.
   * Passing a reason disables the control properly — `disabled` + `aria-disabled`
   * + an accessible name carrying the reason — so its state is legible rather
   * than mysterious (rule 11 §5: "disabled buttons need a visible reason").
 */
  closeBlockedReason?: string;
  className?: string;
  children: ReactNode;
}

export function DetailDrawer({
  open,
  onOpenChange,
  title,
  badges,
  meta,
  tabs,
  footer,
  size = 'md',
  className,
  closeBlockedReason,
  children,
}: DetailDrawerProps) {
  const closeBlocked = Boolean(closeBlockedReason);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        showCloseButton={!closeBlocked}
        // Esc and outside-click are suppressed the SAME way and for the same
        // reason as the button, so all three exits agree with one another.
        onEscapeKeyDown={(event) => {
          if (closeBlocked) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (closeBlocked) event.preventDefault();
        }}
        className={cx(
          // Mobile: full-screen sheet. Desktop (md+): constrained right slide-over.
          'flex h-svh w-full max-w-none flex-col gap-0 sm:max-w-none md:h-full',
          SIZE_CLASS[size],
          className,
        )}
      >
        {closeBlocked ? (
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="ring-offset-background absolute top-4 right-4 rounded-xs opacity-50"
          >
            <IconX aria-hidden className="size-4" />
            <span className="sr-only">Close — unavailable: {closeBlockedReason}</span>
          </button>
        ) : null}
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

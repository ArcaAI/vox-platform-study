'use client';

/**
 * A titled region of the Test tab: a card-styled `<section>` named by its `<h2>`, so each panel is
 * a landmark a screen-reader user can jump to (rule 11 §11). Content flows in the tab's ONE scroll
 * container — a panel never scrolls on its own (rule 11 §1).
 */
import { useId, type ReactNode } from 'react';

export function Panel({ title, actions, children, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`bg-card text-card-foreground flex min-w-0 flex-col rounded-xl border ${className ?? ''}`}>
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <h2 id={id} className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          {title}
        </h2>
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <div className="flex min-w-0 flex-col gap-3 p-4">{children}</div>
    </section>
  );
}

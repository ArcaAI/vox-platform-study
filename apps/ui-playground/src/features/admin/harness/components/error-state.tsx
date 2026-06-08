import { AlertCircle } from 'lucide-react';

/**
 * Inline error state for the harness screens: a destructive icon + title +
 * description, shown when a query fails (never a misleading empty state), per
 * `11-ux-ui-principles.mdc` §4–5. Mirrors {@link EmptyState}'s shape so it slots
 * into the same card/table bodies.
 */
export function ErrorState({ title = 'Failed to load', description }: { title?: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center" data-testid="harness-error" role="alert">
      <AlertCircle className="text-destructive size-8" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground max-w-md text-sm">{description}</p>
    </div>
  );
}

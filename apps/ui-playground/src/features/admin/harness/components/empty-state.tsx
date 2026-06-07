import type { LucideIcon } from 'lucide-react';

/**
 * Consistent empty state for the harness screens: icon + title + description
 * (never a blank area), per `11-ux-ui-principles.mdc` §4.
 */
export function EmptyState({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center" data-testid="harness-empty">
      <Icon className="text-muted-foreground size-8" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground max-w-md text-sm">{description}</p>
    </div>
  );
}

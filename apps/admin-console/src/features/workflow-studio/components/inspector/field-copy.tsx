'use client';

/**
 * TASK-893 B3 (INTERFACES.md Contract B §4.3) — the two-tier field copy every renderer in
 * `field-renderers.tsx` shows: `summary` inline under the label, `description` behind a `?`
 * popover with an accessible name. When `summary` is absent the inline text falls back to
 * `description` truncated to one line, with the full text still reachable in the popover.
 *
 * `summary` is not yet a field on `lib/schema-form.ts`'s `FieldDescriptor` (Lane D owns that
 * file) — `summaryOf` reads it defensively off whatever the compiled descriptor actually
 * carries, so this renders correctly today (every field takes the truncated-description
 * fallback) and picks up real per-field summaries with no further change once `FieldDescriptor`
 * carries one. See this ticket's `### Cross-lane requests`.
 */
import { IconInfoCircle } from '@tabler/icons-react';
import { FieldDescription, Popover, PopoverContent, PopoverTrigger } from '@arcaai/ui';

/** Reads `summary` off a compiled field descriptor without requiring the type to declare it. */
export function summaryOf(descriptor: { summary?: unknown }): string | undefined {
  return typeof descriptor.summary === 'string' && descriptor.summary.length > 0 ? descriptor.summary : undefined;
}

export interface FieldCopyProps {
  /** The field's own label — carried into the popover trigger's accessible name. */
  label: string;
  summary?: string;
  description?: string;
}

/** `null` when there is no copy at all — callers render nothing, exactly as before this ticket. */
export function FieldCopy({ label, summary, description }: FieldCopyProps) {
  if (!summary && !description) return null;

  const inlineText = summary ?? description;
  const truncated = !summary;

  return (
    <FieldDescription className="flex items-start gap-1">
      <span className={truncated ? 'min-w-0 flex-1 truncate' : 'min-w-0 flex-1'}>{inlineText}</span>
      {description ? (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" aria-label={`More about ${label}`} className="text-muted-foreground hover:text-foreground mt-0.5 shrink-0">
              <IconInfoCircle aria-hidden="true" className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="text-sm">{description}</PopoverContent>
        </Popover>
      ) : null}
    </FieldDescription>
  );
}

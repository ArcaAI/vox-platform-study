'use client';

import type { TimelineRendererProps } from '../types';

/** Renders user-supplied custom content. */
export function CustomRenderer({ content }: TimelineRendererProps) {
  if (content.type !== 'custom') return null;
  return <div data-slot="timeline-custom">{content.render()}</div>;
}

/** Last-resort renderer for unknown/unsupported variants. */
export function FallbackRenderer({ item }: TimelineRendererProps) {
  return (
    <div data-slot="timeline-fallback" data-testid="timeline-fallback" className="rounded-md border bg-card p-3 text-sm text-muted-foreground">
      Unsupported content{typeof item.title === 'string' ? `: ${item.title}` : ''}.
    </div>
  );
}

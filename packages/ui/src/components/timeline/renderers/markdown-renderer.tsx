'use client';

import { Markdown } from '@/components/registries/prompt-kit/markdown';
import { cn } from '@/lib/utils';

import type { TimelineRendererProps } from '../types';

/**
 * Markdown content renderer (thin wrapper over prompt-kit `Markdown`, which uses
 * react-markdown without `rehype-raw` — raw HTML/script is NOT executed: XSS-safe).
 */
export function MarkdownRenderer({ content }: TimelineRendererProps) {
  if (content.type !== 'markdown') return null;
  return (
    <div
      data-slot="timeline-markdown"
      className={cn(
        'space-y-2 text-sm leading-relaxed text-foreground',
        '[&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono',
        '[&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5',
      )}
    >
      <Markdown>{content.markdown}</Markdown>
    </div>
  );
}

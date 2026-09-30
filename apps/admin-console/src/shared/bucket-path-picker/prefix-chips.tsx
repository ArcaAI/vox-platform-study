'use client';

import { IconChevronRight } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';

/**
 * Breadcrumb path bar over the current prefix (frame 31): the root chip is the
 * bucket name; each segment navigates into that prefix.
 */
export function PrefixChips({ bucketName, prefix, onNavigate }: { bucketName: string; prefix: string; onNavigate: (prefix: string) => void }) {
  const segments = prefix.split('/').filter(Boolean);
  return (
    <nav aria-label="Object prefix" className="flex flex-wrap items-center gap-1">
      <Button type="button" variant={segments.length === 0 ? 'secondary' : 'ghost'} size="sm" className="font-mono text-xs" onClick={() => onNavigate('')}>
        {bucketName}
      </Button>
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`} className="flex items-center gap-1">
          <IconChevronRight aria-hidden className="text-muted-foreground size-3.5" />
          <Button
            type="button"
            variant={index === segments.length - 1 ? 'secondary' : 'ghost'}
            size="sm"
            className="font-mono text-xs"
            onClick={() => onNavigate(`${segments.slice(0, index + 1).join('/')}/`)}
          >
            {segment}
          </Button>
        </span>
      ))}
    </nav>
  );
}

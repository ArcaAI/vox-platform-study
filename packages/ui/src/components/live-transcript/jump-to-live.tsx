'use client';

import { ArrowDown } from 'lucide-react';

import { Button } from '@/components/shadcn/button';
import { cn } from '@/lib/utils';

export interface JumpToLiveProps {
  onClick: () => void;
  className?: string;
  hasBacklog?: boolean;
}

/** Floating control shown when the transcript is scrolled away from the bottom. */
export function JumpToLive({ onClick, className, hasBacklog }: JumpToLiveProps) {
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={onClick}
      aria-label="Jump to latest"
      className={cn('absolute bottom-3 left-1/2 -translate-x-1/2', className)}
    >
      <ArrowDown className="size-4" />
      {hasBacklog ? 'New messages' : 'Jump to live'}
    </Button>
  );
}

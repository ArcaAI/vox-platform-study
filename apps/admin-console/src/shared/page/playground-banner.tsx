'use client';

import { IconPlayerPlay } from '@tabler/icons-react';
import { useSession } from '@/shared/auth';

/**
 * Playground banner (frames 50–54): the tier 50–59 screens carry this
 * primary-tinted strip in their `statusBanner` slot — playground planes are
 * end-user planes that run under the admin's OWN account, not /admin/*
 * surfaces. The username renders once the session projection hydrates.
 */
export function PlaygroundBanner() {
  const session = useSession();
  const username = session.data?.user.username;

  return (
    <div
      role="note"
      className="border-primary/25 bg-primary/10 text-foreground flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium"
    >
      <IconPlayerPlay aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        Playground {'—'} demo sessions run under your own account
        {username ? <span className="font-mono font-normal"> ({username})</span> : null}
      </span>
    </div>
  );
}

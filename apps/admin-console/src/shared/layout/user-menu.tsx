'use client';

import { IconLogout, IconUserCircle } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import type { SafeSession } from '@/shared/auth/hooks';

export function UserMenu({ session }: { session: SafeSession }) {
  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    // Full navigation so every client cache (queries, zustand) is dropped.
    window.location.assign('/login');
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account menu">
          <IconUserCircle className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{session.user.username}</span>
            <span className="text-muted-foreground text-xs font-normal">{session.user.email}</span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void handleLogout()}>
          <IconLogout />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

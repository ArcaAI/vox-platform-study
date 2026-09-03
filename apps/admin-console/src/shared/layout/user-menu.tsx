'use client';

import { IconLogout, IconUserCircle } from '@tabler/icons-react';
import Link from 'next/link';
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
import { usePermissions } from '@/shared/auth/hooks';
import { visibleUserMenuEntries } from '@/shared/navigation/nav-config';

export function UserMenu({ session }: { session: SafeSession }) {
  // /developer and /account are personal chrome, not rail domains.
  // Same ability gate they carried in the sidebar — see USER_MENU_ENTRIES.
  const { data: rules } = usePermissions();
  const entries = visibleUserMenuEntries(rules);

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
        {entries.map((entry) => {
          const Icon = entry.icon;
          return (
            <DropdownMenuItem key={entry.route} asChild>
              <Link href={entry.route}>
                <Icon aria-hidden />
                {entry.label}
              </Link>
            </DropdownMenuItem>
          );
        })}
        {entries.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem variant="destructive" onSelect={() => void handleLogout()}>
          <IconLogout />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

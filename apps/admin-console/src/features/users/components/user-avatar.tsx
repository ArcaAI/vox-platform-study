'use client';

import { Avatar, AvatarFallback } from '@arcaai/ui/components/shadcn/avatar';

/** "mia.okafor" -> "MO", "svc-export" -> "SE", "root" -> "RO". */
export function userInitials(username: string): string {
  const parts = username.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Initials avatar (decorative — the username is always rendered next to it). */
export function UserAvatar({ username, size = 'default' }: { username: string; size?: 'default' | 'sm' | 'lg' }) {
  return (
    <Avatar aria-hidden size={size}>
      <AvatarFallback>{userInitials(username)}</AvatarFallback>
    </Avatar>
  );
}

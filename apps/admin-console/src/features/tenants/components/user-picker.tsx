'use client';

import { useState } from 'react';
import { IconCheck, IconSelector } from '@tabler/icons-react';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@arcaai/ui/components/shadcn/command';
import { Popover, PopoverContent, PopoverTrigger } from '@arcaai/ui/components/shadcn/popover';
import { cn } from '@arcaai/ui';
import { useUsers } from '@/features/users/api/hooks';
import type { User } from '@/features/users/api/types';

export function UserPicker({
  id,
  value,
  onChange,
  className,
}: {
  id?: string;
  value: User | null;
  onChange: (user: User | null) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const usersQuery = useUsers({ search: query.trim(), searchFields: 'username', limit: 10 }, { enabled: open });
  const results = usersQuery.data?.data ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            'border-input flex min-h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm outline-none',
            'hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>{value ? value.username : 'Search by username…'}</span>
          <IconSelector aria-hidden="true" className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] min-w-64 p-0">
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search users by username…" />
          <CommandList>
            {usersQuery.isFetching ? (
              <div className="text-muted-foreground py-6 text-center text-sm">Searching…</div>
            ) : results.length === 0 ? (
              <div className="text-muted-foreground py-6 text-center text-sm">{query.trim() ? 'No user found.' : 'Type to search users.'}</div>
            ) : (
              <CommandGroup>
                {results.map((user) => {
                  const active = user.id === value?.id;
                  return (
                    <CommandItem
                      key={user.id}
                      value={user.id}
                      onSelect={() => {
                        onChange(user);
                        setOpen(false);
                      }}
                    >
                      <span className="flex-1 truncate">{user.username}</span>
                      <span className="font-mono text-muted-foreground text-xs">{user.id.slice(0, 8)}</span>
                      {active ? <IconCheck aria-hidden="true" className="size-4 text-foreground" /> : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

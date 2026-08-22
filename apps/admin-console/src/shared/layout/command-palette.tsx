'use client';

import { useEffect, useState } from 'react';
import { IconArrowRight, IconMoon, IconSearch } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@arcaai/ui/components/shadcn/command';
import { Kbd } from '@arcaai/ui/components/shadcn/kbd';
import { usePermissions } from '@/shared/auth/hooks';
import { NAV_SECTIONS, visibleNavEntries, visibleUserMenuEntries } from '@/shared/navigation/nav-config';

/**
 * ⌘K palette (frame 07): jump to any implemented screen the ability grants,
 * plus a theme toggle. Opens from the topbar search affordance or the
 * keyboard shortcut.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const { data: rules } = usePermissions();
  // TASK-788 Phase A: /developer and /account left NAV_ENTRIES for the user menu,
  // but they are still screens a user jumps to — keep them searchable here, or the
  // nav reorganisation silently removes two routes from ⌘K.
  const entries = [...visibleNavEntries(rules), ...visibleUserMenuEntries(rules)];

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((previous) => !previous);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border-input bg-muted/50 text-muted-foreground hover:bg-muted focus-visible:ring-ring hidden h-8 w-64 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm outline-none focus-visible:ring-2 md:flex"
      >
        <IconSearch aria-hidden className="size-4" />
        <span className="flex-1 text-left">Search or jump to…</span>
        <Kbd>⌘K</Kbd>
      </button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Command palette" description="Type a command or search…">
        <CommandInput placeholder="Type a command or search…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          {NAV_SECTIONS.map((section) => {
            const sectionEntries = entries.filter((entry) => entry.tier === section.tier);
            if (sectionEntries.length === 0) return null;
            return (
              <CommandGroup key={section.tier} heading={section.label}>
                {sectionEntries.map((entry) => (
                  <CommandItem key={entry.route} value={`${entry.label} ${entry.route}`} onSelect={() => run(() => router.push(entry.route))}>
                    <IconArrowRight aria-hidden />
                    {entry.label}
                    <span className="text-muted-foreground ml-auto font-mono text-xs">{entry.route}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            );
          })}
          <CommandGroup heading="Preferences">
            <CommandItem value="toggle theme dark light" onSelect={() => run(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'))}>
              <IconMoon aria-hidden />
              Toggle theme
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}

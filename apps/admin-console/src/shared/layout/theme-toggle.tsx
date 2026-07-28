'use client';

import { IconMoon, IconSun } from '@tabler/icons-react';
import { useTheme } from 'next-themes';
import { Button } from '@arcaai/ui/components/shadcn/button';

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
      {/* Render both and let the class-driven theme pick one: avoids a hydration mismatch. */}
      <IconSun className="size-4 dark:hidden" />
      <IconMoon className="hidden size-4 dark:block" />
    </Button>
  );
}

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Minimal light/dark toggle — no next-themes dependency (this is a plain
 * Vite app, not Next.js). Applies `.dark` on `<html>` for the Tailwind v4
 * `@custom-variant dark (&:is(.dark *))` in `@arcaai/ui/globals.css`, starts
 * from the OS preference, and follows live OS changes until the user
 * overrides it for the session.
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(systemTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(mediaQuery.matches ? 'dark' : 'light');
    mediaQuery.addEventListener('change', onChange);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, []);

  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  return [theme, toggle];
}

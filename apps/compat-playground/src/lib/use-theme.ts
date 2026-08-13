import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * The theme the pre-paint bootstrap script in `index.html` already put on
 * `<html>`. Adopting it — instead of re-deriving it — is what keeps the mount
 * effect below a no-op, so the initial theme never starts a transition.
 *
 * The `systemTheme()` fallback covers only the degraded case where that script
 * did not run: it adds the class exclusively for a dark OS preference, so an
 * absent class plus a dark OS can mean nothing else.
 */
function documentTheme(): Theme {
  if (typeof document === 'undefined') return systemTheme();
  return document.documentElement.classList.contains('dark') ? 'dark' : systemTheme();
}

/**
 * Flip the theme class with CSS transitions suppressed for the duration of the
 * change.
 *
 * WHY: every `@arcaai/ui` control carries
 * `transition-all` or `transition-[color,box-shadow]`. Toggling `.dark` on
 * `<html>` changes `color` / `background-color` / `border-color` purely through
 * a custom-property cascade, which starts a transition on each of those
 * elements — but the browser never repaints them, so the interpolation never
 * advances and the control keeps the PREVIOUS theme's colour (input text at
 * ~1.03 contrast). Verified in the running app: a bare
 * `<div class="transition-all">` appended straight to `<body>` — no React, no
 * tabs — strands its colour, background and border, while the same div without
 * the transition class follows the theme correctly.
 *
 * Suppressing transitions across the flip makes the new values apply instantly,
 * which is also what a theme switch should look like. It is exactly what
 * next-themes' `disableTransitionOnChange` does for `apps/admin-console`
 * (`src/shared/providers.tsx`); this app is plain Vite, so it is spelled out.
*/
function applyThemeWithoutTransitions(theme: Theme): void {
  const suppressor = document.createElement('style');
  suppressor.appendChild(document.createTextNode('*,*::before,*::after{transition:none !important;animation:none !important}'));
  document.head.appendChild(suppressor);

  document.documentElement.classList.toggle('dark', theme === 'dark');

  // Force a style recalculation so the new colours are committed while
  // transitions are still off — without it the suppressor is removed in the
  // same frame and the transitions fire after all.
  void window.getComputedStyle(document.documentElement).color;

  suppressor.remove();
}

/**
 * Minimal light/dark toggle — no next-themes dependency (this is a plain
 * Vite app, not Next.js). Applies `.dark` on `<html>` for the Tailwind v4
 * `@custom-variant dark (&:is(.dark *))` in `@arcaai/ui/globals.css`, starts
 * from the OS preference (already applied before first paint by the bootstrap
 * script in `index.html`), and follows live OS changes until the user
 * overrides it for the session.
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(documentTheme);

  useEffect(() => {
    applyThemeWithoutTransitions(theme);
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

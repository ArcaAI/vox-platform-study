import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { STORAGE_KEYS } from '@/lib/constants';

export type Theme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function readStored(): Theme {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(STORAGE_KEYS.THEME);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored);
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() =>
    readStored() === 'dark' || (readStored() === 'system' && systemPrefersDark()) ? 'dark' : 'light',
  );

  useEffect(() => {
    const apply = () => {
      const resolved = theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme;
      setResolvedTheme(resolved);
      document.documentElement.classList.toggle('dark', resolved === 'dark');
      document.documentElement.style.colorScheme = resolved;
    };
    apply();

    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      resolvedTheme,
      setTheme: (next) => {
        window.localStorage.setItem(STORAGE_KEYS.THEME, next);
        setThemeState(next);
      },
      toggle: () => {
        const next = resolvedTheme === 'dark' ? 'light' : 'dark';
        window.localStorage.setItem(STORAGE_KEYS.THEME, next);
        setThemeState(next);
      },
    }),
    [theme, resolvedTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

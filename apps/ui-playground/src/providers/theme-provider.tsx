import { getLocalStorage, removeLocalStorage, setLocalStorage } from '@/lib/local-storage';
import { STORAGE_KEYS } from '@/lib/constants';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

type Theme = 'dark' | 'light' | 'system';
type ResolvedTheme = Exclude<Theme, 'system'>;

const DEFAULT_THEME: Theme = 'system';

interface ThemeProviderState {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeProviderState>({
  theme: DEFAULT_THEME,
  resolvedTheme: 'light',
  setTheme: () => null,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, _setTheme] = useState<Theme>(() => (getLocalStorage(STORAGE_KEYS.THEME) as Theme) || DEFAULT_THEME);

  const resolvedTheme = useMemo((): ResolvedTheme => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return theme;
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const applyTheme = (resolved: ResolvedTheme) => {
      root.classList.remove('light', 'dark');
      root.classList.add(resolved);
    };

    const handleChange = () => {
      if (theme === 'system') {
        applyTheme(mediaQuery.matches ? 'dark' : 'light');
      }
    };

    applyTheme(resolvedTheme);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme, resolvedTheme]);

  const setTheme = (t: Theme) => {
    if (t === DEFAULT_THEME) {
      removeLocalStorage(STORAGE_KEYS.THEME);
    } else {
      setLocalStorage(STORAGE_KEYS.THEME, t);
    }
    _setTheme(t);
  };

  return <ThemeContext value={{ theme, resolvedTheme, setTheme }}>{children}</ThemeContext>;
}

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
};

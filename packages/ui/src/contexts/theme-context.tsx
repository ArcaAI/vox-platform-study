'use client';

import { createContext, useContext, type ReactNode } from 'react';

export type Theme = 'light' | 'dark' | 'system';

export interface ThemeContextValue {
  currentTheme: Theme;
  previewDarkMode: boolean;
}

const defaultValue: ThemeContextValue = {
  currentTheme: 'light',
  previewDarkMode: false,
};

const ThemeContext = createContext<ThemeContextValue>(defaultValue);

export function ThemeProvider({ children, value = defaultValue }: { children: ReactNode; value?: ThemeContextValue }) {
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  return context ?? defaultValue;
}

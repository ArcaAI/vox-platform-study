import React from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';

function ThemeWrapper({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-background text-foreground light">{children}</div>;
}

function DarkThemeWrapper({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-background text-foreground dark">{children}</div>;
}

// Return types are annotated explicitly: the inferred `RenderResult<...>` names
// query types from the transitive `@testing-library/dom` install, which is not
// portable into this package's emitted declarations.
function renderWithTheme(ui: React.ReactElement, options?: Omit<RenderOptions, 'wrapper'>): RenderResult {
  return render(ui, { wrapper: ThemeWrapper, ...options });
}

function renderWithDarkTheme(ui: React.ReactElement, options?: Omit<RenderOptions, 'wrapper'>): RenderResult {
  return render(ui, { wrapper: DarkThemeWrapper, ...options });
}

export { renderWithTheme, renderWithDarkTheme, ThemeWrapper, DarkThemeWrapper };
export { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
export { userEvent } from '@testing-library/user-event';

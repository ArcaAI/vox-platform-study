import React from 'react'
import { render, type RenderOptions } from '@testing-library/react'

function ThemeWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground light">
      {children}
    </div>
  )
}

function DarkThemeWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground dark">
      {children}
    </div>
  )
}

function renderWithTheme(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) {
  return render(ui, { wrapper: ThemeWrapper, ...options })
}

function renderWithDarkTheme(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) {
  return render(ui, { wrapper: DarkThemeWrapper, ...options })
}

export { renderWithTheme, renderWithDarkTheme, ThemeWrapper, DarkThemeWrapper }
export { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
export { userEvent } from '@testing-library/user-event'

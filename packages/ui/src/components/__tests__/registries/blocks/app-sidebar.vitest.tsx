import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AppSidebar } from '../../../registries/blocks/app-sidebar'
import { SidebarProvider } from '../../../shadcn/sidebar'

describe('AppSidebar', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    )
    expect(container.firstChild).toBeTruthy()
  })
})

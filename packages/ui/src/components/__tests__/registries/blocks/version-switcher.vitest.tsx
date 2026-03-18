import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { VersionSwitcher } from '../../../registries/blocks/version-switcher'
import { SidebarProvider, Sidebar } from '../../../shadcn/sidebar'

describe('VersionSwitcher', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <VersionSwitcher versions={['1.0.0', '2.0.0']} defaultVersion="1.0.0" />
        </Sidebar>
      </SidebarProvider>
    )
    expect(container.firstChild).toBeTruthy()
  })
})

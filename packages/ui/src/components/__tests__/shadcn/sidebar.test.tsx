import { test, expect } from '@playwright/experimental-ct-react'
import {
  SidebarProvider,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarSeparator,
  SidebarInset,
  SidebarInput,
  SidebarTrigger,
  SidebarRail,
} from '../../shadcn/sidebar'

test.describe('Sidebar', () => {
  test.describe('Sidebar (non-collapsible)', () => {
    test('renders with collapsible="none"', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>Content</SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const sidebar = component.locator('[data-slot="sidebar"]')
      await expect(sidebar).toBeVisible()
    })

    test('has data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>Content</SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const sidebar = component.locator('[data-slot="sidebar"]')
      await expect(sidebar).toHaveAttribute('data-slot', 'sidebar')
    })
  })

  test.describe('SidebarProvider wrapper', () => {
    test('wrapper has data-slot, layout classes, and CSS variables', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarHeader>Header</SidebarHeader>
            <SidebarContent>Content</SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const sidebar = component.locator('[data-slot="sidebar"]')
      await expect(sidebar).toBeVisible()

      const wrapper = sidebar.locator('..')
      await expect(wrapper).toHaveClass(/min-h-svh/)
      await expect(wrapper).toHaveClass(/flex/)
      const style = await wrapper.getAttribute('style')
      expect(style).toContain('--sidebar-width')
    })

    test('wrapper accepts custom className', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider className="custom-provider">
          <Sidebar collapsible="none">
            <SidebarContent>Content</SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const sidebar = component.locator('[data-slot="sidebar"]')
      await expect(sidebar).toBeVisible()

      const wrapper = sidebar.locator('..')
      await expect(wrapper).toHaveClass(/custom-provider/)
    })
  })

  test.describe('SidebarHeader', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarHeader>Header Content</SidebarHeader>
          </Sidebar>
        </SidebarProvider>
      )
      const header = component.locator('[data-slot="sidebar-header"]')
      await expect(header).toBeVisible()
      await expect(header).toHaveText('Header Content')
    })

    test('applies custom className', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarHeader className="custom-header">Header</SidebarHeader>
          </Sidebar>
        </SidebarProvider>
      )
      const header = component.locator('[data-slot="sidebar-header"]')
      await expect(header).toHaveClass(/custom-header/)
    })

    test('has flex column layout', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarHeader>Header</SidebarHeader>
          </Sidebar>
        </SidebarProvider>
      )
      const header = component.locator('[data-slot="sidebar-header"]')
      await expect(header).toHaveClass(/flex/)
      await expect(header).toHaveClass(/flex-col/)
    })
  })

  test.describe('SidebarFooter', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarFooter>Footer Content</SidebarFooter>
          </Sidebar>
        </SidebarProvider>
      )
      const footer = component.locator('[data-slot="sidebar-footer"]')
      await expect(footer).toBeVisible()
      await expect(footer).toHaveText('Footer Content')
    })

    test('has flex column layout', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarFooter>Footer</SidebarFooter>
          </Sidebar>
        </SidebarProvider>
      )
      const footer = component.locator('[data-slot="sidebar-footer"]')
      await expect(footer).toHaveClass(/flex/)
      await expect(footer).toHaveClass(/flex-col/)
    })
  })

  test.describe('SidebarContent', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>Main Content</SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const content = component.locator('[data-slot="sidebar-content"]')
      await expect(content).toBeVisible()
    })

    test('has overflow auto for scrolling', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>Content</SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const content = component.locator('[data-slot="sidebar-content"]')
      await expect(content).toHaveClass(/overflow-auto/)
    })

    test('has flex-1 to fill available space', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>Content</SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const content = component.locator('[data-slot="sidebar-content"]')
      await expect(content).toHaveClass(/flex-1/)
    })
  })

  test.describe('SidebarGroup', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>Group Content</SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const group = component.locator('[data-slot="sidebar-group"]')
      await expect(group).toBeVisible()
    })

    test('has flex column layout', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>Group</SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const group = component.locator('[data-slot="sidebar-group"]')
      await expect(group).toHaveClass(/flex/)
      await expect(group).toHaveClass(/flex-col/)
    })
  })

  test.describe('SidebarGroupLabel', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupLabel>Label</SidebarGroupLabel>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const label = component.locator('[data-slot="sidebar-group-label"]')
      await expect(label).toBeVisible()
      await expect(label).toHaveText('Label')
    })

    test('has small text styling', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupLabel>Label</SidebarGroupLabel>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const label = component.locator('[data-slot="sidebar-group-label"]')
      await expect(label).toHaveClass(/text-xs/)
      await expect(label).toHaveClass(/font-medium/)
    })
  })

  test.describe('SidebarMenu', () => {
    test('renders as ul element', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton>Item</SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const menu = component.locator('[data-slot="sidebar-menu"]')
      await expect(menu).toBeVisible()
      const tagName = await menu.evaluate((el) => el.tagName.toLowerCase())
      expect(tagName).toBe('ul')
    })
  })

  test.describe('SidebarMenuItem', () => {
    test('renders as li element', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton>Item</SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const item = component.locator('[data-slot="sidebar-menu-item"]')
      await expect(item).toBeVisible()
      const tagName = await item.evaluate((el) => el.tagName.toLowerCase())
      expect(tagName).toBe('li')
    })
  })

  test.describe('SidebarMenuButton', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton>Click me</SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const button = component.locator('[data-slot="sidebar-menu-button"]')
      await expect(button).toBeVisible()
      await expect(button).toHaveText('Click me')
    })

    test('renders active state', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton isActive>Active</SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const button = component.locator('[data-slot="sidebar-menu-button"]')
      await expect(button).toHaveAttribute('data-active', 'true')
    })

    test('supports size variants', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton size="sm">Small</SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const button = component.locator('[data-slot="sidebar-menu-button"]')
      await expect(button).toHaveAttribute('data-size', 'sm')
    })
  })

  test.describe('SidebarMenuBadge', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton>Item</SidebarMenuButton>
                      <SidebarMenuBadge>5</SidebarMenuBadge>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const badge = component.locator('[data-slot="sidebar-menu-badge"]')
      await expect(badge).toBeVisible()
      await expect(badge).toHaveText('5')
    })
  })

  test.describe('SidebarMenuSkeleton', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarMenuSkeleton />
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const skeleton = component.locator('[data-slot="sidebar-menu-skeleton"]')
      await expect(skeleton).toBeVisible()
    })

    test('renders with icon when showIcon is true', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarMenuSkeleton showIcon />
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const iconSkeleton = component.locator('[data-sidebar="menu-skeleton-icon"]')
      await expect(iconSkeleton).toBeVisible()
    })

    test('renders text skeleton', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarMenuSkeleton />
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const textSkeleton = component.locator('[data-sidebar="menu-skeleton-text"]')
      await expect(textSkeleton).toBeVisible()
    })
  })

  test.describe('SidebarMenuSub', () => {
    test('renders as ul element', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton>Parent</SidebarMenuButton>
                      <SidebarMenuSub>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton>Child</SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      </SidebarMenuSub>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const sub = component.locator('[data-slot="sidebar-menu-sub"]')
      await expect(sub).toBeVisible()
      const tagName = await sub.evaluate((el) => el.tagName.toLowerCase())
      expect(tagName).toBe('ul')
    })
  })

  test.describe('SidebarMenuSubButton', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton>Parent</SidebarMenuButton>
                      <SidebarMenuSub>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton>Child Item</SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      </SidebarMenuSub>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const subButton = component.locator('[data-slot="sidebar-menu-sub-button"]')
      await expect(subButton).toBeVisible()
      await expect(subButton).toHaveText('Child Item')
    })

    test('supports active state', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton>Parent</SidebarMenuButton>
                      <SidebarMenuSub>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton isActive>Active Child</SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      </SidebarMenuSub>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const subButton = component.locator('[data-slot="sidebar-menu-sub-button"]')
      await expect(subButton).toHaveAttribute('data-active', 'true')
    })

    test('supports size variants', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton>Parent</SidebarMenuButton>
                      <SidebarMenuSub>
                        <SidebarMenuSubItem>
                          <SidebarMenuSubButton size="sm">Small</SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      </SidebarMenuSub>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const subButton = component.locator('[data-slot="sidebar-menu-sub-button"]')
      await expect(subButton).toHaveAttribute('data-size', 'sm')
    })
  })

  test.describe('SidebarSeparator', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarSeparator />
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      )
      const separator = component.locator('[data-slot="sidebar-separator"]')
      await expect(separator).toBeVisible()
    })
  })

  test.describe('SidebarInput', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarHeader>
              <SidebarInput placeholder="Search..." />
            </SidebarHeader>
          </Sidebar>
        </SidebarProvider>
      )
      const input = component.locator('[data-slot="sidebar-input"]')
      await expect(input).toBeVisible()
      await expect(input).toHaveAttribute('placeholder', 'Search...')
    })
  })

  test.describe('SidebarInset', () => {
    test('renders as main element', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>Content</SidebarContent>
          </Sidebar>
          <SidebarInset>Main Content</SidebarInset>
        </SidebarProvider>
      )
      const inset = component.locator('[data-slot="sidebar-inset"]')
      await expect(inset).toBeVisible()
      const tagName = await inset.evaluate((el) => el.tagName.toLowerCase())
      expect(tagName).toBe('main')
    })

    test('has flex-1 to fill remaining space', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <SidebarInset>Content</SidebarInset>
        </SidebarProvider>
      )
      const inset = component.locator('[data-slot="sidebar-inset"]')
      await expect(inset).toHaveClass(/flex-1/)
    })
  })

  test.describe('SidebarTrigger', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <SidebarTrigger />
        </SidebarProvider>
      )
      const trigger = component.locator('[data-slot="sidebar-trigger"]')
      await expect(trigger).toBeVisible()
    })

    test('has sr-only label text', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <SidebarTrigger />
        </SidebarProvider>
      )
      const srOnly = component.locator('.sr-only')
      await expect(srOnly).toHaveText('Toggle Sidebar')
    })
  })

  test.describe('SidebarRail', () => {
    test('renders with data-slot attribute', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>Content</SidebarContent>
            <SidebarRail />
          </Sidebar>
        </SidebarProvider>
      )
      const rail = component.locator('[data-slot="sidebar-rail"]')
      await expect(rail).toBeVisible()
    })

    test('has aria-label for accessibility', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarContent>Content</SidebarContent>
            <SidebarRail />
          </Sidebar>
        </SidebarProvider>
      )
      const rail = component.locator('[data-slot="sidebar-rail"]')
      await expect(rail).toHaveAttribute('aria-label', 'Toggle Sidebar')
    })
  })

  test.describe('full composition', () => {
    test('renders a complete sidebar layout', async ({ mount }) => {
      const component = await mount(
        <SidebarProvider>
          <Sidebar collapsible="none">
            <SidebarHeader>App Name</SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupLabel>Navigation</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton isActive>Dashboard</SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton>Settings</SidebarMenuButton>
                      <SidebarMenuBadge>3</SidebarMenuBadge>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>Footer</SidebarFooter>
          </Sidebar>
          <SidebarInset>
            <main>Page Content</main>
          </SidebarInset>
        </SidebarProvider>
      )

      await expect(component.locator('[data-slot="sidebar-header"]')).toHaveText('App Name')
      await expect(component.locator('[data-slot="sidebar-group-label"]')).toHaveText('Navigation')

      const menuButtons = component.locator('[data-slot="sidebar-menu-button"]')
      await expect(menuButtons).toHaveCount(2)

      const activeButton = component.locator('[data-slot="sidebar-menu-button"][data-active="true"]')
      await expect(activeButton).toHaveText('Dashboard')

      await expect(component.locator('[data-slot="sidebar-menu-badge"]')).toHaveText('3')
      await expect(component.locator('[data-slot="sidebar-footer"]')).toHaveText('Footer')
      await expect(component.locator('[data-slot="sidebar-inset"]')).toBeVisible()
    })
  })
})

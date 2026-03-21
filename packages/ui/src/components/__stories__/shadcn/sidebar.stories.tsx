import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  IconHome,
  IconInbox,
  IconCalendar,
  IconSearch,
  IconSettings,
} from '@tabler/icons-react'

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarHeader,
  SidebarFooter,
  SidebarSeparator,
  SidebarTrigger,
  SidebarInset,
} from '../../shadcn/sidebar'

const menuItems = [
  { title: 'Home', icon: IconHome },
  { title: 'Inbox', icon: IconInbox },
  { title: 'Calendar', icon: IconCalendar },
  { title: 'Search', icon: IconSearch },
  { title: 'Settings', icon: IconSettings },
]

const meta = {
  title: 'Components/Sidebar',
  component: Sidebar,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Sidebar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1">
            <div className="bg-primary size-6 rounded" />
            <span className="font-semibold">Acme Inc</span>
          </div>
        </SidebarHeader>
        <SidebarSeparator />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Application</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {menuItems.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton>
                      <item.icon className="size-4" />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="text-muted-foreground px-2 py-1 text-xs">v1.0.0</div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <span className="text-sm font-medium">Dashboard</span>
        </header>
        <div className="p-4">
          <p className="text-muted-foreground text-sm">Main content area</p>
        </div>
      </SidebarInset>
    </SidebarProvider>
  ),
}

export const WithActiveItem: Story = {
  render: () => (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Navigation</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {menuItems.map((item, i) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton isActive={i === 0}>
                      <item.icon className="size-4" />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <div className="p-4">
          <p className="text-muted-foreground text-sm">Content</p>
        </div>
      </SidebarInset>
    </SidebarProvider>
  ),
}

export const RightSide: Story = {
  render: () => (
    <SidebarProvider>
      <SidebarInset>
        <div className="p-4">
          <p className="text-muted-foreground text-sm">Main content</p>
        </div>
      </SidebarInset>
      <Sidebar side="right">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Properties</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {menuItems.slice(0, 3).map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton>
                      <item.icon className="size-4" />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  ),
}

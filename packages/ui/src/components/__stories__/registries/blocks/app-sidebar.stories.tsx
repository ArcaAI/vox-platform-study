import type { Meta, StoryObj } from '@storybook/react-vite'

import { AppSidebar } from '../../../registries/blocks/app-sidebar'
import { SidebarProvider } from '../../../shadcn/sidebar'

const meta = {
  title: 'Registries/Blocks/AppSidebar',
  component: AppSidebar,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <SidebarProvider>
        <Story />
      </SidebarProvider>
    ),
  ],
} satisfies Meta<typeof AppSidebar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {},
}

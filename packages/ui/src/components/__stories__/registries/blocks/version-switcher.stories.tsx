import type { Meta, StoryObj } from '@storybook/react-vite'

import { VersionSwitcher } from '../../../registries/blocks/version-switcher'
import { SidebarProvider, Sidebar } from '../../../shadcn/sidebar'

const meta = {
  title: 'Registries/Blocks/VersionSwitcher',
  component: VersionSwitcher,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <SidebarProvider>
        <Sidebar>
          <Story />
        </Sidebar>
      </SidebarProvider>
    ),
  ],
} satisfies Meta<typeof VersionSwitcher>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    versions: ['1.0.0', '1.1.0', '2.0.0-beta'],
    defaultVersion: '1.0.0',
  },
}

export const SingleVersion: Story = {
  args: {
    versions: ['1.0.0'],
    defaultVersion: '1.0.0',
  },
}

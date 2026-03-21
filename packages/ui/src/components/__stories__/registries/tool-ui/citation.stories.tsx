import type { Meta, StoryObj } from '@storybook/react-vite'

import { Citation } from '../../../registries/tool-ui/citation'

const meta = {
  title: 'Registries/ToolUI/Citation',
  component: Citation,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Citation>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    id: '1',
    href: 'https://example.com',
    title: 'Example Source',
  },
}

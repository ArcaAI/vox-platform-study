import type { Meta, StoryObj } from '@storybook/react-vite'

import { StatsDisplay } from '../../../registries/tool-ui/stats-display'

const meta = {
  title: 'Registries/ToolUI/StatsDisplay',
  component: StatsDisplay,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof StatsDisplay>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    id: '1',
    stats: [
      { key: 'users', label: 'Users', value: 1234 },
      {
        key: 'revenue',
        label: 'Revenue',
        value: 5678,
        format: { kind: 'currency', currency: 'USD' },
      },
    ],
  },
}

import type { Meta, StoryObj } from '@storybook/react-vite'

import { Chart } from '../../../registries/tool-ui/chart'

const meta = {
  title: 'Registries/ToolUI/Chart',
  component: Chart,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Chart>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    id: '1',
    type: 'bar',
    xKey: 'month',
    series: [{ key: 'revenue', label: 'Revenue' }],
    data: [
      { month: 'Jan', revenue: 100 },
      { month: 'Feb', revenue: 200 },
      { month: 'Mar', revenue: 150 },
    ],
  },
}

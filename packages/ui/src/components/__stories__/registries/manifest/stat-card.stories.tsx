import type { Meta, StoryObj } from '@storybook/react-vite'

import { StatCard } from '../../../registries/manifest/stat-card'

const meta = {
  title: 'Registries/Manifest/StatCard',
  component: StatCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof StatCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <StatCard />,
}

import type { Meta, StoryObj } from '@storybook/react-vite'

import { Status, StatusIndicator, StatusLabel } from '../../../registries/kibo-ui/status'

const meta = {
  title: 'Registries/KiboUI/Status',
  component: Status,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Status>

export default meta
type Story = StoryObj<typeof meta>

export const Online: Story = {
  args: {
    status: 'online',
    children: (
      <>
        <StatusIndicator />
        <StatusLabel />
      </>
    ),
  },
}

export const Offline: Story = {
  args: {
    status: 'offline',
    children: (
      <>
        <StatusIndicator />
        <StatusLabel />
      </>
    ),
  },
}

export const Maintenance: Story = {
  args: {
    status: 'maintenance',
    children: (
      <>
        <StatusIndicator />
        <StatusLabel />
      </>
    ),
  },
}

export const Degraded: Story = {
  args: {
    status: 'degraded',
    children: (
      <>
        <StatusIndicator />
        <StatusLabel />
      </>
    ),
  },
}

import type { Meta, StoryObj } from '@storybook/react-vite'

import { EventList } from '../../../registries/manifest/event-list'

const meta = {
  title: 'Registries/Manifest/EventList',
  component: EventList,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof EventList>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <EventList />,
}

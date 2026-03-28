import type { Meta, StoryObj } from '@storybook/react-vite';

import { EventCard } from '../../../registries/manifest/event-card';

const meta = {
  title: 'Registries/Manifest/EventCard',
  component: EventCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof EventCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <EventCard />,
};

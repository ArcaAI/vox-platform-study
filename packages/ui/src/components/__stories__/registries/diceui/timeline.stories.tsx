import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  Timeline,
  TimelineItem,
  TimelineDot,
  TimelineConnector,
  TimelineContent,
  TimelineHeader,
  TimelineTitle,
} from '../../../registries/diceui/timeline';

const meta = {
  title: 'Registries/DiceUI/Timeline',
  component: Timeline,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Timeline>;

export default meta;
type Story = StoryObj<typeof meta>;

const events = [
  { id: '1', title: 'First event' },
  { id: '2', title: 'Second event' },
  { id: '3', title: 'Third event' },
];

export const Default: Story = {
  render: () => (
    <Timeline>
      {events.map((event) => (
        <TimelineItem key={event.id}>
          <TimelineDot />
          <TimelineConnector />
          <TimelineContent>
            <TimelineHeader>
              <TimelineTitle>{event.title}</TimelineTitle>
            </TimelineHeader>
          </TimelineContent>
        </TimelineItem>
      ))}
    </Timeline>
  ),
};

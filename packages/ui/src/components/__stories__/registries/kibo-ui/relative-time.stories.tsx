import type { Meta, StoryObj } from '@storybook/react-vite';

import { RelativeTime, RelativeTimeZone, RelativeTimeZoneDisplay, RelativeTimeZoneLabel } from '../../../registries/kibo-ui/relative-time';

const meta = {
  title: 'Registries/KiboUI/RelativeTime',
  component: RelativeTime,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof RelativeTime>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <RelativeTime className="w-64">
      <RelativeTimeZone zone="America/New_York">
        <RelativeTimeZoneLabel>EST</RelativeTimeZoneLabel>
        <RelativeTimeZoneDisplay />
      </RelativeTimeZone>
      <RelativeTimeZone zone="Europe/London">
        <RelativeTimeZoneLabel>GMT</RelativeTimeZoneLabel>
        <RelativeTimeZoneDisplay />
      </RelativeTimeZone>
      <RelativeTimeZone zone="Asia/Tokyo">
        <RelativeTimeZoneLabel>JST</RelativeTimeZoneLabel>
        <RelativeTimeZoneDisplay />
      </RelativeTimeZone>
    </RelativeTime>
  ),
};

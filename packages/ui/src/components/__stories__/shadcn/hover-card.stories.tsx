import type { Meta, StoryObj } from '@storybook/react-vite';
import { IconCalendar } from '@tabler/icons-react';

import { HoverCard, HoverCardTrigger, HoverCardContent } from '../../shadcn/hover-card';
import { Button } from '../../shadcn/button';
import { Avatar, AvatarImage, AvatarFallback } from '../../shadcn/avatar';

const meta = {
  title: 'Components/HoverCard',
  component: HoverCard,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof HoverCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Button variant="link" className="px-0">
          @shadcn
        </Button>
      </HoverCardTrigger>
      <HoverCardContent className="w-80">
        <div className="flex justify-between space-x-4">
          <Avatar>
            <AvatarImage src="https://github.com/shadcn.png" />
            <AvatarFallback>SC</AvatarFallback>
          </Avatar>
          <div className="space-y-1">
            <h4 className="text-sm font-semibold">@shadcn</h4>
            <p className="text-sm">The creator of shadcn/ui — beautifully designed components built with Radix and Tailwind.</p>
            <div className="flex items-center pt-2">
              <IconCalendar className="mr-2 size-4 opacity-70" />
              <span className="text-muted-foreground text-xs">Joined December 2021</span>
            </div>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  ),
};

export const Simple: Story = {
  render: () => (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Button variant="outline">Hover me</Button>
      </HoverCardTrigger>
      <HoverCardContent>
        <p className="text-sm">This is a simple hover card with just text content.</p>
      </HoverCardContent>
    </HoverCard>
  ),
};

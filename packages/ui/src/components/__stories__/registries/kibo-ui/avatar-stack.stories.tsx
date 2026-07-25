import type { Meta, StoryObj } from '@storybook/react-vite';

import { AvatarStack } from '../../../registries/kibo-ui/avatar-stack';
import { Avatar, AvatarFallback, AvatarImage } from '../../../shadcn/avatar';

const meta = {
  title: 'Registries/KiboUI/AvatarStack',
  component: AvatarStack,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof AvatarStack>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  // Passed as an array rather than a fragment: AvatarStack uses `Children.map`
  // to wrap each avatar, and a fragment would collapse to a single child.
  args: {
    children: [
      <Avatar key="a">
        <AvatarFallback>A</AvatarFallback>
      </Avatar>,
      <Avatar key="b">
        <AvatarFallback>B</AvatarFallback>
      </Avatar>,
      <Avatar key="c">
        <AvatarFallback>C</AvatarFallback>
      </Avatar>,
    ],
  },
  render: (args) => <AvatarStack {...args} />,
};

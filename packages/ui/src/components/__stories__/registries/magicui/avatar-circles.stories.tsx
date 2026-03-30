import type { Meta, StoryObj } from '@storybook/react-vite';

import { AvatarCircles } from '../../../registries/magicui/avatar-circles';

const meta = {
  title: 'Registries/MagicUI/AvatarCircles',
  component: AvatarCircles,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof AvatarCircles>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    avatarUrls: [{ imageUrl: 'https://via.placeholder.com/40', profileUrl: '#' }],
  },
};

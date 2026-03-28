import type { Meta, StoryObj } from '@storybook/react-vite';

import { PostCard } from '../../../registries/manifest/post-card';

const meta = {
  title: 'Registries/Manifest/PostCard',
  component: PostCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof PostCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <PostCard />,
};

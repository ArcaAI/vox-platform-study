import type { Meta, StoryObj } from '@storybook/react-vite';

import { PostList } from '../../../registries/manifest/post-list';

const meta = {
  title: 'Registries/Manifest/PostList',
  component: PostList,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof PostList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <PostList />,
};

import type { Meta, StoryObj } from '@storybook/react-vite'

import { PostDetail } from '../../../registries/manifest/post-detail'

const meta = {
  title: 'Registries/Manifest/PostDetail',
  component: PostDetail,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof PostDetail>

export default meta
type Story = StoryObj<typeof meta>

export const Inline: Story = {
  render: () => (
    <div className="w-[500px]">
      <PostDetail appearance={{ displayMode: 'inline' }} />
    </div>
  ),
}

export const Pip: Story = {
  render: () => (
    <div className="w-[500px]">
      <PostDetail appearance={{ displayMode: 'pip' }} />
    </div>
  ),
}

export const Fullscreen: Story = {
  render: () => <PostDetail appearance={{ displayMode: 'fullscreen' }} />,
}

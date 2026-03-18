import type { Meta, StoryObj } from '@storybook/react-vite'

import { Safari } from '../../../registries/magicui/safari'

const meta = {
  title: 'Registries/MagicUI/Safari',
  component: Safari,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Safari>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    url: 'https://example.com',
    className: 'h-96 w-full max-w-2xl',
  },
}

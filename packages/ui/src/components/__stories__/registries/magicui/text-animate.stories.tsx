import type { Meta, StoryObj } from '@storybook/react-vite'

import { TextAnimate } from '../../../registries/magicui/text-animate'

const meta = {
  title: 'Registries/MagicUI/TextAnimate',
  component: TextAnimate,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof TextAnimate>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    children: 'Hello World',
  },
}

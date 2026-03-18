import type { Meta, StoryObj } from '@storybook/react-vite'

import { ShimmerButton } from '../../../registries/magicui/shimmer-button'

const meta = {
  title: 'Registries/MagicUI/ShimmerButton',
  component: ShimmerButton,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ShimmerButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    children: 'Shimmer',
  },
}

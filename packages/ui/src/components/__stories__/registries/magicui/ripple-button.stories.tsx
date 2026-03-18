import type { Meta, StoryObj } from '@storybook/react-vite'

import { RippleButton } from '../../../registries/magicui/ripple-button'

const meta = {
  title: 'Registries/MagicUI/RippleButton',
  component: RippleButton,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof RippleButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    children: 'Ripple',
  },
}

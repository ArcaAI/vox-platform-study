import type { Meta, StoryObj } from '@storybook/react-vite'

import { InteractiveHoverButton } from '../../../registries/magicui/interactive-hover-button'

const meta = {
  title: 'Registries/MagicUI/InteractiveHoverButton',
  component: InteractiveHoverButton,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof InteractiveHoverButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    children: 'Hover Me',
  },
}

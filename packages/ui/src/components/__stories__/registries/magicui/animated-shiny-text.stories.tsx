import type { Meta, StoryObj } from '@storybook/react-vite'

import { AnimatedShinyText } from '../../../registries/magicui/animated-shiny-text'

const meta = {
  title: 'Registries/MagicUI/AnimatedShinyText',
  component: AnimatedShinyText,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof AnimatedShinyText>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    children: 'Shiny Text',
  },
}

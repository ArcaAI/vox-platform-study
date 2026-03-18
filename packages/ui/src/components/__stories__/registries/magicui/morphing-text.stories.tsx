import type { Meta, StoryObj } from '@storybook/react-vite'

import { MorphingText } from '../../../registries/magicui/morphing-text'

const meta = {
  title: 'Registries/MagicUI/MorphingText',
  component: MorphingText,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof MorphingText>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    texts: ['Hello', 'World', 'Magic'],
  },
}

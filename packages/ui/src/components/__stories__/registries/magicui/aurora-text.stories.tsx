import type { Meta, StoryObj } from '@storybook/react-vite'

import { AuroraText } from '../../../registries/magicui/aurora-text'

const meta = {
  title: 'Registries/MagicUI/AuroraText',
  component: AuroraText,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof AuroraText>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    children: 'Aurora',
  },
}

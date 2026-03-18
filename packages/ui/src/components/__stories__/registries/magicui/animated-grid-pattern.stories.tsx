import type { Meta, StoryObj } from '@storybook/react-vite'

import { AnimatedGridPattern } from '../../../registries/magicui/animated-grid-pattern'

const meta = {
  title: 'Registries/MagicUI/AnimatedGridPattern',
  component: AnimatedGridPattern,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof AnimatedGridPattern>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="relative h-screen w-full overflow-hidden">
      <AnimatedGridPattern />
    </div>
  ),
}

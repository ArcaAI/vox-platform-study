import type { Meta, StoryObj } from '@storybook/react-vite'

import { Particles } from '../../../registries/magicui/particles'

const meta = {
  title: 'Registries/MagicUI/Particles',
  component: Particles,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof Particles>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="relative h-screen w-full">
      <Particles />
    </div>
  ),
}

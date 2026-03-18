import type { Meta, StoryObj } from '@storybook/react-vite'

import { FlickeringGrid } from '../../../registries/magicui/flickering-grid'

const meta = {
  title: 'Registries/MagicUI/FlickeringGrid',
  component: FlickeringGrid,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof FlickeringGrid>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="relative h-screen w-full">
      <FlickeringGrid />
    </div>
  ),
}

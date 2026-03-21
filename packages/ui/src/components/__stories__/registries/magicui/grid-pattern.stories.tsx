import type { Meta, StoryObj } from '@storybook/react-vite'

import { GridPattern } from '../../../registries/magicui/grid-pattern'

const meta = {
  title: 'Registries/MagicUI/GridPattern',
  component: GridPattern,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof GridPattern>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="relative h-screen w-full overflow-hidden">
      <GridPattern />
    </div>
  ),
}

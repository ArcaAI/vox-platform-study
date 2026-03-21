import type { Meta, StoryObj } from '@storybook/react-vite'

import { ScrollProgress } from '../../../registries/magicui/scroll-progress'

const meta = {
  title: 'Registries/MagicUI/ScrollProgress',
  component: ScrollProgress,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof ScrollProgress>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="h-[200vh]">
      <ScrollProgress />
      <div className="flex h-screen items-center justify-center">
        <p className="text-lg">Scroll down to see the progress bar</p>
      </div>
    </div>
  ),
}

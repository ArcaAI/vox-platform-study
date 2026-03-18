import type { Meta, StoryObj } from '@storybook/react-vite'

import { AnimatedList } from '../../../registries/magicui/animated-list'

const meta: Meta = {
  title: 'Registries/MagicUI/AnimatedList',
  component: AnimatedList,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <AnimatedList>
      <div key="1" className="rounded-lg border bg-muted px-4 py-2">
        Item 1
      </div>
      <div key="2" className="rounded-lg border bg-muted px-4 py-2">
        Item 2
      </div>
      <div key="3" className="rounded-lg border bg-muted px-4 py-2">
        Item 3
      </div>
      <div key="4" className="rounded-lg border bg-muted px-4 py-2">
        Item 4
      </div>
    </AnimatedList>
  ),
}

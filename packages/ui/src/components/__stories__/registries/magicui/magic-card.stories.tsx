import type { Meta, StoryObj } from '@storybook/react-vite'

import { MagicCard } from '../../../registries/magicui/magic-card'

const meta = {
  title: 'Registries/MagicUI/MagicCard',
  component: MagicCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof MagicCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <MagicCard>
      <div className="p-8">
        <p className="text-lg font-medium">Magic Card</p>
        <p className="text-sm text-muted-foreground">
          Move your cursor over the card to see the gradient effect.
        </p>
      </div>
    </MagicCard>
  ),
}

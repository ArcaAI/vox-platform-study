import type { Meta, StoryObj } from '@storybook/react-vite'
import { RelativeTimeCard } from '@/components/registries/diceui/relative-time-card'

const meta = {
  title: 'Registries/DiceUI/RelativeTimeCard',
  component: RelativeTimeCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof RelativeTimeCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    date: new Date(),
    children: 'Event Title',
  },
}

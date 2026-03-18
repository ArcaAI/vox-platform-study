import type { Meta, StoryObj } from '@storybook/react-vite'
import { Rating, RatingItem } from '@/components/registries/diceui/rating'

const meta = {
  title: 'Registries/DiceUI/Rating',
  component: Rating,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Rating>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Rating>
      {Array.from({ length: 5 }).map((_, i) => (
        <RatingItem key={i} index={i} />
      ))}
    </Rating>
  ),
}

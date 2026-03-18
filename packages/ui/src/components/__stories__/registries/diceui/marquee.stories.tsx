import type { Meta, StoryObj } from '@storybook/react-vite'

import { Marquee, MarqueeContent, MarqueeItem } from '../../../registries/diceui/marquee'

const meta = {
  title: 'Registries/DiceUI/Marquee',
  component: Marquee,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Marquee>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Marquee className="w-64 overflow-hidden">
      <MarqueeContent>
        <MarqueeItem>Item 1</MarqueeItem>
        <MarqueeItem>Item 2</MarqueeItem>
        <MarqueeItem>Item 3</MarqueeItem>
        <MarqueeItem>Item 4</MarqueeItem>
        <MarqueeItem>Item 5</MarqueeItem>
      </MarqueeContent>
    </Marquee>
  ),
}

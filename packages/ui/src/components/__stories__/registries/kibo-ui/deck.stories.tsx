import type { Meta, StoryObj } from '@storybook/react-vite'

import { Deck, DeckCards, DeckItem, DeckEmpty } from '../../../registries/kibo-ui/deck'

const meta = {
  title: 'Registries/KiboUI/Deck',
  component: Deck,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Deck>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="relative h-64 w-64">
      <Deck>
        <DeckEmpty />
        <DeckCards>
          <DeckItem>Card 1</DeckItem>
          <DeckItem>Card 2</DeckItem>
          <DeckItem>Card 3</DeckItem>
        </DeckCards>
      </Deck>
    </div>
  ),
}

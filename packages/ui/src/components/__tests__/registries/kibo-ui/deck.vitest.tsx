import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Deck, DeckCards, DeckItem, DeckEmpty } from '../../../registries/kibo-ui/deck'

describe('Deck', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Deck>
        <DeckEmpty />
        <DeckCards>
          <DeckItem>Card 1</DeckItem>
          <DeckItem>Card 2</DeckItem>
        </DeckCards>
      </Deck>
    )
    expect(container.firstChild).toBeTruthy()
  })
})

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ItemCarousel } from '../../../registries/tool-ui/item-carousel'

describe('ItemCarousel', () => {
  it('renders without crashing', () => {
    render(
      <ItemCarousel id="1" items={[{ id: "1", name: "Item 1" }]} />
    )
    expect(screen.getByText('Item 1')).toBeInTheDocument()
  })
})

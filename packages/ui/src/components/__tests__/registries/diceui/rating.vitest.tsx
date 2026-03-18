import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Rating, RatingItem } from '@/components/registries/diceui/rating'

describe('Rating', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Rating>
        <RatingItem value={1} />
        <RatingItem value={2} />
      </Rating>,
    )
    expect(container.firstChild).toBeTruthy()
  })
})

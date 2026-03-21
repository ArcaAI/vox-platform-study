import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Rating, RatingButton } from '../../../registries/kibo-ui/rating'

describe('Rating', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Rating defaultValue={3}>
        <RatingButton />
        <RatingButton />
        <RatingButton />
        <RatingButton />
        <RatingButton />
      </Rating>
    )
    expect(container.firstChild).toBeTruthy()
  })
})

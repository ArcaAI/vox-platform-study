import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Marquee, MarqueeContent, MarqueeItem } from '../../../registries/kibo-ui/marquee'

describe('Marquee', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Marquee>
        <MarqueeContent>
          <MarqueeItem>Item 1</MarqueeItem>
        </MarqueeContent>
      </Marquee>
    )
    expect(container.firstChild).toBeTruthy()
  })
})

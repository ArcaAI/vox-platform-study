import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Marquee } from '../../../registries/magicui/marquee'

describe('Marquee', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Marquee>
        <div>Item 1</div>
      </Marquee>
    )
    expect(container.firstChild).toBeTruthy()
  })
})

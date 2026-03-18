import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { NumberTicker } from '../../../registries/magicui/number-ticker'

describe('NumberTicker', () => {
  it('renders without crashing', () => {
    const { container } = render(<NumberTicker value={42} />)
    expect(container.firstChild).toBeTruthy()
  })
})

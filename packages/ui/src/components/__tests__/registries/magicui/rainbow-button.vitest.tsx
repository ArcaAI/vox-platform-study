import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { RainbowButton } from '../../../registries/magicui/rainbow-button'

describe('RainbowButton', () => {
  it('renders without crashing', () => {
    const { container } = render(<RainbowButton>Test</RainbowButton>)
    expect(container.firstChild).toBeTruthy()
  })
})

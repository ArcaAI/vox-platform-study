import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ShimmerButton } from '../../../registries/magicui/shimmer-button'

describe('ShimmerButton', () => {
  it('renders without crashing', () => {
    const { container } = render(<ShimmerButton>Test</ShimmerButton>)
    expect(container.firstChild).toBeTruthy()
  })
})

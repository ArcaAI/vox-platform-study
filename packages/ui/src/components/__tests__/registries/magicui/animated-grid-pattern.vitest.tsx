import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AnimatedGridPattern } from '../../../registries/magicui/animated-grid-pattern'

describe('AnimatedGridPattern', () => {
  it('renders without crashing', () => {
    const { container } = render(<AnimatedGridPattern />)
    expect(container.firstChild).toBeTruthy()
  })
})

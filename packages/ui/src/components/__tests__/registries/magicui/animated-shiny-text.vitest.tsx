import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AnimatedShinyText } from '../../../registries/magicui/animated-shiny-text'

describe('AnimatedShinyText', () => {
  it('renders without crashing', () => {
    const { container } = render(<AnimatedShinyText>Test</AnimatedShinyText>)
    expect(container.firstChild).toBeTruthy()
  })
})

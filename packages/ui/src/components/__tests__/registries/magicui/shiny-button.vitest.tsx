import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ShinyButton } from '../../../registries/magicui/shiny-button'

describe('ShinyButton', () => {
  it('renders without crashing', () => {
    const { container } = render(<ShinyButton>Test</ShinyButton>)
    expect(container.firstChild).toBeTruthy()
  })
})

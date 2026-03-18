import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Terminal } from '../../../registries/ai-elements/terminal'

describe('Terminal', () => {
  it('renders without crashing', () => {
    const { container } = render(<Terminal output="$ echo hello" />)
    expect(container.firstChild).toBeTruthy()
  })

  it('renders the output text', () => {
    const { container } = render(<Terminal output="test output" />)
    expect(container.textContent).toContain('test output')
  })
})

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TypingAnimation } from '../../../registries/magicui/typing-animation'

describe('TypingAnimation', () => {
  it('renders without crashing', () => {
    const { container } = render(<TypingAnimation>Test</TypingAnimation>)
    expect(container.firstChild).toBeTruthy()
  })
})

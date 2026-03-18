import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { SpeechInput } from '../../../registries/ai-elements/speech-input'

describe('SpeechInput', () => {
  it('renders without crashing', () => {
    const { container } = render(<SpeechInput />)
    expect(container.firstChild).toBeTruthy()
  })

  it('renders a button element', () => {
    const { container } = render(<SpeechInput />)
    expect(container.querySelector('button')).toBeTruthy()
  })
})

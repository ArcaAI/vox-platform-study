import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PulsatingButton } from '../../../registries/magicui/pulsating-button'

describe('PulsatingButton', () => {
  it('renders without crashing', () => {
    const { container } = render(<PulsatingButton>Test</PulsatingButton>)
    expect(container.firstChild).toBeTruthy()
  })
})

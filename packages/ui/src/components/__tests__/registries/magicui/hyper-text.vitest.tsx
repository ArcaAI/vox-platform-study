import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { HyperText } from '../../../registries/magicui/hyper-text'

describe('HyperText', () => {
  it('renders without crashing', () => {
    const { container } = render(<HyperText>Test</HyperText>)
    expect(container.firstChild).toBeTruthy()
  })
})

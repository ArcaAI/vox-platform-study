import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Input } from '../../../registries/basecn/input'

describe('Input', () => {
  it('renders without crashing', () => {
    const { container } = render(<Input />)
    expect(container.firstChild).toBeTruthy()
  })

  it('renders with placeholder', () => {
    const { container } = render(<Input placeholder="Enter text" />)
    const input = container.querySelector('input')
    expect(input?.placeholder).toBe('Enter text')
  })
})

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { RetroGrid } from '../../../registries/magicui/retro-grid'

describe('RetroGrid', () => {
  it('renders without crashing', () => {
    const { container } = render(<RetroGrid />)
    expect(container.firstChild).toBeTruthy()
  })
})

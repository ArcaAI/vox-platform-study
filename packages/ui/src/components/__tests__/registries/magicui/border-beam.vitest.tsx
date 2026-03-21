import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { BorderBeam } from '../../../registries/magicui/border-beam'

describe('BorderBeam', () => {
  it('renders without crashing', () => {
    const { container } = render(<BorderBeam />)
    expect(container.firstChild).toBeTruthy()
  })
})

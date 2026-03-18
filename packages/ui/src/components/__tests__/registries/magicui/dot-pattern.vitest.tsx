import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { DotPattern } from '../../../registries/magicui/dot-pattern'

describe('DotPattern', () => {
  it('renders without crashing', () => {
    const { container } = render(<DotPattern />)
    expect(container.firstChild).toBeTruthy()
  })
})

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ScrollProgress } from '../../../registries/magicui/scroll-progress'

describe('ScrollProgress', () => {
  it('renders without crashing', () => {
    const { container } = render(<ScrollProgress />)
    expect(container.firstChild).toBeTruthy()
  })
})

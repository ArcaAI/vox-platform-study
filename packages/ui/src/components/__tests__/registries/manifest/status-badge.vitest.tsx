import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { StatusBadge } from '../../../registries/manifest/status-badge'

describe('StatusBadge', () => {
  it('renders without crashing', () => {
    const { container } = render(<StatusBadge />)
    expect(container.firstChild).toBeTruthy()
  })
})

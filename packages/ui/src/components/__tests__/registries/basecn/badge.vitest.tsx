import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Badge } from '../../../registries/basecn/badge'

describe('Badge', () => {
  it('renders without crashing', () => {
    const { container } = render(<Badge>New</Badge>)
    expect(container.firstChild).toBeTruthy()
  })

  it('renders the badge text', () => {
    const { getByText } = render(<Badge>Status</Badge>)
    expect(getByText('Status')).toBeTruthy()
  })
})

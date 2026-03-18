import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { StatCard } from '../../../registries/manifest/stat-card'

describe('StatCard', () => {
  it('renders without crashing', () => {
    const { container } = render(<StatCard />)
    expect(container.firstChild).toBeTruthy()
  })
})

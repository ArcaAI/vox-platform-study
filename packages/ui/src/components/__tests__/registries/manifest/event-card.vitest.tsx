import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { EventCard } from '../../../registries/manifest/event-card'

describe('EventCard', () => {
  it('renders without crashing', () => {
    const { container } = render(<EventCard />)
    expect(container.firstChild).toBeTruthy()
  })
})

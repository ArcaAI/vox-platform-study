import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { RelativeTimeCard } from '@/components/registries/diceui/relative-time-card'

describe('RelativeTimeCard', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <RelativeTimeCard date={new Date()} title="Test" />,
    )
    expect(container.firstChild).toBeTruthy()
  })
})

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Plan } from '../../../registries/tool-ui/plan'

describe('Plan', () => {
  it('renders without crashing', () => {
    render(
      <Plan id="1" title="My Plan" todos={[{ id: "1", label: "Task 1", status: "completed" }]} />
    )
    expect(screen.getByText('My Plan')).toBeInTheDocument()
  })
})

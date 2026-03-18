import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FeedbackBar } from '../../../registries/prompt-kit/feedback-bar'

describe('FeedbackBar', () => {
  it('renders without crashing', () => {
    render(<FeedbackBar title="Was this helpful?" />)
    expect(screen.getByText('Was this helpful?')).toBeInTheDocument()
  })
})

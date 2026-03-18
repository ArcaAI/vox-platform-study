import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import {
  Suggestions,
  Suggestion,
} from '../../../registries/ai-elements/suggestion'

describe('Suggestions', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Suggestions>
        <Suggestion suggestion="Hello" />
      </Suggestions>
    )
    expect(container.firstChild).toBeTruthy()
  })
})

describe('Suggestion', () => {
  it('renders the suggestion text', () => {
    const { getByText } = render(<Suggestion suggestion="Ask me anything" />)
    expect(getByText('Ask me anything')).toBeTruthy()
  })

  it('calls onClick with the suggestion text', () => {
    const handleClick = vi.fn()
    const { getByText } = render(
      <Suggestion suggestion="Hello" onClick={handleClick} />
    )
    fireEvent.click(getByText('Hello'))
    expect(handleClick).toHaveBeenCalledWith('Hello')
  })
})

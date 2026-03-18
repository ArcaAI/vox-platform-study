import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from '../../../registries/ai-elements/reasoning'

describe('Reasoning', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Reasoning defaultOpen>
        <ReasoningTrigger />
        <ReasoningContent>Thinking about the problem...</ReasoningContent>
      </Reasoning>
    )
    expect(container.firstChild).toBeTruthy()
  })
})

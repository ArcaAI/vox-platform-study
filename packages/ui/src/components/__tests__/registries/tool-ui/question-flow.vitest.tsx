import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { QuestionFlow } from '../../../registries/tool-ui/question-flow'

describe('QuestionFlow', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <QuestionFlow id="1" steps={[{ id: "1", title: "What is your name?", options: [{ id: "a", label: "Answer" }] }]} />
    )
    expect(container.firstChild).toBeTruthy()
  })
})

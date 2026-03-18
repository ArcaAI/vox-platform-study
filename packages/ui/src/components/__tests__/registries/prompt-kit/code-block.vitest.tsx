import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CodeBlock, CodeBlockCode } from '../../../registries/prompt-kit/code-block'

describe('CodeBlock', () => {
  it('renders without crashing', () => {
    render(
      <CodeBlock>
        <CodeBlockCode code="const x = 1" />
      </CodeBlock>,
    )
    expect(screen.getByText(/const x = 1/)).toBeInTheDocument()
  })
})

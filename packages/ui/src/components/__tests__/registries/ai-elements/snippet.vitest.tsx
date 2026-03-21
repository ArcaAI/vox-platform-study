import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  Snippet,
  SnippetInput,
  SnippetCopyButton,
} from '../../../registries/ai-elements/snippet'

describe('Snippet', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Snippet code="npm install">
        <SnippetInput />
        <SnippetCopyButton />
      </Snippet>
    )
    expect(container.firstChild).toBeTruthy()
  })

  it('displays the code value in the input', () => {
    const { container } = render(
      <Snippet code="pnpm add react">
        <SnippetInput />
      </Snippet>
    )
    const input = container.querySelector('input')
    expect(input?.value).toBe('pnpm add react')
  })
})

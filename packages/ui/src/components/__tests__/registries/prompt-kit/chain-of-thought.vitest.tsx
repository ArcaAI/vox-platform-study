import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  ChainOfThought,
  ChainOfThoughtStep,
  ChainOfThoughtItem,
  ChainOfThoughtTrigger,
  ChainOfThoughtContent,
} from '../../../registries/prompt-kit/chain-of-thought'

describe('ChainOfThought', () => {
  it('renders without crashing', () => {
    render(
      <ChainOfThought>
        <ChainOfThoughtStep>
          <ChainOfThoughtItem>
            <ChainOfThoughtTrigger>Step 1</ChainOfThoughtTrigger>
            <ChainOfThoughtContent>Content 1</ChainOfThoughtContent>
          </ChainOfThoughtItem>
        </ChainOfThoughtStep>
      </ChainOfThought>,
    )
    expect(screen.getByText('Step 1')).toBeInTheDocument()
  })
})
